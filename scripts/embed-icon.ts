/**
 * Re-inline `icon.png` into `src/lib/broker-icon.ts`.
 *
 * The addon runs in an opaque-origin sandbox, so an image has to travel as a
 * data URI inside the bundle — a relative path has no origin to resolve
 * against. Run this after replacing `icon.png` with newer branding.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const png = readFileSync(resolve(root, 'icon.png'));
const uri = `data:image/png;base64,${png.toString('base64')}`;

const file = `/**
 * Trading 212's app icon, inlined.
 *
 * Fetched from \`https://www.trading212.com/apple-touch-icon.png\` — the icon the
 * site serves for a home-screen shortcut, which is the same mark as the phone
 * app. Taken from Trading 212 directly rather than a re-upload, so it is the
 * current artwork at full resolution and not somebody's rescaled copy.
 *
 * The logo is Trading 212's trademark, used here to identify the broker this
 * addon connects to. The addon is not published by, or affiliated with, them.
 *
 * Inlined as a data URI rather than shipped as a file because the addon runs in
 * an opaque-origin sandbox: a relative image path has no origin to resolve
 * against, and the packaged zip carries only the manifest, \`dist/\` and the
 * README. The source PNG is kept at \`icon.png\` in the repo so it can be
 * refreshed if the branding changes.
 *
 * GENERATED from icon.png — regenerate with \`pnpm icon:embed\`.
 */
export const BROKER_ICON = '${uri}';
`;

writeFileSync(resolve(root, 'src/lib/broker-icon.ts'), file);
console.log(`Inlined ${(png.length / 1024).toFixed(1)} KB from icon.png.`);
