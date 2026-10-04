import { describe, it, expect } from 'vitest';
import { GpuTimer, type TimerGl } from '../../../src/render/core/gpuTimer';

interface FakeQuery { id: number; available: boolean; resultNs: number; deleted: boolean }

/**
 * Minimal WebGL2 + EXT_disjoint_timer_query_webgl2 fake. Records protocol violations the real API
 * would turn into GL errors (begin while active, reading an active/unavailable result, double delete).
 */
class FakeGl {
  readonly QUERY_RESULT = 0x8866;
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  hasExt = true;
  disjoint = false;
  active: FakeQuery | null = null;
  created: FakeQuery[] = [];
  deleted: FakeQuery[] = [];
  paramCalls = 0;
  errors: string[] = [];

  getExtension(name: string): unknown {
    return name === 'EXT_disjoint_timer_query_webgl2' && this.hasExt ? this.ext : null;
  }
  createQuery(): WebGLQuery {
    const q: FakeQuery = { id: this.created.length, available: false, resultNs: 0, deleted: false };
    this.created.push(q);
    return q as unknown as WebGLQuery;
  }
  beginQuery(target: number, q: WebGLQuery): void {
    if (target !== this.ext.TIME_ELAPSED_EXT) this.errors.push('beginQuery: wrong target');
    if (this.active) this.errors.push('beginQuery while a query is active');
    this.active = q as unknown as FakeQuery;
  }
  endQuery(target: number): void {
    if (target !== this.ext.TIME_ELAPSED_EXT) this.errors.push('endQuery: wrong target');
    if (!this.active) this.errors.push('endQuery without an active query');
    this.active = null;
  }
  deleteQuery(q: WebGLQuery | null): void {
    const f = q as unknown as FakeQuery | null;
    if (!f) return;
    if (f.deleted) this.errors.push('double delete');
    f.deleted = true;
    if (this.active === f) this.active = null;
    this.deleted.push(f);
  }
  getQueryParameter(q: WebGLQuery, pname: number): unknown {
    this.paramCalls++;
    const f = q as unknown as FakeQuery;
    if (f === this.active) this.errors.push('getQueryParameter on the active query');
    if (f.deleted) this.errors.push('getQueryParameter on a deleted query');
    if (pname === this.QUERY_RESULT_AVAILABLE) return f.available;
    if (pname === this.QUERY_RESULT) {
      if (!f.available) this.errors.push('QUERY_RESULT read before it was available');
      return f.resultNs;
    }
    return null;
  }
  getParameter(pname: number): unknown {
    if (pname === this.ext.GPU_DISJOINT_EXT) {
      const d = this.disjoint;
      this.disjoint = false; // reading resets the flag, like the real extension
      return d;
    }
    return null;
  }
  /** Mark query #index finished with a GPU time in ms. */
  complete(index: number, ms: number): void {
    const q = this.created[index]!;
    q.available = true;
    q.resultNs = ms * 1e6;
  }
  get inFlightNotDeleted(): number {
    return this.created.filter((q) => !q.deleted).length;
  }
}

const asGl = (f: FakeGl): TimerGl => f as unknown as TimerGl;
const frame = (t: GpuTimer): void => { t.begin(); t.end(); };

