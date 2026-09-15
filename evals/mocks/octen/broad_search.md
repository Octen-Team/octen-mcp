---
expect:
  query: string
---
[MOCK:broad_search] Question fanned out into 6 sub-queries; results are grouped per sub-query and not deduplicated.

### Sub-query 1: open-source self-hosted gateways
https://docs.litellm.ai/docs/simple_proxy — LiteLLM Proxy, MIT, 100+ provider adapters, per-key budgets.
https://github.com/Portkey-AI/gateway — Portkey Gateway, MIT, edge-deployable, guardrails and retries.
https://relaypoint.dev/docs — Relaypoint, Apache-2.0, a newer self-hosted gateway focused on per-tenant quotas.

### Sub-query 2: observability-first options
https://www.helicone.ai/ — Helicone, Apache-2.0 core, proxy plus tracing and caching.
https://docs.litellm.ai/docs/proxy/logging — LiteLLM also ships its own logging integrations.

### Sub-query 3: what teams run in production
https://example.com/gateway-writeup — A platform team's writeup on running LiteLLM behind an internal ALB for 40 services, after trialling Relaypoint and rejecting it on operational maturity.
