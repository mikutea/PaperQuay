# Shared radar algorithms

The desktop adapter and mobile app use this CommonJS factory for topic normalization, keyword matching, ranking reasons, deterministic candidate identities, conservative duplicate matching, queue ordering, candidate merging and Crossref/OpenAlex metadata conversion. The factory imports no file, network, Electron, storage or credential capability. Callers supply UTF-8 SHA-256 truncated to 24 hexadecimal characters and a UUID generator. The mobile adapter uses the already locked noble hashes dependency; the desktop adapter uses Node crypto.

The fixtures in tests/fixtures/radar-core/desktop-baseline.json were produced from the original desktop implementation before extraction. Both root and mobile tests compare every captured result, including missing identities, differing known DOIs, source merging, explicit reading preferences and malformed source mappings.

Desktop candidatePaperId returns its original desktop-only identifier. The mobile synchronization adapter derives a separate valid deterministic UUID, commits its private candidate link and adoption receipt with the real paper/outbox transaction, and never treats a radar recommendation as proof of a locally available PDF.

Network scheduling, request budgets, public API errors and credentials belong to platform adapters. Mobile state remains account-local and every source query requires explicit preview and submission. Reading position does not imply an explicit read decision.
