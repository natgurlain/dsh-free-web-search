# dsh-free-web-search

[![npm](https://img.shields.io/npm/v/%40natgurlain%2Fdsh-free-web-search?label=npm)](https://www.npmjs.com/package/@natgurlain/dsh-free-web-search)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A free web-search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web capability seam (`ctx.web`). It registers the search provider id **`free`**,
so the built-in `web_search` tool works without paying for a search API.

- **General web first:** Tavily answers out of the box in its keyless mode, and
  reliably once you add a free Tavily API key (1,000 credits/month, no card).
- **Free upgrades:** Brave Search API ($5 of free credits per month) and a
  self-hosted SearXNG instance slot into the same chain when configured.
- **X posts through Grok Build:** a query that targets X (`site:x.com`,
  "tweets about …") is answered by the `grok` CLI's X search when Grok Build is
  installed and signed in.
- **Keyless floor:** the Wikipedia Action API and Hacker News Algolia API keep
  `web_search` returning something when every general backend is unavailable.
- **Bounded and cancellable:** one search never runs past its time budget,
  Stop interrupts it at once, a rate-limited backend is skipped until its
  `Retry-After` passes, and a repeated query is answered from memory.
- **No dependencies:** Node's global `fetch` is the only network client.

## Requirements

- DeepSeek Harness `0.2.2-rc.1` up to (but excluding) `0.3.0`.
- No other runtime dependencies.
- Optional: [Grok Build](https://x.ai/cli) (`grok`), signed in, for X search.

## Install

In DeepSeek Harness open **Plugins → Add plugin**, enter:

```text
@natgurlain/dsh-free-web-search
```

and install. Enabling the bundle is enough: its patch inserts the provider row
and pins the web service to it, so the model-facing `web_search` tool starts
using it. From a terminal the same install is:

```bash
dsh plugin --profile <name> add @natgurlain/dsh-free-web-search
```

To install a local checkout instead, pass its path:

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-free-web-search
```

### First run: add the free Tavily key

Keyless Tavily is shared evaluation traffic: it stops after roughly ten
searches a day and then answers `429` until the next day. For everyday use,
create a free key at [tavily.com](https://tavily.com) (1,000 credits a month,
no credit card) and store it as `TAVILY_API_KEY` — in DeepSeek Harness's
credential settings, or as an environment variable. The plugin reads the
harness credential store first, so no restart is needed.

Without a key the plugin still works; once the daily cap is hit, results come
from Wikipedia and Hacker News only, and the tool result says so in one line.

## Backends

The provider tries backends in configuration order and returns the first
non-empty general-web answer. Keyless domain sources are merged and interleaved
only when no general-web backend answers.

| Backend id    | Service                     | Credential | Cost / limits |
| ------------- | --------------------------- | ---------- | ------------- |
| `x`           | X posts through Grok Build (`grok` CLI) | a signed-in Grok Build install | only used for X-targeted queries; uses your Grok plan; about 10 s per search |
| `tavily`      | Tavily Search (`api.tavily.com/search`) | none — keyless access mode; free key (`TAVILY_API_KEY`) recommended | keyless is capped at about ten searches a day; a free key gives 1,000 credits/month with no card |
| `brave`       | Brave Search API (`/res/v1/web/search`) | `BRAVE_SEARCH_API_KEY` or `braveApiKey` | no free plan; each plan includes $5/month free credits ≈ 1,000 queries; a card is required to activate |
| `searxng`     | A SearXNG instance with JSON enabled | `searxngBaseURL` | free and keyless when self-hosted; public instances usually disable JSON; can include the DuckDuckGo engine |
| `duckduckgo`  | DuckDuckGo consumer HTML endpoint (`html.duckduckgo.com/html/`) | none | **opt-in, not in the default chain**; not an official API, no key exists for it, and plain HTTP clients usually get a CAPTCHA; see below |
| `wikipedia`   | Wikipedia Action API        | none       | keyless, encyclopedic results only |
| `hackernews`  | Hacker News (Algolia)       | none       | keyless, tech/community results only |

## Default behavior

- `tavily` answers first. `brave` and `searxng` are skipped until their key or
  base URL is configured. `duckduckgo` is not tried unless you add it.
- As soon as one general backend fails, `wikipedia` and `hackernews` start in
  the background. Their results are used only when no general backend answers,
  and the tool result then opens with one sentence naming what failed, for
  example: *General web search was unavailable (Tavily keyless mode daily limit
  reached); these results come only from Wikipedia and Hacker News.* The full
  per-backend diagnostics go to the harness log.
- **Rate limits:** a backend that answers `429` is not asked again until its
  `Retry-After` has passed (one hour for a daily cap without the header, one
  minute otherwise). A DuckDuckGo CAPTCHA pauses that backend for 15 minutes.
- **Cache:** an answer is reused for the same query for five minutes
  (`cacheTtlSeconds`); a fallback-only answer for one minute. The cache lives
  in memory and is gone when the plugin reloads.
- **Time budget:** each request gets at most `timeoutMs` (8 s), and one whole
  search at most `totalTimeoutMs` (25 s) — below the web tool's own
  `searchTimeoutMs` (30 s), so a stalled backend cannot get the tool call
  killed before the fallback answers.
- **Cancellation:** the caller's abort signal reaches every request and the
  Grok process, so Stop and tool timeouts interrupt a search immediately.

## X search through Grok Build

DeepSeek Harness has no way to search X on its own, and X has no free search
API. If [Grok Build](https://x.ai/cli) is installed and signed in
(`grok login`), this plugin uses it:

- A query is sent to Grok only when it targets X: it contains `site:x.com` or
  `site:twitter.com`, or mentions `x.com`, Twitter, tweets, or "on X" /
  "X posts". Every other query skips Grok entirely.
- The plugin runs `grok` in headless mode, in an empty temporary folder, with
  the read-only sandbox and every tool except X search removed (no shell, no
  files, no web, no MCP). Post text is untrusted input to that agent.
- An answer is accepted only if the run really called an X search tool, and
  only `x.com/<handle>/status/<id>` URLs are kept, so posts answered from the
  model's memory are discarded rather than cited.
- If Grok is missing, signed out, slow, or finds nothing, the normal chain
  answers and the result says the posts are general web results, not X posts.

The search uses your Grok account and plan. `grok` is looked up on `PATH`, then
in `~/.local/bin`, `~/.grok/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`
(a desktop app does not inherit your shell's `PATH`); set `grokPath` if it
lives elsewhere. Remove `x` from `backends` to turn the feature off.

## DuckDuckGo is opt-in (read before enabling it)

DuckDuckGo has **no official API that returns web results**. Its only documented
machine endpoint is the deprecated Instant Answer API, which returns entity
cards, not search results. The consumer HTML endpoints are not a sanctioned
search API: DuckDuckGo's acceptable-use policy does not authorize automated
access, and the service responds to many automated clients with an HTTP 202
"anomaly" CAPTCHA page.

There is also **no API key** that unlocks it: DuckDuckGo sells no search API,
and the scrapers that still get through do so by imitating a browser's TLS
fingerprint with native libraries, which a zero-dependency plugin cannot do.

For that reason the `duckduckgo` backend is **not in the default chain** since
0.2.0. It still works from some networks (on 2026-11-11 Node's `fetch` got
results where `curl` did not; on 2026-11-17 it was the reverse), so it remains
available:

- To try it, add `"duckduckgo"` to `backends`, after the sanctioned backends.
  You are responsible for how the endpoint is used.
- A CAPTCHA is reported as an error and the backend is paused for 15 minutes,
  so a blocked network pays for one failed request, not one per search.
- If you need a compliant, stable DuckDuckGo-backed path, run **SearXNG with
  its DuckDuckGo engine enabled** and use the `searxng` backend.

## Configuration

The plugin exports a configuration schema, so the fields below are validated
when the plugin loads (a wrong type or an unknown backend id fails the load
with a message) and appear in the plugin's settings form, with API keys
masked. To set them by hand, override the plugin row in the profile's
`cordis.patch.yml`:

```yaml
- id: free-web-search
  name: '@natgurlain/dsh-free-web-search'
  config:
    backends: ['x', 'tavily', 'brave', 'searxng', 'wikipedia', 'hackernews']
    tavilyApiKeyEnv: TAVILY_API_KEY
    braveApiKeyEnv: BRAVE_SEARCH_API_KEY
    searxngBaseURL: http://127.0.0.1:8888
    wikipediaLanguage: en
    timeoutMs: 8000
    totalTimeoutMs: 25000
    cacheTtlSeconds: 300
```

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `backends` | all seven, in the order above | Which backends to use and in what order |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | Credential reference holding the Tavily key |
| `tavilyApiKey` | (unset) | Literal Tavily key; prefer the reference so no secret enters configuration |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Credential reference holding the Brave key |
| `braveApiKey` | (unset) | Literal Brave key; prefer the reference |
| `searxngBaseURL` | (unset) | Base URL of a SearXNG instance with JSON enabled |
| `wikipediaLanguage` | `en` | Wikipedia language edition |
| `timeoutMs` | `8000` | Upper bound for one request |
| `totalTimeoutMs` | `25000` | Upper bound for one whole search; keep it below the web tool's `searchTimeoutMs` |
| `cacheTtlSeconds` | `300` | How long an answer is reused for the same query; `0` disables the cache |
| `grokPath` | (found automatically) | Path of the Grok Build CLI |
| `grokModel` | (Grok Build's default) | Grok model used for X searches |
| `xTimeoutMs` | `20000` | Upper bound for one X search |

Keys are resolved for every search: first the literal value, then the harness
credential store (which also covers environment variables and `.env` files),
then the process environment.

To use `brave` first, move it before `tavily` in `backends`. To disable a
backend, remove it from the list; an empty list makes the provider unavailable.

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
search settings page (or a profile-level `web` row) wins over this pin. In that
page the provider is listed as **Free web search**. `web_fetch` keeps using the
shipped anonymous HTTP fetch provider, whose id is `http`.

## Notes and limits

- **Vendor fragility is expected.** Free tiers, keyless modes, and consumer
  endpoints change; the fallback chain and per-backend error messages exist so
  one vendor cannot break the tool completely.
- **Bounded output.** Snippets are whitespace-collapsed and capped at 480
  characters. Results are de-duplicated by URL, ignoring tracking parameters
  such as `utm_source`. The web service enforces the tool's final source cap.
- **User agent.** All requests send a descriptive `User-Agent` identifying the
  plugin; the DuckDuckGo backend sends a browser User-Agent instead because
  the endpoint answers anything else with a CAPTCHA.
- **Not included:** You.com/Exa remote MCP backends (they speak MCP rather than
  plain REST and can be mounted through DSH's MCP client).

## Development

There is no build step and nothing to install; the package ships plain ESM.

- Run the tests (they mock the network and Grok Build):

  ```bash
  npm test
  ```

- Run one live search with Node:

  ```bash
  node --input-type=module -e "
    const mod = await import('./index.js')
    let provider
    mod.apply({ web: { registerSearchProvider: (p) => { provider = p } } }, {})
    console.log(await provider.search({ query: 'deepseek harness', maxResults: 3 }))
  "
  ```

- License and publication: MIT, published as
  `@natgurlain/dsh-free-web-search`.

## License

[MIT](./LICENSE) © 2026 Nat Gurlain
