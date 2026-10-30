# Shared literature-review core

Desktop and mobile use this single implementation for blueprints, staged writing prompts, resumable parts, final draft composition, formal citation numbering, Markdown and DOCX rendering. It contains no filesystem, Electron, credentials or model transport. Desktop retains model calls, approved output paths, file reads and image conversion. Mobile supplies only explicitly validated image bytes.

## Runtime boundaries

- Pure business algorithms need no adapters. Word libraries are injected only when rendering Word.
- Mobile resolves its own pinned browser dependencies and returns Uint8Array. Desktop injects the same libraries and returns a Node buffer. ZIP timestamps can differ; academic XML and media parts must match.
- readFigure is the only image IO seam. The core does not open a path, resolve a URL, fetch media or request permission. Missing images produce explicit skipped-figure receipts that callers must display.
- Legacy normalizers preserve desktop behavior, including filtering unknown IDs. They are not validation of model output or source ownership. Mobile must reject unknown source/figure IDs before normalization, recheck account/version/hash, and validate edited content before export. Citation membership does not prove a claim.
- Model transport, source selection, persistence, account invalidation and explicit export/share belong to the mobile workflow. Importing this library does not implement PAR-03.

## Checkpoint composition

A checkpoint stores sectionParagraphs as task slots, with null for unfinished work. Final composition expects sections merged with mergeGeneratedParagraphParts, as on desktop. Preserve the checkpoint separately for resuming. Changed blueprint/context invalidates old task slots; never silently reuse by position after edits.

## Evidence

tests/fixtures/review-core captures a synthetic pre-extraction desktop baseline. Root tests compare plans, prompts, checkpoints, Markdown, all Word XML and media bytes. Mobile tests cover portable bytes and editable OMML. Task QA executes the browser bundle in a real Android WebView with no INTERNET permission and no Node globals. These checks do not replace external-model, OIDC, cross-device or four-device acceptance.
