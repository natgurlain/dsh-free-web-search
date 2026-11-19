# dsh-free-web-search

[![npm](https://img.shields.io/npm/v/%40natgurlain%2Fdsh-free-web-search?label=npm)](https://www.npmjs.com/package/@natgurlain/dsh-free-web-search)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A free web-search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web capability seam (`ctx.web`). It registers the search provider id **`free`**,
so the built-in `web_search` tool works without paying for a search API.

- **General web first:** Tavily answers out of the box in its keyless mode, and
  reliably once you add a free Tavily API key (1,000 credits/month, no card).
- **Keyless backups:** when Tavily's keyless allowance is spent, Exa and
  You.com answer through their hosted keyless endpoints, so the model still
  gets real web results without any account.
- **Specialised sources for the right queries:** a query that quotes an error
  message is also looked up on Stack Overflow, and a query that names GitHub or
  asks for a repository is also sent to GitHub repository search. Their top
  results lead the answer, marked with their source type.
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

Without a key the plugin still works: once Tavily's daily cap is hit, Exa and
You.com answer keyless. Their limits are small or unpublished, so the free
Tavily key remains the dependable setup. Only when all three are unavailable do
results come from Wikipedia and Hacker News, and the tool result then says so
in one line.

## Backends

There are three kinds of backend:

- **General web** (`tavily`, `brave`, `searxng`, `exa`, `you`, `duckduckgo`):
  tried in configuration order; the first non-empty answer wins.
- **Specialised** (`stackexchange`, `github`, `arxiv`): asked only for queries
  routed to them (see [Specialised sources](#specialised-sources)), beside the
  general chain.
- **Keyless floor** (`wikipedia`, `hackernews`): merged and interleaved only
  when no general-web backend answers.

| Backend id    | Service                     | Credential | Cost / limits |
| ------------- | --------------------------- | ---------- | ------------- |
| `x`           | X posts through Grok Build (`grok` CLI) | a signed-in Grok Build install | only used for X-targeted queries; uses your Grok plan; 10–25 s per search |
| `tavily`      | Tavily Search (`api.tavily.com/search`) | none — keyless access mode; free key (`TAVILY_API_KEY`) recommended | keyless is capped at about ten searches a day; a free key gives 1,000 credits/month with no card |
| `brave`       | Brave Search API (`/res/v1/web/search`) | `BRAVE_SEARCH_API_KEY` or `braveApiKey` | no free plan; each plan includes $5/month free credits ≈ 1,000 queries; a card is required to activate |
| `searxng`     | A SearXNG instance with JSON enabled | `searxngBaseURL` | free and keyless when self-hosted; public instances usually disable JSON; can include the DuckDuckGo engine |
| `exa`         | Exa hosted MCP endpoint (`mcp.exa.ai/mcp`, tool `web_search_exa`) | none — keyless | free rate limit, number unpublished; keyless needs a direct IPv4 connection (IPv6 or a proxy gets `403`) |
| `you`         | You.com hosted MCP endpoint, free profile (`api.you.com/mcp?profile=free`, tool `you-search`) | none — keyless | 100 searches a day, no account |
| `stackexchange` | Stack Exchange API, Stack Overflow questions with at least one answer | none | specialised; keyless quota is 300 requests a day per address |
| `github`      | GitHub REST API, repository search | none | specialised; unauthenticated search allows 10 requests a minute per address |
| `arxiv`       | arXiv Atom API | none | specialised, **opt-in**: multi-word queries were slow or rate-limited when tested on 2026-11-18 |
| `duckduckgo`  | DuckDuckGo consumer HTML endpoint (`html.duckduckgo.com/html/`) | none | **opt-in, not in the default chain**; not an official API, no key exists for it, and plain HTTP clients usually get a CAPTCHA; see below |
| `wikipedia`   | Wikipedia Action API        | none       | keyless, encyclopedic results only |
| `hackernews`  | Hacker News (Algolia)       | none       | keyless, tech/community results only |

## Default behavior

- `tavily` answers first. `brave` and `searxng` are skipped until their key or
  base URL is configured. `exa` and then `you` answer when the backends before
  them fail. `duckduckgo` and `arxiv` are not used unless you add them.
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
  search at most `totalTimeoutMs` (28 s) — below the web tool's own
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
- A Grok X search takes 10–25 s, so X gets nearly the whole time budget
  (`xTimeoutMs`, 27 s). The web search starts beside it six seconds before
  the deadline, or at once when X fails, so its results are ready if X does
  not answer in time. One X search returns at most six posts.

The search uses your Grok account and plan. `grok` is looked up on `PATH`, then
in `~/.local/bin`, `~/.grok/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`
(a desktop app does not inherit your shell's `PATH`); set `grokPath` if it
lives elsewhere. Remove `x` from `backends` to turn the feature off.

## Specialised sources

General engines are weak at two things a coding agent asks for all the time, so
two free APIs are asked as well when the query calls for them:

| Query | Also asked | What comes back |
| ----- | ---------- | --------------- |
| quotes an error (`TypeError: …`, `ECONNREFUSED`, `Traceback`, "is not a function") or names Stack Overflow | `stackexchange` | answered Stack Overflow questions with score, answer count and tags |
| names GitHub, or asks for a repository or an open-source library/tool | `github` | repositories with stars, language and last push |
| names arXiv, preprints or research papers (only with `arxiv` enabled) | `arxiv` | papers with authors and abstract |

- Routing is deliberately narrow: a query that names no source and quotes no
  error asks none of them, and costs nothing extra.
- Up to three specialised results lead the answer; the general results fill
  the rest of the page. Each specialised snippet starts with its source type,
  for example `Stack Overflow question · answered · score 12 · 3 answers`.
- They run beside the general chain under a 5 s timeout. A source still
  answering 1.5 s after the general answer is ready is left out, so it cannot
  slow a search down.
- When no general backend answers, their results join the fallback and the
  note names them.
- Package registries are not included: the npm and crates.io search APIs
  ranked worse than the general engines for descriptive queries when tested.

To turn one off, remove its id from `backends`.

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
    backends: ['x', 'tavily', 'brave', 'searxng', 'exa', 'you', 'stackexchange', 'github', 'wikipedia', 'hackernews']
    tavilyApiKeyEnv: TAVILY_API_KEY
    braveApiKeyEnv: BRAVE_SEARCH_API_KEY
    searxngBaseURL: http://127.0.0.1:8888
    wikipediaLanguage: en
    timeoutMs: 8000
    totalTimeoutMs: 28000
    cacheTtlSeconds: 300
```

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `backends` | the ten in the example above | Which backends to use; general backends are tried in this order |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | Credential reference holding the Tavily key |
| `tavilyApiKey` | (unset) | Literal Tavily key; prefer the reference so no secret enters configuration |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Credential reference holding the Brave key |
| `braveApiKey` | (unset) | Literal Brave key; prefer the reference |
| `searxngBaseURL` | (unset) | Base URL of a SearXNG instance with JSON enabled |
| `wikipediaLanguage` | `en` | Wikipedia language edition |
| `timeoutMs` | `8000` | Upper bound for one request |
| `totalTimeoutMs` | `28000` | Upper bound for one whole search; keep it below the web tool's `searchTimeoutMs` |
| `cacheTtlSeconds` | `300` | How long an answer is reused for the same query; `0` disables the cache |
| `grokPath` | (found automatically) | Path of the Grok Build CLI |
| `grokModel` | (Grok Build's default) | Grok model used for X searches |
| `xTimeoutMs` | `27000` | Upper bound for one X search; the whole search still ends within `totalTimeoutMs` |

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
- **Exa and You.com are called keyless only.** Each search is one stateless
  `tools/call` request to their hosted MCP endpoint. To use your own Exa or
  You.com plan, mount their MCP server through DSH's MCP client.

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
