import { sampleHistory } from '../../core/test/fixtures';
import { STUB_API_KEY, STUB_API_SECRET, createT212Stub } from '../../core/test/t212-stub';
import { beforeEach, describe, expect, it } from 'vitest';
import enable from '../src/addon';
import { CREDENTIALS_SECRET_KEY } from '../src/config';
import { hasCredentials, saveCredentials } from '../src/lib/credentials';
import { commitImport, fetchAccountSummary, previewImport } from '../src/lib/sync';
import { createMockHost } from './mocks/mock-host';
import type { MockHost } from './mocks/mock-host';

/**
 * End-to-end coverage of the addon against the mock host: credentials into the
 * keyring, a brokered call to the stub Trading 212 API, mapping, validation,
 * and the write. This is the substitute for a running Wealthfolio instance.
 */

function host(overrides: Parameters<typeof createMockHost>[0] = {}): MockHost {
  const stub = createT212Stub({ orders: sampleHistory() });
  return createMockHost({ handleRequest: stub.handle, ...overrides });
}

async function configured(overrides: Parameters<typeof createMockHost>[0] = {}) {
  const mock = host(overrides);
  await saveCredentials(mock.ctx, STUB_API_KEY, STUB_API_SECRET);
  return mock;
}

const preview = { accountId: 'acct-1', minRequestIntervalMs: 0 };

describe('addon registration', () => {
  it('registers the route id declared in the manifest', () => {
    const mock = host();
    enable(mock.ctx);

    expect(mock.routes.has('trading212-import')).toBe(true);
    expect(mock.routes.get('trading212-import')?.path).toBe('/addons/trading212-import');
    expect(mock.disableCallbacks).toHaveLength(1);
  });
});

describe('credentials', () => {
  let mock: MockHost;
  beforeEach(() => {
    mock = host();
  });

  it('stores base64(key:secret) under the key the broker expects', async () => {
    await saveCredentials(mock.ctx, 'my-key', 'my-secret');

    expect(await hasCredentials(mock.ctx)).toBe(true);
    expect(mock.secrets.get(CREDENTIALS_SECRET_KEY)).toBe(
      Buffer.from('my-key:my-secret').toString('base64'),
    );
  });

  it('refuses a half-filled key pair', async () => {
    await expect(saveCredentials(mock.ctx, 'key-only', '')).rejects.toThrow(/required/);
    expect(await hasCredentials(mock.ctx)).toBe(false);
  });

  it('reports no credentials before anything is saved', async () => {
    expect(await hasCredentials(mock.ctx)).toBe(false);
  });
});

describe('network brokering', () => {
  it('never puts the plaintext secret in the request the addon builds', async () => {
    const mock = await configured();
    await fetchAccountSummary(mock.ctx);

    const request = mock.requests[0]!;
    expect(request.auth).toEqual({ type: 'basic', secretKey: CREDENTIALS_SECRET_KEY });
    expect(JSON.stringify(request)).not.toContain(STUB_API_SECRET);
    // The broker, not the addon, produced the header.
    expect(mock.sentAuthorizations[0]).toBe(
      `Basic ${Buffer.from(`${STUB_API_KEY}:${STUB_API_SECRET}`).toString('base64')}`,
    );
  });

  it('only reaches hosts the manifest declares', async () => {
    const mock = await configured({ allowedHosts: ['demo.trading212.com'] });
    await expect(fetchAccountSummary(mock.ctx)).rejects.toThrow(/allowedHosts/);
  });

  it('fails clearly when credentials are missing', async () => {
    const mock = host();
    await expect(fetchAccountSummary(mock.ctx)).rejects.toThrow(/No secret stored/);
  });

  it('only ever issues GET requests', async () => {
    const mock = await configured();
    await previewImport(mock.ctx, preview);

    expect(mock.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('reads the live account summary through the broker', async () => {
    const mock = await configured();
    const summary = await fetchAccountSummary(mock.ctx);

    expect(summary.id).toBe(12345678);
    expect(summary.totalValue).toBe(10000.75);
  });
});

describe('previewImport', () => {
  it('maps history and has the host validate it without writing', async () => {
    const mock = await configured();
    const result = await previewImport(mock.ctx, preview);

    expect(result.activities).toHaveLength(3);
    expect(result.validCount).toBe(3);
    expect(result.invalidCount).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.truncated).toBe(false);
    // A preview must not touch the database.
    expect(mock.imported).toHaveLength(0);
  });

  it('reports progress as it goes', async () => {
    const mock = await configured();
    const messages: string[] = [];
    await previewImport(mock.ctx, { ...preview, onProgress: (m) => messages.push(m) });

    expect(messages[0]).toMatch(/Fetching order history/);
    expect(messages.at(-1)).toMatch(/Validating/);
  });

  it('surfaces host validation errors rather than hiding them', async () => {
    const mock = await configured({
      checkImport: async (rows) =>
        rows.map((row) => ({
          ...row,
          isValid: row.symbol !== 'VOD',
          errors: row.symbol === 'VOD' ? { symbol: ['Unknown symbol'] } : undefined,
        })),
    });

    const result = await previewImport(mock.ctx, preview);

    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(1);
  });

  it('returns an empty preview when the account has no history', async () => {
    const stub = createT212Stub({ orders: [] });
    const mock = await configured({ handleRequest: stub.handle });

    const result = await previewImport(mock.ctx, preview);

    expect(result.activities).toHaveLength(0);
    expect(result.validCount).toBe(0);
  });
});

describe('commitImport', () => {
  it('writes the validated rows', async () => {
    const mock = await configured();
    const result = await previewImport(mock.ctx, preview);
    const imported = await commitImport(mock.ctx, result.activities);

    expect(imported.summary.imported).toBe(3);
    expect(imported.summary.success).toBe(true);
    expect(mock.imported.map((row) => row.symbol)).toEqual(['AAPL', 'VOD', 'MSFT']);
  });

  it('drops rows the host rejected instead of forcing them through', async () => {
    const mock = await configured({
      checkImport: async (rows) =>
        rows.map((row) => ({
          ...row,
          isValid: row.symbol !== 'VOD',
          errors: row.symbol === 'VOD' ? { symbol: ['Unknown symbol'] } : undefined,
        })),
    });

    const result = await previewImport(mock.ctx, preview);
    const imported = await commitImport(mock.ctx, result.activities);

    expect(imported.summary.imported).toBe(2);
    expect(mock.imported.map((row) => row.symbol)).toEqual(['AAPL', 'MSFT']);
  });

  it('refuses to import when nothing passed validation', async () => {
    const mock = await configured({
      checkImport: async (rows) => rows.map((row) => ({ ...row, isValid: false })),
    });

    const result = await previewImport(mock.ctx, preview);
    await expect(commitImport(mock.ctx, result.activities)).rejects.toThrow(/Nothing to import/);
  });

  it('detects re-imported fills as duplicates rather than doubling positions', async () => {
    const mock = await configured();

    const first = await previewImport(mock.ctx, preview);
    await commitImport(mock.ctx, first.activities);

    const second = await previewImport(mock.ctx, preview);
    const again = await commitImport(mock.ctx, second.activities);

    expect(again.summary.duplicates).toBe(3);
    expect(again.summary.imported).toBe(0);
    expect(mock.imported).toHaveLength(3);
  });
});
