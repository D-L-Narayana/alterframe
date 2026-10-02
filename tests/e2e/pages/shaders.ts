/**
 * Compiles every W5 pass on a real WebGL2 context. Prefers W4's `compilePass` (contract §W4.2);
 * falls back to raw compilation with the prelude documented in src/types/render.ts so the test is
 * meaningful before W4 lands.
 */
import type { StylePass, StylePreset } from '@/types';

// Resolved at runtime by the Vite dev server (string variables keep tsc from resolving modules that other workers may not have written yet).
const CORE_PATH = '/src/render/core/index.ts';
const STYLES_PATH = '/src/render/styles.ts';

export interface ShaderResult { preset: string; pass: string; ok: boolean; log: string; via: 'compilePass' | 'raw' }
declare global {
  interface Window { __shaderResults?: { done: boolean; error?: string; results: ShaderResult[] } }
}

/** Contract prelude (src/types/render.ts doc comment). W4's own prelude may add more; this is the minimum. */
const CONTRACT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_color;
uniform sampler2D u_video;
uniform sampler2D u_mask;
uniform sampler2D u_backdrop;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform float u_time;
out vec4 fragColor;
`;

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; v_uv.y = 1.0 - v_uv.y; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

function rawCompile(gl: WebGL2RenderingContext, pass: StylePass): { ok: boolean; log: string } {
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!fs || !vs) return { ok: false, log: 'createShader failed' };
  gl.shaderSource(vs, VERT);
  gl.compileShader(vs);
  gl.shaderSource(fs, CONTRACT_PRELUDE + pass.frag);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return { ok: false, log: gl.getShaderInfoLog(fs) ?? 'compile failed' };
  const prog = gl.createProgram();
  if (!prog) return { ok: false, log: 'createProgram failed' };
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  const ok = Boolean(gl.getProgramParameter(prog, gl.LINK_STATUS));
  const log = ok ? '' : gl.getProgramInfoLog(prog) ?? 'link failed';
  gl.deleteProgram(prog);
  gl.deleteShader(fs);
  gl.deleteShader(vs);
  return { ok, log };
}

type CompilePassFn = (pass: StylePass) => { ok: boolean; log: string } | Promise<{ ok: boolean; log: string }>;

async function loadCompilePass(): Promise<CompilePassFn | null> {
  try {
    const mod = (await import(/* @vite-ignore */ CORE_PATH)) as Record<string, unknown>;
    const fn = mod['compilePass'];
    return typeof fn === 'function' ? (fn as CompilePassFn) : null;
  } catch {
    return null;
  }
}

async function loadPresets(): Promise<Record<string, StylePreset>> {
  const mod = (await import(/* @vite-ignore */ STYLES_PATH)) as Record<string, unknown>;
  const presets = mod['STYLE_PRESETS'];
  if (!presets || typeof presets !== 'object') throw new Error('STYLE_PRESETS not exported from src/render/styles.ts');
  return presets as Record<string, StylePreset>;
}

async function main(): Promise<void> {
  const out = document.getElementById('out');
  const state: NonNullable<Window['__shaderResults']> = { done: false, results: [] };
  window.__shaderResults = state;
  try {
    const presets = await loadPresets();
    const compilePass = await loadCompilePass();
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 unavailable');
    for (const preset of Object.values(presets)) {
      for (const pass of preset.passes) {
        let res: { ok: boolean; log: string };
        let via: ShaderResult['via'] = 'raw';
        if (compilePass) {
          try {
            res = await compilePass(pass);
            via = 'compilePass';
          } catch (e) {
            res = { ok: false, log: `compilePass threw: ${String(e)}` };
          }
        } else {
          res = rawCompile(gl, pass);
        }
        // Always also raw-compile against the CONTRACT prelude: catches passes that only work with W4 extras.
        const raw = rawCompile(gl, pass);
        if (!raw.ok && res.ok) res = { ok: false, log: `compiles via W4 but not against contract prelude: ${raw.log}` };
        state.results.push({ preset: preset.id, pass: pass.id, ok: res.ok, log: res.log, via });
      }
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  state.done = true;
  if (out) out.textContent = JSON.stringify(state, null, 2);
}

void main();
