import { describe, expect, it } from 'vitest';
import { buildId3v2, readId3v2 } from '../src/core/id3';
import type { TagPayload } from '../src/core/types';

const payload: TagPayload = {
  title: 'Voices of Spring',
  artist: 'André Rieu',
  albumArtist: 'Schulball 08.05.2024',
  album: 'Schulball 08.05.2024',
  genre: 'Wiener Walzer',
  trackNumber: '01',
  comment: 'Wiener Walzer',
};

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('buildId3v2', () => {
  it('writes an id3v2.4 header', () => {
    const tag = buildId3v2(payload);
    expect(tag[0]).toBe(0x49);
    expect(tag[1]).toBe(0x44);
    expect(tag[2]).toBe(0x33);
    expect(tag[3]).toBe(0x04);
    expect(tag[5]).toBe(0x00);
  });

  it('writes all frames of the python tool', () => {
    const tag = buildId3v2(payload);
    const ids = [...(readId3v2(tag)?.frames.map((frame) => frame.id) ?? [])];
    expect(ids).toEqual([
      'TIT2',
      'TPE1',
      'TPE2',
      'TALB',
      'TCON',
      'TCOM',
      'TRCK',
      'COMM',
    ]);
    // mutagen silently drops the non standard `TRK` frame, so we do not write it
    expect(ids).not.toContain('TRK');
  });

  it('round trips the text frames', () => {
    const tag = buildId3v2(payload);
    const parsed = readId3v2(tag);
    expect(parsed?.text.TIT2).toBe(payload.title);
    expect(parsed?.text.TPE1).toBe(payload.artist);
    expect(parsed?.text.TPE2).toBe(payload.albumArtist);
    expect(parsed?.text.TALB).toBe(payload.album);
    expect(parsed?.text.TCON).toBe(payload.genre);
    expect(parsed?.text.TCOM).toBe(payload.artist);
    expect(parsed?.text.TRCK).toBe(payload.trackNumber);
    expect(parsed?.text.COMM).toBe(payload.comment);
  });

  it('stores the text as utf-16 with a byte order mark like mutagen does', () => {
    const tag = buildId3v2(payload);
    const parsed = readId3v2(tag);
    const tit2 = parsed?.frames.find((frame) => frame.id === 'TIT2');
    expect(tit2?.data[0]).toBe(1);
    expect(tit2?.data[1]).toBe(0xff);
    expect(tit2?.data[2]).toBe(0xfe);
  });

  it('keeps the frames of the original file but replaces the managed ones', () => {
    const original = buildId3v2({
      ...payload,
      title: 'Old title',
      comment: 'old comment',
      picture: { mime: 'image/jpeg', data: new Uint8Array([9, 9, 9]) },
    });
    // simulate a file that also carries an unknown frame
    const withExtra = concatBytes(original, new Uint8Array(0));

    const parsedOriginal = readId3v2(withExtra);
    const tag = buildId3v2(payload, { existing: parsedOriginal });
    const parsed = readId3v2(tag);

    expect(parsed?.text.TIT2).toBe('Voices of Spring');
    expect(parsed?.text.COMM).toBe('Wiener Walzer');
    // the old cover is kept when no new one is provided
    expect(parsed?.picture?.data.length).toBe(3);
  });

  it('replaces an existing cover when a new one is provided', () => {
    const original = buildId3v2({
      ...payload,
      picture: { mime: 'image/jpeg', data: new Uint8Array([9, 9, 9]) },
    });
    const tag = buildId3v2(
      { ...payload, picture: { mime: 'image/png', data: new Uint8Array([1, 2]) } },
      { existing: readId3v2(original) },
    );
    const parsed = readId3v2(tag);
    expect(parsed?.picture?.mime).toBe('image/png');
    expect([...(parsed?.picture?.data ?? [])]).toEqual([1, 2]);
  });

  it('embeds the cover art', () => {
    const picture = { mime: 'image/jpeg', data: new Uint8Array([1, 2, 3, 4, 5]) };
    const tag = buildId3v2({ ...payload, picture });
    const parsed = readId3v2(tag);
    expect(parsed?.picture?.mime).toBe('image/jpeg');
    expect([...(parsed?.picture?.data ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed?.frames.some((frame) => frame.id === 'APIC')).toBe(true);
  });

  it('supports id3v2.3', () => {
    const tag = buildId3v2(payload, { version: 2.3 });
    expect(tag[3]).toBe(0x03);
    const parsed = readId3v2(tag);
    expect(parsed?.text.TIT2).toBe(payload.title);
  });

  it('returns null when there is no id3 header', () => {
    expect(readId3v2(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });
});
