/**
 * Host half of the region-probe bundle.
 *
 * Deliberately empty: this bundle is pure Client-side inspection (see
 * `client.js`) — it registers one read-only Cordis Inspect provider, renders
 * nothing, and owns no tool. The Host half exists only so the Loader has an
 * entry to load.
 *
 * Same caching note as the session-tree bundle: the Loader caches an imported
 * Host module by package name, so editing this file for an already-loaded
 * package has no effect until the process restarts. A NEW package name has no
 * cached module, which is why a fresh bundle activates through the ordinary
 * `plugin_manager install_bundle` flow.
 *
 * Keep this a function/namespace plugin: a stray `export default` would make
 * the Loader's unwrapExports collapse the module and drop `inject`.
 */
export const name = 'region-probe'

export function apply() {}
