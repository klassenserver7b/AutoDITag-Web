import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { parseDescriptor } from '../src/core/descriptor';
import { processPlaylist } from '../src/core/process';
import { readId3v2 } from '../src/core/id3';
import type { PickedFile } from '../src/core/types';
import { makeMp3 } from './helpers/mp3';

function picked(name: string, bytes: Uint8Array): PickedFile {
  return {
    name,
    relativePath: `Tanzmusik/${name}`,
    file: new File([bytes as BlobPart], name, { type: 'audio/mpeg' }),
  };
}

async function archiveEntries(blob: Blob): Promise<Record<string, Uint8Array>> {
  const buffer = await blob.arrayBuffer();
  return unzipSync(new Uint8Array(buffer));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** An ID3v2 header that promises a tag of the given (syncsafe) size. */
function id3v24Header(size: number[]): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...size]);
}

describe('processPlaylist', () => {
  it('renames, tags and playlists the tracks', async () => {
    const { entries } = parseDescriptor(
      '01_Waltz; Artist -- Dance\n02_Tango; Artist2 -- Dance2\n',
    );
    const files = [
      picked('01-Song.mp3', makeMp3({ frames: 100 })),
      picked('02-Song.mp3', makeMp3({ frames: 200 })),
    ];

    const result = await processPlaylist({
      playlistName: 'Schulball',
      entries,
      files,
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]?.targetName).toBe('01_Waltz; Artist -- Dance.mp3');
    expect(result.tracks[0]?.durationSeconds).toBeCloseTo(
      (8 * makeMp3({ frames: 100 }).length) / 128000,
      6,
    );

    expect(result.m3u).toContain('#EXTM3U');
    expect(result.m3u).toContain('#EXTINF:2,Artist - Waltz');
    expect(result.m3u).toContain('Tanzmusik/01_Waltz%3B%20Artist%20--%20Dance.mp3');
    expect(result.m3u8).toBe(result.m3u);

    // the archive contains the playlist files and the tagged mp3 files
    const archive = await archiveEntries(result.archive);
    expect(Object.keys(archive).sort()).toEqual([
      'Schulball.m3u',
      'Schulball.m3u8',
      'Tanzmusik/01_Waltz; Artist -- Dance.mp3',
      'Tanzmusik/02_Tango; Artist2 -- Dance2.mp3',
    ]);

    const tagged = archive['Tanzmusik/01_Waltz; Artist -- Dance.mp3'] as Uint8Array;
    expect(tagged[0]).toBe(0x49);
    expect(tagged[1]).toBe(0x44);
    expect(tagged[2]).toBe(0x33);

    const tag = readId3v2(tagged);
    expect(tag?.text.TIT2).toBe('Waltz');
    expect(tag?.text.TPE1).toBe('Artist');
    expect(tag?.text.TALB).toBe('Schulball');
    expect(tag?.text.TPE2).toBe('Schulball');
    expect(tag?.text.TCON).toBe('Dance');
    expect(tag?.text.TCOM).toBe('Artist');
    expect(tag?.text.TRCK).toBe('01');
    expect(tag?.text.COMM).toBe('Dance');
    expect(tag?.picture).toBeNull();

    // the audio data is still there
    expect(tagged.length).toBeGreaterThan(makeMp3({ frames: 100 }).length);
  });

  it('reports tracks without a matching file', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance\n02_Tango; Artist2 -- Dance2');
    const files = [picked('01-Song.mp3', makeMp3({ frames: 10 }))];

    const result = await processPlaylist({
      playlistName: 'Schulball',
      entries,
      files,
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    expect(result.tracks).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('was skipped: no matching file found');
    expect(result.m3u).not.toContain('Tango');

    const archive = await archiveEntries(result.archive);
    expect(Object.keys(archive)).toHaveLength(3);
  });

  it('replaces an existing id3 tag instead of stacking tags', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const tagged = makeMp3({ frames: 20 });
    // prepend a dummy id3v2 tag
    const dummy = new Uint8Array(10 + 4);
    dummy.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0);
    dummy.set([0x00, 0x00, 0x00, 0x04], 6);
    const withTag = new Uint8Array(dummy.length + tagged.length);
    withTag.set(dummy, 0);
    withTag.set(tagged, dummy.length);

    const result = await processPlaylist({
      playlistName: 'Schulball',
      entries,
      files: [picked('01-Song.mp3', withTag)],
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    const archive = await archiveEntries(result.archive);
    const data = archive['Tanzmusik/01_Waltz; Artist -- Dance.mp3'] as Uint8Array;
    // only one id3 header at the beginning
    expect(data[0]).toBe(0x49);
    expect(data[1]).toBe(0x44);
    expect(readId3v2(data)?.text.TIT2).toBe('Waltz');
  });

  it('sanitises the playlist file names but keeps the album tag raw', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const result = await processPlaylist({
      playlistName: '../../evil',
      entries,
      files: [picked('01-Song.mp3', makeMp3({ frames: 10 }))],
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    const archive = await archiveEntries(result.archive);
    expect(Object.keys(archive).sort()).toEqual([
      '.._.._evil.m3u',
      '.._.._evil.m3u8',
      'Tanzmusik/01_Waltz; Artist -- Dance.mp3',
    ]);
    const tagged = archive['Tanzmusik/01_Waltz; Artist -- Dance.mp3'] as Uint8Array;
    expect(readId3v2(tagged)?.text.TALB).toBe('../../evil');
    expect(readId3v2(tagged)?.text.TPE2).toBe('../../evil');
  });

  it('skips a file whose id3 tag is broken instead of cutting off the audio', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const audio = makeMp3({ frames: 50 });
    // a tag that promises more than the file contains
    const broken = concatBytes(id3v24Header([0x00, 0x3f, 0x7f, 0x7f]), audio);

    const result = await processPlaylist({
      playlistName: 'Schulball',
      entries,
      files: [picked('01-Song.mp3', broken)],
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    // the file is reported and left out, nothing broken is written
    expect(result.tracks).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('the ID3 tag of \'01-Song.mp3\' is broken');
    const archive = await archiveEntries(result.archive);
    expect(Object.keys(archive).filter((name) => name.endsWith('.mp3'))).toHaveLength(0);
  });

  it('processes a file that has something between the tag and the music', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const audio = makeMp3({ frames: 50 });
    // a Lyrics3v2 block behind the tag
    const junk = new TextEncoder().encode('LYRICSBEGININD00000000LYRICS200');
    const header = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04]);
    const withJunk = concatBytes(header, junk);
    const tagged = concatBytes(withJunk, audio);

    const result = await processPlaylist({
      playlistName: 'Schulball',
      entries,
      files: [picked('01-Song.mp3', tagged)],
      musicFolderName: 'Tanzmusik',
      spotify: null,
    });

    // the file is processed, the music is complete
    expect(result.tracks).toHaveLength(1);
    const archive = await archiveEntries(result.archive);
    const data = archive['Tanzmusik/01_Waltz; Artist -- Dance.mp3'] as Uint8Array;
    expect(readId3v2(data)?.text.TIT2).toBe('Waltz');
    expect(data.length).toBeGreaterThan(audio.length);
  });

  it('can be cancelled', async () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const controller = new AbortController();
    controller.abort();

    await expect(
      processPlaylist({
        playlistName: 'Schulball',
        entries,
        files: [picked('01-Song.mp3', makeMp3({ frames: 10 }))],
        musicFolderName: 'Tanzmusik',
        spotify: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
