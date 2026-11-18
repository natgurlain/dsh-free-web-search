import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import * as plugin from '../index.js'

const realFetch = globalThis.fetch
let calls

/** Register the plugin against a fake `ctx.web` and return the provider it registers. */
function load(config = {}, extra = {}) {
	let provider
	const ctx = { web: { registerSearchProvider: (registered) => { provider = registered } }, ...extra }
	plugin.apply(ctx, config)
	return provider
}

/** A JSON `Response`. */
function json(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A request that never answers until its signal aborts. */
function hang(init) {
	return new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => {
			const error = new Error('This operation was aborted')
			error.name = 'AbortError'
			reject(error)
		})
	})
}

/** Route `fetch` by host; unrouted hosts fail the test loudly. */
function route(routes) {
	globalThis.fetch = async (url, init) => {
		const host = new URL(String(url)).host
		calls.push({ host, url: String(url), init })
		const handler = routes[host]
		if (handler === undefined) throw new Error(`unexpected request to ${host}`)
		return await handler(init, String(url))
	}
}

const wikipedia = () => json({ query: { search: [{ title: 'Rust (programming language)', snippet: 'A <b>language</b>', timestamp: '2026-01-02T03:04:05Z' }] } })
const hackernews = () => json({ hits: [{ title: 'Show HN', url: 'https://example.com/hn', objectID: '1', points: 42, author: 'bob', num_comments: 7, created_at: '2026-02-03T04:05:06Z', story_text: '<p>Body of the story</p>' }] })
const countOf = (host) => calls.filter((call) => call.host === host).length

beforeEach(() => {
	calls = []
	plugin.resetState()
})

afterEach(() => {
	globalThis.fetch = realFetch
})

test('registers with a title and a description, and is unavailable with no backends', () => {
	const provider = load()
	assert.equal(provider.id, 'free')
	assert.equal(provider.title, 'Free web search')
	assert.ok(provider.description.en.length > 20)
	assert.equal(provider.available(), true)
	assert.equal(load({ backends: [] }).available(), false)
})

test('an empty backend list fails without advertising backends', async () => {
	await assert.rejects(load({ backends: [] }).search({ query: 'q' }), /no backends enabled/u)
})

test('the caller abort interrupts a running request', async () => {
	route({ 'api.tavily.com': hang })
	const controller = new AbortController()
	const started = Date.now()
	const pending = load({ backends: ['tavily'] }).search({ query: 'q' }, controller.signal)
	setTimeout(() => controller.abort(), 50)
	await assert.rejects(pending, { name: 'AbortError' })
	assert.ok(Date.now() - started < 400, `abort took ${Date.now() - started} ms`)
})

test('a pre-aborted signal sends no request', async () => {
	route({})
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(load().search({ query: 'q' }, controller.signal), { name: 'AbortError' })
	assert.equal(calls.length, 0)
})

test('hanging general backends cannot push a search past the total budget, and the floor still answers', async () => {
	route({
		'api.tavily.com': hang,
		'html.duckduckgo.com': hang,
		'en.wikipedia.org': wikipedia,
		'hn.algolia.com': hackernews,
	})
	const started = Date.now()
	const result = await load({ backends: ['tavily', 'duckduckgo', 'wikipedia', 'hackernews'], timeoutMs: 400, totalTimeoutMs: 600 }).search({ query: 'q' })
	const elapsed = Date.now() - started
	assert.ok(elapsed < 900, `search took ${elapsed} ms`)
	assert.equal(result.sources.length, 2)
})

test('a 429 honours Retry-After: the backend is skipped afterwards and the note stays short', async () => {
	route({
		'api.tavily.com': () => json({ detail: 'daily_cap_reached' }, 429, { 'retry-after': '120' }),
		'en.wikipedia.org': wikipedia,
		'hn.algolia.com': hackernews,
	})
	const provider = load({ backends: ['tavily', 'brave', 'searxng', 'wikipedia', 'hackernews'], cacheTtlSeconds: 0 })
	const first = await provider.search({ query: 'one' })
	assert.equal(first.sources.length, 2)
	assert.match(first.content, /^General web search was unavailable \(Tavily keyless mode daily limit reached\)/u)
	assert.ok(first.content.length < 220, first.content)
	assert.doesNotMatch(first.content, /\.\./u)
	assert.doesNotMatch(first.content, /not configured/u)
	await provider.search({ query: 'two' })
	assert.equal(countOf('api.tavily.com'), 1)
})

