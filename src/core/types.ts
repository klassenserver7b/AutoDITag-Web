/**
 * Shared data types for the AutoDITag web app.
 *
 * Everything in `src/core` is pure and DOM free so it can be unit tested
 * with plain Node (see `tests/`).
 */

/** One successfully parsed line of the descriptor file. */
export interface DescriptorEntry {
  /** 1-based position of the line inside the descriptor file (blank lines ignored). */
  readonly lineNumber: number;
  /** The trimmed descriptor line, e.g. `01_Voices of Spring; André Rieu -- Wiener Walzer`. */
  readonly raw: string;
  /** Track number exactly as written in the file, e.g. `01`. */
  readonly trackNumber: string;
  /** Song title (everything between `_` and `;`). */
  readonly title: string;
  /** Artist (everything between `;` and `--`). */
  readonly artist: string;
  /** Dance style (everything after `--`). Stored in the genre and comment frames. */
  readonly dance: string;
}

/** A single problem found in the descriptor file. */
export interface DescriptorIssue {
  /** 1-based line number the problem belongs to (0 for file level problems). */
  readonly lineNumber: number;
  /** Human readable, ready to display description. */
  readonly message: string;
  /** The offending line (empty for file level problems). */
  readonly line: string;
}

/** Result of parsing a descriptor file. */
export interface DescriptorParseResult {
  readonly entries: readonly DescriptorEntry[];
  readonly issues: readonly DescriptorIssue[];
  /** `true` when the file can be used (no issues and at least one entry). */
  readonly ok: boolean;
}

/** A file the user selected (single file or part of a picked folder). */
export interface PickedFile {
  /** File name including extension, e.g. `01-Song.mp3`. */
  readonly name: string;
  /** Path relative to the picked root, e.g. `Tanzmusik/01-Song.mp3`. */
  readonly relativePath: string;
  /** The underlying browser file handle. */
  readonly file: File;
}

/** Result of matching one descriptor entry against the selected files. */
export type TrackStatus = 'ok' | 'missing' | 'duplicate' | 'invalid-source';

export interface TrackPlan {
  readonly entry: DescriptorEntry;
  /** The file that will be used for this track, `null` when nothing matched. */
  readonly source: PickedFile | null;
  /** File name after renaming, e.g. `01_Voices of Spring; André Rieu -- Wiener Walzer.mp3`. */
  readonly targetName: string;
  /** `true` when the source file has to be renamed. */
  readonly needsRename: boolean;
  readonly status: TrackStatus;
  /** Non fatal problems, e.g. "multiple files matched". */
  readonly warnings: readonly string[];
}

/** Result of building the rename/tag plan. */
export interface ProcessingPlan {
  readonly tracks: readonly TrackPlan[];
  /** Files that did not match any descriptor entry. */
  readonly unmatched: readonly PickedFile[];
  /** Plan level problems. */
  readonly warnings: readonly string[];
}

/** Embedded cover art. */
export interface CoverArt {
  /** MIME type, e.g. `image/jpeg`. */
  readonly mime: string;
  /** Raw image bytes. */
  readonly data: Uint8Array;
}

/** Everything that is written into the ID3 tag of a track. */
export interface TagPayload {
  readonly title: string;
  readonly artist: string;
  /** Written to `TPE2` (album artist) - the playlist name in the original tool. */
  readonly albumArtist: string;
  /** Written to `TALB` - the playlist name in the original tool. */
  readonly album: string;
  /** Written to `TCON` - the dance style. */
  readonly genre: string;
  /** Written to `TRCK` and `TRK`, e.g. `01`. */
  readonly trackNumber: string;
  /** Written to `COMM`, e.g. the dance style. */
  readonly comment: string;
  /** Optional cover art written to `APIC`. */
  readonly picture?: CoverArt | undefined;
}

/** A single line of a generated M3U playlist. */
export interface PlaylistEntry {
  /** Duration in seconds (rounded down, like the original Python tool). */
  readonly durationSeconds: number;
  readonly artist: string;
  readonly title: string;
  /** Path of the audio file relative to the playlist file. */
  readonly path: string;
}

/** Result of a single processed track. */
export interface ProcessedTrack {
  readonly entry: DescriptorEntry;
  readonly source: PickedFile | null;
  readonly targetName: string;
  /** Duration in seconds. */
  readonly durationSeconds: number;
  /** `true` when Spotify returned cover art for this track. */
  readonly hasCover: boolean;
  /** Non fatal problems for this track. */
  readonly warnings: readonly string[];
}

/** Everything the app produces for one run. */
export interface ProcessingResult {
  readonly playlistName: string;
  readonly tracks: readonly ProcessedTrack[];
  /** M3U playlist content. */
  readonly m3u: string;
  /** M3U8 playlist content (identical copy, like the original tool). */
  readonly m3u8: string;
  /** Run level warnings. */
  readonly warnings: readonly string[];
  /** The download archive with the tagged mp3 files and the playlist files. */
  readonly archive: Blob;
}
