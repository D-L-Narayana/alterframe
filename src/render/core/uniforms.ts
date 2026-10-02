import type { UniformValue } from '@/types';

export type UniformKind = '1f' | '2f' | '3f' | '4f' | 'mat3' | 'mat4' | '1fv';

/**
 * Infer the GL setter from the value shape (the contract UniformValue is untyped by design):
 * number → float; tuples → vecN; Float32Array 1..4 → vecN, 9 → mat3, 16 → mat4, else float[].
 */
export function classifyUniform(v: UniformValue): UniformKind {
  if (typeof v === 'number') return '1f';
  const n = v.length;
  if (v instanceof Float32Array) {
    if (n === 9) return 'mat3';
    if (n === 16) return 'mat4';
    if (n >= 1 && n <= 4) return `${n}f` as UniformKind;
    return '1fv';
  }
  return `${n}f` as UniformKind;
}

/** Cached uniform locations for one program plus typed setters. */
export class UniformCache {
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: WebGL2RenderingContext, private readonly program: WebGLProgram) {}

  location(name: string): WebGLUniformLocation | null {
    let loc = this.locations.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, loc);
    }
    return loc;
  }

  has(name: string): boolean {
    return this.location(name) !== null;
  }

  set1i(name: string, v: number): void {
    const l = this.location(name);
    if (l) this.gl.uniform1i(l, v);
  }

  set1f(name: string, v: number): void {
    const l = this.location(name);
    if (l) this.gl.uniform1f(l, v);
  }

  set2f(name: string, x: number, y: number): void {
    const l = this.location(name);
    if (l) this.gl.uniform2f(l, x, y);
  }

  set4f(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.location(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }

  /** Generic setter driven by classifyUniform. Unknown names are silently ignored (GL semantics). */
  set(name: string, v: UniformValue): void {
    const l = this.location(name);
    if (!l) return;
    const gl = this.gl;
    switch (classifyUniform(v)) {
      case '1f':
        gl.uniform1f(l, typeof v === 'number' ? v : (v[0] ?? 0));
        break;
      case '2f':
        gl.uniform2fv(l, v as Float32Array | [number, number]);
        break;
      case '3f':
        gl.uniform3fv(l, v as Float32Array | [number, number, number]);
        break;
      case '4f':
        gl.uniform4fv(l, v as Float32Array | [number, number, number, number]);
        break;
      case 'mat3':
        gl.uniformMatrix3fv(l, false, v as Float32Array);
        break;
      case 'mat4':
        gl.uniformMatrix4fv(l, false, v as Float32Array);
        break;
      case '1fv':
        gl.uniform1fv(l, v as Float32Array);
        break;
    }
  }
}
