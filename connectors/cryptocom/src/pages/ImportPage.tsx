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
  CRYPTOCOM_LINK,
  CRYPTO_QUOTE_CURRENCY,
  LINKED_ACCOUNT_STORAGE_KEY,
  PROVIDER_STEP_STORAGE_KEY,
  QUOTE_PROVIDER,
} from '../config';
import { applyCryptoComPricing, readPricing } from '../lib/assets';
import type { ApplyResult } from '../lib/assets';
import { createSource, CRYPTOCOM_KEYS } from '../lib/source';
import { underlyingSymbol } from '../lib/mapper';
import { readImportedKeys, resetEverything, runSync } from '../lib/pipeline';
import type { LogEntry, LogLevel, Progress, SyncMode, SyncResult } from '../lib/pipeline';
import type { CryptoComUserBalanceResult } from '../lib/types';
import { BROKER_ICON } from '../lib/broker-icon';

type Step = 'connect' | 'name' | 'prices' | 'confirm' | 'ready';

/** What the connection check found, and what step 2 needs to show. */
interface Connection {
  /** Non-zero positions, by folded symbol. */
  balances: [string, string][];
  /**
   * The currency Crypto.com settles this account in.
   *
   * Unlike Kraken, this is stated rather than guessed —
   * `user-balance.instrument_name` — so it is the default in step 2 rather than
   * a question with no good answer. It stays a choice, because what the account
   * *reports* in is the user's preference and only what it *records* in is
   * Crypto.com's to state.
   */
  accountCurrency: string;
  /** What Crypto.com says the positions are worth, in that currency. */
  totalValue: number;
}

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [step, setStep] = useState<Step>('connect');
  const [restoring, setRestoring] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [currency, setCurrency] = useState(CRYPTO_QUOTE_CURRENCY);
  const [name, setName] = useState('Crypto.com');

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
  const [offProvider, setOffProvider] = useState<string[]>([]);
  const [pricing, setPricing] = useState<ApplyResult | null>(null);
  const [providerChoice, setProviderChoice] = useState<'added' | 'yahoo' | null>(null);
  /** Set when an existing account was adopted and its currency is not the one picked. */
  const [adopted, setAdopted] = useState<{ name: string; currency: string; wanted: string } | null>(null);

  const reporter = {
    log: (level: LogLevel, message: string) =>
      setLog((entries) => [...entries, { at: new Date().toISOString(), level, message }]),
    progress: (value: Progress) => setProgress(value),
  };

  const refreshPricing = useCallback(
    async (accountId: string) => {
      const state = await readPricing(ctx, accountId);
      setUnpriced(state.unpriced.map((asset) => asset.symbol));
      setOffProvider(state.offProvider.map((asset) => asset.symbol));
    },
    [ctx],
  );

  // Pick up where a previous session left off.
  useEffect(() => {
    (async () => {
      try {
        const stored = await hasKeyPair(ctx, CRYPTOCOM_KEYS);
        setConfigured(stored);
        if (!stored) return;

        const savedCurrency = await ctx.api.storage.get(ACCOUNT_CURRENCY_STORAGE_KEY);
        if (savedCurrency) setCurrency(savedCurrency);

        const choice = await ctx.api.storage.get(PROVIDER_STEP_STORAGE_KEY);
        if (choice === 'added' || choice === 'yahoo') setProviderChoice(choice);

        const linkedId = await ctx.api.storage.get(LINKED_ACCOUNT_STORAGE_KEY);
        if (linkedId) {
          const existing = await findLinkedAccount(ctx, CRYPTOCOM_LINK, { id: 'spot' });
          if (existing) {
            setAccount(existing.account);

            // An account this connector created but never imported into is not
            // finished, and sending it to the control panel would skip both the
            // price setup and the import.
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
      await saveKeyPair(ctx, CRYPTOCOM_KEYS, apiKey, apiSecret);
      setApiKey('');
      setApiSecret('');
      setConfigured(true);

      setProgress({ phase: 'Crypto.com', message: 'Checking the connection…' });
      const client = await createSource(ctx);
      if (!client) throw new Error('Credentials did not save.');

      const balance = await client.privateCall<CryptoComUserBalanceResult>('private/user-balance');
      const account = balance.data?.[0];
      if (!account) throw new Error('Crypto.com returned no balance for this key.');

      // Staked balances are folded into the coin they are, so a holding is not
      // reported twice under two codes.
      const held = new Map<string, number>();
      let totalValue = 0;
      for (const position of account.position_balances ?? []) {
        const quantity = Number(position.quantity);
        if (!Number.isFinite(quantity) || quantity === 0) continue;
        const symbol = underlyingSymbol(position.instrument_name);
        held.set(symbol, (held.get(symbol) ?? 0) + quantity);
        totalValue += Number(position.market_value) || 0;
      }

      setConnection({
        balances: [...held]
          .map(([symbol, quantity]) => [symbol, String(Number(quantity.toFixed(8)))] as [string, string])
          .sort((a, b) => a[0].localeCompare(b[0])),
        accountCurrency: account.instrument_name,
        totalValue,
      });
      setCurrency(account.instrument_name);
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
      const link = await linkOrCreateAccount(ctx, CRYPTOCOM_LINK, { id: 'spot', currency }, name);

      // An existing account is re-found by provider and id, which is what lets
      // this survive a rename — and it means the currency picked above is
      // ignored whenever one already exists. Saying so matters: a setting that
      // silently does nothing is worse than one that is not offered, and
      // "change the currency" is precisely when a user already has an account.
      if (link.account.currency !== currency) {
        setAdopted({ name: link.account.name, currency: link.account.currency, wanted: currency });
      }

      // Store what the account actually is, never what was asked for. The
      // mapper denominates its value-less rows in this, so a stored GBP against
      // a USD account would put an FX pair on rows that have no money in them.
      await ctx.api.storage.set(ACCOUNT_CURRENCY_STORAGE_KEY, link.account.currency);
      setCurrency(link.account.currency);
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

  const useCryptoComPrices = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applyCryptoComPricing(ctx, account.id, reporter.log);
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
      await clearKeyPair(ctx, CRYPTOCOM_KEYS);
      setConfigured(false);
      setAccount(null);
      setConnection(null);
      setResult(null);
      setPricing(null);
      setUnpriced([]);
      setOffProvider([]);
      setProviderChoice(null);
      setAdopted(null);
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
          <h1 className="text-3xl font-bold">Crypto.com</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Imports your Crypto.com Exchange history — trades, deposits, withdrawals and staking
          rewards — keeping every quantity exactly as Crypto.com recorded it.
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
          Wealthfolio stops it. Crypto.com answers seven days of history per request and limits
          trade lookups to one a second, so a full backfill is roughly one request per week of
          history — a couple of minutes. If it is interrupted nothing is corrupted: rows already
          written are kept, and running it again picks up the rest.
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
            <Note tone="warn">
              This is the <strong>Crypto.com Exchange</strong> at crypto.com/exchange, not the
              mobile app. They are separate products with separate balances, and the app has no API
              at all — if <strong>API Management</strong> is not in your Manage Account menu, you
              are on the app and this connector cannot see your holdings.
            </Note>
            <p className="text-sm text-muted-foreground">
              On the Exchange, go to <strong>Manage Account → API Management</strong> and create a
              new API key. Leave <strong>Enable Trading</strong> and{' '}
              <strong>Enable Withdrawal</strong> off — <strong>Can Read</strong> is on by default
              and is all this uses. Turning either on also forces Crypto.com to require an IP
              whitelist, which breaks the addon as soon as your address changes.
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
                <span className="block mb-1 font-medium">API secret</span>
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
              Crypto.com signs each request with an HMAC over its contents, which Wealthfolio's
              network broker cannot compute on our behalf, so this addon reads the secret back from
              the keyring to build the signature. A read-only key bounds what that is worth to
              anyone. The secret is shown once, at creation, and cannot be retrieved afterwards.
            </p>
            <Button onClick={connect} disabled={busy || !apiKey.trim() || !apiSecret.trim()} primary>
              {busy ? 'Checking…' : 'Connect'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>Your key pair is in Wealthfolio's keyring.</p>
            {connection ? (
              <>
                <p className="text-muted-foreground">
                  {connection.balances.length} assets with a balance:{' '}
                  <span className="font-mono text-xs">
                    {connection.balances.map(([symbol]) => symbol).join(' ')}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Crypto.com values them at{' '}
                  <strong>
                    {connection.totalValue.toFixed(2)} {connection.accountCurrency}
                  </strong>
                  . That is the figure this import has to reproduce.
                </p>
              </>
            ) : null}
          </div>
        )}
      </Panel>

      {/* ── 2. Name the account ────────────────────────────────────────── */}
      {configured ? (
        <Panel title="2. Name the Wealthfolio account" done={account !== null}>
          {account ? (
            <div className="space-y-3">
              <p className="text-sm">
                Importing into <strong>{account.name}</strong> ({account.currency}).
              </p>
              {adopted ? (
                <Note tone="warn">
                  This reused the <strong>{adopted.name}</strong> account you already had, which is
                  in <strong>{adopted.currency}</strong> — so the <strong>{adopted.wanted}</strong>{' '}
                  you picked was not applied. The connector finds its account by the provider stamp
                  rather than by name, which is what lets it survive a rename, and an existing
                  account keeps the currency it was created with. To move to {adopted.wanted}:
                  archive <strong>{adopted.name}</strong> under{' '}
                  <strong>Settings → Accounts</strong>, then reset this addon and set it up again.
                </Note>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Crypto.com settles this account in{' '}
                <strong>{connection?.accountCurrency ?? CRYPTO_QUOTE_CURRENCY}</strong> and says so
                outright — unlike Kraken, which holds a balance per asset and has no account
                currency at all. That is the default here for the same reason this connector
                defaults to anything: it is what the provider states.
              </p>
              <p className="text-sm text-muted-foreground">
                You can still pick another. The account currency only decides what this account{' '}
                <em>reports</em> in — every activity keeps the currency Crypto.com actually used, so
                your GBP deposits stay GBP and the conversions to{' '}
                {connection?.accountCurrency ?? CRYPTO_QUOTE_CURRENCY} keep Crypto.com's own rate.
                Choosing <strong>GBP</strong> is worth it if your other accounts are in GBP and you
                would rather compare them without a currency in the way.
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
                    {currencyChoices(connection?.accountCurrency).map((code) => (
                      <option key={code} value={code}>
                        {code}
                        {code === connection?.accountCurrency ? ' — what Crypto.com settles in' : ''}
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
            Reads your whole Crypto.com history and writes it into {account.name}. Trades, deposits,
            withdrawals and staking rewards, each keyed by Crypto.com's own journal id so a repeat
            run never doubles up. When it finishes, the addon checks that every balance Crypto.com
            reports is accounted for by what it imported.
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
              description="Fetches only what is new since the last run and adds it. Safe to run as often as you like — anything already imported is skipped, and nothing is removed. It stops at the first row it already holds, so a routine sync takes a moment rather than minutes."
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
      {account && step === 'ready' && (offProvider.length > 0 || pricing) ? (
        <Prices
          offProvider={offProvider}
          unpriced={unpriced}
          pricing={pricing}
          busy={busy}
          onApply={useCryptoComPrices}
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
            is fetched from Crypto.com again.
          </p>
          <p className="text-muted-foreground">
            Anything you entered by hand is left alone, and so is the account itself. Nothing is
            sent to Crypto.com — every call it makes is a query.
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
            The imported activities, the remembered account and your Crypto.com API credentials are
            all removed.
          </p>
          <p className="text-muted-foreground">
            The Wealthfolio account survives, and has to — the host gives an addon no way to delete
            one. Assets the import created also remain, since they are shared with any other account
            holding the same coin.
          </p>
        </Confirm>
      ) : null}
    </div>
  );
}

/**
 * Currencies offered for the Wealthfolio account, the stated one first.
 *
 * Crypto.com's own settlement currency leads because it is the only one here
 * that is a fact rather than a preference. The rest are offered because the
 * account currency is a reporting choice, not a constraint: activities carry
 * whatever currency Crypto.com used regardless, so picking GBP to match the
 * other connectors costs nothing in fidelity.
 *
 * Deliberately short. A full ISO list would imply this matters more than it
 * does, and every entry beyond the handful a user actually holds is noise.
 */
function currencyChoices(stated: string | undefined): string[] {
  return [...new Set([stated ?? CRYPTO_QUOTE_CURRENCY, 'GBP', 'USD', 'EUR', 'CAD', 'AUD', 'CHF'])];
}

function BrokerMark() {
  return (
    <img
      src={BROKER_ICON}
      alt="Crypto.com"
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
        Three cards sit at the top. Pick <strong>Both</strong> (“series + override”) — it is the
        only one that gives you a historical endpoint, and without history every chart stays empty
        and every return is computed from a single point. Two tabs appear underneath:{' '}
        <strong>Latest price</strong> and <strong>Historical</strong>. You fill in both.
      </Step2>

      <Step2 n={3} title="Provider name">
        Scroll to <strong>Provider identity</strong> and type the name exactly.{' '}
        <strong>Code</strong> fills itself in and cannot be edited — which is why the name has to
        match: it is what this addon looks for when it checks whether the provider is in place.
        <dl className="space-y-1.5 pt-1">
          <CopyField label="Name" value={QUOTE_PROVIDER.name} />
        </dl>
      </Step2>

      <Step2 n={4} title="Latest price tab">
        Set <strong>Source type</strong> to <strong>JSON API</strong> (“REST returning JSON”), paste
        the <strong>URL template</strong>, then under <strong>Map response fields</strong> set{' '}
        <strong>Price</strong>. Leave <strong>As of</strong> empty here.
        <dl className="space-y-1.5 pt-1">
          <CopyField label="URL" value={latest?.url ?? ''} />
          <CopyField label="Price" value={latest?.pricePath ?? ''} />
        </dl>
        <p className="text-xs text-muted-foreground mt-2">
          <code>a</code> is the latest traded price. <code>b</code> and <code>k</code> in the same
          response are the bid and the ask, which are the wrong things to value a holding at.
        </p>
      </Step2>

      <Step2 n={5} title="Historical tab">
        Switch to <strong>Historical</strong>. Source type <strong>JSON API</strong> again, paste
        its own URL, then map <strong>Price</strong> and — this one matters — <strong>As of</strong>.
        <dl className="space-y-1.5 pt-1">
          <CopyField label="URL" value={historical?.url ?? ''} />
          <CopyField label="Price" value={historical?.pricePath ?? ''} />
          {historical?.datePath ? <CopyField label="As of" value={historical.datePath} /> : null}
        </dl>
        <div className="pt-2">
          <Note tone="warn">
            <strong>As of</strong> is the field the dates come from, and the series cannot be built
            without it. Do not put this path in <strong>Date format</strong> — that is a different
            field, further down, and it expects a format like <code>%Y-%m-%d</code> rather than a
            path. A provider with the path in the wrong box saves happily, fetches happily, and
            stores nothing.
          </Note>
        </div>
      </Step2>

      <Step2 n={6} title="Historical → More mappings & options">
        Expand it and set the four candle fields. Leave <strong>Date format</strong> <em>empty</em>{' '}
        — Crypto.com sends a unix timestamp, which Wealthfolio detects on its own. Set{' '}
        <strong>Date timezone</strong> to <strong>UTC</strong>, because that is what Crypto.com
        stamps its candles in.
        <dl className="space-y-1.5 pt-1">
          {historical?.openPath ? <CopyField label="Open" value={historical.openPath} /> : null}
          {historical?.highPath ? <CopyField label="High" value={historical.highPath} /> : null}
          {historical?.lowPath ? <CopyField label="Low" value={historical.lowPath} /> : null}
          {historical?.volumePath ? (
            <CopyField label="Volume" value={historical.volumePath} />
          ) : null}
        </dl>
        <p className="text-xs text-muted-foreground mt-2">
          Crypto.com returns each candle as a named object —{' '}
          <code>{'{ "t": …, "o": …, "h": …, "l": …, "c": …, "v": … }'}</code> — so unlike an
          exchange that returns bare arrays, these paths read fields by name rather than by
          position. <code>t</code> is in <strong>milliseconds</strong>.
        </p>
      </Step2>

      <Step2 n={7} title="Test before saving">
        On the right, put <code>CRO</code> in <strong>Test symbol</strong> and press{' '}
        <strong>Fetch</strong>, on both tabs. The checklist at the bottom should end up with{' '}
        <strong>URL template</strong>, <strong>Fetch succeeds</strong>,{' '}
        <strong>Required fields mapped</strong> and <strong>Provider name</strong> all ticked.
      </Step2>

      <Step2 n={8} title="Create provider">
        Click <strong>Create provider</strong>. The card should then show{' '}
        <strong>{QUOTE_PROVIDER.name}</strong> with its switch on.
      </Step2>

      <Step2 n={9} title="Rebuild History">
        Back on <strong>Settings → Market Data</strong>, click <strong>Rebuild History</strong> and
        confirm. Creating the provider does not re-price anything on its own: assets already
        carrying another provider's history keep it until a rebuild replaces it. This takes a few
        minutes and runs in the background.
      </Step2>

      <Step2 n={10} title="Come back here">
        Continue below. Straight after the import this addon checks whether the prices really came
        from Crypto.com, and the Prices panel will say either way.
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
  /**
   * Deliberately not skippable.
   *
   * The Kraken connector offers "Continue with Yahoo prices" here and this one
   * did too, inherited along with the rest of the step. On a live account that
   * escape hatch is a trap: Yahoo priced eight coins plausibly, named one of
   * them after a different coin entirely, and had nothing at all for the
   * others — and a single unpriced day is enough for Wealthfolio to mark the
   * valuations incomplete and refuse to report a return.
   *
   * So there is one way forward, and it costs a tick box. The claim cannot be
   * verified here — see the text — but it can be made deliberate, and it is
   * checked for real once the import has created something to check against.
   */
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Panel title="3. Set up Crypto.com prices">
      <p className="text-sm text-muted-foreground">
        Wealthfolio prices crypto through Yahoo, whose symbols are not Crypto.com's. It has no entry
        at all for some of the smaller listings, and for others it resolves a{' '}
        <strong>different instrument</strong> and returns a confident, wrong number. A wrong price
        is worse than a missing one, because nothing looks broken.
      </p>
      <p className="text-sm text-muted-foreground">
        Crypto.com prices every coin it lists, needs no API key, and is the venue your holdings
        actually sit on. Do this <strong>before</strong> importing: assets created while the
        provider exists price correctly from the start, whereas adding it later needs every daily
        valuation rebuilt before a chart is right.
      </p>

      <ProviderGuide />

      <Note tone="warn">
        The <code>USD</code> in each URL is literal, and has to be. Wealthfolio's{' '}
        <code>{'{CURRENCY}'}</code> placeholder expands to the <em>asset's own</em> currency, so a
        GBP-quoted asset would ask Crypto.com for a <code>CRO_GBP</code> pair that does not exist on
        the venue. Crypto.com quotes 421 of its 577 spot pairs against USD, which is why USD is the
        right constant here rather than a convenient default.
      </Note>

      <Note tone="warn">
        <strong>This step is required.</strong> Without the provider your coins are priced by
        Yahoo, which resolves some of them to a different instrument and does not list others at
        all — and an unlisted coin has no price, which leaves the valuations incomplete and makes
        Wealthfolio withhold your returns entirely. That is not a cosmetic difference: it is the
        difference between a portfolio you can read and one that reports blanks.
      </Note>

      <p className="text-sm text-muted-foreground">
        This addon cannot verify it for you — Wealthfolio tells addons which provider{' '}
        <em>types</em> exist, never which custom ones are configured, so there is nothing to query.
        Ticking the box is your word for it, and the addon checks it for real straight after the
        import, when there are finally assets to test against. If it turns out to be missing, the
        Prices panel will say so and walk you back through this.
      </p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          I have created <strong>{QUOTE_PROVIDER.name}</strong> under Settings → Market Data, and{' '}
          <strong>Fetch</strong> succeeded on both the Latest and Historical tabs.
        </span>
      </label>

      <Button onClick={() => onChoose('added')} disabled={busy || !confirmed} primary>
        Continue
      </Button>
    </Panel>
  );
}

/**
 * Whether Crypto.com prices actually took effect, after the import.
 *
 * This is the step the setup guide could not be: with assets in place, the
 * provider can be assigned and a quote's `dataSource` read back, so the answer
 * here is observed rather than asserted.
 */
function Prices({
  offProvider,
  unpriced,
  pricing,
  busy,
  onApply,
}: {
  offProvider: string[];
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
            {offProvider.length} holding{offProvider.length === 1 ? '' : 's'} still take their price
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
            {busy ? 'Applying…' : 'Use Crypto.com prices'}
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
            ? `Pointed ${pricing.assigned} holding(s) at Crypto.com, but the price refresh did not run${
                pricing.error ? `: ${pricing.error}` : '.'
              } Existing prices are unchanged, so this is not confirmed — run a sync and check back.`
            : `All ${pricing.assigned} holdings now take their price from Crypto.com; ${
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
 * ⚠ Layout geometry is inline styles, not Tailwind brackets. This addon has no
 * Tailwind build of its own — it inherits Wealthfolio's compiled stylesheet, so
 * only utilities the host itself already uses exist. An arbitrary value like
 * `grid-cols-[1.75rem_1fr]` compiles to nothing and fails silently, which is
 * exactly how these markers ended up stacked above their headings on the Kraken
 * connector. Verified in the running host: standard utilities and theme tokens
 * resolve, opacity modifiers resolve, bracket values do not.
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
 * The button reports which of those happened, because an earlier version said
 * "Copied" unconditionally and nothing had reached the clipboard at all.
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
//  Shared presentation, matching the Trading 212 and Kraken connectors
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
