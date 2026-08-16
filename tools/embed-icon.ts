/**
 * Re-inline a connector's `icon.png` into `src/lib/broker-icon.ts`.
 *
 * The addon runs in an opaque-origin sandbox, so an image has to travel as a
 * data URI inside the bundle — a relative path has no origin to resolve
 * against, and the packaged zip carries only the manifest and `dist/`.
 *
 * Run from a connector directory after replacing its `icon.png`:
 *
 *   pnpm icon:embed
 *   pnpm icon:embed -- --manifest    # also update the manifest's icon field
 *
 * The provider's name and the URL the artwork came from are read from
 * `icon.json` beside the PNG, so this tool knows nothing about any one broker.
 * It used to hardcode Trading 212's wording, which the second connector
 * inherited verbatim.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface IconMeta {
  /** How the provider is named in prose, e.g. "Trading 212". */
  provider: string;
  /** Where the artwork was taken from, so it can be refreshed. */
  source: string;
}

const root = process.cwd();
const metaPath = resolve(root, 'icon.json');

if (!existsSync(metaPath)) {
  console.error(
    `No icon.json in ${root}.\n\n` +
      'It records which provider the artwork belongs to and where it came from:\n' +
      '  { "provider": "Kraken", "source": "https://www.kraken.com/_assets/icons/apple-touch-icon.png" }',
  );
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as IconMeta;
const png = readFileSync(resolve(root, 'icon.png'));
const uri = `data:image/png;base64,${png.toString('base64')}`;

const file = `/**
 * ${meta.provider}'s app icon, inlined.
 *
 * Fetched from \`${meta.source}\` — the icon the site serves for a home-screen
 * shortcut, which is the same mark as the phone app. Taken from ${meta.provider}
 * directly rather than a re-upload, so it is the current artwork at full
 * resolution and not somebody's rescaled copy.
 *
 * The logo is ${meta.provider}'s trademark, used here to identify the provider
 * this addon connects to. The addon is not published by, or affiliated with,
 * them.
 *
 * Inlined as a data URI rather than shipped as a file because the addon runs in
 * an opaque-origin sandbox: a relative image path has no origin to resolve
 * against, and the packaged zip carries only the manifest and \`dist/\`. The
 * source PNG is kept at \`icon.png\` in the repo so it can be refreshed if the
 * branding changes.
 *
 * GENERATED from icon.png — regenerate with \`pnpm icon:embed\`.
 */
export const BROKER_ICON = '${uri}';
`;

writeFileSync(resolve(root, 'src/lib/broker-icon.ts'), file);
console.log(`Inlined ${(png.length / 1024).toFixed(1)} KB from icon.png for ${meta.provider}.`);

// The manifest carries its own copy, for the add-on list in Wealthfolio's
// settings. Kept opt-in so a routine re-embed does not churn the manifest.
if (process.argv.includes('--manifest')) {
  const manifestPath = resolve(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  manifest.icon = uri;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('Updated the manifest icon too.');
}
