import type { HttpRequest, HttpResponse } from '@t212/core';
import type {
  Account,
  ActivityImport,
  AddonContext,
  ImportActivitiesResult,
  NetworkRequest,
} from '@wealthfolio/addon-sdk';

/**
 * A stand-in for the Wealthfolio host.
 *
 * Wealthfolio ships no mock host — `wealthfolio-addon test` only pings the dev
 * server, and the official addons unit-test pure helpers. So this file is the
 * test environment: enough of `AddonContext` to run the addon's real code path
 * (keyring → network broker → checkImport → import) in plain Node.
 *
 * It copies the parts of the host's behaviour that the addon actually depends
 * on, rather than stubbing them away:
 *
 *   • the network broker refuses hosts the manifest does not declare;
 *   • it resolves `auth.secretKey` out of the keyring and builds the
 *     `Authorization` header itself, exactly as the real broker does;
 *   • `checkImport` validates and marks duplicates instead of waving rows through;
 *   • any API the addon touches but this mock does not implement throws a
 *     named error, mirroring the sandbox's "unknown API" failure.
 */

export interface MockHostOptions {
  accounts?: Account[];
  /** Hosts the manifest declares under `network.allowedHosts`. */
  allowedHosts?: string[];
  /** Serves brokered requests; usually `createT212Stub().handle`. */
  handleRequest?: (request: HttpRequest, authorization?: string) => Promise<HttpResponse>;
  /** Override the default validation if a test needs specific errors. */
  checkImport?: (rows: ActivityImport[]) => ActivityImport[] | Promise<ActivityImport[]>;
}

export interface MockHost {
  ctx: AddonContext;
  secrets: Map<string, string>;
  storage: Map<string, string>;
  /** Every brokered request the addon made, in order. */
  requests: NetworkRequest[];
  /** Authorization header values the broker built, in order. */
  sentAuthorizations: (string | undefined)[];
  /** Rows that reached `activities.import()`. */
  imported: ActivityImport[];
  logs: { level: string; message: string }[];
  toasts: { level: string; message: string }[];
  /** Registered routes, keyed by route id. */
  routes: Map<string, { path?: string; component?: unknown }>;
  disableCallbacks: (() => void)[];
}

export function createMockHost(options: MockHostOptions = {}): MockHost {
  const secrets = new Map<string, string>();
  const storage = new Map<string, string>();
  const requests: NetworkRequest[] = [];
  const sentAuthorizations: (string | undefined)[] = [];
  const imported: ActivityImport[] = [];
  const logs: { level: string; message: string }[] = [];
  const toasts: { level: string; message: string }[] = [];
  const routes = new Map<string, { path?: string; component?: unknown }>();
  const disableCallbacks: (() => void)[] = [];

  const accounts = options.accounts ?? [defaultAccount()];
  const allowedHosts = options.allowedHosts ?? ['live.trading212.com'];
  const validate = async (rows: ActivityImport[]): Promise<ActivityImport[]> =>
    options.checkImport ? options.checkImport(rows) : defaultCheckImport(rows, imported);

  const api = {
    accounts: {
      getAll: async () => accounts,
    },

    activities: {
      checkImport: async (rows: ActivityImport[]) => validate(rows),
      import: async (rows: ActivityImport[]): Promise<ImportActivitiesResult> => {
        // The real host re-validates on write; a row that failed checkImport
        // must not sneak through just because the addon passed it along.
        const validated = await validate(rows);
        const accepted = validated.filter((row) => row.isValid && !row.duplicateOfId);
        const duplicates = validated.filter((row) => row.duplicateOfId).length;
        imported.push(...accepted);
        return {
          activities: validated,
          importRunId: `mock-run-${imported.length}`,
          summary: {
            total: rows.length,
            imported: accepted.length,
            skipped: rows.length - accepted.length - duplicates,
            duplicates,
            assetsCreated: 0,
            success: true,
          },
        };
      },
    },

    secrets: {
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },

    storage: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => void storage.set(key, value),
      delete: async (key: string) => void storage.delete(key),
    },

    network: {
      request: async (request: NetworkRequest): Promise<HttpResponse> => {
        requests.push(request);

        const host = new URL(request.url).hostname;
        if (!allowedHosts.includes(host)) {
          throw new Error(
            `Network request to "${host}" blocked: not listed in manifest network.allowedHosts.`,
          );
        }

        // Broker-side credential handling: the secret never travels through
        // the addon, only its key does.
        let authorization: string | undefined;
        if (request.auth) {
          const stored = secrets.get(request.auth.secretKey);
          if (!stored) {
            throw new Error(`No secret stored under "${request.auth.secretKey}".`);
          }
          authorization =
            request.auth.type === 'basic' ? `Basic ${stored}` : `Bearer ${stored}`;
        }
        sentAuthorizations.push(authorization);

        if (!options.handleRequest) {
          throw new Error('MockHost has no handleRequest; pass one to serve network calls.');
        }
        return options.handleRequest(request, authorization);
      },
    },

    logger: {
      error: (message: string) => void logs.push({ level: 'error', message }),
      warn: (message: string) => void logs.push({ level: 'warn', message }),
      info: (message: string) => void logs.push({ level: 'info', message }),
      debug: (message: string) => void logs.push({ level: 'debug', message }),
      trace: (message: string) => void logs.push({ level: 'trace', message }),
    },

    toast: {
      success: (message: string) => void toasts.push({ level: 'success', message }),
      error: (message: string) => void toasts.push({ level: 'error', message }),
      info: (message: string) => void toasts.push({ level: 'info', message }),
      warning: (message: string) => void toasts.push({ level: 'warning', message }),
    },

    query: {
      getClient: () => {
        throw new UnimplementedHostApi('query.getClient');
      },
      invalidateQueries: () => {},
      refetchQueries: () => {},
    },
  };

  const ctx = {
    ui: { root: undefined as unknown as HTMLElement },
    sidebar: {
      addItem: () => ({ remove: () => {} }),
    },
    router: {
      add: (route: { id: string; path?: string; component?: unknown }) => {
        routes.set(route.id, { path: route.path, component: route.component });
      },
    },
    onDisable: (callback: () => void) => void disableCallbacks.push(callback),
    // Unimplemented namespaces throw by name rather than returning undefined,
    // so a typo surfaces the same way it would in the real sandbox.
    api: withUnimplementedGuard(api),
  } as unknown as AddonContext;

  return {
    ctx,
    secrets,
    storage,
    requests,
    sentAuthorizations,
    imported,
    logs,
    toasts,
    routes,
    disableCallbacks,
  };
}

