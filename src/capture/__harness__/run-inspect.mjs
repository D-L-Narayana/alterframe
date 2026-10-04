/* eslint-disable no-console */
/* global process */
// Zero-dependency runner for inspect.mjs: starts the Vite dev server on a private port, waits until the
// harness page answers, runs the inspection in headless Chromium, then stops the server (and its process
// group) and exits with the inspection's exit code.
//   node src/capture/__harness__/run-inspect.mjs [--port 6219]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 6219;
const host = '127.0.0.1';
const url = `http://${host}:${port}/src/capture/__harness__/index.html`;
const viteBin = ['node_modules/vite/bin/vite.js', 'node_modules/.bin/vite'].map((p) => path.join(root, p)).find((p) => existsSync(p));
if (!viteBin) {
  console.error('[run-inspect] vite is not installed (run npm ci first)');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = process.platform !== 'win32';
const server = spawn(process.execPath, [viteBin, '--port', String(port), '--host', host, '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: posix, // own process group so the esbuild helpers die with the server
});
let serverLog = '';
let serverExited = false;
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
server.on('exit', () => { serverExited = true; });

async function waitForServer(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) throw new Error(`vite exited early:\n${serverLog}`);
    try {
      const res = await fetch(url);
      await res.text();
      if (res.ok) return Date.now() - t0;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`vite did not answer at ${url} within ${timeoutMs} ms:\n${serverLog}`);
}

function stopServer() {
  return new Promise((resolve) => {
    if (serverExited) return resolve();
    server.once('exit', () => resolve());
    const signal = (sig) => {
      try {
        if (posix) process.kill(-server.pid, sig);
        else server.kill(sig);
      } catch {
        /* already gone */
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      signal('SIGKILL');
      resolve();
    }, 3000).unref();
  });
}

let code = 1;
try {
  const readyMs = await waitForServer();
  console.log(`[run-inspect] vite ready at ${url} after ${readyMs} ms`);
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'inspect.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, HARNESS_URL: url },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (e) => {
      console.error(`[run-inspect] could not start inspect.mjs: ${e.message}`);
      resolve(1);
    });
  });
} catch (e) {
  console.error(`[run-inspect] ${e instanceof Error ? e.message : String(e)}`);
  code = 2;
} finally {
  await stopServer();
}
console.log(`[run-inspect] done, exit ${code}`);
process.exit(code);
