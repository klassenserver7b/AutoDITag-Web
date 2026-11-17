import { describe, expect, it } from 'vitest';
import { readMp3Info, stripTags } from '../src/core/mp3';
import { makeMp3, makeMp3WithTags } from './helpers/mp3';

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A normal ID3v2.4 header with the given (untrusted) size field. */
function id3v24Header(size: readonly number[], flags = 0): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, flags, ...size]);
}

/** An ID3v2.2 tag: 6 byte header plus a plain 3 byte size. */
function id3v22Tag(body: Uint8Array): Uint8Array {
  const size = body.length;
  return concatBytes([
    new Uint8Array([
      0x49, 0x44, 0x33, 0x02, 0x00, 0x00,
      (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff,
    ]),
    body,
  ]);
}

/**
 * An ID3v2.2 tag whose size was written the way mutagen reads it: as a four
 * byte synchsafe value instead of a plain three byte one.
 */
function id3v22TagMutagenStyle(body: Uint8Array): Uint8Array {
  const size = body.length;
  return concatBytes([
    new Uint8Array([
      0x49, 0x44, 0x33, 0x02, 0x00, 0x00,
      (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
    ]),
    body,
  ]);
}

describe('readMp3Info', () => {
  it('reads the duration of a constant bitrate file', () => {
    const data = makeMp3({ frames: 100 });
    const info = readMp3Info(data);
    expect(info).not.toBeNull();
    expect(info?.bitrateKbps).toBe(128);
    expect(info?.sampleRate).toBe(44100);
    expect(info?.channels).toBe(2);
    // without a Xing/VBRI header the length is estimated from the file size,
    // exactly like mutagen does: 8 * bytes / bitrate
    expect(info?.durationSeconds).toBeCloseTo((8 * data.length) / 128000, 6);
  });

  it('prefers the frame count of a Xing header', () => {
    const info = readMp3Info(makeMp3({ xingFrames: 1000 }));
    expect(info?.vbr).toBe(true);
    expect(info?.frameCount).toBe(1000);
    expect(info?.durationSeconds).toBeCloseTo((1000 * 1152) / 44100, 4);
  });

  it('reads a VBRI header', () => {
    const info = readMp3Info(makeMp3({ vbriFrames: 500 }));
    expect(info?.frameCount).toBe(500);
    expect(info?.durationSeconds).toBeCloseTo((500 * 1152) / 44100, 4);
  });

  it('returns null for data that is not an mp3', () => {
    expect(readMp3Info(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(readMp3Info(new Uint8Array(0))).toBeNull();
  });

  it('ignores an existing id3 tag when measuring the duration', () => {
    const plain = readMp3Info(makeMp3({ frames: 100 }));
    const tagged = readMp3Info(makeMp3WithTags({ frames: 100 }));
    expect(tagged?.durationSeconds).toBeCloseTo(plain?.durationSeconds ?? 0, 4);
  });
});

describe('stripTags', () => {
  it('removes the id3v2 header and the id3v1 trailer', () => {
    const tagged = makeMp3WithTags({ frames: 10 });
    const { audio, id3v2Size, hadId3v1 } = stripTags(tagged);
    expect(id3v2Size).toBe(14);
    expect(hadId3v1).toBe(true);
    expect(audio.length).toBe(makeMp3({ frames: 10 }).length);
  });

  it('keeps untagged files untouched', () => {
    const plain = makeMp3({ frames: 10 });
    const { audio, id3v2Size, hadId3v1 } = stripTags(plain);
    expect(audio.length).toBe(plain.length);
    expect(id3v2Size).toBe(0);
    expect(hadId3v1).toBe(false);
  });

  it('strips a normal id3v2 tag without touching the audio', () => {
    const audio = makeMp3({ frames: 10 });
    const body = new Uint8Array([0x54, 0x58, 0x58, 0x58]);
    const header = id3v24Header([0x00, 0x00, 0x00, body.length]);
    const tagged = concatBytes([header, body, audio]);

    const result = stripTags(tagged);
    expect(result.id3v2Size).toBe(header.length + body.length);
    expect([...result.audio]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });

  it('keeps the audio when the size field is bogus', () => {
    const audio = makeMp3({ frames: 10 });
    // 0x7f7f7f7f is the largest value the synchsafe encoding can hold
    const tagged = concatBytes([id3v24Header([0x7f, 0x7f, 0x7f, 0x7f]), audio]);

    const result = stripTags(tagged);
    expect(result.id3v2Size).toBe(0);
    // the corrupt header is treated as audio, the audio bytes are all there
    expect(result.audio.length).toBe(tagged.length);
    expect([...result.audio.subarray(10)]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });

  it('keeps the audio when the tag is larger than the file', () => {
    const audio = makeMp3({ frames: 10 });
    // ~1 MB are promised, but only the 10 byte header and the audio exist
    const tagged = concatBytes([id3v24Header([0x00, 0x3f, 0x7f, 0x7f]), audio]);

    const result = stripTags(tagged);
    expect(result.id3v2Size).toBe(0);
    expect(result.audio.length).toBe(tagged.length);
    expect([...result.audio.subarray(10)]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });

  it('strips an id3v2.2 tag (6 byte header, plain 3 byte size)', () => {
    const audio = makeMp3({ frames: 10 });
    // three character frame ids with a 3 byte size, like ID3v2.2 uses them
    const body = new Uint8Array([0x54, 0x54, 0x32, 0x00, 0x00, 0x04, 1, 2, 3, 4]);
    const tagged = concatBytes([id3v22Tag(body), audio]);

    const result = stripTags(tagged);
    expect(result.id3v2Size).toBe(9 + body.length);
    expect([...result.audio]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });

  it('strips an id3v2.2 tag whose size was written the mutagen way', () => {
    const audio = makeMp3({ frames: 10 });
    const body = new Uint8Array([0x54, 0x54, 0x32, 0x00, 0x00, 0x04, 1, 2, 3, 4]);
    const tagged = concatBytes([id3v22TagMutagenStyle(body), audio]);

    const result = stripTags(tagged);
    // the audio has to survive, no matter how the size was written
    expect(result.audio.length).toBe(audio.length);
    expect([...result.audio]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });

  it('keeps a file whose first bytes are not a tag untouched', () => {
    const audio = makeMp3({ frames: 10 });
    const result = stripTags(audio);
    expect(result.id3v2Size).toBe(0);
    expect([...result.audio]).toEqual([...audio]);
    expect(readMp3Info(audio)?.durationSeconds).toBeGreaterThan(0);
  });

  it('keeps the audio for an unknown id3 version', () => {
    const audio = makeMp3({ frames: 10 });
    const tagged = concatBytes([new Uint8Array([0x49, 0x44, 0x33, 0x09, 0x00, 0x00, 0, 0, 0, 0]), audio]);
    const result = stripTags(tagged);
    expect(result.id3v2Size).toBe(0);
    expect([...result.audio.subarray(10)]).toEqual([...audio]);
    expect(readMp3Info(tagged)?.durationSeconds).toBeGreaterThan(0);
  });
});
