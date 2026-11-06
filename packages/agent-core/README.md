# Shared library Agent planning

The factory reuses the desktop algorithms for rename commands, tag normalization and inference, category suggestions, metadata differences and reviewable plan items. It imports no filesystem, network, model, Electron or storage capability. Optional time and random adapters preserve the desktop ID format and let baseline tests compare complete plans. These IDs are display/planning identifiers; synchronization adapters must use valid operation UUIDs and independent replay receipts.

Desktop metadata lookup, PDF resolution, category creation and actual writes stay in libraryAgentPlanHelpers.ts. They are not mobile execution permission. No plan applies itself. Mobile integration still needs explicit target/source selection, request preview, per-item approval, strict target/version/schema checks and one atomic account transaction. A proposal to load document context does not authorize fetching or sending it.

The original desktop helper was captured before extraction. Root fixtures compare 47 exported results and three complete metadata-plan updates with fixed clock/entropy. Shared suggestions preserve the original normalization and ranking rules; a mobile category name cannot recreate an unsynchronized desktop category ID or hierarchy.
