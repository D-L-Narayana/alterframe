/**
 * WebM (Matroska/EBML) helpers for the transport spec (owner: W10).
 *
 * MediaRecorder produces a "live" WebM: the Segment has an unknown size and Segment→Info carries
 * no Duration, so a `<video>` reports `duration = Infinity` until the whole file has been scanned
 * (and never for some engines), which leaves a seek slider without a range. `withWebmDuration`
 * inserts/overwrites the Duration element (a float in TimecodeScale units) — pure byte work on
 * the EBML structure, no media re-encoding. Unit-tested in tests/unit/infra/webm-fixture.test.ts.
 */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
} as const;

export interface Vint { value: number; length: number; unknown: boolean }
export interface EbmlElement {
  id: number;
  /** Offset of the first ID byte. */
  start: number;
  /** Offset of the first data byte. */
  dataStart: number;
  /** Declared data size, or null for an unknown-size master element. */
  dataSize: number | null;
  /** Offset just past the element (buffer end for unknown-size elements). */
  end: number;
}

/**
 * Reads an EBML variable-length integer at `pos`. With `keepMarker` the length-marker bit stays
 * part of the value (element IDs are compared that way); without it the marker is stripped (sizes).
 */
export function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): Vint {
  const first = buf[pos];
  if (first === undefined) throw new Error(`EBML: unexpected end of data at ${pos}`);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8) throw new Error(`EBML: invalid VINT at ${pos}`);
  if (pos + length > buf.length) throw new Error(`EBML: truncated VINT at ${pos}`);
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** Reads the element header at `pos` (ID + size). */
export function readElement(buf: Uint8Array, pos: number): EbmlElement {
  const id = readVint(buf, pos, true);
  const size = readVint(buf, pos + id.length, false);
  const dataStart = pos + id.length + size.length;
  if (size.unknown) return { id: id.value, start: pos, dataStart, dataSize: null, end: buf.length };
  return { id: id.value, start: pos, dataStart, dataSize: size.value, end: Math.min(buf.length, dataStart + size.value) };
}

/** Encodes a data size as an 8-byte VINT (always valid, never confused with the unknown-size marker for sizes < 2^56-1). */
export function encodeVintSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 53) throw new Error(`EBML: size out of range: ${n}`);
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(bytes);
}

function readUint(buf: Uint8Array, start: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i]!;
  return v;
}

function readFloat(buf: Uint8Array, start: number, size: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + start, size);
  if (size === 4) return view.getFloat32(0);
  if (size === 8) return view.getFloat64(0);
  throw new Error(`EBML: float of size ${size}`);
}

interface InfoLocation { segment: EbmlElement; info: EbmlElement; timecodeScaleNs: number; duration: EbmlElement | null }

function locateInfo(buf: Uint8Array): InfoLocation {
  const header = readElement(buf, 0);
  if (header.id !== EBML_ID.EBML || header.dataSize === null) throw new Error('EBML: not an EBML document (missing header)');
  let pos = header.end;
  let segment: EbmlElement | null = null;
  while (pos < buf.length) {
    const el = readElement(buf, pos);
    if (el.id === EBML_ID.SEGMENT) {
      segment = el;
      break;
    }
    pos = el.end;
  }
  if (!segment) throw new Error('EBML: Segment element missing');
  pos = segment.dataStart;
  while (pos < segment.end) {
    const el = readElement(buf, pos);
    if (el.id === EBML_ID.INFO) {
      let timecodeScaleNs = 1_000_000;
      let duration: EbmlElement | null = null;
      for (let p = el.dataStart; p < el.end; ) {
        const child = readElement(buf, p);
        if (child.id === EBML_ID.TIMECODE_SCALE && child.dataSize) timecodeScaleNs = readUint(buf, child.dataStart, child.dataSize);
        if (child.id === EBML_ID.DURATION) duration = child;
        p = child.end;
      }
      return { segment, info: el, timecodeScaleNs, duration };
    }
    // Clusters are unknown-size in live files; Info always precedes them.
    if (el.id === EBML_ID.CLUSTER || el.dataSize === null) break;
    pos = el.end;
  }
  throw new Error('EBML: Segment Info element missing');
}

/** Duration in milliseconds declared by the file, or null when the muxer wrote none (live WebM). */
export function readWebmDuration(buf: Uint8Array): number | null {
  const { duration, timecodeScaleNs } = locateInfo(buf);
  if (!duration || !duration.dataSize) return null;
  const ticks = readFloat(buf, duration.dataStart, duration.dataSize);
  return Math.round((ticks * timecodeScaleNs) / 1_000_000);
}

/** Returns a copy of `input` whose Segment→Info declares `durationMs` (existing Duration replaced). */
export function withWebmDuration(input: Uint8Array, durationMs: number): Uint8Array {
  const { segment, info, timecodeScaleNs, duration } = locateInfo(input);
  const ticks = (durationMs * 1_000_000) / timecodeScaleNs;
  const durationEl = new Uint8Array(2 + 1 + 8);
  durationEl.set(idBytes(EBML_ID.DURATION), 0);
  durationEl[2] = 0x88;
  new DataView(durationEl.buffer).setFloat64(3, ticks);

  // New Info payload: children without the old Duration, plus the new one.
  const children: Uint8Array[] = [];
  for (let p = info.dataStart; p < info.end; ) {
    const child = readElement(input, p);
    if (child !== duration && child.id !== EBML_ID.DURATION) children.push(input.subarray(child.start, child.end));
    p = child.end;
  }
  children.push(durationEl);
  const payloadSize = children.reduce((n, c) => n + c.length, 0);
  const infoId = idBytes(EBML_ID.INFO);
  const infoSize = encodeVintSize(payloadSize);
  const newInfoLength = infoId.length + infoSize.length + payloadSize;
  const delta = newInfoLength - (info.end - info.start);

  const segmentHeaderLen = segment.dataStart - segment.start;
  let segmentHeader = input.subarray(segment.start, segment.dataStart);
  if (segment.dataSize !== null) {
    // Known-size Segment: re-encode its size (8-byte VINT) so it still spans everything.
    const segId = idBytes(EBML_ID.SEGMENT);
    const newSegSize = encodeVintSize(segment.dataSize + delta);
    segmentHeader = new Uint8Array(segId.length + newSegSize.length);
    segmentHeader.set(segId, 0);
    segmentHeader.set(newSegSize, segId.length);
  }
  const headerDelta = segmentHeader.length - segmentHeaderLen;

  const out = new Uint8Array(input.length + delta + headerDelta);
  let o = 0;
  const put = (bytes: Uint8Array) => {
    out.set(bytes, o);
    o += bytes.length;
  };
  put(input.subarray(0, segment.start));
  put(segmentHeader);
  put(input.subarray(segment.dataStart, info.start));
  put(infoId);
  put(infoSize);
  for (const c of children) put(c);
  put(input.subarray(info.end));
  return out;
}
