import { Children, cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from 'react';
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
  PROVIDER_STEP_STORAGE_KEY,
  QUOTE_PROVIDER,
} from '../config';
import { applyKrakenPricing, readPricing } from '../lib/assets';
import type { ApplyResult } from '../lib/assets';
import { createSource, KRAKEN_KEYS } from '../lib/source';
import { displaySymbol, fetchAssets } from '../lib/extract';
import { readImportedKeys, resetEverything, runSync } from '../lib/pipeline';
import type { LogEntry, LogLevel, Progress, SyncMode, SyncResult } from '../lib/pipeline';
import type { KrakenBalances } from '../lib/types';
import { BROKER_ICON } from '../lib/broker-icon';

type Step = 'connect' | 'name' | 'prices' | 'confirm' | 'ready';

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
  const [providerChoice, setProviderChoice] = useState<'added' | 'yahoo' | null>(null);

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

        const choice = await ctx.api.storage.get(PROVIDER_STEP_STORAGE_KEY);
        if (choice === 'added' || choice === 'yahoo') setProviderChoice(choice);

        const linkedId = await ctx.api.storage.get(LINKED_ACCOUNT_STORAGE_KEY);
        if (linkedId) {
          const existing = await findLinkedAccount(ctx, KRAKEN_LINK, { id: 'spot' });
          if (existing) {
            setAccount(existing.account);

            // An account this connector created but never imported into is not
            // finished, and sending it to the control panel skips both the
            // price setup and the import — which is exactly what happened to an
            // account created just before a container was rebuilt.
            const imported = await readImportedKeys(ctx, existing.account.id);
            if (imported.size === 0) {
              const pending = await ctx.api.storage.get(PROVIDER_STEP_STORAGE_KEY);
              setStep(pending ? 'confirm' : 'prices');
              setRestoring(false);
              return;
            }

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
      setStep(providerChoice ? 'confirm' : 'prices');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [ctx, name, currency, providerChoice]);

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

  const choosePrices = useCallback(
    async (choice: 'added' | 'yahoo') => {
      setProviderChoice(choice);
      setStep('confirm');
      try {
        await ctx.api.storage.set(PROVIDER_STEP_STORAGE_KEY, choice);
      } catch {
        // Remembering the choice is a convenience; failing to is not worth
        // stopping an import over.
      }
    },
    [ctx],
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
      setProviderChoice(null);
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
        <div className="flex items-center gap-3">
          <BrokerMark />
          <h1 className="text-3xl font-bold">Kraken</h1>
        </div>
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

      {/* ── 3. Prices ──────────────────────────────────────────────────── */}
      {account && step === 'prices' ? (
        <ProviderSetup busy={busy} onChoose={choosePrices} />
      ) : null}

      {/* ── 4. Import ──────────────────────────────────────────────────── */}
      {account && step === 'confirm' ? (
        <Panel title="4. Import your history">
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

function BrokerMark() {
  return (
    <img
      src={BROKER_ICON}
      alt="Kraken"
      width={36}
      height={36}
      className="h-9 w-9 shrink-0 rounded-lg"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Setting up Kraken as the price source, before anything is imported.
 *
 * This sits before the import because that is when it is least work: assets
 * created while the provider exists take their prices from it immediately,
 * and adding it afterwards needs a rebuild of every daily valuation before the
 * charts redraw.
 *
 * It cannot be verified here. An addon can ask for Wealthfolio's market-data
 * providers and gets the built-in *types* back, never a configured custom one —
 * so the only real test is assigning it to an asset and seeing whether a quote
 * arrives, and no assets exist yet. What this step can do is refuse to be
 * skipped silently: continuing means either saying the provider is in place, or
 * choosing Yahoo knowing what that costs. The claim is then checked for real
 * after the first import.
 */
/**
 * How to add the provider, in the order Wealthfolio's own form asks for it.
 *
 * Shared by the onboarding step and the Prices panel: someone who set the
 * connector up before this step existed never sees step 3, and would otherwise
 * be told the provider is missing with no way to find out what to type.
 */
function ProviderGuide() {
  const [latest, historical] = QUOTE_PROVIDER.sources;
  return (
    <Steps2>
      <Step2 n={1} title="Open the form">
        In a second tab, go to <strong>Settings → Market Data</strong>, choose the{' '}
        <strong>Custom Providers</strong> tab, and click <strong>Add Provider</strong>.
      </Step2>

      <Step2 n={2} title="Provider mode → Both">
        Three modes are offered. Pick <strong>Both</strong> (“series + override”) — it is the only
        one with a historical endpoint, and without history every chart stays empty and every
        return is computed from a single point.
      </Step2>

      <Step2 n={3} title="Source type → JSON API">
        Kraken returns JSON, so choose <strong>JSON API</strong> (“REST returning JSON”), not Web
        Page, HTML Table or CSV.
      </Step2>

      <Step2 n={4} title="Provider identity">
        <dl className="space-y-1.5 pt-1">
          <CopyField label="Name" value={QUOTE_PROVIDER.name} />
          <CopyField label="Code" value={QUOTE_PROVIDER.id} />
        </dl>
        <p className="text-xs text-muted-foreground mt-2">
          The code must match exactly — it is what this addon looks for when it checks whether
          the provider is in place.
        </p>
      </Step2>

      <Step2 n={5} title="Configure Latest endpoint">
        Paste the <strong>URL template</strong>, then under{' '}
        <strong>Field mapping (latest)</strong> set <strong>Price</strong>.
        <dl className="space-y-1.5 pt-1">
          <CopyField label="URL" value={latest?.url ?? ''} />
          <CopyField label="Price" value={latest?.pricePath ?? ''} />
        </dl>
      </Step2>

      <Step2 n={6} title="Configure Historical endpoint">
        Same again for the historical URL, then map six fields under{' '}
        <strong>Field mapping (historical)</strong>.
        <dl className="space-y-1.5 pt-1">
          <CopyField label="URL" value={historical?.url ?? ''} />
          <CopyField label="Price" value={historical?.pricePath ?? ''} />
          {historical?.datePath ? <CopyField label="Date" value={historical.datePath} /> : null}
          {historical?.openPath ? <CopyField label="Open" value={historical.openPath} /> : null}
          {historical?.highPath ? <CopyField label="High" value={historical.highPath} /> : null}
          {historical?.lowPath ? <CopyField label="Low" value={historical.lowPath} /> : null}
          {historical?.volumePath ? (
            <CopyField label="Volume" value={historical.volumePath} />
          ) : null}
        </dl>
        <p className="text-xs text-muted-foreground mt-2">
          Kraken returns each candle as{' '}
          <code>[time, open, high, low, close, vwap, volume, count]</code>, which is why the paths
          index by position and Price is <code>[4]</code>.
        </p>
      </Step2>

      <Step2 n={7} title="Create provider">
        The form's checklist should show <strong>Provider name</strong>,{' '}
        <strong>URL template</strong> and <strong>Required fields mapped</strong> all satisfied.
        If it offers a live preview, test with symbol <code>SOL</code> — a price should come back.
        Then click <strong>Create provider</strong>.
      </Step2>

      <Step2 n={8} title="Come back here">
        Continue below. Straight after the import this addon checks whether the prices really
        came from Kraken, and the Prices panel will say either way.
      </Step2>
      </Steps2>
  );
}

function ProviderSetup({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (choice: 'added' | 'yahoo') => void;
}) {
  return (
    <Panel title="3. Set up Kraken prices">
      <p className="text-sm text-muted-foreground">
        Wealthfolio prices crypto through Yahoo, whose symbols are not Kraken's. It has no entry at
        all for some Kraken coins, and for others it resolves a{' '}
        <strong>different instrument</strong> and returns a confident, wrong number — its{' '}
        <code>USDG</code> is $5.45 for a dollar stablecoin, and its <code>CC</code> is CloudCoin,
        not the Canton Coin you hold, at roughly twice the price.
      </p>
      <p className="text-sm text-muted-foreground">
        Kraken prices every coin it sells, needs no API key, and is the venue your holdings sit on.
        Do this <strong>before</strong> importing: assets created while the provider exists price
        correctly from the start, whereas adding it later needs every daily valuation rebuilt
        before a chart is right.
      </p>

      <ProviderGuide />

      <Note tone="warn">
        Keep every <code>*</code> exactly as shown. Kraken re-keys some pairs — a request for{' '}
        <code>XBTUSD</code> comes back under <code>XXBTZUSD</code> — so an exact key would work for
        most coins and silently fail on Bitcoin and Ether. The <code>USD</code> in each URL is
        literal too: <code>{'{CURRENCY}'}</code> expands to the asset's own currency and asks for
        pairs that do not exist.
      </Note>

      <p className="text-sm text-muted-foreground">
        This addon cannot check whether you have added it — Wealthfolio tells addons which provider{' '}
        <em>types</em> exist, never which custom ones are configured.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onChoose('added')} disabled={busy} primary>
          I've added it — continue
        </Button>
        <Button onClick={() => onChoose('yahoo')} disabled={busy}>
          Continue with Yahoo prices
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Yahoo still imports every holding and transaction correctly — only the prices suffer, and
        you can add the provider later from the Prices panel.
      </p>
    </Panel>
  );
}

/**
 * Whether Kraken prices actually took effect, after the import.
 *
 * This is the step the setup guide could not be: with assets in place, the
 * provider can be assigned and a quote's `dataSource` read back, so the answer
 * here is observed rather than asserted.
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
            {offKraken.length} holding{offKraken.length === 1 ? '' : 's'} still take their price
            from Yahoo
            {unpriced.length > 0 ? (
              <>
                , and {unpriced.length} have no price at all —{' '}
                <span className="font-mono text-xs">{unpriced.join(' ')}</span>
              </>
            ) : null}
            .
          </p>
          <Button onClick={onApply} disabled={busy} primary>
            {busy ? 'Applying…' : 'Use Kraken prices'}
          </Button>
        </>
      ) : null}

      {pricing?.providerMissing ? (
        <>
          <Note tone="warn">
            No <strong>{QUOTE_PROVIDER.name}</strong> provider is configured — every asset was
            pointed at it and no quote came back. Add it, then press the button again.
          </Note>
          <ProviderGuide />
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
 * A numbered walkthrough, so the order of the wizard is the order on screen.
 *
 * The marker sits in its own column beside the heading rather than above it, on
 * a rail running between steps — the shape of a sequence, so it reads as one at
 * a glance. The heading takes the marker's line height (`leading-7` against
 * `h-7`) so the two share a centre line; without that the digit floats a few
 * pixels high and every row looks slightly out of true.
 *
 * ⚠ Layout geometry is inline styles, not Tailwind brackets. This addon has no
 * Tailwind build of its own — it inherits Wealthfolio's compiled stylesheet, so
 * only utilities the host itself already uses exist. An arbitrary value like
 * `grid-cols-[1.75rem_1fr]` compiles to nothing and fails silently, which is
 * exactly how the markers ended up stacked above their headings. Verified in
 * the running host: standard utilities and theme tokens resolve, opacity
 * modifiers resolve, bracket values do not.
 */
function Steps2({ children }: { children: React.ReactNode }) {
  const steps = Children.toArray(children);
  return (
    <ol className="mt-1">
      {steps.map((step, index) =>
        isValidElement<{ isLast?: boolean }>(step)
          ? cloneElement(step, { isLast: index === steps.length - 1 })
          : step,
      )}
    </ol>
  );
}

/** Half the marker's width, so the rail runs through its centre. */
const RAIL_OFFSET = '0.875rem';
/** The marker's height, so the rail starts where the marker ends. */
const MARKER_SIZE = '1.75rem';

function Step2({
  n,
  title,
  children,
  isLast = false,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  /** Set by `Steps2`; the last step ends the rail rather than trailing off. */
  isLast?: boolean;
}) {
  return (
    <li className="relative flex gap-4" style={{ paddingBottom: isLast ? 0 : '1.5rem' }}>
      {!isLast && (
        <span
          aria-hidden
          className="absolute w-px bg-border"
          style={{ left: RAIL_OFFSET, top: MARKER_SIZE, bottom: 0 }}
        />
      )}
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold leading-7">{title}</h3>
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/**
 * One value to copy into Wealthfolio's provider form.
 *
 * The clipboard is not reliably available here. The addon runs in an
 * `sandbox="allow-scripts"` iframe with no `allow` attribute, so the Clipboard
 * API is refused by permissions policy — `navigator.clipboard.writeText`
 * rejects. `document.execCommand('copy')` is the legacy path and is not gated
 * the same way, so it is tried second, and the value stays in a read-only input
 * that selects itself so a keyboard copy always works.
 *
 * The button reports which of those happened. An earlier version said "Copied"
 * unconditionally and nothing had reached the clipboard at all.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
    const input = inputRef.current;
    input?.focus();
    input?.select();

    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
    }

    setState(copied ? 'copied' : 'selected');
    setTimeout(() => setState('idle'), 2500);
  };

  return (
    <div className="flex items-center gap-2">
      <dt className="w-14 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">
        <input
          ref={inputRef}
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          className="min-w-0 flex-1 rounded border bg-muted/40 px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={copy}
          className="w-20 shrink-0 rounded border px-2 py-1 text-xs transition-colors hover:bg-muted"
        >
          {state === 'copied' ? 'Copied' : state === 'selected' ? 'Press ⌘C' : 'Copy'}
        </button>
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
  { key: 'prices', label: 'Prices' },
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
