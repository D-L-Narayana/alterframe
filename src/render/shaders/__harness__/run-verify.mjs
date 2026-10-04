#!/usr/bin/env node
/**
 * One-shot GPU verification for the shader harness (Node built-ins only): starts the Vite dev
 * server on a dedicated port, waits until the harness page answers, runs verify.mjs against it
 * and stops the server again — no background shell job needed.
 *
 *   node src/render/shaders/__harness__/run-verify.mjs [--port 6215] [--host 127.0.0.1] [--out <dir>]
 *        [--timeout <ms>] [--browsers-path <dir>] [--log <file>]
 *
 * Run from anywhere inside the repository; exit code = verify.mjs's (0 = every check passed).
 * `--browsers-path` points Playwright at an existing browser cache (sets PLAYWRIGHT_BROWSERS_PATH
 * for the verify step only) when the browsers were installed under a different HOME.
 * `--log` additionally writes the verify transcript to a file (CI artefact / evidence).
 * `vite.config.ts` sets `strictPort`, so a busy port fails fast instead of moving.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(arg('--port', '6215'));
const host = arg('--host', '127.0.0.1');
const out = arg('--out', null);
const browsersPath = arg('--browsers-path', null);
const logFile = arg('--log', null);
const readyTimeoutMs = Number(arg('--timeout', '120000'));
const base = `http://${host}:${port}`;
const pageUrl = `${base}/src/render/shaders/__harness__/index.html`;

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error(`[run-verify] vite not found at ${viteBin} — run npm ci first`);
  process.exit(2);
}

let finished = false;
let serverLog = '';
const server = spawn(process.execPath, [viteBin, '--port', String(port), '--host', host, '--strictPort'], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });
server.on('exit', (code) => {
  if (!finished) {
    console.error(`[run-verify] dev server exited early (code ${code})\n${serverLog}`);
    process.exit(code === 0 ? 1 : code ?? 1);
  }
});

function stopServer() {
  finished = true;
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 3000).unref();
  }
}
process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('SIGTERM', () => { stopServer(); process.exit(143); });

async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < readyTimeoutMs) {
    try {
      const res = await fetch(pageUrl, { redirect: 'manual' });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`dev server did not serve ${pageUrl} within ${readyTimeoutMs} ms\n${serverLog}`);
}

try {
  await waitReady();
  console.log(`[run-verify] dev server ready at ${base} — running verify.mjs (headless Chromium, SwiftShader)`);
  const verifyArgs = [join(here, 'verify.mjs'), '--url', base];
  if (out) verifyArgs.push('--out', out);
  const verifyEnv = browsersPath ? { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath } : process.env;
  const verify = spawn(process.execPath, verifyArgs, { cwd: root, env: verifyEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let transcript = '';
  verify.stdout.on('data', (d) => { process.stdout.write(d); transcript += d.toString(); });
  verify.stderr.on('data', (d) => { process.stderr.write(d); transcript += d.toString(); });
  const code = await new Promise((resolveCode) => verify.on('close', (c) => resolveCode(c ?? 1)));
  stopServer();
  if (logFile) writeFileSync(logFile, `${new Date().toISOString()} ${base} verify exit ${code} (headless Chromium, SwiftShader)\n${transcript}`);
  process.exit(code);
} catch (err) {
  stopServer();
  console.error(`[run-verify] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
