# Changelog

## 0.2.1 — 2026-11-19

### Fixed

- **X search no longer times out just before Grok answers.** A real Grok X
  search takes 10–25 s, but 0.2.0 stopped it after 19 s to keep time for the
  web search that followed. The web search now starts beside a still-running
  X search six seconds before the deadline (or at once when X fails), so X
  keeps the whole budget: `xTimeoutMs` defaults to 27 s and `totalTimeoutMs`
  to 28 s, still below the web tool's 30 s. An X answer that arrives first
  cancels the web search; a fast X answer never starts it.
- **Shorter X answers.** One X search asks for at most six posts of 280
  characters each; the length of Grok's answer is most of its run time.
- **`maxResults` is honoured with specialised sources.** A routed query with a
  small `maxResults` returned up to three extra results.
  The Wikipedia and Hacker News fallback now stops at `maxResults` too.
- **A query that only names a source** (`github`) is no longer sent to that
  source with nothing to look up.

## 0.2.0 — 2026-11-17

Reliability release, from an end-to-end review of 0.1.1 inside DeepSeek Harness.

### Changed

- **DuckDuckGo is opt-in.** It is no longer in the default backend chain:
  there is no official API or key for it, and its HTML endpoint answers plain
  HTTP clients with a CAPTCHA. Add `"duckduckgo"` to `backends` to try it.

### Added

- **Keyless backups: Exa and You.com.** New general backends `exa` and `you`
  call the vendors' hosted keyless endpoints (no account). They sit after
  Tavily, Brave and SearXNG in the default chain, so a spent Tavily keyless
  allowance still leaves real web results instead of Wikipedia and Hacker News.
- **Specialised sources with query routing.** A query that quotes an error
  message (or names Stack Overflow) is also looked up on Stack Overflow, and a
  query that names GitHub or asks for a repository is also sent to GitHub
  repository search (`stackexchange`, `github`, both on by default). Up to
  three of their results lead the answer, marked with their source type. They
  never delay an answer by more than 1.5 s. `arxiv` exists as an opt-in.

- **X search through Grok Build.** A query that targets X (`site:x.com`,
  `site:twitter.com`, "tweets about …", "on X") is answered by the `grok` CLI's
  X search when Grok Build is installed and signed in. Grok runs headless,
  read-only sandboxed, with every other tool removed; posts are accepted only
  when the run really called an X search tool. New backend id `x`, and the
  `grokPath`, `grokModel`, and `xTimeoutMs` settings.
- **Configuration schema** (`Config` export): fields are validated at load,
  appear in the plugin's settings form, and API keys are masked. A wrong type
  such as `timeoutMs: "500"` now fails the load instead of being ignored.
- **Credential store support:** keys are resolved through DeepSeek Harness's
  credential service for every search, then the process environment.
- **Answer cache:** the same query is answered from memory for
  `cacheTtlSeconds` (default 300; fallback-only answers 60 s).
- **Rate-limit handling:** a `429` reads `Retry-After` and the backend is
  skipped until then; a DuckDuckGo CAPTCHA pauses that backend for 15 minutes.
- **Total time budget** `totalTimeoutMs` (default 25 s), below the web tool's
  30 s, and the Wikipedia/Hacker News floor now starts as soon as one general
  backend fails instead of after all of them.
- Provider `title` and `description`, so the Web search provider picker shows
  "Free web search" instead of the bare id `free`.
- A test suite (`npm test`), with the network and Grok Build mocked.

### Fixed

- **Cancellation:** the caller's abort signal was never forwarded to any
  request; Stop and tool timeouts now interrupt a search immediately.
- **Latency:** backends could add up to 60 s, past the tool's 30 s budget, so
  a stalled backend got the tool call killed before the fallback ran. The
  default per-request timeout is now 8 s (was 15 s).
- **Model-visible note:** the fallback note was a ~500-character diagnostic
  dump rendered as the answer. It is now one sentence naming what failed; the
  full diagnostics go to the harness log.
- Doubled periods in every failure message.
- `fetch failed` with no cause: network errors now name the host and the
  cause (`ECONNREFUSED`, `ENOTFOUND`, …).
- URL de-duplication only ran on the fallback path and kept tracking
  parameters; it now runs on every path and ignores `utm_*` and similar.
- Hacker News `publishedAt` was date-only; it is now the full ISO timestamp,
  and the snippet carries the story text when there is one.
- With `backends: []` the provider reported itself available and its error
  advertised Tavily and Brave.
- The source comment said DuckDuckGo was opt-in while the default chain
  included it; the comment and README now describe the actual default.
- README: the install steps (a zero-dependency package needs no
  `pnpm install`), the Tavily keyless limits, and a first-run step for the
  free Tavily key. `locale/en.json` described a pre-Tavily version.

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
