/**
 * Watch, rebundle, reinstall.
 *
 * Wealthfolio's own hot-reload server only talks to a Wealthfolio built from
 * source, so it cannot reach the Docker instance. This is the equivalent loop
 * for a release build: on every save it runs the full `pnpm bundle` (clean →
 * type-check → build → zip) and pushes the result to the container's
 * `POST /addons/install-zip` endpoint.
 *
 * Reinstalling preserves the addon's stored secrets, so your Trading 212
 * credentials survive each cycle. The browser tab still needs a manual reload:
 * the frontend loads addons at startup and there is no external trigger to
 * re-run that.
 *
 *   pnpm dev:deploy
 *
 * Point it elsewhere with WF_URL (default http://127.0.0.1:8088).
 */

import { execFile } from 'node:child_process';
import { readFile, watch } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WF_URL = (process.env.WF_URL ?? 'http://127.0.0.1:8088').replace(/\/+$/, '');
const ROOT = resolve(import.meta.dirname, '..');
const WATCHED = ['src', 'manifest.json'];
const DEBOUNCE_MS = 300;

interface Manifest {
  id: string;
  version: string;
  network?: { allowedHosts?: string[] };
}

const manifest = JSON.parse(await readFile(resolve(ROOT, 'manifest.json'), 'utf-8')) as Manifest;
const zipPath = resolve(ROOT, `trading212-import-${manifest.version}.zip`);

console.log(`Watching ${WATCHED.join(', ')} → ${WF_URL}`);
console.log('Reload the Wealthfolio tab after each deploy.\n');

// Declared before the first deploy() call: `let` bindings are in the temporal
// dead zone until initialised, and deploy() reads them.
let timer: NodeJS.Timeout | undefined;
let running = false;
let queued = false;

await deploy('initial');

for (const target of WATCHED) {
  void (async () => {
    for await (const event of watch(resolve(ROOT, target), { recursive: true })) {
      if (event.filename?.endsWith('~')) continue;
      clearTimeout(timer);
      timer = setTimeout(() => void deploy(event.filename ?? target), DEBOUNCE_MS);
    }
  })();
}

async function deploy(reason: string): Promise<void> {
  // A save during a build queues exactly one more run rather than piling up.
  if (running) {
    queued = true;
    return;
  }
  running = true;

  const started = Date.now();
  console.log(`[${time()}] ${reason} → bundling…`);

  try {
    await run('pnpm', ['bundle'], { cwd: ROOT });
  } catch (error) {
    // Type errors are the common case here; keep watching so the next save
    // gets another go.
    console.error(`[${time()}] bundle failed:\n${tail(error)}`);
    running = false;
    if (queued) {
      queued = false;
      void deploy('queued change');
    }
    return;
  }

  try {
    const zip = await readFile(zipPath);
    const response = await fetch(`${WF_URL}/api/v1/addons/install-zip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        zipDataB64: zip.toString('base64'),
        enableAfterInstall: true,
        // Pre-approving what the manifest already declares keeps the loop
        // unattended. It cannot widen access: the host still refuses any host
        // the manifest does not list.
        approvedNetworkHosts: manifest.network?.allowedHosts ?? [],
      }),
    });

    if (!response.ok) {
      console.error(`[${time()}] install failed: HTTP ${response.status} ${await response.text()}`);
    } else {
      const installed = (await response.json()) as { version?: string };
      console.log(
        `[${time()}] deployed ${manifest.id} ${installed.version ?? ''} in ${
          Date.now() - started
        }ms — reload the tab`,
      );
    }
  } catch (error) {
    console.error(
      `[${time()}] could not reach ${WF_URL} (${
        error instanceof Error ? error.message : String(error)
      }). Is the container up?`,
    );
  }

  running = false;
  if (queued) {
    queued = false;
    void deploy('queued change');
  }
}

function time(): string {
  return new Date().toTimeString().slice(0, 8);
}

function tail(error: unknown): string {
  const output = error as { stdout?: string; stderr?: string };
  const text = `${output.stdout ?? ''}${output.stderr ?? ''}`.trim();
  return text.split('\n').slice(-6).join('\n') || String(error);
}