test('an identical query is answered from the cache', async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/a', title: 'A', content: 'text' }] }) })
	const provider = load({ backends: ['tavily'] })
	const first = await provider.search({ query: 'Same Query' })
	const second = await provider.search({ query: 'same query' })
	assert.deepEqual(second, first)
	assert.equal(calls.length, 1)
})

test('duplicates are removed on the general path, tracking parameters included', async () => {
	route({
		'api.tavily.com': () => json({ results: [
			{ url: 'https://example.com/page?utm_source=hn', title: 'A' },
			{ url: 'https://example.com/page', title: 'B' },
			{ url: 'https://www.example.com/page/#top', title: 'C' },
			{ url: 'https://example.com/other', title: 'D' },
		] }),
	})
	const result = await load({ backends: ['tavily'] }).search({ query: 'q' })
	assert.deepEqual(result.sources.map((source) => source.title), ['A', 'D'])
})

test('Hacker News returns a full ISO timestamp and the story text', async () => {
	route({ 'hn.algolia.com': hackernews })
	const result = await load({ backends: ['hackernews'] }).search({ query: 'q' })
	assert.equal(result.sources[0].publishedAt, '2026-02-03T04:05:06Z')
	assert.match(result.sources[0].snippet, /^Body of the story — Hacker News · 42 points/u)
	assert.equal(result.content, undefined)
})

test('keys come from the harness credential store', async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/a' }] }) })
	const credentials = { resolve: async (ref) => (ref === 'TAVILY_API_KEY' ? { value: 'tvly-secret', source: 'file' } : undefined) }
	await load({ backends: ['tavily'] }, { get: (service) => (service === 'credentials' ? credentials : undefined) }).search({ query: 'q' })
	assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-secret')
	assert.equal(calls[0].init.headers['x-tavily-access-mode'], undefined)
})

test('a numeric string is accepted for timeoutMs', async () => {
	route({ 'api.tavily.com': hang })
	const started = Date.now()
	await assert.rejects(load({ backends: ['tavily'], timeoutMs: '150' }).search({ query: 'q' }), /timed out after 150 ms/u)
	assert.ok(Date.now() - started < 600)
})

test('a network failure names the host and the cause, with single periods', async () => {
	globalThis.fetch = async () => {
		throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
	}
	await assert.rejects(
		load({ backends: ['searxng'], searxngBaseURL: 'http://127.0.0.1:9' }).search({ query: 'q' }),
		(error) => {
			assert.match(error.message, /SearXNG could not reach 127\.0\.0\.1:9 \(ECONNREFUSED — connection refused/u)
			assert.doesNotMatch(error.message, /\.\./u)
			return true
		},
	)
})

test('a DuckDuckGo challenge is reported once, then skipped', async () => {
	route({
		'html.duckduckgo.com': () => new Response('<form id="challenge-form">', { status: 202 }),
		'en.wikipedia.org': wikipedia,
	})
	const provider = load({ backends: ['duckduckgo', 'wikipedia'], cacheTtlSeconds: 0 })
	const first = await provider.search({ query: 'one' })
	assert.match(first.content, /DuckDuckGo blocked automated access/u)
	await provider.search({ query: 'two' })
	assert.equal(countOf('html.duckduckgo.com'), 1)
})

/** Write a fake `grok` that prints the given streaming-json events. */
function fakeGrok(events) {
	const folder = mkdtempSync(join(tmpdir(), 'fake-grok-'))
	const file = join(folder, 'grok')
	writeFileSync(file, `#!/usr/bin/env node\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))\n`)
	chmodSync(file, 0o755)
	return { file, remove: () => rmSync(folder, { recursive: true, force: true }) }
}

const posts = { posts: [
	{ url: 'https://x.com/alice/status/123', author: 'alice', text: 'tokio vs smol', postedAt: '2026-11-01T10:00:00Z' },
	{ url: 'https://evil.example/alice/status/1', author: 'mallory', text: 'not an X url' },
] }

test('an X-targeted query is answered through Grok Build', { skip: process.platform === 'win32' }, async () => {
	route({})
	const grok = fakeGrok([
		{ type: 'tool_call_update', status: 'completed', rawOutput: { name: 'x_keyword_search' } },
		{ type: 'text', data: 'Searching. {"posts":[]}' },
		{ type: 'text', data: JSON.stringify(posts) },
		{ type: 'end', stopReason: 'end_turn' },
	])
	try {
		const result = await load({ grokPath: grok.file }).search({ query: 'rust async runtime site:x.com' })
		assert.deepEqual(result.sources, [{
			url: 'https://x.com/alice/status/123', title: '@alice on X', snippet: 'tokio vs smol', publishedAt: '2026-11-01T10:00:00Z',
		}])
		assert.equal(calls.length, 0)
	} finally {
		grok.remove()
	}
})

test('posts from a Grok run that never searched X are discarded', { skip: process.platform === 'win32' }, async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/a', title: 'A' }] }) })
	const grok = fakeGrok([{ type: 'text', data: JSON.stringify(posts) }, { type: 'end' }])
	try {
		const result = await load({ grokPath: grok.file, backends: ['x', 'tavily'] }).search({ query: 'tweets about rust' })
		assert.deepEqual(result.sources.map((source) => source.url), ['https://example.com/a'])
		assert.match(result.content, /^X search was unavailable \(X search returned no verified posts\); these are general web results, not X posts\.$/u)
	} finally {
		grok.remove()
	}
})

