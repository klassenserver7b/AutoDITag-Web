/**
 * Helpers around the file naming convention used by AutoDITag.
 *
 * The original Python tool renames `01-Song.mp3` to
 * `01_Title; Artist -- Style.mp3` and afterwards parses that name again to
 * extract the tag values.
 */

/** `true` when the file name looks like an mp3 file. */
export function isMp3(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.mp3');
}

/**
 * The prefixes a source file may use for the given track index.
 *
 * The Python tool always looks for a two digit prefix (`01`), which breaks for
 * playlists with less than ten tracks. Zero padded and unpadded variants are
 * accepted here so `1_x.mp3`, `01_x.mp3` and `001_x.mp3` all match.
 */
export function trackNumberPrefixes(index: number): string[] {
  const plain = String(index);
  const prefixes = new Set<string>([plain, plain.padStart(2, '0'), plain.padStart(3, '0')]);
  return [...prefixes];
}

/**
 * `true` when the file name starts with the track number of `index`
 * followed by `_` or `-` (the separators the Python tool accepts).
 */
export function matchesTrackPrefix(fileName: string, index: number): boolean {
  return trackNumberPrefixes(index).some(
    (prefix) => fileName.startsWith(`${prefix}_`) || fileName.startsWith(`${prefix}-`),
  );
}

/** The file name a track gets after renaming. */
export function targetFileName(descriptorLine: string): string {
  return `${descriptorLine}.mp3`;
}

/**
 * Makes a file name safe for the file system and for the zip archive.
 *
 * A descriptor line may contain characters that are not allowed in a file name
 * (`/` for example). The python tool failed on such a line, here the character
 * is replaced instead.
 */
export function safeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}
