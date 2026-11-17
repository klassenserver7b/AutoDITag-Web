import { zip } from 'fflate';

/** A file that goes into the generated zip archive. */
export interface ZipEntry {
  /** Path inside the archive. */
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * Creates a zip archive.
 *
 * MP3 files are already compressed, so the entries are stored without
 * compression - that is fast and keeps the memory footprint low.
 */
export function createZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.name] = entry.data;
  }

  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data);
    });
  });
}

/** Triggers a browser download for the given blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