export class UnimplementedHostApi extends Error {
  constructor(name: string) {
    super(`Host API "${name}" is not implemented by the mock host.`);
    this.name = 'UnimplementedHostApi';
  }
}

function withUnimplementedGuard<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === 'string') throw new UnimplementedHostApi(property);
      return undefined;
    },
  });
}

/**
 * Approximates the host's import validation: the checks that decide whether a
 * mapper bug reaches the database.
 */
function defaultCheckImport(
  rows: ActivityImport[],
  alreadyImported: ActivityImport[],
): ActivityImport[] {
  const seen = new Map<string, string>();
  for (const row of alreadyImported) {
    if (row.comment) seen.set(row.comment, row.id ?? row.comment);
  }

  return rows.map((row, index) => {
    const errors: Record<string, string[]> = {};

    if (!row.accountId) errors.accountId = ['Account is required'];
    if (!row.activityType) errors.activityType = ['Activity type is required'];

    const tradeType = row.activityType === 'BUY' || row.activityType === 'SELL';
    if (tradeType) {
      if (!row.symbol) errors.symbol = ['Symbol is required for trades'];
      if (toNumber(row.quantity) <= 0) errors.quantity = ['Quantity must be positive'];
      if (toNumber(row.unitPrice) < 0) errors.unitPrice = ['Unit price cannot be negative'];
    }

    const date = row.date instanceof Date ? row.date : new Date(String(row.date ?? ''));
    if (Number.isNaN(date.getTime())) errors.date = ['Date is not a valid timestamp'];
    if (!row.currency) errors.currency = ['Currency is required'];

    // Duplicate detection keys off the stable Trading 212 identity the mapper
    // writes into `comment`.
    const duplicateOfId = row.comment ? seen.get(row.comment) : undefined;

    return {
      ...row,
      lineNumber: row.lineNumber ?? index + 1,
      isValid: Object.keys(errors).length === 0,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      duplicateOfId,
    };
  });
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultAccount(): Account {
  return {
    id: 'acct-1',
    name: 'Trading 212 Invest',
    accountType: 'SECURITIES',
    balance: 0,
    currency: 'GBP',
    isDefault: true,
    isActive: true,
    isArchived: false,
    trackingMode: 'TRANSACTIONS',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  } as Account;
}
