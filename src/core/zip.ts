import { Zip, ZipPassThrough } from 'fflate';

/**
 * A zip archive that is written file by file.
 *
 * MP3 files are already compressed, so the entries are stored without
 * compression - that is fast and keeps the memory footprint low. Because the
 * entries are pushed into the archive one after the other, a folder with many
 * large mp3 files does not have to be held in memory completely.
 */
export interface ZipStream {
  /** Adds a file to the archive. */
  add(name: string, data: Uint8Array): void;
  /** Finishes the archive and returns it as a blob. */
  finish(): Promise<Blob>;
}

/** Creates a streaming zip archive. */
export function createZipStream(): ZipStream {
  const chunks: Uint8Array[] = [];

  const zip = new Zip((error: Error | null, data: Uint8Array, final: boolean) => {
    if (error) throw error;
    chunks.push(data);
    if (final) {
      /* the central directory has been written, the archive is complete */
    }
  });

  return {
    add(name: string, data: Uint8Array): void {
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data, true);
    },
    async finish(): Promise<Blob> {
      zip.end();
      // The blob takes the chunks without copying them into one big buffer.
      return new Blob(chunks as BlobPart[], { type: 'application/zip' });
    },
  };
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
