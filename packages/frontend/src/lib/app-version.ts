/** UI / build identity for this fork (sourced from package.json). */

const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '1.7.1'; // x-release-please-version

export const APP_VERSION = version;
export const APP_REPOSITORY_URL = 'https://github.com/uniskela/ts6-manager';
export const APP_DOCUMENTATION_URL = 'https://uniskela.com/docs/ts6-manager/';

/** Footer label, e.g. `TS6 WEBUI v1.1.0`. */
export const APP_VERSION_LABEL = `TS6 WEBUI v${version}`;
