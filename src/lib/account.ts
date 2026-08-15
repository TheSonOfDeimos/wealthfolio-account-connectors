import type { Account, AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountSummary } from 't212-sdk';
import { LINKED_ACCOUNT_STORAGE_KEY, T212_PROVIDER } from '../config';

/**
 * Creating and re-finding the Wealthfolio account that mirrors Trading 212.
 *
 * The account is created once and then found again on every later run, because
 * the alternative — a fresh account per sync — is the kind of mistake that is
 * tedious to undo by hand. Three things are checked, cheapest first: a
 * remembered id in addon storage, then a `providerAccountId` match, then the
 * name. Only if none of them finds anything is a new account created.
 */

/** What `accounts.create` accepts, established against a live 3.6.3 host. */
interface NewAccount {
  name: string;
  accountType: 'SECURITIES';
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  /**
   * Wealthfolio computes holdings and cash from the activity ledger. That is
   * the whole point here — the alternative, `HOLDINGS`, would take position
   * snapshots and discard the history we went to such lengths to extract.
   */
  trackingMode: 'TRANSACTIONS';
  group?: string;
  /** Survives renames, which is what makes re-finding the account reliable. */
  provider?: string;
  providerAccountId?: string;
}

export interface LinkResult {
  account: Account;
  /** False when an existing account was adopted rather than created. */
  created: boolean;
  /** How it was found, for the UI to explain itself. */
  foundBy?: 'storage' | 'provider' | 'name';
}

/**
 * Find the account this addon already syncs into, if there is one.
 *
 * Kept separate from creation so the UI can say "this will import into X"
 * before anything is written.
 */
export async function findLinkedAccount(
  ctx: AddonContext,
  summary: Pick<AccountSummary, 'id'>,
  name?: string,
): Promise<{ account: Account; foundBy: LinkResult['foundBy'] } | undefined> {
  const accounts = await ctx.api.accounts.getAll();
  const live = accounts.filter((account) => !account.isArchived);

  const rememberedId = await ctx.api.storage.get(LINKED_ACCOUNT_STORAGE_KEY);
  const remembered = rememberedId && live.find((account) => account.id === rememberedId);
  if (remembered) return { account: remembered, foundBy: 'storage' };

  // Survives a rename and a cleared addon storage, so it is the sounder key.
  const providerAccountId = String(summary.id);
  const byProvider = live.find(
    (account) =>
      account.provider === T212_PROVIDER && account.providerAccountId === providerAccountId,
  );
  if (byProvider) return { account: byProvider, foundBy: 'provider' };

  // Last resort, and only when the caller supplied a name to match: adopting
  // an account on name alone would be too eager without one.
  const trimmed = name?.trim();
  if (trimmed) {
    const byName = live.find((account) => account.name.trim() === trimmed);
    if (byName) return { account: byName, foundBy: 'name' };
  }

  return undefined;
}

/**
 * Get the Wealthfolio account for this Trading 212 account, creating it if
 * needed, and remember it for next time.
 *
 * The new account takes Trading 212's own currency rather than Wealthfolio's
 * base currency. That is not cosmetic: the ledger records cash movements in the
 * currency Trading 212 settled them in, and an account denominated in anything
 * else would need those amounts converted — exactly what this addon refuses to
 * do silently.
 */
export async function linkOrCreateAccount(
  ctx: AddonContext,
  summary: AccountSummary,
  name: string,
): Promise<LinkResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the account a name before creating it.');

  const existing = await findLinkedAccount(ctx, summary, trimmed);
  if (existing) {
    await ctx.api.storage.set(LINKED_ACCOUNT_STORAGE_KEY, existing.account.id);
    return { account: existing.account, created: false, foundBy: existing.foundBy };
  }

  const payload: NewAccount = {
    name: trimmed,
    accountType: 'SECURITIES',
    currency: summary.currency,
    isDefault: false,
    isActive: true,
    trackingMode: 'TRANSACTIONS',
    group: 'Trading 212',
    provider: T212_PROVIDER,
    providerAccountId: String(summary.id),
  };

  const account = await ctx.api.accounts.create(payload);
  await ctx.api.storage.set(LINKED_ACCOUNT_STORAGE_KEY, account.id);
  ctx.api.logger.info(
    `[trading212] Created account ${account.id} (${account.currency}) for Trading 212 ${summary.id}.`,
  );

  return { account, created: true };
}

/**
 * Warn when the account cannot represent Trading 212 faithfully.
 *
 * A currency mismatch is not fatal — Wealthfolio converts for display — but it
 * does mean the account total will never equal the figure Trading 212 shows,
 * and that is worth saying out loud before an import rather than after.
 */
export function describeMismatch(account: Account, summary: AccountSummary): string | undefined {
  if (account.currency === summary.currency) return undefined;
  return (
    `This account is in ${account.currency} but Trading 212 reports in ${summary.currency}. ` +
    'Cash movements will be recorded in the currency Trading 212 used, and Wealthfolio will ' +
    'convert them for display, so the totals will not match exactly.'
  );
}
