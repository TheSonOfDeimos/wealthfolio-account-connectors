import type { Account, AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountSummary } from 't212-sdk';
import { useCallback, useEffect, useState } from 'react';
import { SELECTED_ACCOUNT_STORAGE_KEY } from '../config';
import { clearCredentials, hasCredentials, saveCredentials } from '../lib/credentials';
import { commitImport, fetchAccountSummary, previewImport } from '../lib/sync';
import type { PreviewResult } from '../lib/sync';

type Phase = 'idle' | 'working' | 'error';

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [credentialsPresent, allAccounts, storedAccountId] = await Promise.all([
          hasCredentials(ctx),
          ctx.api.accounts.getAll(),
          ctx.api.storage.get(SELECTED_ACCOUNT_STORAGE_KEY),
        ]);
        if (cancelled) return;
        setConfigured(credentialsPresent);
        setAccounts(allAccounts);
        // Fall back to the first active account so there is always a target.
        const usable = allAccounts.filter((account) => account.isActive && !account.isArchived);
        setAccountId(storedAccountId ?? usable[0]?.id ?? '');
      } catch (err) {
        if (!cancelled) fail(err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    setPhase('error');
    setStatus('');
    ctx.api.logger.error(`[trading212] ${message}`);
  }

  async function run(label: string, action: () => Promise<void>) {
    setPhase('working');
    setError('');
    setStatus(label);
    try {
      await action();
      setPhase('idle');
      setStatus('');
    } catch (err) {
      fail(err);
    }
  }

  const onSaveCredentials = () =>
    run('Saving credentials…', async () => {
      await saveCredentials(ctx, apiKey, apiSecret);
      setApiKey('');
      setApiSecret('');
      setConfigured(true);
      ctx.api.toast.success('Trading 212 credentials saved to the keyring.');
    });

  const onForgetCredentials = () =>
    run('Removing credentials…', async () => {
      await clearCredentials(ctx);
      setConfigured(false);
      setSummary(null);
      setPreview(null);
      ctx.api.toast.info('Trading 212 credentials removed.');
    });

  const onTestConnection = () =>
    run('Contacting Trading 212…', async () => {
      setSummary(await fetchAccountSummary(ctx));
    });

  const onPreview = useCallback(
    () =>
      run('Fetching order history…', async () => {
        setPreview(null);
        const result = await previewImport(ctx, {
          accountId,
          onProgress: setStatus,
        });
        setPreview(result);
        await ctx.api.storage.set(SELECTED_ACCOUNT_STORAGE_KEY, accountId);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, accountId],
  );

  const onImport = () =>
    run('Importing into Wealthfolio…', async () => {
      if (!preview) return;
      const result = await commitImport(ctx, preview.activities);
      ctx.api.toast.success(
        `Imported ${result.summary.imported} activities (${result.summary.duplicates} duplicates skipped).`,
      );
      setPreview(null);
      ctx.api.query.invalidateQueries('activities');
    });

  const busy = phase === 'working';

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Trading 212 Import</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reads filled orders from your <strong>live</strong> Trading 212 account and imports
          them as BUY/SELL activities. Nothing is written until you confirm the preview.
        </p>
      </header>

      {error ? (
        <div className="border border-red-300 bg-red-50 text-red-800 rounded-lg p-4 text-sm">
          <strong className="block mb-1">Something went wrong</strong>
          {error}
        </div>
      ) : null}

      {status ? (
        <div className="border rounded-lg p-3 text-sm text-muted-foreground">{status}</div>
      ) : null}

      <section className="border rounded-lg p-5 space-y-3">
        <h2 className="text-lg font-semibold">1. API credentials</h2>
        {configured === null ? (
          <p className="text-sm text-muted-foreground">Checking the keyring…</p>
        ) : configured ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">
              Credentials are stored in the OS keyring. Wealthfolio attaches them to each
              request; the addon never reads them back.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={onTestConnection}
                disabled={busy}
                className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
              >
                Test connection
              </button>
              <button
                type="button"
                onClick={onForgetCredentials}
                disabled={busy}
                className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
              >
                Forget
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Generate a key pair in the Trading 212 mobile app (Settings → API). Read-only
              access is enough for importing.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block mb-1 font-medium">API key</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full border rounded px-2 py-1.5 font-mono text-xs"
                />
              </label>
              <label className="text-sm">
                <span className="block mb-1 font-medium">API secret</span>
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                  autoComplete="off"
                  className="w-full border rounded px-2 py-1.5 font-mono text-xs"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={onSaveCredentials}
              disabled={busy || !apiKey || !apiSecret}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
            >
              Save to keyring
            </button>
          </div>
        )}

        {summary ? (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-sm">
            <Metric label="Account" value={String(summary.id)} />
            <Metric
              label="Free cash"
              value={money(summary.cash.availableToTrade, summary.currency)}
            />
            <Metric
              label="Investments"
              value={money(summary.investments.currentValue, summary.currency)}
            />
            <Metric label="Total value" value={money(summary.totalValue, summary.currency)} />
          </dl>
        ) : null}
      </section>

      <section className="border rounded-lg p-5 space-y-3">
        <h2 className="text-lg font-semibold">2. Destination account</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Wealthfolio accounts yet — create one first, then reload this page.
          </p>
        ) : (
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={busy}
            className="border rounded px-2 py-1.5 text-sm min-w-64"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </select>
        )}
      </section>

      <section className="border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">3. Preview and import</h2>
          <button
            type="button"
            onClick={onPreview}
            disabled={busy || !configured || !accountId}
            className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Fetch and preview'}
          </button>
        </div>

        {preview ? <PreviewPanel preview={preview} onImport={onImport} busy={busy} /> : null}
      </section>
    </div>
  );
}