describe('GpuTimer (EXT_disjoint_timer_query_webgl2, asynchronous polling)', () => {
  it('is unavailable without the extension: null forever, no queries created', () => {
    const gl = new FakeGl();
    gl.hasExt = false;
    const t = new GpuTimer(asGl(gl));
    expect(t.available).toBe(false);
    frame(t);
    frame(t);
    expect(t.gpuMs).toBeNull();
    expect(gl.created).toHaveLength(0);
    expect(gl.errors).toEqual([]);
  });

  it('wraps a frame in one TIME_ELAPSED query and publishes the result only once a later frame finds it available', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl));
    expect(t.available).toBe(true);
    frame(t); // frame 1: query 0 in flight
    expect(gl.created).toHaveLength(1);
    expect(t.pending).toBe(1);
    expect(t.gpuMs).toBeNull(); // no result yet
    frame(t); // frame 2: polled once, still unavailable
    expect(t.gpuMs).toBeNull();
    gl.complete(0, 3.5);
    frame(t); // frame 3: result picked up, query deleted
    expect(t.gpuMs).toBeCloseTo(3.5, 9);
    expect(gl.deleted.map((q) => q.id)).toEqual([0]);
    expect(gl.errors).toEqual([]);
  });

  it('never spins: at most one availability check per in-flight query per frame', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl));
    frame(t);
    frame(t);
    const before = gl.paramCalls;
    t.begin(); // polls the two unfinished queries: ≤ 2 availability checks, no result reads
    expect(gl.paramCalls - before).toBeLessThanOrEqual(2);
    t.end();
    expect(gl.errors).toEqual([]);
  });

  it('keeps at most maxInFlight queries alive; frames beyond that are simply not measured until results drain', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl), 3);
    for (let i = 0; i < 6; i++) frame(t);
    expect(t.pending).toBe(3);
    expect(gl.created).toHaveLength(3);
    expect(gl.inFlightNotDeleted).toBe(3);
    gl.complete(0, 1);
    gl.complete(1, 2);
    frame(t); // drains two finished ones (newest wins), then measures again
    expect(t.gpuMs).toBe(2);
    expect(gl.deleted.map((q) => q.id).sort()).toEqual([0, 1]);
    expect(t.pending).toBe(2); // query 2 still pending + the new one
    expect(gl.errors).toEqual([]);
  });

  it('publishes the newest finished result when several complete out of order and deletes all finished ones', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl));
    frame(t);
    frame(t);
    frame(t);
    gl.complete(2, 9);
    gl.complete(0, 4);
    frame(t);
    expect(t.gpuMs).toBe(9);
    expect(gl.deleted.map((q) => q.id).sort()).toEqual([0, 2]);
    expect(gl.created[1]!.deleted).toBe(false);
    gl.complete(1, 5); // an older result arriving later must not overwrite the newer one
    frame(t);
    expect(t.gpuMs).toBe(9);
    expect(gl.created[1]!.deleted).toBe(true);
    expect(gl.errors).toEqual([]);
  });

  it('a disjoint event invalidates pending results: gpuMs becomes null, queries are discarded, timing resumes afterwards', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl));
    frame(t);
    gl.complete(0, 2);
    frame(t);
    expect(t.gpuMs).toBe(2);
    frame(t);
    gl.complete(1, 7);
    gl.complete(2, 8);
    gl.disjoint = true;
    frame(t);
    expect(t.gpuMs).toBeNull();
    expect(gl.created[1]!.deleted).toBe(true);
    expect(gl.created[2]!.deleted).toBe(true);
    // The frame after the disjoint read starts a fresh query and results flow again.
    const fresh = gl.created.length - 1;
    gl.complete(fresh, 1.25);
    frame(t);
    expect(t.gpuMs).toBe(1.25);
    expect(gl.errors).toEqual([]);
  });

  it('dispose ends an open query, deletes every query and makes later calls harmless', () => {
    const gl = new FakeGl();
    const t = new GpuTimer(asGl(gl));
    frame(t);
    frame(t);
    t.begin(); // open query at dispose time
    t.dispose();
    expect(gl.active).toBeNull();
    expect(gl.inFlightNotDeleted).toBe(0);
    expect(t.pending).toBe(0);
    expect(t.gpuMs).toBeNull();
    frame(t);
    expect(gl.created).toHaveLength(3); // nothing new after dispose
    expect(gl.errors).toEqual([]);
  });

  it('tolerates createQuery returning null (lost context): frame is skipped without errors', () => {
    const gl = new FakeGl();
    gl.createQuery = () => null as unknown as WebGLQuery;
    const t = new GpuTimer(asGl(gl));
    frame(t);
    expect(t.pending).toBe(0);
    expect(t.gpuMs).toBeNull();
    expect(gl.errors).toEqual([]);
  });
});
