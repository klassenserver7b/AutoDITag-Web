import { describe, expect, it } from 'vitest';
import { quotePath, buildM3U } from '../src/core/playlist';

describe('quotePath', () => {
  it('behaves like python urllib.parse.quote', () => {
    // Reference values produced with python:
    //   urllib.parse.quote('music/01_Title; Artist -- Style.mp3')
    expect(quotePath('music/01_Title; Artist -- Style.mp3')).toBe(
      'music/01_Title%3B%20Artist%20--%20Style.mp3',
    );
    expect(quotePath('a b')).toBe('a%20b');
    expect(quotePath('safe-._~')).toBe('safe-._~');
    expect(quotePath('!*()')).toBe('%21%2A%28%29');
    expect(quotePath('tänze.txt')).toBe('t%C3%A4nze.txt');
  });
});

describe('buildM3U', () => {
  it('writes the header, the extinf lines and the encoded paths', () => {
    const m3u = buildM3U([
      { durationSeconds: 123.9, artist: 'Artist', title: 'Title', path: 'music/01_Title; A -- B.mp3' },
    ]);
    expect(m3u).toBe(
      '#EXTM3U\n#EXTINF:123,Artist - Title\nmusic/01_Title%3B%20A%20--%20B.mp3\n',
    );
  });

  it('rounds the duration down like the python tool', () => {
    const m3u = buildM3U([
      { durationSeconds: 59.99, artist: 'A', title: 'B', path: 'x.mp3' },
    ]);
    expect(m3u).toContain('#EXTINF:59,A - B');
  });

  it('writes an empty playlist with just the header', () => {
    expect(buildM3U([])).toBe('#EXTM3U\n');
  });
});
