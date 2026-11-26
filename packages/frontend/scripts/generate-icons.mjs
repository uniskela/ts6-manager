// Uses the existing backend SVG renderer; no image tooling runtime dependency.
// Run from the repository root: node packages/frontend/scripts/generate-icons.mjs
//
// public/favicon.svg is the one source of the T6 glyph (a currentColor mark that
// the WebUI also uses as a CSS mask). This script wraps it in the brand colours:
// a cyan-to-violet gradient on a dark tile, shared with the TS6 Manager website.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const root = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', root), 'utf8');

const BRAND = { from: '#4fd3e2', to: '#9483ff', tile: '#0b1018' };
// The glyph's bounding box is centred 12px right of and below the canvas centre.
const CENTRE_OFFSET = -12;

const source = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)?.[1]
  ?.replace(/<title>[\s\S]*?<\/title>/i, '')
  .trim();

if (!source || !svg.includes('viewBox="0 0 512 512"') || !svg.includes('currentColor')) {
  throw new Error('favicon.svg must be a currentColor mark with viewBox="0 0 512 512"');
}

const gradient = `<linearGradient id="brand" x1="96" y1="80" x2="416" y2="432" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${BRAND.from}"/>
      <stop offset="1" stop-color="${BRAND.to}"/>
    </linearGradient>`;
const glyph = (scale) => {
  const offset = (512 - 512 * scale) / 2 + CENTRE_OFFSET * scale;
  return `<g transform="translate(${offset} ${offset}) scale(${scale})">${source.replaceAll('currentColor', 'url(#brand)')}</g>`;
};

// Rounded tile with a faint gradient edge: the browser tab and "any" install icons.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>TS6 Manager</title>
  <defs>
    ${gradient}
  </defs>
  <rect width="512" height="512" rx="128" fill="${BRAND.tile}"/>
  <rect x="8" y="8" width="496" height="496" rx="120" fill="none" stroke="url(#brand)" stroke-opacity=".45" stroke-width="16"/>
  ${glyph(1)}
</svg>
`;
// Full-bleed square for platforms that apply their own mask (iOS, Android adaptive icons).
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>${gradient}</defs>
  <rect width="512" height="512" fill="${BRAND.tile}"/>
  ${glyph(scale)}
</svg>`;

writeFileSync(new URL('icons/app-icon.svg', root), tile);
for (const [name, size, art] of [
  ['icon-192', 192, tile],
  ['icon-512', 512, tile],
  ['apple-touch-icon', 180, square(0.82)],
  // Keep all meaningful artwork inside the maskable radius-204.8 safe circle.
  ['maskable-512', 512, square(0.78)],
]) {
  writeFileSync(new URL(`icons/${name}.png`, root), new Resvg(art, {
    fitTo: { mode: 'width', value: size },
  }).render().asPng());
}
