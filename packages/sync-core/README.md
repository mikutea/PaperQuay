# PaperQuay sync core (M1)

This dependency-free TypeScript package contains protocol schemas, runtime validation, immutable client state reducers, and a pure desktop projection. It does not open a desktop profile, read or write SQLite/localStorage, access files, start network requests, or contain authentication credentials. Import from `src/index.ts` in the service and mobile app.

## Protocol boundary

The five entity types are `paper`, `attachmentVersion`, `note`, `annotation`, and `readingPosition`. The exported JSON schemas reject additional fields at every payload boundary. `validateEntityData`, `validateSyncOperation`, `validateSyncRecord`, and request/response validators also check semantic invariants, including reading progress order. Server schema engines must reject, rather than silently remove, additional properties. Entity runtime validation remains necessary after JSON-schema validation because the furthest/current position comparison is a semantic check.

Account identity belongs to the authenticated service context. Wire operations and records contain no `accountId`, local path, model setting, API key, WebDAV credential, or desktop document snapshot. Error diagnostics contain schema field paths and fixed codes, never submitted values. The `canonicalJson` helper rejects non-JSON values instead of silently dropping them.

Annotations reference an immutable attachment version with a complete lowercase SHA-256 hash. Their quads use `pdf-crop-box-unrotated-normalized` coordinates in `[0,1]`. Each device owns its reading checkpoint. The current position may move backward; the furthest position cannot precede it.

## Durable client adapter contract

`AccountSyncState` is a complete persisted snapshot. The storage adapter owns transactions and must follow this order:

1. Obtain `accountId` and the session's service-issued `deviceId`, then open that account's isolated store. Never derive either ID from a display name, filesystem path, or hardware identifier.
2. Validate loaded state with `validateClientState`. Call `resumeAfterRestart` to invalidate callbacks from an earlier runtime; call `rebindDevice` when a newly authenticated session has another service-issued device ID. Commit the resulting snapshot.
3. For a local edit, call `queueLocalEdit` with a fresh UUID `opId` and an ISO timestamp. Persist the complete result in one transaction before reporting the edit as saved.
4. Capture `getSyncContext(state)`, call `preparePush`, and commit its returned state **before** sending its request. Send nothing when `opIds` is empty. Retain the original request operation IDs and context until the response is handled.
5. In a storage transaction, read the newest persisted state and apply `applyPushResults` with that captured context and the sent `opIds`. A lost response uses `markPushUncertain`; retry sends the identical operation, including its original `opId`, base revision, and data.
6. Pull using the current cursor. In one transaction apply `applyPullPage({fromCursor,response})` to the newest state and commit both records and cursor. A push acknowledgement never advances the pull cursor.

Reducers do not mutate input state. Errors leave the input snapshot usable, but an in-memory result is not durable until the adapter's transaction completes. Transactions must serialize read/modify/write steps so that typing, pull, and push completion cannot overwrite one another. Before processing a network callback, the adapter must also ensure that its store still belongs to the active authenticated account; the core's account/device/generation context rejects a mismatched callback.

An edit made while an earlier operation is sending, uncertain, rejected, or conflicted becomes a local overlay. Applied acknowledgements promote that overlay using the acknowledged revision, even when a newer pull has arrived; they never silently rebase an edit onto unseen server content. Retryable rejections retain the original operation. Permanent rejections and conflicts remain visible for user recovery. Reading operations from an earlier device session are preserved as `device-blocked` instead of being attributed to the new device.

Ordinary edits coalesced into an explicit restore that has never been sent retain its `restore` mutation and original base revision while replacing the content and local edit identity. A later delete cancels that restoration intent and keeps the tombstone. Once any send attempt has occurred, further edits remain overlays; neither retries nor edit coalescing change the original request.

Conflict resolution has its own service request. The adapter must persist its fixed resolution operation ID, submitted snapshot, and optional `consumedOverlayOpId` before sending it. After server acknowledgement, call `applyConflictResolution` with the returned record (or `null` when keeping a missing server value). Only the exact consumed overlay is removed. An edit created while resolution is in flight survives and is queued against the resolution's acknowledged revision. A `null` resolution does not erase an independently pulled newer record.

When another device closes a conflict, first establish that closure from an authoritative conflict listing and pull the current records, then call `applyRemoteConflictResolution`. This separate reducer removes the closed conflict but preserves any later local overlay as a fresh operation against the blocked attempt's original base revision. Its stale CAS basis lets the service create a new, resolvable conflict; it does not grant the local edit permission to overwrite the other device's decision. A restore overlay whose blocked create used revision zero uses revision one, which predates every service tombstone. With no overlay, the closed conflict simply clears. Replaying the closure cannot rebase the newly queued operation.

The M1 reducers intentionally provide no automatic repair for a permanently rejected operation. Preserve/export it and make any recovery action explicit. Do not remove a rejected or conflicted outbox entry merely to display a successful sync indicator.

## Desktop projection boundary

`createDesktopIdentityMap(accountId, libraryBindingId)` creates a private mapping. `libraryBindingId` is a random binding stored in the trusted desktop profile; it is not a library path or path hash. `projectDesktopLibrary` uses the caller's UUID allocator to assign opaque IDs, returning a new identity map that must be persisted before sending the projected entities. Reuse this map for later projections. Reusing it with another account or library binding fails.

The projection reconstructs paper metadata from an explicit whitelist. It emits PDF versions only with supplied `verification: 'sha256-complete'` evidence that matches stored size/hash metadata when present. It does not hash a PDF or consider a metadata hash to be proof that today's bytes were verified. A moved file with the same verified bytes keeps its version ID; replaced bytes obtain a different version ID.

Only explicit new Markdown notes (`format: 'markdown'`, `body`) are projected. Legacy `contentJson` notes and unknown text formats are skipped without flattening rich content. Existing notes remain in their original desktop store.

Old reading coordinates are not bound to today's file based on its pathname. A reading checkpoint requires a capture-time `DesktopHistoryVersionBinding`, matching account/library scope, full PDF hash, source-key update timestamp, device/session identity, and known furthest position. Standalone path-based histories, unsupported old position formats, legacy pixel annotation anchors, and structured-text marks are skipped. Skips expose only a type, index, and fixed reason code. The private desktop history, document/QA payload, and path-bearing source keys are never returned as wire entities.

M1 provides the pure projection and synthetic acceptance tests only. Wiring a real desktop store adapter, historical hash capture, UI conflict recovery, and real-device acceptance remains integration work. No legacy desktop library is written back by this package.

## Verification

From the repository root with Node 24 and the root dependencies installed:

```powershell
node --test tests/accountSyncSchema.test.ts tests/accountSyncState.test.ts tests/accountSyncProjection.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions --moduleResolution bundler --module esnext --target ES2022 --lib ES2022,DOM packages/sync-core/src/index.ts tests/accountSyncSchema.test.ts tests/accountSyncState.test.ts tests/accountSyncProjection.test.ts
```

The tests use synthetic records only. They cover field allowlists, immutable edits, lost responses, editing during push and conflict resolution, receipt replay, cursor transactions, account/session isolation, device-owned reading state, tombstones, stable scoped desktop mappings, path/credential exclusion, rich-note preservation, and PDF replacement/version binding.
