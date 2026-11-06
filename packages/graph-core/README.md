# Shared graph derivation

This factory contains the desktop graph's original 22 data derivation functions. Desktop file-backed custom relation storage, model calls and other I/O remain in the desktop adapter. The factory has no imported runtime dependencies, filesystem, network, credentials or implicit custom relation store. Its only data access is through callbacks explicitly supplied by the adapter.

The mobile projector supplies only current-account visible paper/note fields. It reconstructs collections from synchronized names; those names do not restore desktop category IDs or hierarchy. Historical note anchors establish an association, not verified PDF-version or page evidence. Missing targets and deleted sources do not create dangling edges. Desktop-private reference caches, vector similarities and custom/AI-approved relations are unavailable on mobile and are explicitly excluded.

Desktop defaults, search-plus-one-hop neighbors, local breadth-first depth, coauthor matching/caps and reference resolution remain unchanged. Mobile deliberately returns an empty graph when a selected local center disappears, rather than applying the desktop helper's global fallback. Neither shared author names nor labels establish scholarly validity.

Graph UI is read-only. It pages nodes/relationships, shows up to eight distinct visual neighbors with a complete relationship list, and exports only the current filtered snapshot with provenance. Node labels and a bounded visible note preview are exported, not full note bodies or image bytes. Mobile UTF8 JSON export is limited to 8 MiB and fails before a file write when oversized. Mobile material limits fail explicitly and ask for a smaller tag/collection scope; they do not silently omit a source.

Regression evidence: tests/fixtures/graph-core/desktop-baseline.json was captured from the desktop implementation before extraction. Twenty request variants compare every node/edge field; existing desktop graph/storage tests and mobile model/UI tests cover the remaining adapter boundaries.

Material relation fanout is budgeted before core allocation. Unresolved note targets are filtered without changing visible graph output; historical anchor associations are deduplicated. Coauthor pair work has a separate 50000-comparison budget, with an explicit option to disable coauthor edges. These mobile work budgets do not change the desktop algorithm.
