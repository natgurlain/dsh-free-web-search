/**
 * dsh-free-web-search — a free web-search provider for the DeepSeek Harness
 * `ctx.web` seam.
 *
 * The provider registers as `free` and tries, in configuration order:
 *   1. Tavily search — the keyless access mode needs no account or key; a free
 *      Tavily API key (1,000 credits/month, no card) raises the limits;
 *   2. Brave Search API — no free plan, but every plan includes $5 of monthly
 *      free credits (≈1,000 queries) and needs an API key plus a card;
 *   3. a SearXNG instance that serves JSON (self-hosted; free and keyless);
 *   4. DuckDuckGo's consumer HTML endpoint as a best-effort fallback. It is not
 *      an official API, automated access is not authorized, and the endpoint
 *      often answers with an HTTP 202 CAPTCHA; it is tried after the sanctioned
 *      backends and reports the challenge instead of pretending it has no
 *      results;
 *   5. keyless Wikipedia (Action API) and Hacker News (Algolia) as a
 *      vendor-independent floor that needs no credentials at all.
 *
 * General-web backends are tried first and the first non-empty answer wins;
 * keyless domain sources are merged and interleaved only when no general
 * backend answers. Nothing is cached, stored, or trained on.
 *
 * The package has no npm dependencies: the only network client is Node's
 * global `fetch`.
 *
 * Plugin-row configuration (every field optional):
 *   backends: ['tavily', 'brave', 'searxng', 'duckduckgo', 'wikipedia', 'hackernews']
 *   tavilyApiKey: literal Tavily key (prefer the environment variable)
 *   tavilyApiKeyEnv: environment variable holding the key (default TAVILY_API_KEY)
 *   braveApiKey: literal Brave key (prefer the environment variable)
 *   braveApiKeyEnv: environment variable holding the key (default BRAVE_SEARCH_API_KEY)
 *   searxngBaseURL: base URL of a SearXNG instance with JSON enabled
 *   wikipediaLanguage: Wikipedia language edition (default 'en')
 *   timeoutMs: per-backend request timeout (default 15000)
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'free-web-search'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Stable provider id this plugin registers under; pin it with `searchProvider`. */
export const PROVIDER_ID = 'free'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const HN_ENDPOINT = 'https://hn.algolia.com/api/v1/search'
const USER_AGENT = 'deepseek-harness-free-web-search/0.1.1'
/**
 * Leading browser User-Agent for the DuckDuckGo HTML endpoint only. The endpoint
 * fingerprints its clients and answers plain automation with a CAPTCHA, so this
 * backend stays opt-in and is never a default.
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_BACKENDS = ['tavily', 'brave', 'searxng', 'duckduckgo', 'wikipedia', 'hackernews']
const GENERAL_BACKENDS = new Set(['tavily', 'brave', 'searxng', 'duckduckgo'])
const KEYLESS_BACKENDS = new Set(['wikipedia', 'hackernews'])
const KNOWN_BACKENDS = new Set([...GENERAL_BACKENDS, ...KEYLESS_BACKENDS])
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_RESULTS = 8
const SNIPPET_MAX_CHARS = 480
const ERROR_MAX_CHARS = 240

/** Human label for one backend id. */
function labelOf(backend) {
	if (backend === 'tavily') return 'Tavily'
	if (backend === 'brave') return 'Brave Search API'
	if (backend === 'searxng') return 'SearXNG'
	if (backend === 'duckduckgo') return 'DuckDuckGo'
	if (backend === 'wikipedia') return 'Wikipedia'
	if (backend === 'hackernews') return 'Hacker News'
	return backend
}

