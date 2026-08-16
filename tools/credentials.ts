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
  return readPair('T212', 'Trading 212', 'Generate the pair in the Trading 212 app under Settings → API.');
}

/**
 * The Kraken pair, for `pnpm smoke:live` in `connectors/kraken`.
 *
 * `KRAKEN_API_SECRET` is Kraken's "Private key" — base64, stored exactly as it
 * is displayed. It is decoded at signing time, so nothing has to keep a second
 * form of it.
 */
export function requireKrakenCredentials(): { apiKey: string; apiSecret: string } {
  return readPair(
    'KRAKEN',
    'Kraken',
    'Kraken Pro → Settings → API → Add API key. Tick exactly three permissions:\n' +
      '  Funds · Query, Orders · Query closed orders & trades, Data · Query ledger entries.\n' +
      'Everything else is a write path that adds no read access.',
  );
}

/**
 * Shared lookup. Exits rather than returning empty strings: a script that
 * carries on with no credentials fails later with an auth error that says
 * nothing about the cause.
 */
function readPair(
  prefix: string,
  provider: string,
  guidance: string,
): { apiKey: string; apiSecret: string } {
  const dotEnv = fromDotEnv();
  const apiKey = process.env[`${prefix}_API_KEY`] ?? dotEnv[`${prefix}_API_KEY`] ?? '';
  const apiSecret = process.env[`${prefix}_API_SECRET`] ?? dotEnv[`${prefix}_API_SECRET`] ?? '';

  if (!apiKey || !apiSecret) {
    console.error(
      `Missing ${provider} credentials.\n\n` +
        'Create a .env file in the project root (git ignores it) with:\n' +
        `  ${prefix}_API_KEY=your-key\n` +
        `  ${prefix}_API_SECRET=your-secret\n\n` +
        `${guidance}\n` +
        'The addon itself does not use these; it asks for the pair in its own form.',
    );
    process.exit(1);
  }

  return { apiKey, apiSecret };
}
