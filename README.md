# dsh-free-web-search

[![npm](https://img.shields.io/npm/v/%40natgurlain%2Fdsh-free-web-search?label=npm)](https://www.npmjs.com/package/@natgurlain/dsh-free-web-search)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A free web-search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web capability seam (`ctx.web`). It registers the search provider id **`free`**,
so the built-in `web_search` tool works without paying for a search API —
including with no API key at all.

- **General web first:** Tavily's keyless access mode works out of the box; a
  free Tavily API key (1,000 credits/month, no card) raises the limits.
- **Free upgrades:** Brave Search API ($5 of free credits per month) and a
  self-hosted SearXNG instance slot into the same chain when configured.
- **DuckDuckGo fallback:** when no sanctioned backend answers, a best-effort
  DuckDuckGo HTML backend is tried (see the caveat below).
- **Keyless floor:** the Wikipedia Action API and Hacker News Algolia API keep
  `web_search` returning something when every general backend is unavailable.
- **No dependencies:** Node's global `fetch` is the only network client.

## Requirements

- DeepSeek Harness `0.2.2-rc.1` up to (but excluding) `0.3.0`.
- No other runtime dependencies; Node's global `fetch` supplies networking.

## Install

### From npm (published package)

In DeepSeek Harness open **Plugins → Add plugin**, enter:

```text
@natgurlain/dsh-free-web-search
```

and install. Enabling the bundle is enough: its patch inserts the provider row
and pins the web service to it, so the model-facing `web_search` tool starts
using it.

### From this repository (local checkout)

Install the bundle from the package directory:

```text
pnpm install
```

or let the plugin manager install the directory directly by passing its
absolute path as the bundle target. Then verify the plugin row is live in
**Plugins** and call `web_search` once in a chat.

## Backends

The provider tries backends in configuration order and returns the first
non-empty general-web answer. Keyless domain sources are merged and interleaved
only when no general-web backend answers.

| Backend id    | Service                     | Credential | Cost / limits |
| ------------- | --------------------------- | ---------- | ------------- |
| `tavily`      | Tavily Search (`api.tavily.com/search`) | none — keyless access mode; optional free key (`TAVILY_API_KEY`) for higher limits | keyless is shared and rate-limited; a free key gives 1,000 credits/month with no card |
| `brave`       | Brave Search API (`/res/v1/web/search`) | `BRAVE_SEARCH_API_KEY` or `braveApiKey` | no free plan; each plan includes $5/month free credits ≈ 1,000 queries; a card is required to activate; no result retention and no AI training on results |
| `searxng`     | A SearXNG instance with JSON enabled | `searxngBaseURL` | free and keyless when self-hosted; public instances usually disable JSON; can include the DuckDuckGo engine |
| `duckduckgo`  | DuckDuckGo consumer HTML endpoint (`html.duckduckgo.com/html/`) | none | best-effort fallback; **not an official API**, automated access is not authorized and may be answered with a CAPTCHA; see below |
| `wikipedia`   | Wikipedia Action API        | none       | keyless, encyclopedic results only |
| `hackernews`  | Hacker News (Algolia)       | none       | keyless, tech/community results only |

Nothing is cached or stored by this plugin.

## Default behavior

- With no configuration, `tavily` answers first (keyless general web search).
- If Tavily is rate-limited or fails, the configured sanctioned backends
  (`brave`, `searxng`) are tried, then the **DuckDuckGo HTML fallback**.
- If all general-web backends fail, `wikipedia` and `hackernews` are merged as
  a keyless floor, and the tool result carries a note naming the failed
  general-web backend.
- `brave` and `searxng` are skipped until their key or base URL is configured.

> **Observed 2026-11-11:** Tavily's keyless mode reached its
> `daily_cap_reached` limit after a single successful search from one machine
> (it returns `429` with a `Retry-After` header). Treat keyless as evaluation
> traffic; for regular use, create the **free Tavily API key** (1,000
> credits/month, no credit card) and export `TAVILY_API_KEY`, or configure
> Brave or a SearXNG instance.

## DuckDuckGo caveat (read before relying on it)

DuckDuckGo has **no official API that returns web results**. Its only documented
machine endpoint is the deprecated Instant Answer API, which returns entity
cards, not search results. The consumer HTML endpoints are not a sanctioned
search API: DuckDuckGo's acceptable-use policy does not authorize automated
access, and the service responds to many automated clients with an HTTP 202
"anomaly" CAPTCHA page.

This plugin includes a `duckduckgo` backend anyway because it can work from some
networks: on 2026-11-11 the same machine received CAPTCHA pages from `curl` but
real results from Node's `fetch` (which presents a different TLS fingerprint).
That is inherently fragile and can break or be blocked at any time. Consequences:

- The backend stays **after** the sanctioned backends in the default order.
- A CAPTCHA or blocked response is reported as an error, so the chain falls
  through to the keyless floor instead of hanging.
- If you need a compliant, stable DuckDuckGo-backed path, run **SearXNG with
  its DuckDuckGo engine enabled** and use the `searxng` backend: SearXNG owns
  the upstream access instead of this plugin.
- To keep the plugin to sanctioned APIs only, remove `"duckduckgo"` from
  `backends`. You are responsible for how the endpoint is used.

## Configuration

Override the plugin row from the profile's `cordis.patch.yml` (or pass the same
object as the row's `config`):

```yaml
- id: free-web-search
  name: '@natgurlain/dsh-free-web-search'
  config:
    backends: ['tavily', 'brave', 'searxng', 'duckduckgo', 'wikipedia', 'hackernews']
    tavilyApiKeyEnv: TAVILY_API_KEY
    braveApiKeyEnv: BRAVE_SEARCH_API_KEY
    searxngBaseURL: http://127.0.0.1:8888
    wikipediaLanguage: en
    timeoutMs: 15000
```

All fields are optional. `tavilyApiKey` and `braveApiKey` also accept a literal
key, but prefer the environment variables so no secret enters configuration.

To use `brave` first, move it before `tavily` in `backends`. To disable a
backend, remove it from the list; an empty list makes the provider unavailable
and `web_search` reports a configuration error.

### SearXNG setup

Self-hosted SearXNG serves JSON once `settings.yml` includes it:

```yaml
search:
  formats:
    - html
    - json
```

Public instances commonly disable JSON and answer 403, so point
`searxngBaseURL` at an instance you control or trust. SearXNG's default engine
set includes DuckDuckGo, which makes this the recommended way to get
DuckDuckGo results without direct scraping.

## Wiring

`cordis.patch.yml` inserts the provider row and pins the web service:

```yaml
- insert:
    - id: free-web-search
      name: '@natgurlain/dsh-free-web-search'
      config: {}
- id: web
  config:
    searchProvider: free
    fetchProvider: http
```

The profile layer applies after this bundle, so a selection saved from the Web
search settings page (or a profile-level `web` row) wins over this pin.
`web_fetch` keeps using the shipped anonymous HTTP fetch provider.

## Notes and limits

- **Vendor fragility is expected.** Free tiers, keyless modes, and consumer
  endpoints change; the fallback chain and per-backend error messages exist so
  one vendor cannot break the tool completely.
- **Bounded output.** Snippets are whitespace-collapsed and capped at 480
  characters before the `web_search` tool applies its own summary cap. Result
  counts are bounded per backend; the web service enforces the tool's final
  source cap.
- **User agent.** All requests send a descriptive `User-Agent` identifying the
  plugin; the DuckDuckGo backend additionally sends a browser User-Agent because
  the endpoint fingerprints clients.
- **Not included:** You.com/Exa remote MCP backends (they speak MCP rather than
  plain REST and can be mounted through DSH's MCP client), and paid providers
  such as xAI Grok search.

## Development

There is no build step; the package ships plain ESM.

- Validate the module and run one live search with Node:

  ```bash
  node --input-type=module -e "
    const mod = await import('./index.js')
    let provider
    mod.apply({ web: { registerSearchProvider: (p) => { provider = p } } }, {})
    console.log(await provider.search({ query: 'deepseek harness', maxResults: 3 }))
  "
  ```

- Install the directory into a profile with the plugin manager's bundle
  installation, then confirm the row with the live config inspection and one
  `web_search` call.
- License and publication: MIT, published as
  `@natgurlain/dsh-free-web-search`.

## License

[MIT](./LICENSE) © 2026 Nat Gurlain
