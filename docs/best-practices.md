# Best practices for agent integration

This guide is for developers wiring Octen Extract into an LLM agent (RAG pipeline, autonomous workflow, MCP integration). It covers how to consume the per-page labels Octen returns — `page_structure`, `category`, `highlights` — so your agent spends fewer tokens and skips garbage pages.

If you only have time for one rule:

> **Read `page_structure` and `category` BEFORE you feed `full_content` to the LLM.** These two fields are cheap (a handful of tokens) and let you skip ~20–30% of typical fetched URLs without an LLM call.

---

## Why labels first, body second

Most extract tools hand you the page body and let the LLM figure out the rest. That works, but it's expensive: the LLM burns tokens parsing nav cruft, recognizing login walls, and inferring topical fit — work the extraction layer should have done.

Octen returns three structured signals on every successful extract:

| Field | What it tells you | Cost to check |
|---|---|---|
| `page_structure` `{primary, secondary}` | What *kind* of page this is — content vs nav vs operational | ~5 tokens |
| `category` `{primary, secondary}` | What *topic* the page is about | ~5 tokens |
| `highlights[]` (only when `query` is set) | Ranked snippets relevant to the user's intent | 100–300 tokens, replaces `full_content` |

A 30-token check on the first two can save you a 30,000-token LLM call on `full_content`. The rest of this page is how to wire those checks into your agent.

---

## `page_structure` — gate before consuming the body

The `page_structure.primary` value tells your agent whether `full_content` is worth reading at all. Treat it as a gate.

### Common values and what to do

| `page_structure.primary` | Typical pages | What your agent should do |
|---|---|---|
| `Content Page` | Articles, blog posts, encyclopedia entries, documentation | **Consume `full_content`** (or `highlights` if `query` set) — this is real content |
| `Index Page` | Homepages, category landing pages, search results pages | **Don't summarize the body** — it's mostly nav. If the user wanted to find content, pick specific links from `highlights` (with `query`) and re-fetch those |
| `No Main Content` | Login walls, paywalls, "JavaScript required" stubs, captcha pages | **Skip entirely** — tell the user the page has no extractable content. Do not feed the body to the LLM; it's just nav markup |
| `Operation Page` | Login forms, signup forms, contact forms | Same as `No Main Content` — skip |

`page_structure.secondary` adds a finer-grained label (`Article`, `Encyclopedia`, `Code`, `Home Page`, etc.) — useful if you want to route differently between articles and code docs, but the primary value is enough for the main gate.

### Anti-pattern

```python
# ❌ DON'T do this
result = octen.extract(urls=[user_url])[0]
summary = llm.summarize(result.full_content)   # may be summarizing 600 bytes of nav
```

### Pattern

```python
# ✅ DO this
result = octen.extract(urls=[user_url])[0]

if result.page_structure.primary == "No Main Content":
    return f"The page at {user_url} has no extractable content (likely a login wall or shell)."

if result.page_structure.primary == "Index Page":
    # Body is nav. Don't summarize it; offer to crawl deeper.
    return f"{user_url} is an index/landing page. Want me to follow specific links from it?"

# It's a Content Page — safe to summarize
summary = llm.summarize(result.full_content)
```

---

## `category` — filter before embedding

`category.primary` is the topical bucket the page falls into (`Computers, Electronics & Technology`, `Health`, `Finance`, `News & Media`, `Travel`, …). Use it for two patterns:

### Pattern 1: vertical-RAG filtering

If your RAG pipeline is scoped to a vertical (e.g., a finance copilot, a health-info bot), check `category` before embedding the body:

```python
ALLOWED = {"Finance", "Business & Consumer Services"}

for url in candidate_urls:
    r = octen.extract(urls=[url])[0]
    if r.status != "success":
        continue
    if r.category.primary not in ALLOWED:
        # Skip off-vertical pages BEFORE embedding — saves embedding cost too
        log.info(f"skipping {url}: category={r.category.primary}")
        continue
    embed_and_store(r.full_content, metadata={"url": url, "category": r.category})
```

In typical web crawls a meaningful share of URLs (often 20–30%) are off-vertical. Filtering by `category` first cuts embedding cost and keeps your index clean.

### Pattern 2: intent-mismatch detection

When a user asks about topic X and you fetch a URL, compare `category` against the asked-for topic. If they don't match, surface that to the user instead of silently summarizing an irrelevant page:

```python
if r.category.primary == "Ecommerce & Shopping" and user_intent == "API documentation":
    return "Looks like that URL is an e-commerce / marketplace page, not API docs. Did you mean a different URL?"
```

---

## `query` — get ranked snippets instead of the full body

Set `query` whenever the user's question is **about** the page rather than asking for the page itself. The response replaces `full_content` with `highlights[]` — the 5 ranked snippets most relevant to the query.

### When to use `query`

| User intent | Use `query`? |
|---|---|
| "Summarize this article for me" | ❌ no — they want the body |
| "What's the pricing on this page?" | ✅ yes — `query="pricing"` |
| "When was MCP announced according to this post?" | ✅ yes — `query="When was MCP announced?"` |
| "Tell me everything on this docs page" | ❌ no — they want the body |
| "Find the section about authentication" | ✅ yes — `query="authentication"` |

### Token economics

On single-fact queries, `highlights` typically delivers the same answer in a small fraction of the tokens you'd spend on the full body. The longer the page and the narrower the question, the bigger the win.

### Known limitation: structured quantitative data

`highlights` is a ranked-snippets layer over the page's markdown. When the answer lives inside an HTML `<table>` (one number per cell), the ranker can pick the "headline description" and the "row labels" but miss the cell numbers. **If your query asks for specific numbers from a table, fall back to no-`query` and parse `full_content` yourself.**

```python
# Pattern: try highlights first, fall back to full_content if the answer isn't there
r = octen.extract(urls=[url], query=user_q)[0]
answer = llm.answer(query=user_q, context=r.highlights)
if "not found" in answer.lower() or answer.confidence < 0.7:
    # Fall back to full body
    r_full = octen.extract(urls=[url])[0]
    answer = llm.answer(query=user_q, context=r_full.full_content)
```

---

## The decision tree (TL;DR diagram)

```
extract(urls, query?) returns each result.

For each result r:

  if r.status == "failed":
      → handle error (404 / 500 / DNS — different remediations)
      → don't try to consume r.full_content; it's empty

  elif r.page_structure.primary == "No Main Content":
      → skip; tell user the page is a shell / login wall
      → DO NOT summarize r.full_content (it's nav)

  elif r.page_structure.primary == "Index Page":
      → body is nav; don't summarize blindly
      → offer to follow specific links

  elif r.category.primary out-of-vertical for this pipeline:
      → skip; log mismatch

  else:                                # Content Page, on-vertical
      if query was set:
          → use r.highlights[]         (compressed answer)
      else:
          → use r.full_content         (full body)
```

---

## Putting it together: a complete agent loop

```python
def fetch_for_user(user_url, user_question=None):
    # 1. Always include query if you have a user question
    args = {"urls": [user_url]}
    if user_question:
        args["query"] = user_question

    r = octen.extract(**args)["data"]["results"][0]

    # 2. Failure gate
    if r["status"] == "failed":
        return f"Couldn't fetch {user_url}: {r.get('error_message', 'unknown error')}"

    # 3. Structure gate
    ps = r["page_structure"]["primary"]
    if ps in ("No Main Content", "Operation Page"):
        return f"{user_url} is a {ps.lower()} (login wall, shell, or form). No extractable content."

    if ps == "Index Page":
        return f"{user_url} is an index/landing page. Want me to pick specific links from it?"

    # 4. (Optional) Category gate — uncomment for vertical pipelines
    # if r["category"]["primary"] not in ALLOWED_VERTICALS:
    #     return f"{user_url} is in category {r['category']['primary']}, outside the scope of this pipeline."

    # 5. Consume the right field
    if user_question and r.get("highlights"):
        body = "\n\n".join(r["highlights"])
    else:
        body = r["full_content"]

    return llm.answer(query=user_question or "Summarize this page.", context=body)
```

---

## What this guide does NOT replace

- **Failure-mode handling**: see the [edge cases section](https://github.com/Octen-Team/octen-mcp#how-octen-handles-edge-cases) of the MCP README for the 404 / 5xx / DNS patterns.
- **Tokenizer choice / cost modeling**: estimates here use `cl100k_base` (GPT-4 family). Re-measure against your actual LLM.
- **Independent quality eval**: for production confidence, run your own eval against your task distribution. `highlights` ranking quality and edge-case coverage depend on the page type — measure on the pages your agent actually fetches.