/** Trimmed non-empty string, or `undefined`. */
function nonEmpty(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** A finite positive integer, or `undefined`. */
function positiveInt(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/** Clamp a candidate result bound into `[min, max]`, else the fallback. */
function clampInt(value, fallback, min, max) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** True when `value` parses as an absolute http(s) URL. */
function isHttpUrl(value) {
	if (typeof value !== 'string') return false
	try {
		const parsed = new URL(value)
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
	} catch {
		return false
	}
}

/** Collapse whitespace and bound one snippet to the context budget. */
function clipText(value) {
	const text = String(value).replace(/\s+/gu, ' ').trim()
	return text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

/** Collapse whitespace and bound one error message embedded in a later result. */
function clipError(value) {
	const text = String(value).replace(/\s+/gu, ' ').trim()
	return text.length <= ERROR_MAX_CHARS ? text : `${text.slice(0, ERROR_MAX_CHARS - 1)}…`
}

/** Message of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/** Decode the small HTML entity set the Wikipedia search snippets use. */
const HTML_ENTITIES = {
	'&amp;': '&',
	'&quot;': '"',
	'&#39;': "'",
	'&lt;': '<',
	'&gt;': '>',
	'&nbsp;': ' ',
}

/** Decode the named and numeric HTML entities used by search-result markup. */
function decodeEntities(text) {
	return text
		.replace(/&(?:amp|quot|#39|lt|gt|nbsp);/gu, (match) => HTML_ENTITIES[match] ?? match)
		.replace(/&#(\d+);/gu, (match, code) => {
			try {
				return String.fromCodePoint(Number(code))
			} catch {
				return match
			}
		})
		.replace(/&#x([0-9a-f]+);/giu, (match, hex) => {
			try {
				return String.fromCodePoint(Number.parseInt(hex, 16))
			} catch {
				return match
			}
		})
}

/** Strip tags and decode entities from a search-result markup fragment. */
function stripHtml(text) {
	return decodeEntities(text.replace(/<[^>]*>/gu, ''))
}

/** Build the provider's options snapshot from the plugin row config. */
function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	const backends = Array.isArray(source.backends)
		? [...new Set(
			source.backends
				.filter((value) => typeof value === 'string')
				.map((value) => value.trim().toLowerCase())
				.filter((value) => KNOWN_BACKENDS.has(value)),
		)]
		: DEFAULT_BACKENDS.slice()
	const tavilyApiKeyEnv = nonEmpty(source.tavilyApiKeyEnv) ?? 'TAVILY_API_KEY'
	const braveApiKeyEnv = nonEmpty(source.braveApiKeyEnv) ?? 'BRAVE_SEARCH_API_KEY'
	const rawSearxng = nonEmpty(source.searxngBaseURL)
	const language = (nonEmpty(source.wikipediaLanguage) ?? 'en').toLowerCase().replace(/[^a-z-]/gu, '')
	return {
		backends,
		tavilyApiKey: nonEmpty(source.tavilyApiKey) ?? nonEmpty(process.env[tavilyApiKeyEnv]) ?? '',
		tavilyApiKeyEnv,
		braveApiKey: nonEmpty(source.braveApiKey) ?? nonEmpty(process.env[braveApiKeyEnv]) ?? '',
		braveApiKeyEnv,
		searxngBaseURL: isHttpUrl(rawSearxng) ? rawSearxng.replace(/\/+$/u, '') : '',
		wikipediaLanguage: language.length > 0 ? language : 'en',
		timeoutMs: positiveInt(source.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
	}
}

/** Whether one backend has what it needs to be tried (a cheap local check). */
function isBackendUsable(backend, options) {
	if (backend === 'tavily') return true // keyless mode always needs no credential
	if (backend === 'brave') return options.braveApiKey.length > 0
	if (backend === 'searxng') return isHttpUrl(options.searxngBaseURL)
	if (backend === 'duckduckgo') return true // opt-in, best effort, no credential
	return KEYLESS_BACKENDS.has(backend)
}

/** Build the provider's stable cancellation error. */
function abortReason(signal) {
	const reason = signal?.reason
	if (reason instanceof Error && reason.name === 'AbortError') return reason
	const error = new Error('Free web search was aborted.')
	error.name = 'AbortError'
	return error
}

/**
 * Run one HTTP request under the caller's cancellation signal and a per-backend
 * timeout. A timeout becomes a descriptive error; a caller abort is rethrown.
 */
async function fetchWithTimeout(url, init, label, signal, timeoutMs) {
	if (signal?.aborted === true) throw abortReason(signal)
	const controller = new AbortController()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	const onAbort = () => controller.abort()
	if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} catch (error) {
		if (timedOut) throw new Error(`${label} request timed out after ${timeoutMs} ms.`)
		if (signal?.aborted === true) throw abortReason(signal)
		throw error
	} finally {
		clearTimeout(timer)
		if (signal !== undefined) signal.removeEventListener('abort', onAbort)
	}
}

/** Parse a response body as JSON or throw a backend-labelled error. */
async function readJsonResponse(response, label) {
	try {
		return await response.json()
	} catch {
		throw new Error(`${label} returned a response that is not JSON (HTTP ${response.status}).`)
	}
}

/** Read a short error detail from a non-JSON/JSON error body, when one exists. */
async function errorDetail(response) {
	try {
		const text = (await response.text()).replace(/\s+/gu, ' ').trim()
		return text.length > 0 ? clipError(text) : undefined
	} catch {
		return undefined
	}
}

/** Interleave result groups rank-by-rank so merged sources stay balanced. */
function interleave(groups) {
	const longest = groups.reduce((length, group) => Math.max(length, group.length), 0)
	const merged = []
	for (let index = 0; index < longest; index += 1) {
		for (const group of groups) {
			if (index < group.length) merged.push(group[index])
		}
	}
	return merged
}

/** Normalize a result URL for deduplication (drop the hash, keep the query). */
function normalizeUrl(url) {
	try {
		const parsed = new URL(url)
		parsed.hash = ''
		return parsed.href
	} catch {
		return url
	}
}

/** Deduplicate sources by normalized URL, keeping first occurrence order. */
function dedupeByUrl(sources) {
	const seen = new Set()
	const unique = []
	for (const source of sources) {
		if (typeof source.url !== 'string' || !source.url.startsWith('http')) continue
		const key = normalizeUrl(source.url)
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(source)
	}
	return unique
}

/** Search through Tavily: keyless access mode unless a key is configured. */
async function tavilySearch(query, maxResults, options) {
	const headers = {
		accept: 'application/json',
		'content-type': 'application/json',
		'user-agent': USER_AGENT,
		...(options.tavilyApiKey.length > 0
			? { authorization: `Bearer ${options.tavilyApiKey}` }
			: { 'x-tavily-access-mode': 'keyless' }),
	}
	const response = await fetchWithTimeout(TAVILY_ENDPOINT, {
		method: 'POST',
		redirect: 'error',
		headers,
		body: JSON.stringify({ query, max_results: Math.min(Math.max(maxResults, 1), 20) }),
	}, 'Tavily search', undefined, options.timeoutMs)
	if (response.status === 401 || response.status === 403) {
		const detail = await errorDetail(response)
		throw new Error(`Tavily rejected the credential (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}; keyless mode may be unavailable.`)
	}
	if (response.status === 429) throw new Error('Tavily rate limit reached (HTTP 429); keyless mode is shared, a free Tavily API key raises the limit.')
	if (!response.ok) {
		const detail = await errorDetail(response)
		throw new Error(`Tavily search failed with HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}.`)
	}
	const body = await readJsonResponse(response, 'Tavily search')
	const items = Array.isArray(body?.results) ? body.results : []
	const sources = []
	for (const item of items) {
		const url = nonEmpty(item?.url)
		if (url === undefined || !isHttpUrl(url)) continue
		const title = nonEmpty(item?.title)
		const snippet = nonEmpty(item?.content)
		const publishedAt = nonEmpty(item?.published_date)
		sources.push({
			url,
			...(title === undefined ? {} : { title }),
			...(snippet === undefined ? {} : { snippet: clipText(snippet) }),
			...(publishedAt === undefined ? {} : { publishedAt }),
		})
	}
	const answer = nonEmpty(body?.answer)
	return { sources, ...(answer === undefined ? {} : { content: answer }) }
}

/** Search through the Brave Search API (free monthly credits need a key). */
async function braveSearch(query, maxResults, options) {
	const url = new URL(BRAVE_ENDPOINT)
	url.searchParams.set('q', query)
	url.searchParams.set('count', String(Math.min(Math.max(maxResults, 1), 20)))
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		redirect: 'error',
		headers: {
			accept: 'application/json',
			'user-agent': USER_AGENT,
			'x-subscription-token': options.braveApiKey,
		},
	}, 'Brave Search API', undefined, options.timeoutMs)
	if (response.status === 401 || response.status === 403) {
		throw new Error(`Brave Search API rejected the credential (HTTP ${response.status}); check ${options.braveApiKeyEnv} or the braveApiKey config.`)
	}
	if (response.status === 429) throw new Error('Brave Search API rate or monthly free-credit limit reached (HTTP 429).')
	if (!response.ok) throw new Error(`Brave Search API failed with HTTP ${response.status}.`)
	const body = await readJsonResponse(response, 'Brave Search API')
	const items = Array.isArray(body?.web?.results) ? body.web.results : []
	const sources = []
	for (const item of items) {
		const sourceUrl = nonEmpty(item?.url)
		if (sourceUrl === undefined || !isHttpUrl(sourceUrl)) continue
		const title = nonEmpty(item?.title)
		const snippet = nonEmpty(item?.description)
		const publishedAt = nonEmpty(item?.page_age) ?? nonEmpty(item?.age)
		sources.push({
			url: sourceUrl,
			...(title === undefined ? {} : { title }),
			...(snippet === undefined ? {} : { snippet: clipText(snippet) }),
			...(publishedAt === undefined ? {} : { publishedAt }),
		})
	}
	return { sources }
}