test('other queries never start Grok Build', async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/a' }] }) })
	const result = await load({ grokPath: '/nonexistent/grok', backends: ['x', 'tavily'] }).search({ query: 'postgres index types' })
	assert.equal(result.sources.length, 1)
	assert.equal(result.content, undefined)
})

test('xQueryOf recognises X-targeted queries only', () => {
	assert.equal(plugin.xQueryOf('site:x.com rust async'), 'rust async')
	assert.equal(plugin.xQueryOf('rust async site:twitter.com/rustlang'), 'rust async')
	assert.equal(plugin.xQueryOf('what do people say on X about tokio'), 'what do people say on X about tokio')
	assert.equal(plugin.xQueryOf('tweets about tokio'), 'tweets about tokio')
	assert.equal(plugin.xQueryOf('postgres index types'), undefined)
	assert.equal(plugin.xQueryOf('solve for x in 2x + 1'), undefined)
	assert.equal(plugin.xQueryOf('site:linux.com kernel'), undefined)
})

test('aborting an X search returns at once and stops Grok Build', { skip: process.platform === 'win32' }, async () => {
	route({})
	const folder = mkdtempSync(join(tmpdir(), 'fake-grok-'))
	const file = join(folder, 'grok')
	writeFileSync(file, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {})\nsetTimeout(() => {}, 20000)\n')
	chmodSync(file, 0o755)
	const controller = new AbortController()
	const started = Date.now()
	try {
		const pending = load({ grokPath: file, backends: ['x'] }).search({ query: 'tweets about rust' }, controller.signal)
		setTimeout(() => controller.abort(), 100)
		await assert.rejects(pending, { name: 'AbortError' })
		assert.ok(Date.now() - started < 600, `abort took ${Date.now() - started} ms`)
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
})

test('a slow X search times out and the general chain still answers', { skip: process.platform === 'win32' }, async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/a' }] }) })
	const folder = mkdtempSync(join(tmpdir(), 'fake-grok-'))
	const file = join(folder, 'grok')
	writeFileSync(file, '#!/usr/bin/env node\nsetTimeout(() => {}, 20000)\n')
	chmodSync(file, 0o755)
	const started = Date.now()
	try {
		const result = await load({ grokPath: file, backends: ['x', 'tavily'], xTimeoutMs: 200 }).search({ query: 'tweets about rust' })
		assert.ok(Date.now() - started < 1500)
		assert.match(result.content, /X search timed out/u)
		assert.equal(result.sources.length, 1)
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
})

/** An MCP tool answer as the hosted endpoints send it: one event-stream message. */
function mcp(text, extra = {}) {
	return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...extra } })}\n\n`, {
		status: 200, headers: { 'content-type': 'text/event-stream' },
	})
}
const tavilyCapped = () => json({ detail: { error: 'daily cap reached' } }, 429)
const exaText = 'Title: First page\nURL: https://example.com/one\nPublished: 2026-09-28T09:00:00.000Z\nAuthor: N/A\nHighlights:\nFirst   highlight\ntext.\n\nTitle: Second page\nURL: https://example.com/two\nPublished: N/A\nAuthor: N/A\nHighlights:\nSecond highlight.\n'

test('Exa answers keyless when Tavily keyless is capped, with no fallback note', async () => {
	route({ 'api.tavily.com': tavilyCapped, 'mcp.exa.ai': () => mcp(exaText) })
	const result = await load().search({ query: 'plain question', maxResults: 5 })
	assert.deepEqual(result.sources.map((source) => source.url), ['https://example.com/one', 'https://example.com/two'])
	assert.equal(result.sources[0].title, 'First page')
	assert.equal(result.sources[0].snippet, 'First highlight text.')
	assert.equal(result.sources[0].publishedAt, '2026-09-28T09:00:00.000Z')
	assert.equal(result.sources[1].publishedAt, undefined)
	assert.equal(result.content, undefined)
	const request = JSON.parse(calls.find((call) => call.host === 'mcp.exa.ai').init.body)
	assert.equal(request.method, 'tools/call')
	assert.equal(request.params.name, 'web_search_exa')
	assert.equal(request.params.arguments.query, 'plain question')
	assert.ok(request.params.arguments.objective.length > 0)
	assert.equal(countOf('api.you.com'), 0)
})

test('You.com answers when Exa is rate-limited, and Exa is then skipped', async () => {
	const you = { results: { web: [{ url: 'https://example.com/y', title: 'You result', description: 'Described', page_age: '2026-09-28T09:00:00' }], news: [] } }
	route({
		'api.tavily.com': tavilyCapped,
		'mcp.exa.ai': () => new Response('slow down', { status: 429 }),
		'api.you.com': () => mcp(JSON.stringify(you)),
	})
	const provider = load({ cacheTtlSeconds: 0 })
	const result = await provider.search({ query: 'plain question' })
	assert.deepEqual(result.sources, [{ url: 'https://example.com/y', title: 'You result', snippet: 'Described', publishedAt: '2026-09-28T09:00:00' }])
	assert.match(calls.find((call) => call.host === 'api.you.com').url, /profile=free/u)
	await provider.search({ query: 'another question' })
	assert.equal(countOf('mcp.exa.ai'), 1)
	assert.equal(countOf('api.you.com'), 2)
})

test('an MCP tool error is a backend failure, not an empty answer', async () => {
	route({
		'mcp.exa.ai': () => mcp('Rate limit exceeded for the free tier', { isError: true }),
		'en.wikipedia.org': wikipedia,
	})
	const result = await load({ backends: ['exa', 'wikipedia'] }).search({ query: 'plain question' })
	assert.match(result.content, /^General web search was unavailable \(Exa rate-limited\); these results come only from Wikipedia\./u)
})

test('verticalsOf routes error messages and named sources only', () => {
	assert.deepEqual(plugin.verticalsOf('best hiking trails in the Tatra mountains'), [])
	assert.deepEqual(plugin.verticalsOf('how to write a paper airplane'), [])
	assert.deepEqual(plugin.verticalsOf("TypeError: x is not a function react"), [{ backend: 'stackexchange', query: 'TypeError: x is not a function react' }])
	assert.deepEqual(plugin.verticalsOf('ECONNREFUSED 127.0.0.1:5432'), [{ backend: 'stackexchange', query: 'ECONNREFUSED 127.0.0.1:5432' }])
	assert.deepEqual(plugin.verticalsOf('open source vector database github'), [{ backend: 'github', query: 'vector database' }])
	assert.deepEqual(plugin.verticalsOf('arxiv papers on diffusion models'), [{ backend: 'arxiv', query: 'diffusion models' }])
	assert.deepEqual(plugin.verticalsOf('git rebase on stack overflow').map((entry) => entry.backend), ['stackexchange'])
})

const stackoverflow = () => json({
	items: [
		{ title: 'Why &quot;x&quot; fails', link: 'https://stackoverflow.com/q/1', score: 12, is_answered: true, answer_count: 3, creation_date: 1700000000, tags: ['node.js'] },
		{ title: 'Downvoted', link: 'https://stackoverflow.com/q/2', score: -2, is_answered: false, answer_count: 1, creation_date: 1700000000, tags: [] },
	],
	quota_remaining: 250,
})

test('an error query puts answered Stack Overflow questions ahead of the general results', async () => {
	route({
		'api.tavily.com': () => json({ results: [1, 2, 3, 4].map((n) => ({ url: `https://example.com/${n}`, title: `T${n}`, content: 'c' })) }),
		'api.stackexchange.com': stackoverflow,
	})
	const result = await load().search({ query: 'TypeError: x is not a function', maxResults: 4 })
	assert.deepEqual(result.sources.map((source) => source.url), ['https://stackoverflow.com/q/1', 'https://example.com/1', 'https://example.com/2', 'https://example.com/3'])
	assert.equal(result.sources[0].title, 'Why "x" fails')
	assert.equal(result.sources[0].snippet, 'Stack Overflow question · answered · score 12 · 3 answers · tags: node.js')
	assert.equal(result.sources[0].publishedAt, '2023-11-14T22:13:20.000Z')
	const asked = new URL(calls.find((call) => call.host === 'api.stackexchange.com').url)
	assert.equal(asked.searchParams.get('site'), 'stackoverflow')
	assert.equal(asked.searchParams.get('answers'), '1')
})

