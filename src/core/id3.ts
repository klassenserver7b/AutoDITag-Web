import type { CoverArt, TagPayload } from './types';

/**
 * A tiny ID3v2 writer/reader.
 *
 * The byte layout follows the original Python tool (which used mutagen):
 * ID3v2.4, text frames as UTF-16 with a byte order mark, the frame set
 * `TIT2`, `TPE1`, `TPE2`, `TALB`, `TCON`, `TCOM`, `TRCK`, `COMM` and `APIC`.
 *
 * Differences to the Python tool (both are deliberate, see README):
 *  - the non standard `TRK` frame is not written - mutagen silently drops it
 *    because a frame id has to be exactly four characters long,
 *  - the comment language is `eng` instead of mutagen's placeholder `XXX`.
 */

/** Supported ID3v2 versions. */
export type Id3Version = 2.3 | 2.4;

export interface Id3Frame {
  readonly id: string;
  readonly data: Uint8Array;
}

export interface Id3Tag {
  readonly version: number;
  readonly frames: readonly Id3Frame[];
  /** Decoded text frames, keyed by frame id. */
  readonly text: Readonly<Record<string, string>>;
  /** The embedded cover art, if any. */
  readonly picture: CoverArt | null;
}

const ENCODING_UTF16 = 1;
const ENCODING_UTF8 = 3;
const PICTURE_TYPE_COVER_FRONT = 3;

/** Frames the tool writes itself - an existing frame with the same id is replaced. */
const MANAGED_FRAMES = new Set(['TIT2', 'TPE1', 'TPE2', 'TALB', 'TCON', 'TCOM', 'TRCK', 'COMM']);

/** Frames the Python tool deletes before writing (`delall('COMM')`, `delall('TXXX')`). */
const DELETED_FRAMES = new Set(['COMM', 'TXXX']);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeSyncSafe(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >> 21) & 0x7f;
  out[1] = (value >> 14) & 0x7f;
  out[2] = (value >> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function encodeUint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

/** UTF-16 little endian with a byte order mark (like mutagen's UTF16). */
export function utf16leWithBom(text: string): Uint8Array {
  const encoded = new Uint8Array(2 + text.length * 2);
  encoded[0] = 0xff;
  encoded[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    encoded[2 + i * 2] = code & 0xff;
    encoded[3 + i * 2] = (code >> 8) & 0xff;
  }
  return encoded;
}

function textFrameData(text: string): Uint8Array {
  return concat([
    new Uint8Array([ENCODING_UTF16]),
    utf16leWithBom(text),
    new Uint8Array([0x00, 0x00]), // null terminator
  ]);
}

function commentFrameData(text: string, language = 'eng'): Uint8Array {
  const lang = new Uint8Array(3);
  for (let i = 0; i < 3; i += 1) lang[i] = language.charCodeAt(i);
  return concat([
    new Uint8Array([ENCODING_UTF16]),
    lang,
    utf16leWithBom(''), // empty description
    new Uint8Array([0x00, 0x00]),
    utf16leWithBom(text),
    new Uint8Array([0x00, 0x00]),
  ]);
}

function pictureFrameData(picture: CoverArt): Uint8Array {
  const mime = new Uint8Array(picture.mime.length);
  for (let i = 0; i < picture.mime.length; i += 1) mime[i] = picture.mime.charCodeAt(i) & 0xff;
  const description = new Uint8Array('Cover'.length);
  for (let i = 0; i < description.length; i += 1) description[i] = 'Cover'.charCodeAt(i);
  return concat([
    new Uint8Array([ENCODING_UTF8]),
    mime,
    new Uint8Array([0x00]), // mime terminator
    new Uint8Array([PICTURE_TYPE_COVER_FRONT]),
    description,
    new Uint8Array([0x00]), // description terminator
    picture.data,
  ]);
}

export interface BuildId3Options {
  readonly version?: Id3Version;
  /**
   * The tag that was already in the file. Its frames are kept (the Python
   * tool keeps them as well) unless the tool writes a frame with the same id.
   */
  readonly existing?: Id3Tag | null;
}

/**
 * Builds an ID3v2 tag.
 *
 * @param payload the tag values
 * @param options target version and the tag that was already in the file
 */
export function buildId3v2(payload: TagPayload, options: BuildId3Options = {}): Uint8Array {
  const version = options.version ?? 2.4;
  const frames: { id: string; data: Uint8Array }[] = [];

  // keep the frames of the original file
  for (const frame of options.existing?.frames ?? []) {
    if (DELETED_FRAMES.has(frame.id)) continue;
    if (frame.id === 'APIC') {
      // an existing cover is only kept when no new one is fetched
      if (!payload.picture) frames.push({ id: frame.id, data: frame.data });
      continue;
    }
    if (MANAGED_FRAMES.has(frame.id)) continue;
    frames.push({ id: frame.id, data: frame.data });
  }

  frames.push(
    { id: 'TIT2', data: textFrameData(payload.title) },
    { id: 'TPE1', data: textFrameData(payload.artist) },
    { id: 'TPE2', data: textFrameData(payload.albumArtist) },
    { id: 'TALB', data: textFrameData(payload.album) },
    { id: 'TCON', data: textFrameData(payload.genre) },
    { id: 'TCOM', data: textFrameData(payload.artist) },
    { id: 'TRCK', data: textFrameData(payload.trackNumber) },
    { id: 'COMM', data: commentFrameData(payload.comment) },
  );

  if (payload.picture && payload.picture.data.length > 0) {
    frames.push({ id: 'APIC', data: pictureFrameData(payload.picture) });
  }

  const encodedFrames = frames.map((frame) => {
    const size =
      version === 2.4 ? encodeSyncSafe(frame.data.length) : encodeUint32(frame.data.length);
    const id = new Uint8Array(4);
    for (let i = 0; i < 4; i += 1) id[i] = frame.id.charCodeAt(i);
    return concat([id, size, new Uint8Array([0x00, 0x00]), frame.data]);
  });

  const body = concat(encodedFrames);
  const header = concat([
    new Uint8Array([0x49, 0x44, 0x33]), // "ID3"
    new Uint8Array([version === 2.4 ? 0x04 : 0x03, 0x00]),
    new Uint8Array([0x00]), // flags
    encodeSyncSafe(body.length),
  ]);

  return concat([header, body]);
}

function decodeTextWithEncoding(payload: Uint8Array, encoding: number): string {
  let text: string;
  switch (encoding) {
    case 0:
      text = new TextDecoder('iso-8859-1').decode(payload);
      break;
    case 1:
      text = new TextDecoder('utf-16').decode(payload);
      break;
    case 2:
      text = new TextDecoder('utf-16be').decode(payload);
      break;
    default:
      text = new TextDecoder('utf-8').decode(payload);
      break;
  }
  return text.replace(/\u0000+$/u, '');
}

function decodeText(data: Uint8Array): string {
  return decodeTextWithEncoding(data.subarray(1), data[0] ?? 0);
}

function skipTerminatedString(data: Uint8Array, start: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    let cursor = start;
    while (
      cursor + 1 < data.length &&
      !((data[cursor] ?? 0) === 0 && (data[cursor + 1] ?? 0) === 0)
    ) {
      cursor += 2;
    }
    return cursor + 2;
  }
  let cursor = start;
  while (cursor < data.length && (data[cursor] ?? 0) !== 0) cursor += 1;
  return cursor + 1;
}

