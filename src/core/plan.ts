import type {
  DescriptorEntry,
  PickedFile,
  ProcessingPlan,
  TrackPlan,
  TrackStatus,
} from './types';
import { isMp3, matchesTrackPrefix, safeFileName, targetFileName } from './filename';

/**
 * Matches the descriptor entries against the selected files.
 *
 * The Python tool renames the first file whose name starts with the zero
 * padded track number (`01_` or `01-`). Zero padded and unpadded variants are
 * both accepted here, so playlists with less than ten tracks work as well.
 */
export function buildPlan(
  entries: readonly DescriptorEntry[],
  files: readonly PickedFile[],
): ProcessingPlan {
  const tracks: TrackPlan[] = [];
  const warnings: string[] = [];
  const used = new Set<PickedFile>();
  const takenTargets = new Map<string, DescriptorEntry>();

  const candidates = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );

  for (const entry of entries) {
    const targetName = safeFileName(targetFileName(entry.raw));
    const trackWarnings: string[] = [];
    let status: TrackStatus = 'ok';
    let source: PickedFile | undefined;

    const matches = candidates.filter(
      (file) => !used.has(file) && matchesTrackPrefix(file.name, entry.lineNumber),
    );
    const mp3Matches = matches.filter((file) => isMp3(file.name));

    if (mp3Matches.length > 0) {
      // Prefer a file that already carries the target name (re-run safety).
      const preferred = mp3Matches.find((file) => file.name === targetName) ?? mp3Matches.at(0);
      if (preferred) {
        source = preferred;
        used.add(preferred);
        if (mp3Matches.length > 1) {
          trackWarnings.push(
            `Multiple files found for track ${String(entry.lineNumber).padStart(2, '0')}: ${mp3Matches
              .map((file) => file.name)
              .join(', ')}. Using: ${preferred.name}`,
          );
        }
      }
    } else if (matches.length > 0) {
      // the name matches, but the file is not an mp3 file
      status = 'invalid-source';
      used.add(matches[0] as PickedFile);
      trackWarnings.push(
        `Track ${String(entry.lineNumber).padStart(2, '0')}: '${(matches[0] as PickedFile).name}' is not an mp3 file and was skipped.`,
      );
    } else {
      status = 'missing';
      trackWarnings.push(
        `Track ${String(entry.lineNumber).padStart(2, '0')}: No file found matching pattern '${String(
          entry.lineNumber,
        ).padStart(2, '0')}_*' or '${String(entry.lineNumber).padStart(2, '0')}-*'`,
      );
    }

    const previous = takenTargets.get(targetName);
    if (previous) {
      status = 'duplicate';
      trackWarnings.push(
        `Target file already exists, skipping: ${targetName} (already used by line ${previous.lineNumber})`,
      );
    } else {
      takenTargets.set(targetName, entry);
    }

    tracks.push({
      entry,
      source: source ?? null,
      targetName,
      needsRename: source !== undefined && source.name !== targetName,
      status,
      warnings: trackWarnings,
    });
  }

  const unmatched = candidates.filter(
    (file) => !used.has(file) && isMp3(file.name),
  );
  for (const file of unmatched) {
    warnings.push(`No descriptor entry matches '${file.name}', the file is ignored.`);
  }

  return { tracks, unmatched, warnings };
}