test('an unrouted query asks no specialised source', async () => {
	route({ 'api.tavily.com': () => json({ results: [{ url: 'https://example.com/1', title: 'T', content: 'c' }] }) })
	await load().search({ query: 'best hiking trails' })
	assert.deepEqual(calls.map((call) => call.host), ['api.tavily.com'])
})

test('a slow specialised source is left out instead of delaying the answer', async () => {
	route({
		'api.tavily.com': () => json({ results: [{ url: 'https://example.com/1', title: 'T', content: 'c' }] }),
		'api.stackexchange.com': hang,
	})
	const started = Date.now()
	const result = await load().search({ query: 'TypeError: x is not a function' })
	assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`)
	assert.deepEqual(result.sources.map((source) => source.url), ['https://example.com/1'])
})

test('GitHub repositories carry stars and language, and a spent rate limit pauses GitHub', async () => {
	let limited = false
	route({
		'api.tavily.com': () => json({ results: [{ url: 'https://example.com/1', title: 'T', content: 'c' }] }),
		'api.github.com': () => limited
			? json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
			: json({ items: [{ full_name: 'acme/vectordb', html_url: 'https://github.com/acme/vectordb', description: 'A vector database', stargazers_count: 1234, language: 'Rust', pushed_at: '2026-11-01T00:00:00Z' }] }),
	})
	const provider = load({ cacheTtlSeconds: 0 })
	const result = await provider.search({ query: 'vector database github' })
	assert.deepEqual(result.sources[0], { url: 'https://github.com/acme/vectordb', title: 'acme/vectordb', snippet: 'GitHub repository · 1234 stars · Rust — A vector database', publishedAt: '2026-11-01T00:00:00Z' })
	assert.equal(new URL(calls.find((call) => call.host === 'api.github.com').url).searchParams.get('q'), 'vector database')
	limited = true
	await provider.search({ query: 'graph database github' })
	await provider.search({ query: 'time series database github' })
	assert.equal(countOf('api.github.com'), 2)
})

test('specialised results join the fallback and are named in its note', async () => {
	route({ 'api.tavily.com': tavilyCapped, 'api.stackexchange.com': stackoverflow, 'en.wikipedia.org': wikipedia })
	const result = await load({ backends: ['tavily', 'stackexchange', 'wikipedia'] }).search({ query: 'TypeError: x is not a function' })
	assert.match(result.content, /these results come only from Stack Overflow and Wikipedia\./u)
	assert.equal(result.sources.length, 2)
})

test('arXiv is opt-in and its Atom feed is parsed', async () => {
	const atom = `<?xml version="1.0"?><feed><title>query</title><entry><id>http://arxiv.org/abs/2405.07437v2</id><published>2024-05-13T02:33:25Z</published><title>Evaluation of
  RAG: A Survey</title><summary>  We survey &amp; compare.
</summary><author><name>A One</name></author><author><name>B Two</name></author></entry></feed>`
	route({
		'api.tavily.com': () => json({ results: [{ url: 'https://example.com/1', title: 'T', content: 'c' }] }),
		'export.arxiv.org': () => new Response(atom, { status: 200 }),
	})
	await load().search({ query: 'arxiv papers on rag evaluation' })
	assert.equal(countOf('export.arxiv.org'), 0)
	plugin.resetState()
	const result = await load({ backends: ['tavily', 'arxiv'] }).search({ query: 'arxiv papers on rag evaluation' })
	assert.deepEqual(result.sources[0], { url: 'https://arxiv.org/abs/2405.07437v2', title: 'Evaluation of RAG: A Survey', snippet: 'arXiv paper · A One, B Two — We survey & compare.', publishedAt: '2024-05-13T02:33:25Z' })
	assert.equal(new URL(calls.find((call) => call.host === 'export.arxiv.org').url).searchParams.get('search_query'), 'all:rag AND all:evaluation')
})
