import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { seedDevCredentials } from './lib/credentials';
import { ImportPage } from './pages/ImportPage';

/**
 * Wealthfolio mounts the route component itself, with no props of its own, so
 * the context captured at enable time is what the page reads. The host owns
 * the single React root — never call `createRoot` here.
 */
let addonCtx: AddonContext | undefined;

const Trading212Route = () => {
  if (!addonCtx) return null;
  return <ImportPage ctx={addonCtx} />;
};

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // The route id must match `contributes.routes[].id` in manifest.json, and
  // the path is the host-owned `/addons/<addon-id>` mount. The sidebar entry
  // is declared in the manifest, so it needs no registration here.
  ctx.router.add({
    id: 'trading212-import',
    path: '/addons/trading212-import',
    component: Trading212Route,
  });

  // Fire-and-forget: only does anything if DEV_CREDENTIALS are filled in.
  seedDevCredentials(ctx).catch((error: unknown) => {
    ctx.api.logger.error(
      `[trading212] Could not seed dev credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  ctx.api.logger.info('[trading212] Addon enabled');

  ctx.onDisable(() => {
    addonCtx = undefined;
    ctx.api.logger.info('[trading212] Addon disabled');
  });
};

export default enable;