function readPicture(data: Uint8Array): CoverArt | null {
  const encoding = data[0] ?? 0;
  let cursor = 1;
  let mime = '';
  while (cursor < data.length && (data[cursor] ?? 0) !== 0) {
    mime += String.fromCharCode(data[cursor] ?? 0);
    cursor += 1;
  }
  cursor += 1; // mime terminator
  cursor += 1; // picture type
  cursor = skipTerminatedString(data, cursor, encoding);
  if (cursor > data.length) return null;
  return { mime: mime || 'image/jpeg', data: data.subarray(cursor) };
}

/**
 * Reads an ID3v2 tag from the given bytes.
 *
 * @returns `null` when the data does not start with an ID3v2 header.
 */
export function readId3v2(data: Uint8Array): Id3Tag | null {
  if (data.length < 10) return null;
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return null;

  const version = data[3] ?? 4;
  const size =
    ((data[6] ?? 0) & 0x7f) * 0x200000 +
    ((data[7] ?? 0) & 0x7f) * 0x4000 +
    ((data[8] ?? 0) & 0x7f) * 0x80 +
    ((data[9] ?? 0) & 0x7f);

  const end = Math.min(data.length, 10 + size);
  const frames: Id3Frame[] = [];
  const text: Record<string, string> = {};
  let picture: CoverArt | null = null;

  let cursor = 10;
  while (cursor + 10 <= end) {
    const rawId = String.fromCharCode(
      data[cursor] ?? 0,
      data[cursor + 1] ?? 0,
      data[cursor + 2] ?? 0,
      data[cursor + 3] ?? 0,
    );
    // a frame id has four characters; some tools write three plus a null byte
    const isValidId = /^[A-Z0-9]{4}$/.test(rawId) || /^[A-Z0-9]{3}\u0000$/.test(rawId);
    if (!isValidId) break;
    const id = rawId.endsWith('\u0000') ? rawId.slice(0, 3) : rawId;

    const frameSize =
      version === 4
        ? ((data[cursor + 4] ?? 0) & 0x7f) * 0x200000 +
          ((data[cursor + 5] ?? 0) & 0x7f) * 0x4000 +
          ((data[cursor + 6] ?? 0) & 0x7f) * 0x80 +
          ((data[cursor + 7] ?? 0) & 0x7f)
        : ((data[cursor + 4] ?? 0) << 24) +
          ((data[cursor + 5] ?? 0) << 16) +
          ((data[cursor + 6] ?? 0) << 8) +
          (data[cursor + 7] ?? 0);

    const frameFlags = ((data[cursor + 8] ?? 0) << 8) | (data[cursor + 9] ?? 0);
    const dataStart = cursor + 10;
    const dataEnd = dataStart + frameSize;
    if (dataEnd > end || frameSize < 0) break;

    const frameData = data.subarray(dataStart, dataEnd);
    frames.push({ id, data: frameData });

    if (id === 'APIC') {
      picture = readPicture(frameData);
    } else if (id.startsWith('T')) {
      text[id] = decodeText(frameData);
    } else if (id === 'COMM') {
      const encoding = frameData[0] ?? 0;
      const textStart = skipTerminatedString(frameData, 4, encoding);
      text.COMM = decodeTextWithEncoding(frameData.subarray(textStart), encoding);
    }

    const frameHeaderSize = frameFlags & 0x0001 ? 4 : 0;
    cursor = dataEnd + frameHeaderSize;
  }

  return { version, frames, text, picture };
}
