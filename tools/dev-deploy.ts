/**
 * Bundle the addon and install it into a running Wealthfolio.
 *
 * Wealthfolio's own hot-reload server only talks to a Wealthfolio built from
 * source, so it cannot reach the Docker instance. This is the equivalent for a
 * release build, run on demand: full `pnpm bundle` (clean → type-check →
 * build → zip), then push the zip to the container's `POST /addons/install-zip`
 * — the same call the "Install from file" button makes, minus the file picker.
 *
 * Reinstalling preserves the addon's stored secrets, so Trading 212
 * credentials survive. Reload the Wealthfolio tab afterwards: the frontend
 * loads addons at startup and nothing external can re-trigger that.
 *
 *   pnpm dev:deploy            # or the "Addon: deploy to Wealthfolio" task
 *   WF_URL=… pnpm dev:deploy   # default http://127.0.0.1:8088
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WF_URL = (process.env.WF_URL ?? 'http://127.0.0.1:8088').replace(/\/+$/, '');
// The connector that invoked us, not this file's own location: one tool serves
// every connector in the workspace, and each runs it from its own directory.
const ROOT = process.cwd();

interface Manifest {
  id: string;
  version: string;
  network?: { allowedHosts?: string[] };
}

const manifest = JSON.parse(await readFile(resolve(ROOT, 'manifest.json'), 'utf-8')) as Manifest;
const started = Date.now();

console.log('Bundling…');
try {
  await run('pnpm', ['bundle'], { cwd: ROOT });
} catch (error) {
  // Almost always a type error; tsc has already printed the detail.
  console.error(tail(error));
  console.error('\nBundle failed — nothing was deployed.');
  process.exit(1);
}

const zip = await readFile(resolve(ROOT, `${manifest.id}-${manifest.version}.zip`));
console.log(`Installing ${manifest.id} ${manifest.version} → ${WF_URL}`);

let response: Response;
try {
  response = await fetch(`${WF_URL}/api/v1/addons/install-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      zipDataB64: zip.toString('base64'),
      enableAfterInstall: true,
      // Pre-approving what the manifest already declares keeps this
      // unattended. It cannot widen access: the host still refuses any host
      // the manifest does not list.
      approvedNetworkHosts: manifest.network?.allowedHosts ?? [],
    }),
  });
} catch (error) {
  console.error(
    `Could not reach ${WF_URL} (${error instanceof Error ? error.message : String(error)}).`,
  );
  console.error('Is the container up? Try the "Wealthfolio: up" task.');
  process.exit(1);
}

if (!response.ok) {
  console.error(`Install failed: HTTP ${response.status}\n${await response.text()}`);
  process.exit(1);
}

console.log(`Deployed in ${Date.now() - started}ms. Reload the Wealthfolio tab to pick it up.`);

function tail(error: unknown): string {
  const output = error as { stdout?: string; stderr?: string };
  const text = `${output.stdout ?? ''}${output.stderr ?? ''}`.trim();
  return text.split('\n').slice(-8).join('\n') || String(error);
}