function PreviewPanel({
  preview,
  onImport,
  busy,
}: {
  preview: PreviewResult;
  onImport: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <strong>{preview.validCount}</strong> ready to import,{' '}
        <strong>{preview.invalidCount}</strong> with errors,{' '}
        <strong>{preview.skipped.length}</strong> skipped, from {preview.pagesFetched} page
        {preview.pagesFetched === 1 ? '' : 's'} of history.
        {preview.truncated ? ' More history is available beyond the page limit.' : ''}
      </p>

      {preview.warnings.length > 0 ? (
        <details className="text-sm border rounded p-3">
          <summary className="cursor-pointer font-medium">
            {preview.warnings.length} mapping warning
            {preview.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {preview.skipped.length > 0 ? (
        <details className="text-sm border rounded p-3">
          <summary className="cursor-pointer font-medium">
            {preview.skipped.length} fill{preview.skipped.length === 1 ? '' : 's'} not imported
          </summary>
          <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
            {preview.skipped.map((skip, index) => (
              <li key={`${skip.orderId ?? "?"}-${skip.fillId ?? index}`}>
                {skip.ticker ?? "unknown"}: {skip.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {preview.activities.length > 0 ? (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Symbol</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Fee</Th>
                <Th className="text-right">Tax</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {preview.activities.map((row, index) => (
                <tr key={row.comment ?? index} className="border-t">
                  <Td>{formatDate(row.date)}</Td>
                  <Td>{row.activityType}</Td>
                  <Td>
                    <span className="font-medium">{row.symbol}</span>
                    {row.symbolName ? (
                      <span className="block text-xs text-muted-foreground">
                        {row.symbolName}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums">{row.quantity}</Td>
                  <Td className="text-right tabular-nums">
                    {row.unitPrice} {row.currency}
                  </Td>
                  <Td className="text-right tabular-nums">{row.fee}</Td>
                  <Td className="text-right tabular-nums">{row.tax}</Td>
                  <Td>
                    {row.isValid ? (
                      row.duplicateOfId ? (
                        <span className="text-amber-700">duplicate</span>
                      ) : (
                        <span className="text-green-700">ok</span>
                      )
                    ) : (
                      <span className="text-red-700">
                        {Object.values(row.errors ?? {})
                          .flat()
                          .join('; ') || 'invalid'}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No trades to import from this slice of history.
        </p>
      )}

      <button
        type="button"
        onClick={onImport}
        disabled={busy || preview.validCount === 0}
        className="px-4 py-2 text-sm font-medium border rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        Import {preview.validCount} activit{preview.validCount === 1 ? 'y' : 'ies'} into
        Wealthfolio
      </button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(value: Date | string | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}
