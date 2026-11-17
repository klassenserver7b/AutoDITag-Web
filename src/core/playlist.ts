import type { PlaylistEntry } from './types';

/**
 * M3U playlist generation.
 *
 * The Python tool writes `#EXTM3U`, one `#EXTINF:<seconds>,<artist> - <title>`
 * line and a percent encoded file path per track, and copies the result to a
 * `.m3u8` file.
 */

const UNRESERVED = /[A-Za-z0-9_.\-~/]/;

/**
 * Percent encodes a path the same way Python's `urllib.parse.quote` does:
 * only `A-Z a-z 0-9 _ . - ~` and `/` stay as they are.
 */
export function quotePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && UNRESERVED.test(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Builds the content of an M3U playlist. */
export function buildM3U(entries: readonly PlaylistEntry[]): string {
  const lines: string[] = ['#EXTM3U\n'];
  for (const entry of entries) {
    lines.push(`#EXTINF:${Math.floor(entry.durationSeconds)},${entry.artist} - ${entry.title}\n`);
    lines.push(`${quotePath(entry.path)}\n`);
  }
  return lines.join('');
}
