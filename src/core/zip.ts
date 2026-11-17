import { Zip, ZipPassThrough } from 'fflate';

/** A file that goes into the generated zip archive. */
export interface ZipEntry {
  /** Path inside the archive. */
  readonly name: string;
  readonly data: Uint8Array;
}

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

/**
 * Creates a zip archive in one go.
 *
 * MP3 files are already compressed, so the entries are stored without
 * compression - that is fast and keeps the memory footprint low.
 */
export function createZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error: Error | null, data: Uint8Array) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(data);
    });
    for (const entry of entries) {
      const pass = new ZipPassThrough(entry.name);
      zip.add(pass);
      pass.push(entry.data, true);
    }
    zip.end();
    resolve(concat(chunks));
  });
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
