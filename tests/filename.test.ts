import { describe, expect, it } from 'vitest';
import {
  isMp3,
  matchesTrackPrefix,
  safeFileName,
  targetFileName,
  trackNumberPrefixes,
} from '../src/core/filename';

describe('isMp3', () => {
  it('accepts mp3 files', () => {
    expect(isMp3('song.mp3')).toBe(true);
    expect(isMp3('SONG.MP3')).toBe(true);
    expect(isMp3('song.flac')).toBe(false);
  });
});

describe('matchesTrackPrefix', () => {
  it('matches zero padded numbers with both separators', () => {
    expect(matchesTrackPrefix('01-Song.mp3', 1)).toBe(true);
    expect(matchesTrackPrefix('01_Song.mp3', 1)).toBe(true);
  });

  it('matches unpadded numbers (fixes playlists with less than ten tracks)', () => {
    expect(matchesTrackPrefix('1-Song.mp3', 1)).toBe(true);
    expect(matchesTrackPrefix('1_Song.mp3', 1)).toBe(true);
  });

  it('does not match a different track', () => {
    expect(matchesTrackPrefix('02-Song.mp3', 1)).toBe(false);
    expect(matchesTrackPrefix('10-Song.mp3', 1)).toBe(false);
  });

  it('lists the accepted prefixes', () => {
    expect(trackNumberPrefixes(1)).toEqual(['1', '01', '001']);
    expect(trackNumberPrefixes(12)).toEqual(['12', '012']);
  });
});

describe('targetFileName', () => {
  it('appends the mp3 extension to the descriptor line', () => {
    expect(targetFileName('01_Waltz; Artist -- Dance')).toBe('01_Waltz; Artist -- Dance.mp3');
  });
});

describe('safeFileName', () => {
  it('keeps ordinary names untouched', () => {
    expect(safeFileName('01_Voices of Spring; André Rieu -- Wiener Walzer.mp3')).toBe(
      '01_Voices of Spring; André Rieu -- Wiener Walzer.mp3',
    );
  });

  it('replaces path separators so the zip archive stays flat', () => {
    expect(safeFileName('01_AC/DC; A -- B.mp3')).toBe('01_AC_DC; A -- B.mp3');
    expect(safeFileName('01_A\\B; A -- B.mp3')).toBe('01_A_B; A -- B.mp3');
  });

  it('removes control characters', () => {
    expect(safeFileName('01_Song\u0007; A -- B.mp3')).toBe('01_Song; A -- B.mp3');
  });

  it('does not allow a path traversal', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
  });
});
