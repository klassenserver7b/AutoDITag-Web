import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMp3Info } from '../src/core/mp3';

/**
 * Cross check of the MP3 parser against mutagen.
 *
 * The fixtures and the reference values live in the repository, so this test
 * really runs in CI (it must not be skipped when the data is missing). The
 * reference was produced with
 *   python3 -c "from mutagen.mp3 import MP3; ..."
 * for each fixture.
 */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const REFERENCE_FILE = path.join(FIXTURE_DIR, 'mutagen-reference.json');

interface FixtureReference {
  file: string;
  duration: number;
  bitrateBps: number;
  sampleRate: number;
  channels: number;
}

/** Why: a missing reference must fail the suite, not silently skip it. */
function readReference(): FixtureReference[] {
  return JSON.parse(readFileSync(REFERENCE_FILE, 'utf8')) as FixtureReference[];
}

describe('mp3 parser vs mutagen (repository fixtures)', () => {
  const reference = readReference();

  it('has reference data', () => {
    expect(reference.length).toBeGreaterThan(0);
  });

  for (const entry of reference) {
    it(`matches mutagen for ${entry.file}`, () => {
      const bytes = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, entry.file)));
      const info = readMp3Info(bytes);
      expect(info).not.toBeNull();
      expect(info?.durationSeconds ?? -1).toBeCloseTo(entry.duration, 1);
      // mutagen reports the average bitrate, our parser the frame bitrate
      expect(Math.abs((info?.bitrateKbps ?? 0) * 1000 - entry.bitrateBps)).toBeLessThan(1000);
      expect(info?.sampleRate).toBe(entry.sampleRate);
      expect(info?.channels).toBe(entry.channels);
    });
  }
});

/**
 * Additional, optional check against a locally generated reference of the
 * real files in `/home/felix/Videos/Sounds`. It is not part of CI.
 */
const OPTIONAL_REFERENCE_FILE = '/tmp/opencode/xcheck/mutagen.json';

interface OptionalReference {
  path: string;
  duration?: number;
  bitrateBps?: number;
  sampleRate?: number;
  channels?: number;
  error?: string;
}

function loadOptionalReference(): OptionalReference[] {
  try {
    return JSON.parse(readFileSync(OPTIONAL_REFERENCE_FILE, 'utf8')) as OptionalReference[];
  } catch {
    return [];
  }
}

const optionalReference = loadOptionalReference();
if (optionalReference.length > 0) {
  describe('mp3 parser vs mutagen (real files, optional)', () => {
    for (const entry of optionalReference) {
      if (entry.error !== undefined) continue;
      it(`matches mutagen for ${entry.path.split('/').pop()}`, () => {
        const bytes = new Uint8Array(readFileSync(entry.path));
        const info = readMp3Info(bytes);
        expect(info).not.toBeNull();
        expect(info?.durationSeconds ?? -1).toBeCloseTo(entry.duration ?? -1, 1);
        expect(Math.abs((info?.bitrateKbps ?? 0) * 1000 - (entry.bitrateBps ?? 0))).toBeLessThan(
          1000,
        );
        expect(info?.sampleRate).toBe(entry.sampleRate);
        expect(info?.channels).toBe(entry.channels);
      });
    }
  });
}
