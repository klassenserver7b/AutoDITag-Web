import { describe, expect, it } from 'vitest';
import { createZip } from '../src/core/zip';

describe('createZip', () => {
  it('creates a zip archive with the given entries', async () => {
    const zip = await createZip([
      { name: 'Playlist.m3u', data: new TextEncoder().encode('#EXTM3U\n') },
      { name: 'music/01_Song; A -- B.mp3', data: new Uint8Array([1, 2, 3]) },
    ]);

    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);

    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('Playlist.m3u');
    expect(text).toContain('music/01_Song; A -- B.mp3');
  });

  it('creates an empty archive for an empty list', async () => {
    const zip = await createZip([]);
    expect(zip.length).toBeGreaterThan(0);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
  });
});
