import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readMp3Info } from '../src/core/mp3';

/**
 * Cross check of the MP3 parser against mutagen.
 *
 * The ground truth is produced with
 *   python3 -c "from mutagen.mp3 import MP3; print(MP3(path).info.length)"
 * and stored in the file below. The test is skipped when the file (or the
 * audio files it points to) is not available.
 */
const REFERENCE_FILE = '/tmp/opencode/xcheck/mutagen.json';

interface Reference {
  path: string;
  duration?: number;
  bitrateBps?: number;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  error?: string;
}

function loadReference(): Reference[] {
  try {
    return JSON.parse(readFileSync(REFERENCE_FILE, 'utf8')) as Reference[];
  } catch {
    return [];
  }
}

describe('mp3 parser vs mutagen', () => {
  const reference = loadReference();
  // the reference data is generated locally, the test is skipped without it
  const describeWithReference = reference.length > 0 ? describe : describe.skip;

  describeWithReference('matches mutagen', () => {
    it('has reference data', () => {
      expect(reference.length).toBeGreaterThan(0);
    });

    for (const entry of reference) {
      if (entry.error !== undefined) continue;
      it(`matches mutagen for ${entry.path.split('/').pop()}`, () => {
        const bytes = new Uint8Array(readFileSync(entry.path));
        const info = readMp3Info(bytes);
        expect(info).not.toBeNull();
        expect(info?.durationSeconds ?? -1).toBeCloseTo(entry.duration ?? -1, 1);
        // mutagen reports the average bitrate of variable bitrate files
        expect(Math.abs((info?.bitrateKbps ?? 0) * 1000 - (entry.bitrateBps ?? 0))).toBeLessThan(1000);
        expect(info?.sampleRate).toBe(entry.sampleRate);
        expect(info?.channels).toBe(entry.channels);
      });
    }
  });
});
