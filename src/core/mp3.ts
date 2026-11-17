/**
 * Minimal MP3 handling: stripping existing tags and reading the duration.
 *
 * The browser has no access to mutagen, so the few bits of information the
 * original tool needs (duration for the `#EXTINF` line) are derived from the
 * MPEG frame headers directly.
 */

/** Information extracted from an MP3 file. */
export interface Mp3Info {
  /** Duration in seconds. */
  readonly durationSeconds: number;
  /** Bitrate of the first frame in kbit/s. */
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** `true` when the file carries a Xing/VBRI header (variable bitrate). */
  readonly vbr: boolean;
  /** Number of frames when it is known from a Xing/VBRI header. */
  readonly frameCount: number | null;
}

interface FrameHeader {
  readonly offset: number;
  /** MPEG version: 1, 2 or 2.5 */
  readonly version: number;
  /** 1, 2 or 3 */
  readonly layer: number;
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly padding: number;
  readonly channelMode: number;
  readonly frameLength: number;
  readonly samplesPerFrame: number;
}

const BITRATES_V1: Record<number, number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const BITRATES_V2: Record<number, number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

function uint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

/** Reads a synchsafe integer (7 bits per byte) as used by ID3v2 headers. */
function readSyncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[offset + 1] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[offset + 2] ?? 0) & 0x7f) * 0x80 +
    ((bytes[offset + 3] ?? 0) & 0x7f)
  );
}

export interface StrippedAudio {
  /** The file content without any ID3v2/ID3v1 tag. */
  readonly audio: Uint8Array;
  /** Size of the removed ID3v2 tag in bytes (0 when there was none). */
  readonly id3v2Size: number;
  /** `true` when an ID3v1 tag was removed. */
  readonly hadId3v1: boolean;
}

/** Header size of an ID3v2.3 / ID3v2.4 tag. */
const ID3V2_HEADER_SIZE = 10;
/**
 * Header size of an ID3v2.2 tag: the 6 byte header (identifier, version and
 * flags) is followed by a plain 3 byte size, so the frames start at offset 9.
 */
const ID3V22_HEADER_SIZE = 9;
const ID3_FOOTER_SIZE = 10;

/**
 * Size of the ID3v2 tag at the start of `data`, or `null` when the header is
 * not plausible.
 *
 * A corrupt size field (for example `7f7f7f7f`) must never be trusted: the tag
 * is only accepted when it fits into the file. Otherwise `stripTags` would
 * remove the whole file and the result would contain no audio at all.
 *
 * @returns `0` when there is no ID3v2 tag, the tag size otherwise
 */
function id3v2TagSize(data: Uint8Array): number | null {
  if (data.length < 3 || ascii(data, 0, 3) !== 'ID3') return 0;

  const version = data[3] ?? 0;
  if (version === 2) {
    // ID3v2.2: 6 byte header, then a plain (not synchsafe) 3 byte size. The
    // frame layout is irrelevant here, only the total size has to be known.
    if (data.length < ID3V22_HEADER_SIZE) return null;
    const size = ((data[6] ?? 0) << 16) | ((data[7] ?? 0) << 8) | (data[8] ?? 0);
    const total = ID3V22_HEADER_SIZE + size;
    return total <= data.length ? total : null;
  }

  if (version !== 3 && version !== 4) return null;

  if (data.length < ID3V2_HEADER_SIZE) return null;
  const flags = data[5] ?? 0;
  const size = readSyncSafe(data, 6);
  const footerSize = (flags & 0x10) !== 0 ? ID3_FOOTER_SIZE : 0;
  const total = ID3V2_HEADER_SIZE + size + footerSize;
  return total <= data.length ? total : null;
}

/**
 * Removes an ID3v2 tag from the beginning and an ID3v1 tag from the end of
 * the given bytes.
 *
 * An implausible ID3v2 header is treated as if the file had no tag at all -
 * the audio must survive untouched.
 */
export function stripTags(data: Uint8Array): StrippedAudio {
  const tagSize = id3v2TagSize(data);
  if (tagSize === null) {
    return { audio: data, id3v2Size: 0, hadId3v1: false };
  }

  let audio = tagSize > 0 ? data.subarray(tagSize) : data;
  const id3v2Size = tagSize;

  let hadId3v1 = false;
  if (audio.length >= 128 && ascii(audio, audio.length - 128, 3) === 'TAG') {
    audio = audio.subarray(0, audio.length - 128);
    hadId3v1 = true;
  }

  return { audio, id3v2Size, hadId3v1 };
}

