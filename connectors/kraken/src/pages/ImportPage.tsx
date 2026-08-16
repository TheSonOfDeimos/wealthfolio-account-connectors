import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AddonContext } from '@wealthfolio/addon-sdk';
import {
  clearKeyPair,
  findLinkedAccount,
  hasKeyPair,
  linkOrCreateAccount,
  saveKeyPair,
} from '@wealthfolio-connectors/connector-kit';
import {
  ACCOUNT_CURRENCY_STORAGE_KEY,
  FIAT_CURRENCIES,
  KRAKEN_LINK,
  LINKED_ACCOUNT_STORAGE_KEY,
  QUOTE_PROVIDER,
} from '../config';
import { applyKrakenPricing, readPricing } from '../lib/assets';
import type { ApplyResult } from '../lib/assets';
import { createSource, KRAKEN_KEYS } from '../lib/source';
import { displaySymbol, fetchAssets } from '../lib/extract';
import { resetEverything, runSync } from '../lib/pipeline';
import type { LogEntry, LogLevel, Progress, SyncMode, SyncResult } from '../lib/pipeline';
import type { KrakenBalances } from '../lib/types';

type Step = 'connect' | 'name' | 'confirm' | 'ready';

/** What the connection check found, and what step 2 needs to offer. */
interface Connection {
  /** Non-zero balances, by display symbol. */
  balances: [string, string][];
  /** Fiat the account holds, most likely first. */
  currencies: string[];
}

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [step, setStep] = useState<Step>('connect');
  const [restoring, setRestoring] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [currency, setCurrency] = useState('GBP');
  const [name, setName] = useState('Kraken');

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const [unpriced, setUnpriced] = useState<string[]>([]);
  const [offKraken, setOffKraken] = useState<string[]>([]);
  const [pricing, setPricing] = useState<ApplyResult | null>(null);

  const reporter = {
    log: (level: LogLevel, message: string) =>
      setLog((entries) => [...entries, { at: new Date().toISOString(), level, message }]),
    progress: (value: Progress) => setProgress(value),
  };

  const refreshPricing = useCallback(
    async (accountId: string) => {
      const state = await readPricing(ctx, accountId);
      setUnpriced(state.unpriced.map((asset) => asset.symbol));
      setOffKraken(state.offKraken.map((asset) => asset.symbol));
    },
    [ctx],
  );

  // Pick up where a previous session left off.
  useEffect(() => {
    (async () => {
      try {
        const stored = await hasKeyPair(ctx, KRAKEN_KEYS);
        setConfigured(stored);
        if (!stored) return;

        const savedCurrency = await ctx.api.storage.get(ACCOUNT_CURRENCY_STORAGE_KEY);
        if (savedCurrency) setCurrency(savedCurrency);

        const linkedId = await ctx.api.storage.get(LINKED_ACCOUNT_STORAGE_KEY);
        if (linkedId) {
          const existing = await findLinkedAccount(ctx, KRAKEN_LINK, { id: 'spot' });
          if (existing) {
            setAccount(existing.account);
            setStep('ready');
            // Checked on load, not only after a sync: an account imported in an
            // earlier session is the likeliest one sitting on prices Yahoo got
            // wrong, and the offer to fix it should not require running a sync
            // that has nothing to fetch.
            await refreshPricing(existing.account.id);
            return;
          }
        }
        setStep('name');
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setRestoring(false);
      }
    })();
  }, [ctx, refreshPricing]);

  // ── Step 1 ────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await saveKeyPair(ctx, KRAKEN_KEYS, apiKey, apiSecret);
      setApiKey('');
      setApiSecret('');
      setConfigured(true);

      setProgress({ phase: 'Kraken', message: 'Checking the connection…' });
      const client = await createSource(ctx);
      if (!client) throw new Error('Credentials did not save.');

      const [balances, assets] = await Promise.all([
        client.privateCall<KrakenBalances>('Balance'),
        fetchAssets(client),
      ]);

      const held: [string, string][] = Object.entries(balances)
        .filter(([, amount]) => Number(amount) !== 0)
        .map(([code, amount]) => [displaySymbol(assets, code) ?? code, amount]);

      // Kraken has no account currency, so the choice has to be offered. The
      // fiat it actually holds is the best guess to put first.
      const fiat = held.map(([symbol]) => symbol).filter((symbol) => FIAT_CURRENCIES.has(symbol));
      const currencies = [...new Set([...fiat, 'GBP', 'USD', 'EUR'])];

      setConnection({ balances: held.sort((a, b) => a[0].localeCompare(b[0])), currencies });
      setCurrency(currencies[0] ?? 'GBP');
      setStep('name');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [ctx, apiKey, apiSecret]);

  // ── Step 2 ────────────────────────────────────────────────────────────────

  const createAccount = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await linkOrCreateAccount(ctx, KRAKEN_LINK, { id: 'spot', currency }, name);
      await ctx.api.storage.set(ACCOUNT_CURRENCY_STORAGE_KEY, currency);
      setAccount(link.account);
      setStep('confirm');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [ctx, name, currency]);

  // ── Steps 3 and 4 ─────────────────────────────────────────────────────────

  const start = useCallback(
    async (mode: SyncMode) => {
      if (!account) return;
      setConfirmWipe(false);
      setBusy(true);
      setError(null);
      setLog([]);
      setResult(null);
      setPricing(null);
      try {
        const outcome = await runSync(ctx, account.id, currency, mode, reporter);
        setResult(outcome);
        setStep('ready');
        await refreshPricing(account.id);
      } catch (caught) {
        setError(describe(caught));
        reporter.log('error', describe(caught));
      } finally {
        setProgress(null);
        setBusy(false);
      }
    },
    [ctx, account, currency, refreshPricing],
  );

  const useKrakenPrices = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applyKrakenPricing(ctx, account.id, reporter.log);
      setPricing(outcome);
      await refreshPricing(account.id);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [ctx, account, refreshPricing]);

  const reset = useCallback(async () => {
    setConfirmReset(false);
    setBusy(true);
    try {
      await resetEverything(ctx, account?.id, reporter);
      await clearKeyPair(ctx, KRAKEN_KEYS);
      setConfigured(false);
      setAccount(null);
      setConnection(null);
      setResult(null);
      setPricing(null);
      setUnpriced([]);
      setOffKraken([]);
      setStep('connect');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [ctx, account]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Kraken</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Imports your Kraken history — purchases, deposits, withdrawals and staking rewards —
          keeping every amount in the currency Kraken recorded it in.
        </p>
      </header>

      <Steps current={step} />

      {restoring ? (
        <div className="border rounded-lg p-3 text-sm text-muted-foreground">
          Restoring where you left off…
        </div>
      ) : null}

      {busy ? (
        <div className="border border-amber-300 bg-amber-50 text-amber-900 rounded-lg p-4 text-sm">
          <strong className="block mb-1">Keep this page open</strong>
          A sync runs inside this page, so navigating to Dashboard, Holdings or anywhere else in
          Wealthfolio stops it. Kraken's rate limiter allows one page of 50 rows every eight
          seconds, so a full history takes a few minutes — leave the tab here until it finishes.
          If it is interrupted nothing is corrupted: rows already written are kept, and running it
          again picks up the rest.
        </div>
      ) : null}

      {error ? (
        <div className="border border-red-300 bg-red-50 text-red-900 rounded-lg p-4 text-sm">
          <strong className="block mb-1">Something went wrong</strong>
          {error}
        </div>
      ) : null}

      {/* ── 1. Connect ─────────────────────────────────────────────────── */}
      <Panel title="1. Connect your exchange" done={configured === true}>
        {configured === null ? (
          <p className="text-sm text-muted-foreground">Checking the keyring…</p>
        ) : !configured ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              In Kraken Pro, go to Settings → API → Add API key and tick exactly three
              permissions: <strong>Funds · Query</strong>,{' '}
              <strong>Orders · Query closed orders &amp; trades</strong> and{' '}
              <strong>Data · Query ledger entries</strong>. Every other box is a write path that
              gives no extra visibility, so leave them all off.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block mb-1 font-medium">API key</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  type="password"
                  className="w-full border rounded px-2 py-1.5 font-mono text-xs"
                />
              </label>
              <label className="text-sm">
                <span className="block mb-1 font-medium">Private key</span>
                <input
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  type="password"
                  className="w-full border rounded px-2 py-1.5 font-mono text-xs"
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Kraken signs each request, which Wealthfolio's network broker cannot do on our
              behalf, so this addon reads the private key back from the keyring to compute the
              signature. A read-only key bounds what that is worth to anyone.
            </p>
            <Button onClick={connect} disabled={busy || !apiKey.trim() || !apiSecret.trim()} primary>
              {busy ? 'Checking…' : 'Connect'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>Your key pair is in Wealthfolio's keyring.</p>
            {connection ? (
              <p className="text-muted-foreground">
                {connection.balances.length} assets with a balance:{' '}
                <span className="font-mono text-xs">
                  {connection.balances.map(([symbol]) => symbol).join(' ')}
                </span>
              </p>
            ) : null}
          </div>
        )}
      </Panel>

      {/* ── 2. Name the account ────────────────────────────────────────── */}
      {configured ? (
        <Panel title="2. Name the Wealthfolio account" done={account !== null}>
          {account ? (
            <p className="text-sm">
              Importing into <strong>{account.name}</strong> ({account.currency}).
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Kraken holds a balance per asset and has no account currency of its own, so this
                one is your choice. Pick the currency you funded the account with — anything
                bought in another is recorded as Kraken charged it and converted for display.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="block mb-1 font-medium">Account name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="block mb-1 font-medium">Currency</span>
                  <select
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-sm"
                  >
                    {(connection?.currencies ?? ['GBP', 'USD', 'EUR']).map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Button onClick={createAccount} disabled={busy || !name.trim()} primary>
                Create account
              </Button>
            </div>
          )}
        </Panel>
      ) : null}

      {/* ── 3. Import ──────────────────────────────────────────────────── */}
      {account && step === 'confirm' ? (
        <Panel title="3. Import your history">
          <p className="text-sm text-muted-foreground">
            Reads your whole Kraken history and writes it into {account.name}. Purchases, deposits,
            withdrawals and staking rewards, each keyed by Kraken's own record id so a repeat run
            never doubles up.
          </p>
          <Button onClick={() => start('full')} disabled={busy} primary>
            {busy ? 'Importing…' : 'Import everything'}
          </Button>
        </Panel>
      ) : null}

      {/* ── 4. Ready ───────────────────────────────────────────────────── */}
      {account && step === 'ready' ? (
        <Panel title="Keeping it up to date">
          <div className="grid gap-4 sm:grid-cols-2">
            <Action
              title="Sync exchange"
              description="Fetches only what is new since the last run and adds it. Safe to run as often as you like — anything already imported is skipped, and nothing is removed. It stops at the first row it already holds, so a routine sync takes a second rather than minutes."
              button="Sync exchange"
              onClick={() => start('incremental')}
              disabled={busy}
              primary
            />
            <Action
              title="Wipe and reload"
              description="Deletes every activity this addon imported into the account and fetches the whole history again. Use it after changing how data is mapped, or if an import went wrong."
              button="Wipe and reload"
              onClick={() => setConfirmWipe(true)}
              disabled={busy}
              danger
            />
          </div>

          <div className="border-t pt-4">
            <Action
              title="Reset the addon"
              description="Removes the imported activities, the link to this account and your saved API credentials, putting the addon back to how it was on install — ready to set up again or uninstall. The account itself stays; Wealthfolio does not let an addon delete one."
              button="Reset everything"
              onClick={() => setConfirmReset(true)}
              disabled={busy}
              danger
            />
          </div>
        </Panel>
      ) : null}

      {/* ── Prices ─────────────────────────────────────────────────────── */}
      {account && step === 'ready' && (offKraken.length > 0 || pricing) ? (
        <Prices
          offKraken={offKraken}
          unpriced={unpriced}
          pricing={pricing}
          busy={busy}
          onApply={useKrakenPrices}
        />
      ) : null}

      {/* ── Activity ───────────────────────────────────────────────────── */}
      {progress || log.length > 0 || result ? (
        <Activity log={log} progress={progress} result={result} busy={busy} />
      ) : null}

      {confirmWipe ? (
        <Confirm
          title={`Wipe and reload ${account?.name ?? ''}?`}
          confirmLabel="Wipe and reload"
          onCancel={() => setConfirmWipe(false)}
          onConfirm={() => start('wipe')}
        >
          <p>
            Every activity this addon imported into the account is deleted, then the whole history
            is fetched from Kraken again.
          </p>
          <p className="text-muted-foreground">
            Anything you entered by hand is left alone, and so is the account itself. Nothing is
            sent to Kraken — every call it makes is a query.
          </p>
        </Confirm>
      ) : null}

      {confirmReset ? (
        <Confirm
          title="Reset the addon?"
          confirmLabel="Reset everything"
          onCancel={() => setConfirmReset(false)}
          onConfirm={reset}
        >
          <p>
            The imported activities, the remembered account and your Kraken API credentials are all
            removed.
          </p>
          <p className="text-muted-foreground">
            The Wealthfolio account survives, and has to — the host gives an addon no way to delete
            one. Assets the import created also remain, since they are shared with any other
            account holding the same coin.
          </p>
        </Confirm>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Getting Kraken's own prices onto Kraken's own holdings.
 *
 * Wealthfolio prices crypto through Yahoo, which is the wrong source here twice
 * over: it has no entry at all for several Kraken coins, and for others it
 * resolves a different instrument and returns a confident wrong number. The
 * second is the worse failure, because nothing about it looks broken.
 *
 * The addon can point an asset at a provider but cannot create one — there is
 * no custom-provider API in the SDK — so when the provider turns out to be
 * missing this shows the exact values to fill in. Field by field, with a copy
 * button each: Wealthfolio's Add Provider dialog is a form, not a JSON paste,
 * so a single blob would be no use.
 */
function Prices({
  offKraken,
  unpriced,
  pricing,
  busy,
  onApply,
}: {
  offKraken: string[];
  unpriced: string[];
  pricing: ApplyResult | null;
  busy: boolean;
  onApply: () => void;
}) {
  const done = pricing !== null && pricing.verified && !pricing.providerMissing;

  return (
    <Panel title="Prices" done={done}>
      {!pricing ? (
        <>
          <p className="text-sm text-muted-foreground">
            {offKraken.length} holding{offKraken.length === 1 ? '' : 's'} take their price from
            Yahoo, which is the wrong source for coins held on Kraken.
            {unpriced.length > 0 ? (
              <>
                {' '}
                It has no entry at all for {unpriced.length} of them —{' '}
                <span className="font-mono text-xs">{unpriced.join(' ')}</span> —
              </>
            ) : (
              ' It has no entry at all for some Kraken coins'
            )}{' '}
            and for others it resolves a different instrument and returns a confidently wrong
            number. A wrong price is the worse of the two, because nothing looks broken.
          </p>
          <p className="text-sm text-muted-foreground">
            Kraken prices every coin it sells, needs no API key, and is the venue these holdings
            actually sit on.
          </p>
          <Button onClick={onApply} disabled={busy} primary>
            {busy ? 'Applying…' : 'Use Kraken prices'}
          </Button>
        </>
      ) : null}

      {pricing?.providerMissing ? (
        <>
          <Note tone="warn">
            Wealthfolio has no <strong>{QUOTE_PROVIDER.name}</strong> provider yet, and an addon is
            not allowed to create one. Add it once by hand — it takes about a minute — then press
            the button again.
          </Note>
          <p className="text-sm">
            Go to <strong>Settings → Market Data → Custom Providers → Add Provider</strong>, fill
            in the provider, then add <strong>both</strong> sources.
          </p>
          <dl className="space-y-2">
            <CopyField label="Code" value={QUOTE_PROVIDER.id} />
            <CopyField label="Name" value={QUOTE_PROVIDER.name} />
          </dl>

          {QUOTE_PROVIDER.sources.map((source) => (
            <div key={source.kind} className="border-t pt-3 space-y-2">
              <p className="text-xs font-medium">
                Source: <strong>{source.kind === 'latest' ? 'Latest price' : 'Historical'}</strong>{' '}
                <span className="font-normal text-muted-foreground">
                  ({source.format.toUpperCase()})
                  {source.kind === 'historical'
                    ? ' — without this one every chart stays empty'
                    : null}
                </span>
              </p>
              <dl className="space-y-2">
                <CopyField label="URL" value={source.url} />
                <CopyField label="Price" value={source.pricePath} />
                {source.datePath ? <CopyField label="Date" value={source.datePath} /> : null}
                {source.openPath ? <CopyField label="Open" value={source.openPath} /> : null}
                {source.highPath ? <CopyField label="High" value={source.highPath} /> : null}
                {source.lowPath ? <CopyField label="Low" value={source.lowPath} /> : null}
                {source.volumePath ? <CopyField label="Volume" value={source.volumePath} /> : null}
              </dl>
            </div>
          ))}

          <p className="text-xs text-muted-foreground">
            Keep every <code>*</code> exactly as shown. Kraken re-keys some pairs in its response —
            a request for <code>XBTUSD</code> comes back under <code>XXBTZUSD</code> — so an exact
            key would work for most coins and silently fail on Bitcoin and Ether.
          </p>
          <Button onClick={onApply} disabled={busy} primary>
            {busy ? 'Checking…' : "I've added it — try again"}
          </Button>
        </>
      ) : null}

      {pricing && !pricing.providerMissing ? (
        <p className="text-sm">
          {!pricing.verified
            ? `Pointed ${pricing.assigned} holding(s) at Kraken, but the price refresh did not run${
                pricing.error ? `: ${pricing.error}` : '.'
              } Existing prices are unchanged, so this is not confirmed — run a sync and check back.`
            : `All ${pricing.assigned} holdings now take their price from Kraken; ${
                pricing.sourced ?? 0
              } have already refreshed. The rest keep the quote they had until their next refresh.`}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * One value to copy into Wealthfolio's provider form.
 *
 * The value stays in a read-only input rather than plain text so it can be
 * selected by hand when the clipboard is unavailable — the addon runs in a
 * sandboxed iframe, where `navigator.clipboard` is not guaranteed.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
    const input = inputRef.current;
    input?.select();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Falls back to the selection the click just made, which the user can
      // copy with the keyboard.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2">
      <dt className="text-xs text-muted-foreground w-20 shrink-0">{label}</dt>
      <dd className="flex-1 flex items-center gap-2 min-w-0">
        <input
          ref={inputRef}
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          className="flex-1 min-w-0 border rounded px-2 py-1 font-mono text-xs bg-muted/30"
        />
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Activity
// ─────────────────────────────────────────────────────────────────────────────

function Activity({
  log,
  progress,
  result,
  busy,
}: {
  log: LogEntry[];
  progress: Progress | null;
  result: SyncResult | null;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail while it runs, so the newest line is always the visible one.
  useEffect(() => {
    if (busy) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [log.length, busy]);

  const skipped = result?.issues.filter((issue) => issue.kind === 'skipped') ?? [];

  return (
    <section className="border rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Activity</h2>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-xs text-muted-foreground hover:underline"
        >
          {expanded ? 'Hide log' : `Show log (${log.length})`}
        </button>
      </div>

      {progress ? (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="font-medium">{progress.phase}</span>
            <span className="text-muted-foreground">
              {progress.total ? `${progress.done ?? 0} / ${progress.total}` : ''}
            </span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={
                'h-full bg-foreground/70 transition-all ' +
                // Countable work gets a real bar; the rest gets a moving stripe,
                // because a fake percentage is worse than none.
                (progress.total ? '' : 'animate-pulse w-1/3')
              }
              style={
                progress.total
                  ? { width: `${Math.round(((progress.done ?? 0) / progress.total) * 100)}%` }
                  : undefined
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">{progress.message}</p>
        </div>
      ) : null}

      {result ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="Imported" value={String(result.imported)} />
          <Metric label="Skipped" value={String(result.duplicates)} />
          <Metric label="Removed" value={String(result.deleted)} />
          <Metric label="Left out" value={String(skipped.length)} />
        </div>
      ) : null}

      {skipped.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            What was left out, and why
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {skipped.slice(0, 25).map((issue) => (
              <li key={issue.sourceId}>{issue.message}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {expanded && log.length > 0 ? (
        <div className="max-h-72 overflow-y-auto border rounded bg-muted/30 font-mono text-xs">
          {log.map((entry, index) => (
            <div
              key={`${entry.at}-${index}`}
              className="flex gap-2 px-3 py-1 border-b last:border-b-0 border-border/40"
            >
              <span className="text-muted-foreground shrink-0">{entry.at.slice(11, 19)}</span>
              <span className={`shrink-0 w-14 ${LEVEL_STYLE[entry.level]}`}>{entry.level}</span>
              <span className="whitespace-pre-wrap break-words">{entry.message}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : null}
    </section>
  );
}

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: 'text-muted-foreground',
  success: 'text-green-700',
  warn: 'text-amber-700',
  error: 'text-red-700',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Shared presentation, matching the Trading 212 connector
// ─────────────────────────────────────────────────────────────────────────────

const STEP_LABELS: { key: Step; label: string }[] = [
  { key: 'connect', label: 'Connect' },
  { key: 'name', label: 'Name account' },
  { key: 'confirm', label: 'Import' },
  { key: 'ready', label: 'Keep in sync' },
];

function Steps({ current }: { current: Step }) {
  const index = STEP_LABELS.findIndex((step) => step.key === current);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEP_LABELS.map((step, position) => {
        const state = position < index ? 'done' : position === index ? 'current' : 'todo';
        return (
          <li key={step.key} className="flex items-center gap-2">
            <span
              className={
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full border ' +
                (state === 'current'
                  ? 'border-foreground font-medium'
                  : state === 'done'
                    ? 'border-transparent bg-muted text-muted-foreground'
                    : 'border-transparent text-muted-foreground/60')
              }
            >
              <span aria-hidden>{state === 'done' ? '✓' : position + 1}</span>
              {step.label}
            </span>
            {position < STEP_LABELS.length - 1 ? (
              <span className="text-muted-foreground/40" aria-hidden>
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Panel({
  title,
  done,
  children,
}: {
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="border rounded-lg p-5 space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        {title}
        {done ? (
          <span className="text-xs font-normal text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
            done
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

function Action({
  title,
  description,
  button,
  onClick,
  disabled,
  primary,
  danger,
}: {
  title: string;
  description: string;
  button: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
      <div className="mt-auto">
        <Button onClick={onClick} disabled={disabled} primary={primary} danger={danger}>
          {button}
        </Button>
      </div>
    </div>
  );
}

/**
 * A confirmation for something that removes data.
 *
 * Focused on Cancel so the dangerous button is never the one a stray keypress
 * finds. Each caller supplies its own list of what is removed and what
 * survives, because "wipe" and "reset" read worse than they are.
 */
function Confirm({
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onKeyDown={(event) => event.key === 'Escape' && onCancel()}
    >
      <div className="bg-background border rounded-lg shadow-lg max-w-lg w-full p-5 space-y-4">
        <h2 id="confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <div className="text-sm space-y-3">{children}</div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} ref={cancelRef}>
            Cancel
          </Button>
          <Button onClick={onConfirm} danger>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Note({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return (
    <p
      className={
        'text-sm rounded p-3 border ' +
        (tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : '')
      }
    >
      {children}
    </p>
  );
}

const Button = ({
  ref,
  onClick,
  disabled,
  primary,
  danger,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) => (
  <button
    ref={ref}
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={
      'px-3 py-1.5 text-sm border rounded disabled:opacity-50 transition-colors ' +
      (danger
        ? 'border-red-300 text-red-700 hover:bg-red-50'
        : primary
          ? 'bg-foreground text-background border-foreground hover:opacity-90'
          : 'hover:bg-muted')
    }
  >
    {children}
  </button>
);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-sm mt-0.5">{value}</dd>
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
