import type { Account, AddonContext, SymbolSearchResult } from '@wealthfolio/addon-sdk';
import type { AccountSummary } from 't212-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { REVIEW_STORAGE_KEY } from '../config';
import { BROKER_ICON } from '../lib/broker-icon';
import { describeMismatch, findLinkedAccount, linkOrCreateAccount } from '../lib/account';
import { clearCredentials, hasCredentials, saveCredentials } from '../lib/credentials';
import { resetEverything, runSync, source } from '../lib/pipeline';
import { loadOverrides, saveOverrides } from '../lib/symbols';
import type { SymbolReview } from '../lib/symbols';
import type { LogEntry, LogLevel, Progress, SyncMode, SyncResult } from '../lib/pipeline';

/**
 * Onboarding once, then a control panel forever.
 *
 * The wizard exists because the first run has a strict order — credentials, an
 * account to import into, then the import itself — and each step needs the one
 * before it to have succeeded. Once an account is linked the wizard has nothing
 * left to ask, so it collapses to the two buttons you will actually use again.
 */

type Step = 'connect' | 'name' | 'confirm' | 'ready';

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountName, setAccountName] = useState('Trading 212');
  const [step, setStep] = useState<Step>('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const mismatch = account && summary ? describeMismatch(account, summary) : undefined;

  // Restore everything the addon already knows, so a reload lands on the same
  // screen you left rather than back at "Connect". The broker call is the only
  // slow part and it is a single request.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const present = await hasCredentials(ctx);
        if (cancelled) return;
        setConfigured(present);
        if (!present) return;

        setRestoring(true);
        const live = await source(ctx).client.account.getSummary();
        if (cancelled) return;
        setSummary(live);

        const linked = await findLinkedAccount(ctx, live);
        if (cancelled) return;
        if (!linked) {
          setStep('name');
          return;
        }

        setAccount(linked.account);
        setStep('ready');

        // The Symbols panel is worth showing immediately; re-deriving it would
        // mean another trip to Trading 212, so the last one is remembered.
        const stored = await ctx.api.storage.get(REVIEW_STORAGE_KEY);
        if (cancelled || !stored) return;
        try {
          setResult({ review: JSON.parse(stored) } as SyncResult);
        } catch {
          // A malformed cache is not worth surfacing; the next sync rewrites it.
        }
      } catch (err) {
        if (!cancelled) fail(err);
      } finally {
        if (!cancelled) setRestoring(false);
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
    setBusy(false);
    setProgress(null);
    ctx.api.logger.error(`[trading212] ${message}`);
  }

  // A reload or tab close is the one exit the addon can object to; an in-app
  // route change unmounts this component with no chance to intervene, which is
  // why the banner above exists as well.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const append = useCallback((level: LogLevel, message: string) => {
    setLog((entries) => [...entries, { at: new Date().toISOString(), level, message }]);
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      fail(err);
      return;
    }
    setBusy(false);
    setProgress(null);
  }

  // ── Step 1 ────────────────────────────────────────────────────────────────

  const onSaveCredentials = () =>
    run(async () => {
      await saveCredentials(ctx, apiKey, apiSecret);
      setApiKey('');
      setApiSecret('');
      setConfigured(true);
      ctx.api.toast.success('Credentials saved to the keyring.');
    });

  const onConnect = () =>
    run(async () => {
      setProgress({ phase: 'Trading 212', message: 'Contacting your broker…' });
      const live = await source(ctx).client.account.getSummary();
      setSummary(live);
      append('success', `Connected to Trading 212 account ${live.id} (${live.currency}).`);

      // A second run should not be asked to name an account it already has.
      const linked = await findLinkedAccount(ctx, live);
      if (linked) {
        setAccount(linked.account);
        setStep('ready');
        append('info', `Already linked to "${linked.account.name}".`);
      } else {
        setStep('name');
      }
    });

  const onForget = () =>
    run(async () => {
      await clearCredentials(ctx);
      setConfigured(false);
      setSummary(null);
      setAccount(null);
      setStep('connect');
    });

  // ── Step 2 ────────────────────────────────────────────────────────────────

  const onCreateAccount = () =>
    run(async () => {
      if (!summary) return;
      const linked = await linkOrCreateAccount(ctx, summary, accountName);
      setAccount(linked.account);
      append(
        'success',
        linked.created
          ? `Created "${linked.account.name}" in ${linked.account.currency}.`
          : `Using the existing account "${linked.account.name}".`,
      );
      ctx.api.query.invalidateQueries('accounts');
      setStep('confirm');
    });

  // ── Steps 3 and 4 ─────────────────────────────────────────────────────────

  const onReset = () =>
    run(async () => {
      setLog([]);
      append('info', 'Resetting the addon…');
      const outcome = await resetEverything(ctx, account?.id, {
        log: append,
        progress: setProgress,
      });
      setResult(null);
      setAccount(null);
      setStep(summary ? 'name' : 'connect');
      ctx.api.query.invalidateQueries('activities');
      ctx.api.toast.success(
        `Reset done — ${outcome.deleted} activities removed. The account itself is left for you to delete.`,
      );
    });

  const start = (mode: SyncMode) =>
    run(async () => {
      if (!account) return;
      setResult(null);
      setLog([]);
      append('info', mode === 'wipe' ? 'Wiping and reloading…' : `Starting ${mode} sync…`);

      const outcome = await runSync(
        ctx,
        account.id,
        mode,
        { log: append, progress: setProgress },
      );

      setResult(outcome);
      setStep('ready');
      ctx.api.query.invalidateQueries('activities');
      ctx.api.toast.success(
        outcome.imported > 0
          ? `Imported ${outcome.imported} activities.`
          : 'Already up to date.',
      );
    });

