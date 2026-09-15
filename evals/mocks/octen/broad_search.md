---
expect:
  query: string
---
[MOCK:broad_search] Question fanned out into 6 sub-queries; results grouped per sub-query, not deduplicated.

### Sub-query 1: self-hosted options
https://example.com/gateway-a — Gateway A, Apache-2.0, supports streaming and per-key budgets.
https://example.com/gateway-b — Gateway B, BSL licence, adds request caching.

### Sub-query 2: managed offerings
https://example.com/gateway-b — Gateway B also sells a hosted tier.
https://example.com/gateway-c — Gateway C is managed-only.

### Sub-query 3: what teams report in production
https://example.com/writeup — A team's writeup on running Gateway A behind an internal proxy.
