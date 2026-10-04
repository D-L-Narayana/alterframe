/**
 * WebM duration patch (owner: W10). MediaRecorder writes a "live" WebM without Segment→Info→Duration,
 * so a <video> reports `duration = Infinity` and a seek slider has no range. The transport e2e spec
 * generates its fixture in-browser and runs it through `withWebmDuration` so the file behaves like a
 * normal clip. Pure EBML byte manipulation, tested on synthetic structures.
 */
import { describe, it, expect } from 'vitest';
import { EBML_ID, encodeVintSize, readElement, readVint, readWebmDuration, withWebmDuration } from '../../e2e/helpers/webm';

const idBytes = (id: number): number[] => {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
};
/** Element with a 1-byte size (data < 127 bytes). */
const el = (id: number, data: number[]): number[] => [...idBytes(id), 0x80 | data.length, ...data];
/** Element with an unknown size (only legal for master elements). */
const unknown = (id: number, data: number[]): number[] => [...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...data];
const TIMECODE_SCALE_1MS = el(EBML_ID.TIMECODE_SCALE, [0x0f, 0x42, 0x40]); // 1 000 000 ns
const MUXING_APP = el(0x4d80, [0x74, 0x65, 0x73, 0x74]); // "test"
const TRACKS = el(EBML_ID.TRACKS, [0xae, 0x80]); // one empty TrackEntry
const CLUSTER = unknown(EBML_ID.CLUSTER, [0xe7, 0x81, 0x00, 0xa3, 0x82, 0x01, 0x02]); // Timecode 0 + a SimpleBlock

function liveWebm(infoChildren: number[] = [...TIMECODE_SCALE_1MS, ...MUXING_APP]): Uint8Array {
  const header = el(EBML_ID.EBML, [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]); // DocType "webm"
  const info = el(EBML_ID.INFO, infoChildren);
  return Uint8Array.from([...header, ...unknown(EBML_ID.SEGMENT, [...info, ...TRACKS, ...CLUSTER])]);
}

describe('EBML primitives', () => {
  it('reads variable-length integers with and without the length marker', () => {
    expect(readVint(Uint8Array.from([0x81]), 0, false)).toEqual({ value: 1, length: 1, unknown: false });
    expect(readVint(Uint8Array.from([0x40, 0x01]), 0, false)).toEqual({ value: 1, length: 2, unknown: false });
    expect(readVint(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 0, true)).toEqual({ value: EBML_ID.EBML, length: 4, unknown: false });
    expect(readVint(Uint8Array.from([0xff]), 0, false).unknown).toBe(true);
    expect(readVint(Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, false)).toMatchObject({ length: 8, unknown: true });
  });

  it('encodes sizes as 8-byte VINTs', () => {
    expect(Array.from(encodeVintSize(1))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(encodeVintSize(0x01_02_03))).toEqual([0x01, 0, 0, 0, 0, 1, 2, 3]);
    expect(readVint(encodeVintSize(123456), 0, false)).toEqual({ value: 123456, length: 8, unknown: false });
  });

  it('reads elements, including unknown-size master elements', () => {
    const buf = liveWebm();
    const header = readElement(buf, 0);
    expect(header.id).toBe(EBML_ID.EBML);
    expect(header.dataSize).toBe(7);
    const segment = readElement(buf, header.end);
    expect(segment.id).toBe(EBML_ID.SEGMENT);
    expect(segment.dataSize).toBeNull();
    expect(segment.end).toBe(buf.length);
    const info = readElement(buf, segment.dataStart);
    expect(info.id).toBe(EBML_ID.INFO);
  });
});

describe('withWebmDuration', () => {
  it('a live WebM has no duration; after the patch it reports the given duration in ms', () => {
    const live = liveWebm();
    expect(readWebmDuration(live)).toBeNull();
    const patched = withWebmDuration(live, 2000);
    expect(readWebmDuration(patched)).toBe(2000);
  });

  it('keeps the EBML header and everything after Info byte-identical', () => {
    const live = liveWebm();
    const patched = withWebmDuration(live, 1500);
    const header = readElement(live, 0);
    expect(Array.from(patched.subarray(0, header.end))).toEqual(Array.from(live.subarray(0, header.end)));
    const tail = [...TRACKS, ...CLUSTER];
    expect(Array.from(patched.subarray(patched.length - tail.length))).toEqual(tail);
    expect(Array.from(live.subarray(live.length - tail.length))).toEqual(tail);
    // Segment stays an unknown-size master element.
    const seg = readElement(patched, header.end);
    expect(seg.id).toBe(EBML_ID.SEGMENT);
    expect(seg.dataSize).toBeNull();
    // Info's size field describes exactly its new content.
    const info = readElement(patched, seg.dataStart);
    expect(info.id).toBe(EBML_ID.INFO);
    expect(readElement(patched, info.end).id).toBe(EBML_ID.TRACKS);
  });

  it('honours a non-default TimecodeScale', () => {
    const scale100us = el(EBML_ID.TIMECODE_SCALE, [0x01, 0x86, 0xa0]); // 100 000 ns
    const patched = withWebmDuration(liveWebm([...scale100us]), 2000);
    expect(readWebmDuration(patched)).toBe(2000);
  });

  it('overwrites an existing Duration instead of adding a second one', () => {
    const once = withWebmDuration(liveWebm(), 2000);
    const twice = withWebmDuration(once, 3250);
    expect(readWebmDuration(twice)).toBe(3250);
    const seg = readElement(twice, readElement(twice, 0).end);
    const info = readElement(twice, seg.dataStart);
    let durations = 0;
    for (let p = info.dataStart; p < info.end; ) {
      const child = readElement(twice, p);
      if (child.id === EBML_ID.DURATION) durations++;
      p = child.end;
    }
    expect(durations).toBe(1);
  });

  it('updates a KNOWN Segment size when the muxer wrote one', () => {
    const header = el(EBML_ID.EBML, [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const info = el(EBML_ID.INFO, [...TIMECODE_SCALE_1MS]);
    const children = [...info, ...TRACKS];
    const known = Uint8Array.from([...header, ...el(EBML_ID.SEGMENT, children)]);
    const patched = withWebmDuration(known, 800);
    const seg = readElement(patched, readElement(patched, 0).end);
    expect(seg.dataSize).not.toBeNull();
    expect(seg.end).toBe(patched.length);
    expect(readWebmDuration(patched)).toBe(800);
  });

  it('rejects buffers without a Segment Info element', () => {
    const header = el(EBML_ID.EBML, [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const noInfo = Uint8Array.from([...header, ...unknown(EBML_ID.SEGMENT, [...TRACKS, ...CLUSTER])]);
    expect(() => withWebmDuration(noInfo, 1000)).toThrow(/Info/);
    expect(() => withWebmDuration(Uint8Array.from([1, 2, 3]), 1000)).toThrow(/EBML/);
  });
});
