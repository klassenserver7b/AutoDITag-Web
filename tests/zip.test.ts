import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { createZipStream } from '../src/core/zip';

describe('createZipStream', () => {
  it('creates an archive with the given entries', async () => {
    const archive = createZipStream();
    archive.add('Playlist.m3u', new TextEncoder().encode('#EXTM3U\n'));
    archive.add('music/01_Song; A -- B.mp3', new Uint8Array([1, 2, 3]));
    const blob = await archive.finish();

    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      'Playlist.m3u',
      'music/01_Song; A -- B.mp3',
    ]);
    expect(new TextDecoder().decode(entries['Playlist.m3u'] as Uint8Array)).toBe('#EXTM3U\n');
    expect([...(entries['music/01_Song; A -- B.mp3'] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('creates an empty archive without any file', async () => {
    const blob = await createZipStream().finish();
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries)).toHaveLength(0);
  });

  it('stores the entries without compressing them', async () => {
    const data = new Uint8Array(1024).fill(7);
    const archive = createZipStream();
    archive.add('raw.bin', data);
    const blob = await archive.finish();

    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect([...(entries['raw.bin'] as Uint8Array)]).toEqual([...data]);
  });
});
