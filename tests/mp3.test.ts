import { describe, expect, it } from 'vitest';
import { readDurationSeconds, readMp3Info, stripTags } from '../src/core/mp3';
import { makeMp3, makeMp3WithTags } from './helpers/mp3';

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
    expect(readDurationSeconds(new Uint8Array(0))).toBeNull();
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
});
