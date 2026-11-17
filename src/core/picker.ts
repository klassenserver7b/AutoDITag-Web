/**
 * Browser side file selection.
 *
 * Firefox does not implement the File System Access API, so the app uses the
 * classic `<input type="file" webkitdirectory>` element and drag & drop with
 * `webkitGetAsEntry()` - both work in Firefox and in Chromium based browsers.
 */

import type { PickedFile } from './types';

export type { PickedFile };

/** Minimal typings for the non standard directory entry API. */
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}

interface FsFileEntry extends FsEntry {
  isFile: true;
  file(callback: (file: File) => void, errorCallback?: (error: unknown) => void): void;
}

interface FsDirectoryReader {
  readEntries(
    onSuccess: (entries: FsEntry[]) => void,
    onError?: (error: unknown) => void,
  ): void;
}

interface FsDirectoryEntry extends FsEntry {
  isDirectory: true;
  createReader(): FsDirectoryReader;
}

function isFsFileEntry(entry: FsEntry): entry is FsFileEntry {
  return entry.isFile && typeof (entry as FsFileEntry).file === 'function';
}

function isFsDirectoryEntry(entry: FsEntry): entry is FsDirectoryEntry {
  return entry.isDirectory && typeof (entry as FsDirectoryEntry).createReader === 'function';
}

/** Reads all entries of a directory (the API returns them in chunks). */
function readAllEntries(reader: FsDirectoryReader): Promise<FsEntry[]> {
  return new Promise((resolve) => {
    const entries: FsEntry[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      });
    };
    readBatch();
  });
}

function entryToFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/** Collects the files of a directory entry recursively. */
async function collectDirectory(
  directory: FsDirectoryEntry,
  prefix: string,
  collected: PickedFile[],
): Promise<void> {
  const entries = await readAllEntries(directory.createReader());
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isFsDirectoryEntry(entry)) {
      await collectDirectory(entry, relativePath, collected);
    } else if (isFsFileEntry(entry)) {
      const file = await entryToFile(entry);
      collected.push({ name: file.name, relativePath, file });
    }
  }
}

/** Converts the file list of an `<input type="file">` into picked files. */
export function pickedFilesFromFileList(fileList: FileList | readonly File[]): PickedFile[] {
  const files = Array.from(fileList);
  return files.map((file) => {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { name: file.name, relativePath, file };
  });
}

/** Collects the files of a drag & drop operation. */
export async function pickedFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const collected: PickedFile[] = [];
  const items = Array.from(dataTransfer.items ?? []);

  for (const item of items) {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FsEntry | null;
    }).webkitGetAsEntry?.();
    if (!entry) continue;

    if (isFsDirectoryEntry(entry)) {
      await collectDirectory(entry, entry.name, collected);
    } else if (isFsFileEntry(entry)) {
      const file = await entryToFile(entry);
      collected.push({ name: file.name, relativePath: file.name, file });
    }
  }

  if (collected.length === 0) {
    // Fallback for browsers that do not expose the entry API.
    return pickedFilesFromFileList(dataTransfer.files ?? []);
  }

  return collected;
}

/**
 * The name of the folder that holds the selected music files.
 *
 * It is used as the folder inside the generated zip archive and as the path
 * prefix of the playlist entries.
 */
export function rootFolderName(files: readonly PickedFile[]): string {
  for (const file of files) {
    const separator = file.relativePath.indexOf('/');
    if (separator > 0) return file.relativePath.slice(0, separator);
  }
  return 'music';
}