/** Search a SearXNG instance that has the JSON format enabled. */
async function searxngSearch(query, maxResults, options) {
	const url = new URL(`${options.searxngBaseURL}/search`)
	url.searchParams.set('q', query)
	url.searchParams.set('format', 'json')
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		redirect: 'error',
		headers: { accept: 'application/json', 'user-agent': USER_AGENT },
	}, 'SearXNG', undefined, options.timeoutMs)
	if (response.status === 403) {
		throw new Error('SearXNG refused JSON (HTTP 403); enable json in search.formats on the instance, or point searxngBaseURL at one that serves it.')
	}
	if (response.status === 429) throw new Error('SearXNG rate limit reached (HTTP 429).')
	if (!response.ok) throw new Error(`SearXNG failed with HTTP ${response.status}.`)
	const body = await readJsonResponse(response, 'SearXNG')
	const items = Array.isArray(body?.results) ? body.results : []
	const sources = []
	for (const item of items) {
		const sourceUrl = nonEmpty(item?.url)
		if (sourceUrl === undefined || !isHttpUrl(sourceUrl)) continue
		const title = nonEmpty(item?.title)
		const snippet = nonEmpty(item?.content) ?? nonEmpty(item?.description)
		const publishedAt = nonEmpty(item?.publishedDate)
		sources.push({
			url: sourceUrl,
			...(title === undefined ? {} : { title }),
			...(snippet === undefined ? {} : { snippet: clipText(snippet) }),
			...(publishedAt === undefined ? {} : { publishedAt }),
		})
	}
	return { sources }
}

