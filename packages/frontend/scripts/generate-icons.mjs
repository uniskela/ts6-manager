// Uses the existing backend SVG renderer; no image tooling runtime dependency.
// Run from the repository root: node packages/frontend/scripts/generate-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const root = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', root), 'utf8');

const DEFAULT_ACCENT = '#1eb9ca';
const NEUTRAL_BACKGROUND = '#0b0e13';
const source = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)?.[1]
  ?.replace(/<title>[\s\S]*?<\/title>/i, '')
  .trim();

if (!source || !svg.includes('viewBox="0 0 512 512"') || !svg.includes('currentColor')) {
  throw new Error('favicon.svg must be a currentColor mark with viewBox="0 0 512 512"');
}

const renderSource = (scale) => {
  const offset = (512 - 512 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" color="${DEFAULT_ACCENT}">
    <rect width="512" height="512" fill="${NEUTRAL_BACKGROUND}"/>
    <g transform="translate(${offset} ${offset}) scale(${scale})">${source}</g>
  </svg>`;
};

for (const [name, size, scale] of [
  ['icon-192', 192, 0.86],
  ['icon-512', 512, 0.86],
  ['apple-touch-icon', 180, 0.82],
  // Keep all meaningful artwork inside the maskable radius-204.8 safe circle.
  ['maskable-512', 512, 0.78],
]) {
  writeFileSync(new URL(`icons/${name}.png`, root), new Resvg(renderSource(scale), {
    fitTo: { mode: 'width', value: size },
  }).render().asPng());
}
