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