/** Convert a DuckDuckGo result href (possibly a `/l/?uddg=` redirect) to its target URL. */
function duckduckgoUrl(href) {
	const resolved = href.startsWith('//') ? `https:${href}` : href
	if (!/duckduckgo\.com\/l\//u.test(resolved)) return resolved
	try {
		const target = new URL(resolved).searchParams.get('uddg')
		return target !== null && isHttpUrl(target) ? target : resolved
	} catch {
		return resolved
	}
}

/** Parse a DuckDuckGo HTML result page into normalized sources (best effort). */
function parseDuckDuckGoHtml(html) {
	const sources = []
	const chunks = html.split(/<div[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>/u).slice(1)
	for (const chunk of chunks) {
		const titleMatch =
			/<a\b[^>]*\bclass="[^"]*result__a[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u.exec(chunk) ??
			/<a\b[^>]*\bhref="([^"]+)"[^>]*\bclass="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/u.exec(chunk)
		if (titleMatch === null) continue
		const url = duckduckgoUrl(titleMatch[1])
		if (!isHttpUrl(url)) continue
		const title = stripHtml(titleMatch[2]).trim()
		const snippetMatch = /\bclass="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/u.exec(chunk)
		const snippet = snippetMatch === null ? undefined : stripHtml(snippetMatch[1]).trim()
		sources.push({
			url,
			...(title.length === 0 ? {} : { title }),
			...(snippet === undefined || snippet.length === 0 ? {} : { snippet: clipText(snippet) }),
		})
	}
	return sources
}

/**
 * Search DuckDuckGo's consumer HTML endpoint (opt-in, best effort). The endpoint
 * is not a sanctioned search API and usually answers automated clients with an
 * HTTP 202 CAPTCHA, so the backend is excluded from the default chain and
 * reports the challenge instead of pretending it has no results.
 */
async function duckduckgoSearch(query, maxResults, options) {
	const form = new URLSearchParams({ q: query, kl: 'wt-wt' })
	const response = await fetchWithTimeout(DDG_ENDPOINT, {
		method: 'POST',
		redirect: 'error',
		headers: {
			accept: 'text/html,application/xhtml+xml',
			'content-type': 'application/x-www-form-urlencoded',
			'user-agent': BROWSER_UA,
		},
		body: form.toString(),
	}, 'DuckDuckGo', undefined, options.timeoutMs)
	let html
	try {
		html = await response.text()
	} catch {
		throw new Error(`DuckDuckGo returned an unreadable response (HTTP ${response.status}).`)
	}
	if (response.status === 202 || /anomaly\.js|challenge-form|bots use DuckDuckGo/iu.test(html)) {
		throw new Error('DuckDuckGo answered with its anti-bot challenge instead of results; direct HTML access is blocked and not authorized for automation. Use a SearXNG instance that includes the DuckDuckGo engine, or another general-web backend.')
	}
	if (!response.ok) throw new Error(`DuckDuckGo failed with HTTP ${response.status}.`)
	const sources = parseDuckDuckGoHtml(html).slice(0, Math.max(maxResults, 1))
	return { sources }
}

