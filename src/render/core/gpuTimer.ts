/**
 * GPU frame timing through `EXT_disjoint_timer_query_webgl2`.
 *
 * One TIME_ELAPSED_EXT query brackets a frame's draws. Results arrive asynchronously, so they are
 * polled on LATER frames (one `QUERY_RESULT_AVAILABLE` check per in-flight query per frame, never a
 * spin) and the newest finished value is published. A small ring bounds the in-flight queries;
 * finished and discarded queries are deleted. `gpuMs` is null without the extension, after a
 * disjoint event (the GPU clock was unreliable: pending results are thrown away) or before the
 * first result lands.
 */
export interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** The slice of WebGL2 the timer touches, so Node tests can drive it with a fake. */
export type TimerGl = Pick<
  WebGL2RenderingContext,
  'getExtension' | 'createQuery' | 'beginQuery' | 'endQuery' | 'deleteQuery' | 'getQueryParameter' | 'getParameter' | 'QUERY_RESULT' | 'QUERY_RESULT_AVAILABLE'
>;

interface InFlight {
  query: WebGLQuery;
  /** Monotonic frame number so the newest result wins even when they complete out of order. */
  seq: number;
}

export class GpuTimer {
  private readonly ext: TimerQueryExt | null;
  private readonly inFlight: InFlight[] = [];
  private active: WebGLQuery | null = null;
  private seq = 0;
  private latest: number | null = null;
  private latestSeq = -1;
  private disposed = false;

  constructor(private readonly gl: TimerGl, private readonly maxInFlight = 4) {
    this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null) ?? null;
  }

  /** True when the extension exists on this context. */
  get available(): boolean {
    return this.ext !== null && !this.disposed;
  }

  /** Newest completed frame time in ms, or null (no extension / disjoint / nothing finished yet). */
  get gpuMs(): number | null {
    return this.latest;
  }

  /** Queries issued and not yet resolved. */
  get pending(): number {
    return this.inFlight.length;
  }

  /** Call before the frame's first draw: collects finished results, then opens a new query if the ring has room. */
  begin(): void {
    if (!this.ext || this.disposed || this.active) return;
    this.poll();
    if (this.inFlight.length >= this.maxInFlight) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  /** Call after the frame's last draw. */
  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inFlight.push({ query: this.active, seq: this.seq++ });
    this.active = null;
  }

  /** Ends an open query and deletes every query; later begin/end calls are no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ext && this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active);
      this.active = null;
    }
    for (const q of this.inFlight) this.gl.deleteQuery(q.query);
    this.inFlight.length = 0;
    this.latest = null;
  }

  private poll(): void {
    if (!this.ext || this.inFlight.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      // Timer values spanning a disjoint event are meaningless: drop everything and start over.
      for (const q of this.inFlight) gl.deleteQuery(q.query);
      this.inFlight.length = 0;
      this.latest = null;
      return;
    }
    let best: InFlight | null = null;
    let bestNs = 0;
    for (let i = this.inFlight.length - 1; i >= 0; i--) {
      const q = this.inFlight[i]!;
      if (!(gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE) as boolean)) continue;
      const ns = Number(gl.getQueryParameter(q.query, gl.QUERY_RESULT));
      gl.deleteQuery(q.query);
      this.inFlight.splice(i, 1);
      if (!best || q.seq > best.seq) {
        best = q;
        bestNs = ns;
      }
    }
    if (best && best.seq > this.latestSeq) {
      this.latestSeq = best.seq;
      this.latest = bestNs / 1e6;
    }
  }
}
