#!/usr/bin/env node
/**
 * Run a command against a temporary local server (owner: W10). Zero dependencies, portable.
 *
 *   node scripts/with-server.mjs [--port 4173] [--server "node scripts/serve-dist.mjs --port 4173"]
 *        [--url http://127.0.0.1:4173/] [--timeout 60000] [--export E2E_PROD_URL,E2E_BASE_URL] -- <cmd> [args…]
 *
 * Starts the server command (no shell; split on whitespace), polls the URL until it answers, runs
 * <cmd> with the server URL exported in the listed environment variables — by default
 * E2E_PROD_URL (the production gate's target) and E2E_BASE_URL (so Playwright does not boot the
 * Vite dev server) — then stops the server. Exit code = the command's exit code.
 *
 * Typical use (after `npm run build`):
 *   node scripts/with-server.mjs -- npm run test:prod-gate
 */
import { spawn } from 'node:child_process';

function parse(argv) {
  const opts = { port: 4173, server: '', url: '', timeoutMs: 60_000, exportVars: ['E2E_PROD_URL', 'E2E_BASE_URL'], cmd: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const next = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    switch (key) {
      case '--port':
        opts.port = Number(next());
        break;
      case '--server':
        opts.server = String(next());
        break;
      case '--url':
        opts.url = String(next());
        break;
      case '--timeout':
        opts.timeoutMs = Number(next());
        break;
      case '--export':
        opts.exportVars = String(next())
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  opts.cmd = argv.slice(i);
  if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error('--port expects a positive integer');
  if (!opts.server) opts.server = `node scripts/serve-dist.mjs --port ${opts.port}`;
  if (!opts.url) opts.url = `http://127.0.0.1:${opts.port}/`;
  if (opts.cmd.length === 0) throw new Error('missing command after `--`');
  return opts;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (err) {
  console.error(`[with-server] ${err instanceof Error ? err.message : String(err)}`);
  console.error('usage: node scripts/with-server.mjs [--port N] [--server "cmd"] [--url URL] [--timeout MS] [--export A,B] -- <cmd> [args…]');
  process.exit(2);
}

const serverUrl = opts.url.replace(/\/$/, '');
const env = { ...process.env };
for (const name of opts.exportVars) env[name] = serverUrl;

const serverParts = opts.server.split(/\s+/).filter(Boolean);
const server = spawn(serverParts[0], serverParts.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
let finished = false;
server.stdout.on('data', (d) => {
  serverLog += d.toString();
});
server.stderr.on('data', (d) => {
  serverLog += d.toString();
});
server.on('exit', (code) => {
  if (!finished) {
    console.error(`[with-server] server exited early (code ${code})\n${serverLog}`);
    process.exit(code ?? 1);
  }
});

async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const res = await fetch(opts.url, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer at ${opts.url} within ${opts.timeoutMs} ms\n${serverLog}`);
}

function stopServer() {
  finished = true;
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 3000).unref();
}

try {
  await waitReady();
  console.log(`[with-server] ${serverUrl} is up (${opts.exportVars.join(', ')} exported); running: ${opts.cmd.join(' ')}`);
  const child = spawn(opts.cmd[0], opts.cmd.slice(1), { stdio: 'inherit', env });
  const forward = (sig) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  stopServer();
  process.exit(code);
} catch (err) {
  stopServer();
  console.error(`[with-server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