/** Search Wikipedia's Action API (keyless). */
async function wikipediaSearch(query, maxResults, options) {
	const base = `https://${options.wikipediaLanguage}.wikipedia.org`
	const url = new URL(`${base}/w/api.php`)
	url.searchParams.set('action', 'query')
	url.searchParams.set('list', 'search')
	url.searchParams.set('srsearch', query)
	url.searchParams.set('srlimit', String(clampInt(maxResults, DEFAULT_MAX_RESULTS, 1, 20)))
	url.searchParams.set('srprop', 'snippet|timestamp')
	url.searchParams.set('format', 'json')
	url.searchParams.set('formatversion', '2')
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		redirect: 'error',
		headers: { accept: 'application/json', 'user-agent': USER_AGENT },
	}, 'Wikipedia API', undefined, options.timeoutMs)
	if (!response.ok) throw new Error(`Wikipedia API failed with HTTP ${response.status}.`)
	const body = await readJsonResponse(response, 'Wikipedia API')
	const items = Array.isArray(body?.query?.search) ? body.query.search : []
	const sources = []
	for (const item of items) {
		const title = nonEmpty(item?.title)
		if (title === undefined) continue
		const pageUrl = `${base}/wiki/${encodeURIComponent(title.replace(/ /gu, '_'))}`
		const rawSnippet = nonEmpty(item?.snippet)
		const snippet = rawSnippet === undefined ? undefined : stripHtml(rawSnippet)
		const publishedAt = nonEmpty(item?.timestamp)
		sources.push({
			url: pageUrl,
			title,
			...(snippet === undefined || snippet.length === 0 ? {} : { snippet: clipText(snippet) }),
			...(publishedAt === undefined ? {} : { publishedAt }),
		})
	}
	return { sources }
}

/** Search Hacker News stories through the free Algolia API (keyless). */
async function hackernewsSearch(query, maxResults, options) {
	const url = new URL(HN_ENDPOINT)
	url.searchParams.set('query', query)
	url.searchParams.set('tags', 'story')
	url.searchParams.set('hitsPerPage', String(clampInt(maxResults, DEFAULT_MAX_RESULTS, 1, 20)))
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		redirect: 'error',
		headers: { accept: 'application/json', 'user-agent': USER_AGENT },
	}, 'Hacker News API', undefined, options.timeoutMs)
	if (!response.ok) throw new Error(`Hacker News API failed with HTTP ${response.status}.`)
	const body = await readJsonResponse(response, 'Hacker News API')
	const items = Array.isArray(body?.hits) ? body.hits : []
	const sources = []
	for (const item of items) {
		const title = nonEmpty(item?.title)
		if (title === undefined) continue
		const objectId = nonEmpty(item?.objectID)
		const itemUrl = nonEmpty(item?.url) ?? (objectId === undefined ? undefined : `https://news.ycombinator.com/item?id=${encodeURIComponent(objectId)}`)
		if (itemUrl === undefined) continue
		const details = [
			Number.isFinite(item?.points) ? `${item.points} points` : undefined,
			nonEmpty(item?.author) === undefined ? undefined : `by ${item.author}`,
			Number.isFinite(item?.num_comments) ? `${item.num_comments} comments` : undefined,
			'Hacker News',
		].filter((entry) => entry !== undefined).join(' · ')
		const createdAt = nonEmpty(item?.created_at)
		sources.push({
			url: itemUrl,
			title,
			snippet: details,
			...(createdAt === undefined ? {} : { publishedAt: createdAt.slice(0, 10) }),
		})
	}
	return { sources }
}

/** Dispatch one general-web backend. */
async function searchGeneral(backend, query, maxResults, options) {
	if (backend === 'tavily') return await tavilySearch(query, maxResults, options)
	if (backend === 'brave') return await braveSearch(query, maxResults, options)
	if (backend === 'searxng') return await searxngSearch(query, maxResults, options)
	if (backend === 'duckduckgo') return await duckduckgoSearch(query, maxResults, options)
	throw new Error(`Unknown general-web backend "${backend}".`)
}

