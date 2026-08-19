import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { ImportPage } from './pages/ImportPage';

/**
 * Wealthfolio mounts the route component itself, with no props of its own, so
 * the context captured at enable time is what the page reads. The host owns
 * the single React root — never call `createRoot` here.
 */
let addonCtx: AddonContext | undefined;

const CryptoComRoute = () => {
  if (!addonCtx) return null;
  return <ImportPage ctx={addonCtx} />;
};

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // The route id must match `contributes.routes[].id` in manifest.json, and
  // the path is the host-owned `/addons/<addon-id>` mount. The sidebar entry
  // is declared in the manifest, so it needs no registration here.
  ctx.router.add({
    id: 'cryptocom-import',
    path: '/addons/cryptocom-import',
    component: CryptoComRoute,
  });

  ctx.api.logger.info('[cryptocom] Addon enabled');

  ctx.onDisable(() => {
    addonCtx = undefined;
    ctx.api.logger.info('[cryptocom] Addon disabled');
  });
};

export default enable;
