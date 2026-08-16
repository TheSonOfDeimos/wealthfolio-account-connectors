/**
 * Trading 212 credentials for the Node scripts, read from the environment.
 *
 * Only `pnpm smoke:live` and `pnpm symbols:generate` need these. They run under
 * Node, outside Wealthfolio's sandbox, so they have no keyring to read from —
 * unlike the addon itself, which asks for the key pair in its own form and
 * never stores it anywhere else.
 *
 * Put them in `.env`, which git ignores:
 *
 *   T212_API_KEY=...
 *   T212_API_SECRET=...
 *
 * They used to be constants in `src/config.ts`. That file is tracked, so a real
 * key pair reached the history and every built bundle — the reason this module
 * exists. Nothing that holds a secret should be a file git is watching.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Parse `.env` without a dependency: `KEY=value`, `#` comments, blank lines. */
function fromDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(resolve(import.meta.dirname, '../.env'), 'utf-8');
  } catch {
    return values;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Quotes are stripped so both `KEY=value` and `KEY="value"` work.
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) values[key] = value;
  }
  return values;
}

/**
 * The key pair, or a clear explanation of what is missing.
 *
 * Exits rather than returning empty strings: a script that carries on with no
 * credentials fails later with a 401 that says nothing about the cause.
 */
export function requireCredentials(): { apiKey: string; apiSecret: string } {
  const dotEnv = fromDotEnv();
  const apiKey = process.env.T212_API_KEY ?? dotEnv.T212_API_KEY ?? '';
  const apiSecret = process.env.T212_API_SECRET ?? dotEnv.T212_API_SECRET ?? '';

  if (!apiKey || !apiSecret) {
    console.error(
      'Missing Trading 212 credentials.\n\n' +
        'Create a .env file in the project root (git ignores it) with:\n' +
        '  T212_API_KEY=your-key\n' +
        '  T212_API_SECRET=your-secret\n\n' +
        'Generate the pair in the Trading 212 app under Settings → API.\n' +
        'The addon itself does not use these; it asks for the key pair in its own form.',
    );
    process.exit(1);
  }

  return { apiKey, apiSecret };
}
