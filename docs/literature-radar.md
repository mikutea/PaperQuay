# Literature radar and reading queue

Open **Literature radar / 文献雷达** from the workspace rail. Create a topic with
up to four search queries and select Crossref, OpenAlex, or both. All research
terms, exclusions, methods and ranking weights are configuration; no discipline
is built into the engine. An optional Chinese resident–tourist research example
is in [`examples/radar/resident-tourism.json`](../examples/radar/resident-tourism.json).
Copy its JSON into **Topic settings → Import configuration**. It is never seeded
automatically. Exported/imported configurations exclude credentials, history,
identity and enabled schedules.

## Discovery and library import

- **Check now** searches the configured publication-date window (7–3,650 days).
  Queries go to the selected metadata providers; library papers and notes are not
  uploaded. OpenAlex reuses the optional API key and contact address in Library
  settings. The key is not copied to radar state, configuration exports or errors.
- A check takes at most two pages of 25 records per query per provider. Capped
  queries and partial failures appear in the check details. This is a bounded
  discovery aid, not an exhaustive systematic review or database synchronization.
  Late-indexed papers outside the selected publication window are not covered.
- New results stay in the candidate inbox. DOI matching is case-insensitive;
  otherwise title, year and first author must match. Different known DOIs stay
  separate. Candidate status is shared across topics, including **Dismiss**.
- **Add metadata** explicitly adds a record to the existing library. Repeating
  the action reuses the existing paper. **Attach local PDF** copies a selected
  PDF through the existing file permission checks, preserving the source.
  There is no automatic PDF download. A PDF attachment does not mean its full
  text was read or used to calculate the ranking.

## One queue for old and new papers

The reading queue ranks every library paper against the selected topic,
including papers imported before this feature and metadata-only records. It
does not use the library screen's 1,000-result limit. Use **To read**, **Later**,
**Read** and **Pin** to control the queue. Those preferences survive restart and
do not rewrite library order, favorites, annotations or PDF reading progress.
Papers default to **To read** until you choose a status. **Read** is an explicit
decision: scrolling, heatmap activity and the legacy library progress field do
not change this status automatically.

Ranking is an explainable keyword heuristic, not an AI assessment or paper-quality
score. Each of relevance, priority and methods earns its configured weight times
the fraction of matching terms. Relevance uses the queries when no relevance
terms are set. Matches use the title, abstract, keywords and library tags. Recency
decreases linearly from its full weight to zero over ten publication years;
unknown dates earn zero. The default weights sum to 100; customized weights may
sum to another total. Exclusions or a failed relevance-term filter produce zero,
but do not hide existing library papers from the queue. Expand **Why this position**
to see contributions and matched terms.

## Schedules and storage

Automatic checks are off by default. When enabled, they run every 6, 12 or 24
hours, or weekly, only while PaperQuay is open. Startup checks for an overdue
topic after ten seconds; subsequent checks are considered once per minute.
Missed intervals are coalesced into one check per topic. Only one check runs at
a time; cancelling, editing or deleting its topic prevents stale results from
being committed. Requests time out after 15 seconds; a full check is bounded to
90 seconds. Manual retries have a one-minute cooldown, and provider rate-limit
responses postpone the topic (up to 24 hours). A failed check preserves existing
candidates. Existing external radar automations are not changed; enable an
in-app schedule deliberately to avoid duplicate discovery workflows.

Topics, candidates and queue choices are stored atomically in the active private
profile's `.settings/radar/<library-id>.json`, keyed by library location. Opening
another library never imports its subscriptions. There are limits of 20 topics,
5,000 candidates and 50,000 queue preferences. A full inbox reports omissions;
removing an unused topic clears its unique candidates. Deleting topics preserves
imported papers and reading choices. Malformed stored state is reported and kept
intact. Radar preferences are profile-local; ordinary library backup/sync does not
transfer them. Export topic JSON when moving research configuration elsewhere.

Provider references: [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/),
[Crossref filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/),
[OpenAlex API](https://help.openalex.org/api/).
