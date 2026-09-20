// Uses the existing backend SVG renderer; no image tooling runtime dependency.
// Run from the repository root: node packages/frontend/scripts/generate-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const root = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', root), 'utf8');
for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180], ['maskable-512', 512]]) {
  // Opaque full-bleed background for platform masks. The TS strokes fit inside
  // the central radius-204.8 safe circle of the 512px maskable canvas.
  const artwork = svg.replace('rx="96"', 'rx="0"');
  writeFileSync(new URL(`icons/${name}.png`, root), new Resvg(artwork, {
    fitTo: { mode: 'width', value: size },
  }).render().asPng());
}
