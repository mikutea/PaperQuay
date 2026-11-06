# Dependency security maintenance

The `.17` desktop prerelease uses the supported Electron 43 line, starting at
43.8.7 with Node 24.22.1, as listed in the
[official version table](https://releases.electronjs.org/releases.json).
This includes the Chromium and Node certificate-chain mitigation for
[GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9).
Node 24.22.1 is pinned in CI; the reviewed server image digest already contains
Node 24.22.2. These include the
[October 2026 Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

Desktop and mobile use KaTeX 0.18.2 or later, including transitive Markdown renderers.
The Tiptap 3.31.3 peer range supports this version. The shared child-process
regression verifies that pre-existing prototype pollution cannot enable trusted
HTML commands, and that ordinary fractions still render. The
[upstream advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7) requires
prior prototype pollution; this change does not assert a separate pollution
source in PaperQuay.

The root minimatch override applies only to versions 9 and 10, whose consumers
use the named `minimatch` and `Minimatch` APIs. Legacy minimatch 3/5 consumers
retain their compatible versions. Remove the override once Electron Builder
and Electron Universal request a patched version themselves. The override
addresses [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249);
packaged-runtime verification and all four desktop packaging jobs must pass
before publication.

Lockfiles also update compatible Vite, Undici, fast-uri, source-map-js,
postcss-selector-parser and mobile rimraf/glob dependencies. Recheck all three
lockfiles with an online `npm audit`; an offline install is not fresh advisory
evidence. Audit results are dated observations, not a guarantee against future
advisories.