/** Dispatch one keyless domain backend. */
async function searchKeyless(backend, query, maxResults, options) {
	if (backend === 'wikipedia') return await wikipediaSearch(query, maxResults, options)
	if (backend === 'hackernews') return await hackernewsSearch(query, maxResults, options)
	throw new Error(`Unknown keyless backend "${backend}".`)
}

/** Compose a short, model-visible note when a configured general backend failed. */
function fallbackNote(keylessNames, attempts) {
	const sourcesLabel = keylessNames.map(labelOf).join(' and ')
	const detail = attempts.length === 0 ? '' : ` (${attempts.join('; ')})`
	return `General-web search backends were unavailable${detail}; these results come from keyless sources (${sourcesLabel}).`
}

/**
 * One free search: try configured general-web backends in order, then merge
 * keyless domain sources only when no general backend answered.
 *
 * @param request - the seam's search request (`query`, optional `maxResults`).
 * @param options - the provider's resolved options snapshot.
 * @param signal - optional cancellation forwarded to every request.
 * @returns the normalized search result (never truncates; the seam caps sources).
 */
async function searchFree(request, options, signal) {
	const query = typeof request?.query === 'string' ? request.query.trim() : ''
	if (query.length === 0) throw new Error('Free web search received an empty query.')
	const maxResults = clampInt(request?.maxResults, DEFAULT_MAX_RESULTS, 1, 20)
	const attempts = []
	const keyless = []
	let generalAttempted = false

	for (const backend of options.backends) {
		if (!isBackendUsable(backend, options)) {
			attempts.push(`${labelOf(backend)} is not configured`)
			continue
		}
		if (KEYLESS_BACKENDS.has(backend)) {
			keyless.push(backend)
			continue
		}
		generalAttempted = true
		try {
			const result = await searchGeneral(backend, query, maxResults, options)
			if (result.sources.length > 0 || result.content !== undefined) {
				return { ...(result.content === undefined ? {} : { content: result.content }), sources: result.sources, truncated: false }
			}
			attempts.push(`${labelOf(backend)} returned no results`)
		} catch (error) {
			if (signal?.aborted === true) throw abortReason(signal)
			attempts.push(clipError(`${labelOf(backend)}: ${messageOf(error)}`))
		}
	}

	const groups = []
	if (keyless.length > 0) {
		const settled = await Promise.allSettled(
			keyless.map((backend) => searchKeyless(backend, query, maxResults, options)),
		)
		if (signal?.aborted === true) throw abortReason(signal)
		for (let index = 0; index < settled.length; index += 1) {
			const outcome = settled[index]
			if (outcome.status === 'fulfilled') {
				if (outcome.value.sources.length > 0) groups.push(outcome.value.sources)
			} else {
				attempts.push(clipError(`${labelOf(keyless[index])}: ${messageOf(outcome.reason)}`))
			}
		}
	}

	const merged = dedupeByUrl(interleave(groups))
	if (merged.length > 0) {
		return {
			...(generalAttempted ? { content: fallbackNote(keyless, attempts) } : {}),
			sources: merged,
			truncated: false,
		}
	}

	const tried = attempts.length === 0 ? '' : ` Tried: ${attempts.join('; ')}.`
	throw new Error(
		`Free web search found no results for "${query}".${tried} Tavily keyless mode works with no credentials; a free Tavily API key (${options.tavilyApiKeyEnv}), a Brave Search API key (${options.braveApiKeyEnv}), or a JSON-enabled searxngBaseURL improves quality and limits.`,
	)
}

/** The registered provider: one instance, options resolved per operation. */
class FreeSearchProvider {
	/** @param {() => object} resolveOptions - options snapshot for the next operation. */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions
		this.id = PROVIDER_ID
	}

	/** Cheap local check: at least one configured backend can be tried. */
	available() {
		const options = this.resolveOptions()
		return options.backends.some((backend) => isBackendUsable(backend, options))
	}

	/** Run one search through the free backend chain. */
	async search(request, signal) {
		return await searchFree(request, this.resolveOptions(), signal)
	}
}

/**
 * Register the free search provider with `ctx.web`. It needs no credential, so
 * it declares no `ready()`: every model route may use `web_search` while this
 * provider is selected.
 *
 * @param ctx - plugin context with the `web` service injected.
 * @param config - the plugin row config (see the module comment).
 */
export function apply(ctx, config) {
	const provider = new FreeSearchProvider(() => readOptions(config))
	ctx.web.registerSearchProvider({
		id: provider.id,
		available: () => provider.available(),
		search: (request, signal) => provider.search(request, signal),
	})
}
