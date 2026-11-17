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
 */
export async function processPlaylist(options: ProcessOptions): Promise<ProcessingResult> {
  const { playlistName, entries, files, musicFolderName, spotify, onProgress, signal } = options;
  const plan = buildPlan(entries, files);
  const warnings = [...plan.warnings];
  const total = plan.tracks.length;
  // reading the files and fetching the cover art are two steps per track
  const steps = spotify && spotify.isConfigured ? total * 2 : total;

  const usable = plan.tracks.filter((track) => track.source !== null);
  let done = 0;

  // 1. read the audio files
  const sources = await mapWithConcurrency(usable, 4, async (track) => {
    throwIfAborted(signal);
    const file = track.source!.file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = readMp3Info(bytes);
    done += 1;
    onProgress?.(done, steps, `Reading ${track.entry.raw}`);
    return { track, bytes, duration: info?.durationSeconds ?? 0 };
  });

  // 2. fetch the cover art (Spotify)
  const covers = new Map<string, CoverArt | null>();
  if (spotify && spotify.isConfigured) {
    // fail fast when the credentials are broken - every lookup would fail
    await spotify.getAccessToken();
    const fetched = await mapWithConcurrency(sources, 4, async (item) => {
      throwIfAborted(signal);
      const { title, artist } = item.track.entry;
      try {
        const cover = await spotify.findCover(title, artist);
        done += 1;
        onProgress?.(done, steps, `Fetching cover for ${title}`);
        return { key: item.track.entry.raw, cover, error: null as string | null };
      } catch (error) {
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

  // 3. write the tags
  const tracks: ProcessedTrack[] = [];
  for (const item of sources) {
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

    const stripped = stripTags(item.bytes);
    // keep the frames the file already had (like the python tool does)
    const existing = readId3v2(item.bytes);
    const tag = buildId3v2(payload, { existing });
    const data = concat([tag, stripped.audio]);

    tracks.push({
      entry,
      source: item.track.source,
      targetName: item.track.targetName,
      data,
      durationSeconds: item.duration,
      hasCover: cover !== null,
      warnings: trackWarnings,
    });
  }

  // tracks without a source file
  for (const track of plan.tracks) {
    if (track.source === null) {
      warnings.push(
        `Track ${String(track.entry.lineNumber).padStart(2, '0')} (${track.entry.raw}) was skipped: no matching file found.`,
      );
    }
  }

  // 4. build the playlist files
  const folder = safeFileName(musicFolderName) || 'music';
  const playlistEntries = tracks.map((track) => ({
    durationSeconds: track.durationSeconds,
    artist: track.entry.artist,
    title: track.entry.title,
    path: `${folder}/${track.targetName}`,
  }));

  const m3u = buildM3U(playlistEntries);
  const m3u8 = m3u;

  onProgress?.(steps, steps, 'Done');

  return { playlistName, tracks, m3u, m3u8, warnings };
}
