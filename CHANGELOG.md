# Changelog

## 0.1.1 — 2026-11-11

- Add a **DuckDuckGo** backend (`duckduckgo`): best-effort parsing of the
  consumer HTML endpoint, with explicit detection of DuckDuckGo's HTTP 202
  anti-bot challenge. Included after the sanctioned backends in the default
  chain and documented as unofficial (no API, automated access not authorized).
- Extend HTML entity decoding (named and numeric entities) for DuckDuckGo and
  Wikipedia snippets.
- Clarify in the README that the compliant DuckDuckGo route is SearXNG with its
  DuckDuckGo engine enabled.

## 0.1.0 — 2026-11-11

Initial release.

- Registers the `free` search provider with the DeepSeek Harness web seam
  (`ctx.web`), so the built-in `web_search` tool works without a paid API.
- Backends, tried in configuration order: Tavily (keyless access mode by
  default, or a free API key at 1,000 credits/month), Brave Search API ($5
  monthly free credits, key and card required), a JSON-enabled SearXNG
  instance, and the keyless Wikipedia Action API and Hacker News Algolia API
  as a vendor-independent floor.
- Automatic fallback: the first non-empty general-web answer wins; keyless
  domain sources are merged and interleaved only when no general backend
  answers, with a note naming the failure.
- Bundle patch pins `web.searchProvider` to `free` and keeps the shipped
  anonymous HTTP fetch provider for `web_fetch`.
- Zero npm dependencies; Node's global `fetch` is the only network client.
