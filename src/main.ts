import type { DescriptorEntry, PickedFile, ProcessingResult } from './core/types';
import { parseDescriptor } from './core/descriptor';
import { buildPlan } from './core/plan';
import { safeFileName } from './core/filename';
import { processPlaylist } from './core/process';
import { pickedFilesFromDataTransfer, pickedFilesFromFileList, rootFolderName } from './core/picker';
import { SpotifyClient, SpotifyError } from './core/spotify';
import { downloadBlob } from './core/zip';

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const dom = {
  musicInput: byId<HTMLInputElement>('music-input'),
  descriptorInput: byId<HTMLInputElement>('descriptor-input'),
  descriptorText: byId<HTMLTextAreaElement>('descriptor-text'),
  dropZone: byId<HTMLElement>('drop-zone'),
  playlistName: byId<HTMLInputElement>('playlist-name'),
  spotifyEnabled: byId<HTMLInputElement>('spotify-enabled'),
  spotifyClientId: byId<HTMLInputElement>('spotify-client-id'),
  spotifyClientSecret: byId<HTMLInputElement>('spotify-client-secret'),
  spotifyRemember: byId<HTMLInputElement>('spotify-remember'),
  runButton: byId<HTMLButtonElement>('run-button'),
  cancelButton: byId<HTMLButtonElement>('cancel-button'),
  downloadButton: byId<HTMLButtonElement>('download-button'),
  status: byId<HTMLElement>('status'),
  progress: byId<HTMLProgressElement>('progress'),
  planBody: byId<HTMLTableSectionElement>('plan-body'),
  issues: byId<HTMLElement>('issues'),
  warnings: byId<HTMLElement>('warnings'),
  results: byId<HTMLElement>('results'),
};

const STORAGE_KEY = 'autoditag.spotify';

type StatusKind = 'info' | 'busy' | 'success' | 'warn' | 'error';

function setStatus(message: string, kind: StatusKind = 'info'): void {
  dom.status.textContent = message;
  dom.status.dataset.kind = kind;
}

function setState(state: 'idle' | 'running' | 'done' | 'error'): void {
  document.body.classList.remove('state-idle', 'state-running', 'state-done', 'state-error');
  document.body.classList.add(`state-${state}`);
}