function parseFrameHeader(data: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > data.length) return null;

  const b0 = data[offset] ?? 0;
  const b1 = data[offset + 1] ?? 0;
  const b2 = data[offset + 2] ?? 0;
  const b3 = data[offset + 3] ?? 0;

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  if (versionBits === 1) return null; // reserved
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;

  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null; // reserved
  const layer = 4 - layerBits; // 01 -> 3, 10 -> 2, 11 -> 1

  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;

  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (sampleRateIndex === 3) return null;

  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;

  const bitrateTable = version === 1 ? BITRATES_V1 : BITRATES_V2;
  const bitrateKbps = bitrateTable[layer]?.[bitrateIndex] ?? 0;
  if (bitrateKbps <= 0) return null;

  const sampleRate = SAMPLE_RATES[String(version)]?.[sampleRateIndex] ?? 0;
  if (sampleRate <= 0) return null;

  let frameLength: number;
  let samplesPerFrame: number;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4;
    samplesPerFrame = 384;
  } else if (layer === 2) {
    frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
    samplesPerFrame = 1152;
  } else {
    frameLength =
      version === 1
        ? Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding
        : Math.floor((72 * bitrateKbps * 1000) / sampleRate) + padding;
    samplesPerFrame = version === 1 ? 1152 : 576;
  }

  if (frameLength <= 4) return null;

  return {
    offset,
    version,
    layer,
    bitrateKbps,
    sampleRate,
    padding,
    channelMode,
    frameLength,
    samplesPerFrame,
  };
}

function findFirstFrame(data: Uint8Array): FrameHeader | null {
  const limit = Math.min(data.length - 4, 256 * 1024);
  for (let offset = 0; offset <= limit; offset += 1) {
    const header = parseFrameHeader(data, offset);
    if (!header) continue;
    // Guard against false positives: the next frame should start right after
    // this one. Files that are truncated at the very end are still accepted.
    const next = parseFrameHeader(data, offset + header.frameLength);
    if (next || offset + header.frameLength >= data.length - 4) {
      return header;
    }
  }
  return null;
}

interface XingInfo {
  readonly frames: number | null;
  readonly bytes: number | null;
}

function readXingInfo(data: Uint8Array, header: FrameHeader): XingInfo | null {
  const mono = header.channelMode === 3;
  const sideInfoSize = header.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const offset = header.offset + 4 + sideInfoSize;
  if (offset + 8 > data.length) return null;

  const magic = ascii(data, offset, 4);
  if (magic !== 'Xing' && magic !== 'Info') return null;

  const flags = uint32BE(data, offset + 4);
  let cursor = offset + 8;
  let frames: number | null = null;
  let bytes: number | null = null;

  if ((flags & 0x0001) !== 0) {
    frames = uint32BE(data, cursor);
    cursor += 4;
  }
  if ((flags & 0x0002) !== 0) {
    bytes = uint32BE(data, cursor);
    cursor += 4;
  }

  return { frames, bytes };
}

interface VbriInfo {
  readonly frames: number | null;
  readonly bytes: number | null;
}

function readVbri(data: Uint8Array, header: FrameHeader): VbriInfo | null {
  const offset = header.offset + 4 + 32;
  if (offset + 18 > data.length) return null;
  if (ascii(data, offset, 4) !== 'VBRI') return null;

  return {
    bytes: uint32BE(data, offset + 10),
    frames: uint32BE(data, offset + 14),
  };
}

/**
 * Reads duration and a few other properties from MP3 data.
 *
 * @returns `null` when the data does not look like an MP3 file.
 */
export function readMp3Info(data: Uint8Array): Mp3Info | null {
  const { audio } = stripTags(data);
  const header = findFirstFrame(audio);
  if (!header) return null;

  const xing = readXingInfo(audio, header);
  const vbri = xing ? null : readVbri(audio, header);

  let durationSeconds: number;
  let frameCount: number | null = null;
  let vbr = false;
  let bitrateKbps = header.bitrateKbps;

  const frames = xing?.frames ?? vbri?.frames ?? null;
  const bytes = xing?.bytes ?? vbri?.bytes ?? null;

  if (frames !== null && frames > 0) {
    frameCount = frames;
    vbr = true;
    const samples = header.samplesPerFrame * frames;
    durationSeconds = samples / header.sampleRate;
    // like mutagen: the average bitrate of a variable bitrate file
    if (xing && xing.bytes !== null && xing.bytes > 0 && samples > 0) {
      // the first frame is counted in the byte count but not in the frame count
      const audioBytes = Math.max(0, xing.bytes - header.frameLength);
      const bitsPerSecond = Math.round((audioBytes * 8 * header.sampleRate) / samples);
      bitrateKbps = Math.round(bitsPerSecond / 1000);
    } else if (vbri && vbri.bytes !== null && vbri.bytes > 0 && durationSeconds > 0) {
      bitrateKbps = Math.round(Math.trunc((vbri.bytes * 8) / durationSeconds) / 1000);
    }
  } else if (bytes !== null && bytes > 0 && header.bitrateKbps > 0) {
    vbr = true;
    durationSeconds = (bytes * 8) / (header.bitrateKbps * 1000);
  } else {
    const audioBytes = audio.length - header.offset;
    durationSeconds = (audioBytes * 8) / (header.bitrateKbps * 1000);
  }

  return {
    durationSeconds,
    bitrateKbps,
    sampleRate: header.sampleRate,
    channels: header.channelMode === 3 ? 1 : 2,
    vbr,
    frameCount,
  };
}
