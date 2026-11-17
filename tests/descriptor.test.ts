import { describe, expect, it } from 'vitest';
import { parseDescriptor, expectedTrackNumberDigits } from '../src/core/descriptor';

describe('parseDescriptor', () => {
  it('parses a valid descriptor file', () => {
    const result = parseDescriptor('01_Waltz; Artist -- Dance\n02_Tango; Artist -- Dance\n');
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      lineNumber: 1,
      raw: '01_Waltz; Artist -- Dance',
      trackNumber: '01',
      title: 'Waltz',
      artist: 'Artist',
      dance: 'Dance',
    });
    expect(result.entries[1]?.title).toBe('Tango');
  });

  it('allows commas inside the title', () => {
    const result = parseDescriptor('01_Song; Artist -- Dance\n02_Bad,Format; Artist -- Dance\n');
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.title).toBe('Bad,Format');
  });

  it('reports a comma instead of a semicolon', () => {
    const result = parseDescriptor('01_Song, Artist -- Dance\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Line 1');
    expect(result.issues[0]?.message).toContain('Found comma (,) but expected semicolon (;)');
  });

  it('reports a missing semicolon', () => {
    const result = parseDescriptor('01_Song Artist -- Dance\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Missing semicolon (;)');
  });

  it('reports a single dash', () => {
    const result = parseDescriptor('01_Song; Artist - Dance\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Found single dash (-) but expected double dash (--)');
  });

  it('reports a missing double dash separator', () => {
    const result = parseDescriptor('01_Song; Artist Dance\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Missing double dash (--) separator');
  });

  it('reports a track number mismatch', () => {
    const result = parseDescriptor('03_Song; Artist -- Dance\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Track number mismatch');
    expect(result.issues[0]?.message).toContain("Expected '1'");
    expect(result.issues[0]?.message).toContain("but found '3'");
  });

  it('keeps the zero padded expectation of the python tool for bigger files', () => {
    const lines = Array.from({ length: 12 }, (_, index) =>
      `${String(index + 1).padStart(2, '0')}_Song${index + 1}; Artist -- Dance`,
    );
    const result = parseDescriptor(`${lines.join('\n')}\n`);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(12);
  });

  it('counts the lines like python readlines (no extra line for a final newline)', () => {
    // a 9 line file has one digit track numbers, even with a trailing newline
    const lines = Array.from({ length: 9 }, (_, index) =>
      index === 4
        ? '7_Wrong; Artist -- Dance'
        : `${index + 1}_Song${index + 1}; Artist -- Dance`,
    );
    const result = parseDescriptor(`${lines.join('\n')}\n`);
    expect(result.issues[0]?.message).toContain("Expected '5'");
    expect(result.issues[0]?.message).not.toContain("Expected '05'");
  });

  it('rejects an empty descriptor file', () => {
    const result = parseDescriptor('\n  \n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('Descriptor file is empty');
  });

  it('ignores a byte order mark and windows line endings', () => {
    const result = parseDescriptor('\uFEFF01_Song; Artist -- Dance\r\n02_Other; Artist -- Style\r\n');
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.title).toBe('Song');
  });

  it('collects every problem instead of stopping at the first one', () => {
    const result = parseDescriptor('01_Song, Artist -- Dance\n02_Song; Artist - Dance\n');
    expect(result.issues).toHaveLength(2);
  });

  it('accepts artists and dance names with special characters', () => {
    const result = parseDescriptor('01_Friday I\'m In Love; The Cure -- Cha Cha Cha\n');
    expect(result.ok).toBe(true);
    expect(result.entries[0]?.artist).toBe('The Cure');
    expect(result.entries[0]?.dance).toBe('Cha Cha Cha');
  });
});

describe('expectedTrackNumberDigits', () => {
  it('matches the python implementation', () => {
    expect(expectedTrackNumberDigits(1)).toBe(1);
    expect(expectedTrackNumberDigits(9)).toBe(1);
    expect(expectedTrackNumberDigits(10)).toBe(2);
    expect(expectedTrackNumberDigits(51)).toBe(2);
    expect(expectedTrackNumberDigits(99)).toBe(2);
    expect(expectedTrackNumberDigits(100)).toBe(3);
  });
});
