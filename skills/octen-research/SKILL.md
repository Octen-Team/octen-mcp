---
name: octen-research
description: >-
  Use when a question needs coverage rather than a single answer — research, market
  or literature surveys, competitive analysis, "find everything about X", "deep dive
  on Y", "what are all the options for Z", building a list of entities — or when one
  search has already come back thin and the gap is breadth, not phrasing.
  Also covers landscape scans, comprehensive coverage of a field, and answers
  that have to cite their sources.
metadata: {"homepage": "https://octen.ai", "support": "support@octen.ai"}
---

# Octen Research

Multi-source research on Octen. The shape is always the same: **fan out, filter,
ground, then synthesize** — never a single search dressed up as a report.

## When this skill applies

Use it when the answer needs *coverage*: several entities, several angles, or a
claim that must hold across sources.

Do **not** use it for a single fact, a single entity, or a page you already have
the URL for — those are one `search` or one `extract`. Routing for those lives in
the **octen-web-search** skill.

## Before searching: resolve time

A relative window ("recent", "last quarter", "past 6 months") is not a filter
until it becomes two timestamps. Take today's date from your environment context,
work out the bounds, and state them before the first call — an approximate window
silently changes what the fan-out covers.

Pass them as `start_time` / `end_time`, or use `time_range` when one of the coarse
windows (`day` / `week` / `month` / `year`) is exactly what was asked for.

## Step 1 — fan out

One `broad_search` with the **whole** question. Do not pre-split it into
sub-queries; decomposition is what the tool does.

Set `max_queries` to the scope:

| Scope | `max_queries` |
|--|--|
| Focused comparison, 2–3 entities | 3–5 |
| Multi-facet research | 5–10 |
| Landscape scan | 10–20 |
| Exhaustive survey | 20–30 |

For a question about recent events, add `topic: news`. Narrow with
`include_domains` when the credible sources are known (`arxiv.org`, a vendor's
docs domain), and `exclude_domains` to drop content farms.

Results come back grouped per sub-query and are **not deduplicated** — the same
URL can appear under several sub-queries. Dedupe by URL before counting anything.

## Step 2 — filter before you read

Judge candidates from the highlights, not by fetching everything. Drop duplicates,
listicles, and pages that only restate the query. `extract` is the expensive step;
spend it on the handful that carry real evidence.

## Step 3 — ground

`extract` the survivors, up to 20 URLs in one call. Leave `query` unset — this
step exists to read the page, and setting `query` returns ranked excerpts *instead
of* the body, which is the opposite of grounding. Each result carries `category`
and `page_structure` — use them to throw out login walls and nav pages before
spending context on what you fetched.

Any claim that ends up in the answer should trace to a page you actually
extracted, not to a search snippet.

## Step 4 — check coverage, then synthesize

Before writing, ask what is still missing: an entity named in the sources but never
researched, a claim resting on one source, an angle the fan-out never covered. Each
gap is one targeted `search` or `extract` — not a second `broad_search` over the
same ground.

Then write the answer with sources attached to claims, and say plainly what you
could not establish. A gap reported is worth more than a gap papered over.

## Scaling up

For a survey wide enough that the extracted material won't fit comfortably in
context, split it by sub-topic and delegate each branch to a subagent, giving each
one its slice of URLs and a narrow question. Compile their returns yourself. Keep
the fan-out and the final synthesis in one place — only the reading parallelizes.

## Common mistakes

| Mistake | Do this instead |
|--|--|
| Re-running `broad_search` when results disappoint | Targeted `search` / `extract` on the specific gap |
| Pre-splitting the question into sub-queries | Pass the whole question, raise `max_queries` |
| Counting results without deduping | Dedupe by URL first — results are grouped, not deduplicated |
| Citing search snippets as evidence | `extract` the page and cite what you read |
| `extract`-ing every hit | Filter on highlights first; extract the few that matter |
| Relative dates passed through unresolved | Compute explicit dates, pass `start_time` / `end_time` |
| Reporting a confident answer with a silent hole | Name what you couldn't establish |
