/** Helpers that build synthetic MP3 files for the tests. */

const BITRATE_INDEX_V1_L3 = new Map<number, number>([
  [32, 1],
  [40, 2],
  [48, 3],
  [56, 4],
  [64, 5],
  [80, 6],
  [96, 7],
  [112, 8],
  [128, 9],
  [160, 10],
  [192, 11],
  [224, 12],
  [256, 13],
  [320, 14],
]);

const SAMPLE_RATE_INDEX = new Map<number, number>([
  [44100, 0],
  [48000, 1],
  [32000, 2],
]);

export interface Mp3Options {
  readonly frames?: number;
  readonly bitrateKbps?: number;
  readonly sampleRate?: number;
  /** Adds a Xing header with the given frame count. */
  readonly xingFrames?: number;
  /** Adds a VBRI header with the given frame count. */
  readonly vbriFrames?: number;
}

function frameHeader(bitrateKbps: number, sampleRate: number): Uint8Array {
  const bitrateIndex = BITRATE_INDEX_V1_L3.get(bitrateKbps);
  const sampleRateIndex = SAMPLE_RATE_INDEX.get(sampleRate);
  if (bitrateIndex === undefined || sampleRateIndex === undefined) {
    throw new Error(`Unsupported test bitrate/sample rate: ${bitrateKbps}/${sampleRate}`);
  }
  return new Uint8Array([
    0xff,
    0xfb, // MPEG1, Layer III, no CRC
    (bitrateIndex << 4) | (sampleRateIndex << 2),
    0x00, // stereo
  ]);
}

function frameLength(bitrateKbps: number, sampleRate: number): number {
  return Math.floor((144 * bitrateKbps * 1000) / sampleRate);
}

/** Builds a synthetic MPEG1 Layer III file. */
export function makeMp3(options: Mp3Options = {}): Uint8Array {
  const {
    frames = 10,
    bitrateKbps = 128,
    sampleRate = 44100,
    xingFrames,
    vbriFrames,
  } = options;

  const header = frameHeader(bitrateKbps, sampleRate);
  const length = frameLength(bitrateKbps, sampleRate);
  const totalFrames = xingFrames ?? vbriFrames ?? frames;

  const parts: Uint8Array[] = [];
  for (let index = 0; index < totalFrames; index += 1) {
    const frame = new Uint8Array(length);
    frame.set(header, 0);
    if (index === 0 && xingFrames !== undefined) {
      // Xing header: side info of a MPEG1 stereo frame is 32 bytes.
      const xing = new Uint8Array(12);
      xing.set([0x58, 0x69, 0x6e, 0x67], 0); // "Xing"
      xing.set([0x00, 0x00, 0x00, 0x01], 4); // flags: frame count present
      xing.set(
        [
          (xingFrames >>> 24) & 0xff,
          (xingFrames >>> 16) & 0xff,
          (xingFrames >>> 8) & 0xff,
          xingFrames & 0xff,
        ],
        8,
      );
      frame.set(xing, 4 + 32);
    }
    if (index === 0 && vbriFrames !== undefined) {
      const vbri = new Uint8Array(18);
      vbri.set([0x56, 0x42, 0x52, 0x49], 0); // "VBRI"
      vbri.set(
        [
          (vbriFrames >>> 24) & 0xff,
          (vbriFrames >>> 16) & 0xff,
          (vbriFrames >>> 8) & 0xff,
          vbriFrames & 0xff,
        ],
        14,
      );
      frame.set(vbri, 4 + 32);
    }
    parts.push(frame);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Builds a file with an ID3v2 tag in front and an ID3v1 tag at the end. */
export function makeMp3WithTags(options: Mp3Options = {}): Uint8Array {
  const audio = makeMp3(options);
  const id3v2 = new Uint8Array(10 + 4);
  id3v2.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0);
  id3v2.set([0x00, 0x00, 0x00, 0x04], 6);
  id3v2.set([0x54, 0x58, 0x58, 0x58], 10); // "TXXX"

  const id3v1 = new Uint8Array(128);
  id3v1.set([0x54, 0x41, 0x47], 0); // "TAG"

  const out = new Uint8Array(id3v2.length + audio.length + id3v1.length);
  out.set(id3v2, 0);
  out.set(audio, id3v2.length);
  out.set(id3v1, id3v2.length + audio.length);
  return out;
}
