import type {
  CoverArt,
  DescriptorEntry,
  PickedFile,
  ProcessedTrack,
  ProcessingResult,
  TagPayload,
} from './types';
import { buildId3v2, readId3v2 } from './id3';
import { readMp3Info, stripTags } from './mp3';
import { buildM3U } from './playlist';
import { buildPlan } from './plan';
import { safeFileName } from './filename';
import type { SpotifyClient } from './spotify';
import { createZipStream } from './zip';

/** Runs `worker` over `items` with a bounded number of parallel tasks. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export interface ProcessOptions {
  readonly playlistName: string;
  readonly entries: readonly DescriptorEntry[];
  readonly files: readonly PickedFile[];
  /** Name of the folder inside the zip archive, also used as playlist path prefix. */
  readonly musicFolderName: string;
  /** When set, album art is fetched for every track. */
  readonly spotify: SpotifyClient | null;
  /** Progress callback. */
  readonly onProgress?: ((done: number, total: number, message: string) => void) | undefined;
  /** Allows the user to cancel a running job. */
  readonly signal?: AbortSignal | undefined;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was cancelled.', 'AbortError');
  }
}

/**
 * Runs the full AutoDITag pipeline in the browser:
 * rename, tag, fetch cover art and build the playlist files.
 *
 * The audio files are read twice: once to measure them and once to write the
 * tagged version into the archive. That keeps the memory usage low - only one
 * track and the archive itself are held in memory, not the whole folder.
 */
export async function processPlaylist(options: ProcessOptions): Promise<ProcessingResult> {
  const { playlistName, entries, files, musicFolderName, spotify, onProgress, signal } = options;
  // the same signal aborts the Spotify requests as well
  if (spotify) spotify.signal = signal;
  const plan = buildPlan(entries, files);
  const warnings = [...plan.warnings];
  const total = plan.tracks.length;
  // reading the files and fetching the cover art are two steps per track
  const steps = spotify && spotify.isConfigured ? total * 2 : total;

  const usable = plan.tracks.filter((track) => track.source !== null);
  let done = 0;

  // 1. measure the audio files (the bytes are released right away)
  const measured = await mapWithConcurrency(usable, 4, async (track) => {
    throwIfAborted(signal);
    const file = track.source!.file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = readMp3Info(bytes);
    done += 1;
    onProgress?.(done, steps, `Reading ${track.entry.raw}`);
    return { track, duration: info?.durationSeconds ?? 0 };
  });

  // 2. fetch the cover art (Spotify)
  const covers = new Map<string, CoverArt | null>();
  if (spotify && spotify.isConfigured) {
    // fail fast when the credentials are broken - every lookup would fail
    await spotify.getAccessToken();
    const fetched = await mapWithConcurrency(measured, 4, async (item) => {
      throwIfAborted(signal);
      const { title, artist } = item.track.entry;
      try {
        const cover = await spotify.findCover(title, artist);
        done += 1;
        onProgress?.(done, steps, `Fetching cover for ${title}`);
        return { key: item.track.entry.raw, cover, error: null as string | null };
      } catch (error) {
        // a cancelled job must stop instead of collecting "cover failed"
        if ((error as Error).name === 'AbortError') throw error;
        done += 1;
        onProgress?.(done, steps, `Cover failed for ${title}`);
        return {
          key: item.track.entry.raw,
          cover: null,
          error: (error as Error).message,
        };
      }
    });
    for (const item of fetched) {
      covers.set(item.key, item.cover);
      if (item.error) {
        warnings.push(`Cover art for '${item.key}' could not be fetched: ${item.error}`);
      }
    }
  }

  // 3. build the playlist files
  const folder = safeFileName(musicFolderName) || 'music';
  const playlistEntries = measured.map((item) => ({
    durationSeconds: item.duration,
    artist: item.track.entry.artist,
    title: item.track.entry.title,
    path: `${folder}/${item.track.targetName}`,
  }));

  const m3u = buildM3U(playlistEntries);
  const m3u8 = m3u;

  // 4. write the tags and build the archive
  const encoder = new TextEncoder();
  const archive = createZipStream();
  // The album tag keeps the raw name (like the Python tool), but the archive
  // entries must not be able to escape the archive root.
  const archiveName = safeFileName(playlistName) || 'playlist';
  archive.add(`${archiveName}.m3u`, encoder.encode(m3u));
  archive.add(`${archiveName}.m3u8`, encoder.encode(m3u8));

  const tracks: ProcessedTrack[] = [];
  for (const item of measured) {
    throwIfAborted(signal);
    const entry = item.track.entry;
    const trackWarnings = [...item.track.warnings];
    const cover = covers.get(entry.raw) ?? null;

    if (item.duration <= 0) {
      trackWarnings.push('The duration of the file could not be determined.');
    }

    const payload: TagPayload = {
      title: entry.title,
      artist: entry.artist,
      albumArtist: playlistName,
      album: playlistName,
      genre: entry.dance,
      trackNumber: entry.trackNumber,
      comment: entry.dance,
      picture: cover ?? undefined,
    };

    const bytes = new Uint8Array(await item.track.source!.file.arrayBuffer());
    const stripped = stripTags(bytes);

    if (!stripped.tagReadable) {
      // the file carries a tag that cannot be located - the python tool skips
      // such a file as well, writing a broken result would be worse
      warnings.push(
        `Track ${String(entry.lineNumber).padStart(2, '0')} (${entry.raw}) was skipped: the ID3 tag of '${item.track.source!.name}' is broken.`,
      );
      continue;
    }

    // keep the frames the file already had (like the python tool does)
    const existing = readId3v2(bytes);
    const tag = buildId3v2(payload, { existing });
    const data = concat([tag, stripped.audio]);

    archive.add(`${folder}/${item.track.targetName}`, data);

    tracks.push({
      entry,
      source: item.track.source,
      targetName: item.track.targetName,
      durationSeconds: item.duration,
      hasCover: cover !== null,
      warnings: trackWarnings,
    });
  }

  const blob = await archive.finish();

  // tracks without a source file
  let skipped = 0;
  for (const track of plan.tracks) {
    if (track.source === null) {
      skipped += 1;
      warnings.push(
        `Track ${String(track.entry.lineNumber).padStart(2, '0')} (${track.entry.raw}) was skipped: no matching file found.`,
      );
    }
  }

  onProgress?.(steps, steps, 'Done');

  return { playlistName, tracks, skipped, m3u, m3u8, warnings, archive: blob };
}
