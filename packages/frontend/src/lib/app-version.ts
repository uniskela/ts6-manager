/** UI / build identity for this fork (sourced from package.json + optional git sha). */

const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '1.3.0';
const sha = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__.trim() : '';

export const APP_VERSION = version;

/** Footer label, e.g. `TS6 WEBUI v1.1.0` or `TS6 WEBUI v1.1.0 (6fe21da)`. */
export const APP_VERSION_LABEL = sha
  ? `TS6 WEBUI v${version} (${sha})`
  : `TS6 WEBUI v${version}`;
