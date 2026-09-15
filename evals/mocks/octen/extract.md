---
expect:
  urls: array
---
[MOCK:extract] 1 URL fetched.

url: https://docs.litellm.ai/docs/simple_proxy
category: product documentation
page_structure: article

# LiteLLM Proxy Server

LiteLLM Proxy is an open-source LLM gateway released under the MIT licence. It
exposes an OpenAI-compatible endpoint in front of 100+ providers, and supports
virtual keys with per-key budgets and rate limits, request routing with fallbacks,
and logging to external observability backends. It can run as a Docker container
or a Python process, with configuration in a single YAML file. Release 1.52.3
added an admin API for rotating virtual keys without restarting the proxy.