function setList(element: HTMLElement, messages: readonly string[]): void {
  element.replaceChildren();
  if (messages.length === 0) return;
  const list = document.createElement('ul');
  for (const message of messages) {
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
  }
  element.append(list);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function today(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${now.getFullYear()}`;
}

/* -------------------------------------------------------------------------- */
/* state                                                                       */
/* -------------------------------------------------------------------------- */

let musicFiles: PickedFile[] = [];
let nestedFiles: PickedFile[] = [];
let lastResult: ProcessingResult | null = null;
let lastZip: Blob | null = null;
let running = false;
let abortController: AbortController | null = null;

function currentDescriptorText(): string {
  return dom.descriptorText.value;
}

function currentEntries(): { entries: DescriptorEntry[]; issues: string[] } {
  const parsed = parseDescriptor(currentDescriptorText());
  return {
    entries: [...parsed.entries],
    issues: parsed.issues.map((issue) => issue.message),
  };
}

function renderPlan(): void {
  const { entries, issues } = currentEntries();
  setList(dom.issues, issues);
  document.body.classList.toggle('has-issues', issues.length > 0);

  // a changed input invalidates the result of the last run
  invalidateResult();

  const plan = buildPlan(entries, musicFiles);
  dom.planBody.replaceChildren();

  for (const track of plan.tracks) {
    const row = document.createElement('tr');
    row.className = `row-${track.status}`;

    const cells: [string, string][] = [
      [track.entry.trackNumber, 'num'],
      [track.source?.name ?? '—', 'old'],
      [track.targetName, 'new'],
      [track.entry.artist, 'artist'],
      [track.entry.dance, 'dance'],
      [statusLabel(track.status), 'status'],
      [track.warnings.join(' '), 'note'],
    ];

    for (const [value, className] of cells) {
      const cell = document.createElement('td');
      cell.className = className;
      cell.textContent = value;
      if (className === 'old' && track.source) {
        cell.title = track.source.relativePath;
      }
      if (className === 'status' && track.warnings.length > 0) {
        cell.title = track.warnings.join(' ');
      }
      row.append(cell);
    }

    dom.planBody.append(row);
  }

  setList(dom.warnings, [...plan.warnings, ...nestedFileWarnings()]);
  document.body.classList.toggle(
    'has-warnings',
    plan.warnings.length > 0 || nestedFiles.length > 0,
  );

  const missing = plan.tracks.filter((track) => track.status === 'missing').length;
  const mp3Count = musicFiles.filter((file) => file.name.toLowerCase().endsWith('.mp3')).length;
  if (musicFiles.length === 0) {
    setStatus('Choose the folder with your mp3 files to get started.', 'info');
  } else if (mp3Count === 0) {
    setStatus('The selected folder does not contain any mp3 files.', 'warn');
  } else if (entries.length === 0) {
    setStatus('Load the descriptor file that lists your playlist.', 'info');
  } else if (missing > 0) {
    setStatus(`${missing} of ${plan.tracks.length} tracks have no matching file.`, 'warn');
  } else {
    setStatus(`${plan.tracks.length} tracks ready to process.`, 'info');
  }
}

/** Warnings about files that are not used at all. */
function nestedFileWarnings(): string[] {
  if (nestedFiles.length === 0) return [];
  const names = nestedFiles.map((file) => file.relativePath).slice(0, 5).join(', ');
  return [
    `${nestedFiles.length} file(s) in sub folders are ignored: ${names}${
      nestedFiles.length > 5 ? ', …' : ''
    }`,
  ];
}

/** The download of the last run does not match the current input any more. */
function invalidateResult(): void {
  if (!lastResult) return;
  lastResult = null;
  lastZip = null;
  dom.downloadButton.disabled = true;
  document.body.classList.remove('has-results');
  dom.results.replaceChildren();
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'ready';
    case 'missing':
      return 'missing file';
    default:
      return status;
  }
}

/* -------------------------------------------------------------------------- */
/* input handling                                                              */
/* -------------------------------------------------------------------------- */

function setMusicFiles(files: PickedFile[]): void {
  // The python tool only looks at the files of the chosen folder, files in
  // sub folders are ignored (but the user is told about them).
  musicFiles = [];
  nestedFiles = [];
  for (const file of files) {
    if (file.relativePath.split('/').length > 2) {
      nestedFiles.push(file);
    } else {
      musicFiles.push(file);
    }
  }
  renderPlan();
}

dom.musicInput.addEventListener('change', () => {
  if (!dom.musicInput.files) return;
  setMusicFiles(pickedFilesFromFileList(dom.musicInput.files));
});

dom.descriptorInput.addEventListener('change', async () => {
  const file = dom.descriptorInput.files?.[0];
  if (!file) return;
  try {
    // `file.text()` would silently replace invalid bytes with U+FFFD. The
    // Python tool refuses such a file, so decoding has to be strict.
    const bytes = await file.arrayBuffer();
    dom.descriptorText.value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      setStatus('The descriptor file is not valid UTF-8.', 'error');
      setState('error');
      return;
    }
    throw error;
  }
  renderPlan();
});

dom.descriptorText.addEventListener('input', renderPlan);
dom.playlistName.addEventListener('input', invalidateResult);
dom.spotifyEnabled.addEventListener('change', invalidateResult);
dom.spotifyClientId.addEventListener('input', invalidateResult);
dom.spotifyClientSecret.addEventListener('input', invalidateResult);

let dragDepth = 0;
dom.dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  dom.dropZone.classList.add('is-dragging');
});
dom.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
dom.dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.dropZone.classList.remove('is-dragging');
});
dom.dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  dom.dropZone.classList.remove('is-dragging');
  if (!event.dataTransfer) return;
  const files = await pickedFilesFromDataTransfer(event.dataTransfer);
  setMusicFiles(files);
});

/* -------------------------------------------------------------------------- */
/* spotify credentials                                                         */
/* -------------------------------------------------------------------------- */

interface StoredCredentials {
  clientId: string;
  clientSecret: string;
}

function loadCredentials(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredCredentials;
    dom.spotifyClientId.value = parsed.clientId ?? '';
    dom.spotifyClientSecret.value = parsed.clientSecret ?? '';
    dom.spotifyRemember.checked = true;
    dom.spotifyEnabled.checked = true;
  } catch {
    /* ignore broken storage */
  }
}

function storeCredentials(): void {
  try {
    if (dom.spotifyRemember.checked) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          clientId: dom.spotifyClientId.value.trim(),
          clientSecret: dom.spotifyClientSecret.value.trim(),
        }),
      );
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* storage is not available, the credentials stay in memory only */
  }
}

dom.spotifyRemember.addEventListener('change', storeCredentials);

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

function buildSpotifyClient(): SpotifyClient | null {
  if (!dom.spotifyEnabled.checked) return null;
  return new SpotifyClient(dom.spotifyClientId.value, dom.spotifyClientSecret.value);
}

async function run(): Promise<void> {
  if (running) return;

  const { entries, issues } = currentEntries();
  setList(dom.issues, issues);
  document.body.classList.toggle('has-issues', issues.length > 0);

  // like the Python tool, a broken descriptor file must not be processed
  if (issues.length > 0) {
    setStatus('The descriptor file has problems. Fix them first.', 'error');
    setState('error');
    return;
  }
  if (entries.length === 0) {
    setStatus('Load the descriptor file first.', 'error');
    setState('error');
    return;
  }
  if (musicFiles.length === 0) {
    setStatus('Choose the folder with your mp3 files first.', 'error');
    setState('error');
    return;
  }

  const playlistName = dom.playlistName.value.trim() || `Playlist ${today()}`;
  const spotify = buildSpotifyClient();
  const musicFolderName = safeFileName(rootFolderName(musicFiles)) || 'music';

  if (spotify && !spotify.isConfigured) {
    setStatus('Please enter a Spotify client id and client secret, or disable cover art.', 'error');
    setState('error');
    return;
  }

  storeCredentials();

  running = true;
  abortController = new AbortController();
  setState('running');
  dom.runButton.disabled = true;
  dom.cancelButton.disabled = false;
  dom.downloadButton.disabled = true;
  dom.progress.value = 0;
  setStatus('Starting…', 'busy');

  try {
    const result = await processPlaylist({
      playlistName,
      entries,
      files: musicFiles,
      musicFolderName,
      spotify,
      signal: abortController.signal,
      onProgress: (done, total, message) => {
        dom.progress.max = total;
        dom.progress.value = done;
        setStatus(message, 'busy');
      },
    });

    // warnings of a single track have to say which track they belong to
    const trackWarnings = result.tracks.flatMap((track) =>
      track.warnings.map((warning) => `${track.entry.raw}: ${warning}`),
    );
    const warnings = [...result.warnings, ...trackWarnings, ...nestedFileWarnings()];
    setList(dom.warnings, warnings);
    document.body.classList.toggle('has-warnings', warnings.length > 0);

    // an empty result is a failed run, not a success with an empty download
    if (result.tracks.length === 0) {
      lastResult = null;
      lastZip = null;
      dom.downloadButton.disabled = true;
      document.body.classList.remove('has-results');
      dom.results.replaceChildren();
      setState('error');
      setStatus('No file could be processed — check the rename plan.', 'error');
      return;
    }

    lastResult = result;
    lastZip = result.archive;
    renderResult(result);
    document.body.classList.add('has-results');
    dom.downloadButton.disabled = false;
    setState('done');
    setStatus(
      `Done — ${result.tracks.length} tracks processed${
        spotify ? `, ${result.tracks.filter((track) => track.hasCover).length} covers found` : ''
      }.`,
      'success',
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      setStatus('Cancelled.', 'warn');
      setState('idle');
    } else {
      const message =
        error instanceof SpotifyError ? error.message : `Unexpected error: ${(error as Error).message}`;
      setStatus(message, 'error');
      setState('error');
    }
  } finally {
    running = false;
    abortController = null;
    dom.runButton.disabled = false;
    dom.cancelButton.disabled = true;
  }
}

function renderResult(result: ProcessingResult): void {
  dom.results.replaceChildren();

  const total = result.tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
  const withCover = result.tracks.filter((track) => track.hasCover).length;
  // the run level warnings already mention every entry that had no file
  const skipped = result.warnings.filter((warning) =>
    warning.includes('no matching file found'),
  ).length;

  const list = document.createElement('dl');
  list.className = 'result-list';
  const items: [string, string][] = [
    ['Tracks', String(result.tracks.length)],
    ['Skipped (no matching file)', String(skipped)],
    ['Total length', formatDuration(total)],
    ['Cover art', result.tracks.length > 0 ? `${withCover} of ${result.tracks.length}` : '—'],
    ['Playlist files', `${result.playlistName}.m3u and ${result.playlistName}.m3u8`],
  ];
  for (const [label, value] of items) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }
  dom.results.append(list);

  const hint = document.createElement('p');
  hint.className = 'result-hint';
  hint.textContent = 'The download contains the renamed and tagged mp3 files plus the two playlist files.';
  dom.results.append(hint);
}

dom.runButton.addEventListener('click', () => {
  void run();
});

dom.cancelButton.addEventListener('click', () => {
  abortController?.abort();
});

dom.downloadButton.addEventListener('click', () => {
  if (!lastZip || !lastResult) return;
  const name = `${safeFileName(lastResult.playlistName)}.zip`;
  downloadBlob(lastZip, name);
  setStatus(`Downloading ${name}…`, 'success');
});

/* -------------------------------------------------------------------------- */
/* init                                                                        */
/* -------------------------------------------------------------------------- */

function init(): void {
  dom.playlistName.value = `Playlist ${today()}`;
  dom.progress.max = 1;
  dom.progress.value = 0;
  dom.downloadButton.disabled = true;
  dom.cancelButton.disabled = true;
  loadCredentials();
  setState('idle');
  renderPlan();
}

init();
