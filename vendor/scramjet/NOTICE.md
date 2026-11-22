Scramjet code reused by Sandstone
================================

Upstream: https://github.com/MercuryWorkshop/scramjet
Pinned commit: 32ffe62c40e25f6c7d329735324fa355d159fb73
Declared upstream license: AGPL-3.0-only, in packages/core/package.json.
The AGPL v3 license text is included in Sandstone's root LICENSE.

Vendored file:

- src/vendor/scramjet/refresh.mjs comes from packages/core/src/shared/refresh.ts.
  TypeScript annotations were removed, the opening comment was replaced with
  this provenance reference, and the snapshot import was replaced by a local
  captured Number.parseInt. The parsing algorithm is otherwise unchanged.

To update, compare the pinned upstream file with its proposed replacement,
retain attribution, record the new commit and modifications here, then run
test/meta-refresh.test.mjs and the production build. Do not download source at
runtime: this module is bundled into the standalone HTML, including file://.