/**
 * Trading 212's mark, beside the page heading.
 *
 * It lives here rather than in the sidebar because the sidebar is host chrome —
 * Wealthfolio draws that icon itself from a fixed set of Phosphor icons, and an
 * addon cannot ship one across the sandbox boundary. Inside its own page it can
 * draw what it likes.
 *
 * The artwork is Trading 212's, used to identify the broker this addon talks
 * to; see `broker-icon.ts` for where it came from. Its corners are transparent,
 * so the black tile reads on the light theme and drops away to leave the mark
 * floating on the dark one.
 */
function BrokerMark() {
  return (
    <img
      src={BROKER_ICON}
      alt="Trading 212"
      width={36}
      height={36}
      className="h-9 w-9 shrink-0 rounded-lg"
    />
  );
}

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <div className="flex items-center gap-3">
          <BrokerMark />
          <h1 className="text-3xl font-bold">Trading 212</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Imports your Trading 212 history — trades, dividends, deposits, interest and charges —
          keeping every amount in the currency Trading 212 recorded it in.
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
          Wealthfolio stops it. Fetching your history takes a few minutes — leave the tab here
          until it finishes. If it is interrupted, nothing is corrupted: rows already written are
          kept, and running it again picks up the rest.
        </div>
      ) : null}

      {error ? (
        <div className="border border-red-300 bg-red-50 text-red-900 rounded-lg p-4 text-sm">
          <strong className="block mb-1">Something went wrong</strong>
          {error}
        </div>
      ) : null}

      {/* ── 1. Connect ─────────────────────────────────────────────────── */}
      <Panel title="1. Connect your broker" done={summary !== null}>
        {configured === null ? (
          <p className="text-sm text-muted-foreground">Checking the keyring…</p>
        ) : !configured ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Generate a key pair in the Trading 212 app under Settings → API. Read access is
              all this needs; it never places or cancels an order.
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
            <Button onClick={onSaveCredentials} disabled={busy || !apiKey || !apiSecret} primary>
              Save to keyring
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Credentials are in the OS keyring. Wealthfolio attaches them to each request; the
                addon never reads them back.
              </p>
              <div className="flex gap-2 shrink-0">
                <Button onClick={onConnect} disabled={busy} primary>
                  {summary ? 'Reconnect' : 'Connect Trading 212'}
                </Button>
                <Button onClick={onForget} disabled={busy}>
                  Forget
                </Button>
              </div>
            </div>

            {summary ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <Metric label="Broker account" value={String(summary.id)} />
                <Metric label="Currency" value={summary.currency} />
                <Metric
                  label="Free cash"
                  value={money(summary.cash.availableToTrade, summary.currency)}
                />
                <Metric label="Total value" value={money(summary.totalValue, summary.currency)} />
                <Metric
                  label="Invested"
                  value={money(summary.investments.totalCost, summary.currency)}
                />
                <Metric
                  label="Market value"
                  value={money(summary.investments.currentValue, summary.currency)}
                />
                <Metric
                  label="Unrealised"
                  value={money(summary.investments.unrealizedProfitLoss, summary.currency)}
                />
                <Metric
                  label="Realised"
                  value={money(summary.investments.realizedProfitLoss, summary.currency)}
                />
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      {/* ── 2. Name ────────────────────────────────────────────────────── */}
      {summary && step !== 'connect' ? (
        <Panel title="2. Name the Wealthfolio account" done={account !== null}>
          {account ? (
            <p className="text-sm">
              Importing into <strong>{account.name}</strong> ({account.currency}).{' '}
              <span className="text-muted-foreground">
                Renaming it in Wealthfolio is safe — this addon finds it by its broker id, not its
                name.
              </span>
            </p>
          ) : (
            <div className="space-y-3">
              <label className="text-sm block">
                <span className="block mb-1 font-medium">Account name</span>
                <input
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  disabled={busy}
                  className="w-full max-w-sm border rounded px-2 py-1.5 text-sm"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Created in <strong>{summary.currency}</strong>, matching Trading 212, so cash
                movements need no conversion.
              </p>
              <Button onClick={onCreateAccount} disabled={busy || !accountName.trim()} primary>
                Create account
              </Button>
            </div>
          )}
          {mismatch ? <Note tone="warn">{mismatch}</Note> : null}
        </Panel>
      ) : null}

      {/* ── 3. Confirm ─────────────────────────────────────────────────── */}
      {account && step === 'confirm' ? (
        <Panel title="3. Import your history">
          <div className="text-sm space-y-3">
            <p>Here is what will happen when you confirm:</p>
            <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
              <li>
                Your whole Trading 212 history is read — filled orders, dividends, deposits and
                withdrawals, interest on free cash, and every charge.
              </li>
              <li>
                Each one is written as an activity <strong>in its own currency</strong>. A US
                trade stays in dollars, a London one in pence, and the conversion rate Trading
                212 recorded is attached so Wealthfolio can do the arithmetic itself.
              </li>
              <li>
                Nothing is invented. Corporate actions such as share splits are reported for you
                to enter by hand rather than guessed at, and withholding tax on foreign dividends
                is left unset because Trading 212 does not report it separately.
              </li>
              <li>
                This takes a few minutes. Trading 212 rate-limits its history endpoints and the
                addon paces itself to stay within them.
              </li>
              <li>Nothing is written to Trading 212. Every call it makes is a read.</li>
            </ul>
            <Button onClick={() => start('full')} disabled={busy} primary>
              Confirm and import
            </Button>
          </div>
        </Panel>
      ) : null}

      {/* ── 4. Ready ───────────────────────────────────────────────────── */}
      {account && step === 'ready' ? (
        <Panel title="Keeping it up to date">
          <div className="grid gap-4 sm:grid-cols-2">
            <Action
              title="Sync broker"
              description="Fetches only what is new since the last run and adds it. Safe to run as often as you like — anything already imported is skipped, and nothing is removed. Prices come from Wealthfolio's own providers, not from Trading 212."
              button="Sync broker"
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
              description="Removes the imported activities, your ticker corrections and the link to this account, putting the addon back to how it was on install — ready to set up again or uninstall. The account itself stays; Wealthfolio does not let an addon delete one."
              button="Reset everything"
              onClick={() => setConfirmReset(true)}
              disabled={busy}
              danger
            />
          </div>
        </Panel>
      ) : null}

      {confirmReset ? (
        <Confirm
          title="Reset the addon?"
          confirmLabel="Reset everything"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            onReset();
          }}
        >
          <p>This puts the addon back to how it was on install:</p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>
              <strong>Removed:</strong> every activity this addon imported, your saved ticker
              corrections, and the link between the addon and this account.
            </li>
            <li>
              <strong>Kept:</strong> your Trading 212 credentials — use <em>Forget</em> above to
              clear those too.
            </li>
            <li>
              <strong>The account stays.</strong> Wealthfolio does not let an addon delete an
              account, so <strong>{account?.name}</strong> is left empty for you to remove under
              Settings → Accounts if you want it gone. Assets the import created also stay: they
              belong to Wealthfolio and may be shared with your other accounts.
            </li>
            <li>Afterwards you can uninstall the addon, or run through the setup again.</li>
          </ul>
        </Confirm>
      ) : null}

      {confirmWipe ? (
        <Confirm
          title={`Wipe and reload ${account?.name ?? ''}?`}
          confirmLabel="Wipe and reload"
          onCancel={() => setConfirmWipe(false)}
          onConfirm={() => {
            setConfirmWipe(false);
            start('wipe');
          }}
        >
          <p>This removes and re-imports data. Specifically:</p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>
              <strong>Deleted:</strong> every activity this addon imported into this account —
              trades, dividends, deposits, interest and charges.
            </li>
            <li>
              <strong>Kept:</strong> the account itself, your ticker corrections, and any activity
              you added by hand. Only rows this addon recognises as its own are touched.
            </li>
            <li>Any history Wealthfolio derived from the old activities is rebuilt.</li>
            <li>The whole history is then fetched again, which takes a few minutes.</li>
          </ul>
        </Confirm>
      ) : null}

      {account && step === 'ready' ? (
        <Symbols
          ctx={ctx}
          accountId={account.id}
          review={result?.review ?? []}
          busy={busy}
          onSaved={(changes) => {
            for (const change of changes) {
              append(
                'success',
                change.to
                  ? `Symbol correction saved: ${change.ticker} → ${change.to}${
                      change.from ? ` (was ${change.from})` : ''
                    }.`
                  : `Symbol correction removed for ${change.ticker}.`,
              );
            }
            ctx.api.toast.success(
              changes.length === 1
                ? `Saved ${changes[0]!.ticker} → ${changes[0]!.to}.`
                : `Saved ${changes.length} symbol corrections.`,
            );
          }}
        />
      ) : null}

      {progress || log.length > 0 ? (
        <Activity progress={progress} log={log} result={result} busy={busy} />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pieces
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
 * Shared by both destructive actions so they read alike, and focused on Cancel
 * so the dangerous button is never the one a stray keypress finds. Each caller
 * supplies its own list of what is removed and what survives, because "wipe"
 * and "reset" read worse than they are — neither touches the account or
 * anything entered by hand.
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

/**
 * Ticker corrections, and the holdings that look like they need one.
 *
 * Two things live here because they are two views of the same table: what the
 * addon decided each Trading 212 ticker means, and the corrections you have
 * made. Corrections are stored in Wealthfolio's own per-account symbol
 * mappings, so they survive reinstalling the addon and belong to the account
 * rather than to us.
 */
function Symbols({
  ctx,
  accountId,
  review,
  busy,
  onSaved,
}: {
  ctx: AddonContext;
  accountId: string;
  review: SymbolReview[];
  busy: boolean;
  onSaved: (changes: { ticker: string; from?: string; to?: string }[]) => void;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOverrides(ctx, accountId).then((stored) => {
      if (cancelled) return;
      setOverrides(stored);
      setDrafts(stored);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx, accountId]);

  const attention = review.filter((row) => row.status !== 'ok');
  // Rows worth showing: anything unresolved, plus anything already overridden,
  // even when it now looks healthy — otherwise a correction becomes invisible
  // and impossible to undo.
  const overridden = review.filter((row) => row.status === 'ok' && overrides[row.ticker]);
  const shown = showAll ? review : [...attention, ...overridden];

  const dirty = Object.keys({ ...drafts, ...overrides }).some(
    (ticker) => (drafts[ticker] ?? '') !== (overrides[ticker] ?? ''),
  );

  const save = async () => {
    setSaving(true);
    try {
      // What actually changed, so the confirmation can name it rather than
      // saying something vague happened.
      const changes = Object.keys({ ...drafts, ...overrides })
        .filter((ticker) => (drafts[ticker] ?? '') !== (overrides[ticker] ?? ''))
        .map((ticker) => ({ ticker, from: overrides[ticker], to: drafts[ticker] }));

      await saveOverrides(ctx, accountId, drafts);
      const stored = await loadOverrides(ctx, accountId);
      setOverrides(stored);
      setDrafts(stored);
      setSavedAt(new Date());
      onSaved(changes);
    } catch (error) {
      ctx.api.toast.error(error instanceof Error ? error.message : String(error));
    }
    setSaving(false);
  };

  return (
    <section className="border rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Symbols</h2>
        {review.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="text-xs text-muted-foreground hover:underline"
          >
            {showAll ? 'Show only those needing attention' : `Show all ${review.length}`}
          </button>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">
        Trading 212 identifies instruments by a private code, so the market symbol is worked out
        from it. That is right almost always, but a company that renamed keeps its old code —
        Trading 212 reports no event for a rename — so the guess can be stale, and a stale symbol
        can belong to someone else entirely. Anything marked <strong>wrong security</strong> is
        priced far from what Trading 212 quotes, which means Wealthfolio matched a different
        instrument. Correct it below; corrections are saved into Wealthfolio and applied on the
        next sync.
      </p>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading saved corrections…</p>
      ) : review.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Run a sync and the holdings will be listed here with the symbol chosen for each.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-green-700">
          All {review.length} holdings resolved and priced. Nothing needs a correction.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="py-2 pr-3 font-medium">Trading 212</th>
                <th className="py-2 pr-3 font-medium">Instrument</th>
                <th className="py-2 pr-3 font-medium">Symbol used</th>
                <th className="py-2 pr-3 font-medium">Exchange</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium">Correct it</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.ticker} className="border-b border-border/40 last:border-b-0">
                  <td className="py-2 pr-3 font-mono text-xs">{row.ticker}</td>
                  <td className="py-2 pr-3">
                    {row.name ?? '—'}
                    {row.status === 'mismatch' && row.resolvedName ? (
                      <span className="block text-xs text-red-700">
                        Wealthfolio has: {row.resolvedName}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {row.symbol}
                    <span
                      className={
                        'ml-1.5 ' +
                        (row.source === 'searched' ? 'text-amber-700' : 'text-muted-foreground')
                      }
                    >
                      ({row.source})
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {row.resolvedExchange ?? row.exchangeMic ?? '—'}
                    {row.resolvedExchange && row.exchangeMic && row.resolvedExchange !== row.exchangeMic ? (
                      <span className="block text-muted-foreground">sent {row.exchangeMic}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusChip status={row.status} />
                    {row.status === 'mismatch' ? (
                      <span className="block text-xs text-muted-foreground mt-0.5 tabular-nums">
                        {row.brokerPrice?.toFixed(2)} vs {row.wealthfolioPrice?.toFixed(2)}{' '}
                        {row.currency}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <SymbolInput
                      ctx={ctx}
                      value={drafts[row.ticker] ?? ''}
                      placeholder={row.symbol}
                      // Searching the instrument's name finds a renamed company
                      // that its dead ticker never would.
                      hint={row.name}
                      disabled={busy || saving}
                      onChange={(value) =>
                        setDrafts((current) => ({ ...current, [row.ticker]: value }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {savedAt && !dirty ? (
        <p className="text-sm rounded p-3 border border-green-200 bg-green-50 text-green-900">
          Corrections saved at {savedAt.toTimeString().slice(0, 8)}. Run{' '}
          <strong>Wipe and reload</strong> to re-import under them.
        </p>
      ) : null}

      {dirty ? (
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy || saving} primary>
            {saving ? 'Saving…' : 'Save corrections'}
          </Button>
          <Button onClick={() => setDrafts(overrides)} disabled={busy || saving}>
            Discard
          </Button>
          <span className="text-xs text-muted-foreground">
            Then run <strong>Wipe and reload</strong> to re-import under the corrected symbols.
          </span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A symbol field that searches as you type.
 *
 * Correcting a symbol means knowing what the company trades as now, which is
 * exactly what the ticker cannot tell us — so this asks the same market-data
 * search Wealthfolio uses for its own asset picker. Searching the instrument's
 * *name* is usually the shortest path: "Tsakos Energy" finds TEN, where the
 * dead ticker TNP finds nothing.
 */
function SymbolInput({
  ctx,
  value,
  placeholder,
  hint,
  disabled,
  onChange,
}: {
  ctx: AddonContext;
  value: string;
  placeholder: string;
  hint?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  // Debounced so a five-letter ticker is one search, not five.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await ctx.api.market.searchTicker(term);
        if (!cancelled) setResults(found.slice(0, 8));
      } catch {
        if (!cancelled) setResults([]);
      }
      if (!cancelled) setSearching(false);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ctx, query]);

  const choose = (result: SymbolSearchResult) => {
    onChange(result.canonicalSymbol ?? result.symbol);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          // Opening with the instrument's name already typed saves the step
          // people would otherwise have to guess at.
          if (!value && hint) setQuery(hint);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="w-32 border rounded px-2 py-1 font-mono text-xs"
      />

      {open && (results.length > 0 || searching) ? (
        <div className="absolute right-0 z-20 mt-1 w-80 max-h-64 overflow-y-auto border rounded bg-background shadow-lg">
          {searching && results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          ) : (
            results.map((result) => (
              <button
                key={`${result.symbol}-${result.exchange}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(result)}
                className="w-full text-left px-3 py-1.5 hover:bg-muted border-b last:border-b-0 border-border/40"
              >
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-mono font-medium">
                    {result.canonicalSymbol ?? result.symbol}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {result.exchangeName ?? result.exchange} {result.currency ?? ''}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {result.longName || result.shortName}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatusChip({ status }: { status: SymbolReview['status'] }) {
  const style =
    status === 'ok'
      ? 'text-green-700 border-green-200 bg-green-50'
      : status === 'unpriced'
        ? 'text-amber-800 border-amber-200 bg-amber-50'
        : 'text-red-700 border-red-200 bg-red-50';
  const label =
    status === 'ok'
      ? 'priced'
      : status === 'unpriced'
        ? 'no price found'
        : status === 'mismatch'
          ? 'wrong security'
          : 'not imported';
  return <span className={`text-xs border rounded-full px-2 py-0.5 ${style}`}>{label}</span>;
}

/** Progress bar, running log, and the summary a finished run leaves behind. */
function Activity({
  progress,
  log,
  result,
  busy,
}: {
  progress: Progress | null;
  log: LogEntry[];
  result: SyncResult | null;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail while it runs, so the newest line is always the visible one.
  useEffect(() => {
    if (busy) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [log.length, busy]);

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
          <Metric label="Rejected" value={String(result.invalid)} />
        </div>
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

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}
