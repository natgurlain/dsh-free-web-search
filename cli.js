#!/usr/bin/env node
/**
 * Command line for `@natgurlain/dsh-free-web-search`, for use outside DeepSeek
 * Harness:
 *
 *   dsh-free-web-search doctor [--x] [--all]   check every backend from this machine
 *   dsh-free-web-search search <query>         run one search as the agent would
 *
 * It loads the same provider the harness loads. Keys come from the
 * environment (`TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`); a SearXNG instance
 * from `SEARXNG_BASE_URL`.
 */

import process from 'node:process'

import * as plugin from './index.js'

const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
const green = (text) => paint('32', text)
const red = (text) => paint('31', text)
const dim = (text) => paint('2', text)
const bold = (text) => paint('1', text)

/** One probe per backend: the query is one its routing sends there. */
const PROBES = [
	{ backend: 'tavily', name: 'Tavily', kind: 'web', query: 'open source search engines' },
	{ backend: 'brave', name: 'Brave Search', kind: 'web', query: 'open source search engines', needs: 'BRAVE_SEARCH_API_KEY' },
	{ backend: 'searxng', name: 'SearXNG', kind: 'web', query: 'open source search engines', needs: 'SEARXNG_BASE_URL' },
	{ backend: 'exa', name: 'Exa', kind: 'web', query: 'open source search engines' },
	{ backend: 'you', name: 'You.com', kind: 'web', query: 'open source search engines' },
	{ backend: 'duckduckgo', name: 'DuckDuckGo', kind: 'web', query: 'open source search engines', optIn: true },
	{ backend: 'stackexchange', name: 'Stack Overflow', kind: 'specialised', query: 'TypeError: x is not a function' },
	{ backend: 'github', name: 'GitHub', kind: 'specialised', query: 'github repo http client' },
	{ backend: 'arxiv', name: 'arXiv', kind: 'specialised', query: 'arxiv transformers', optIn: true },
	{ backend: 'wikipedia', name: 'Wikipedia', kind: 'fallback', query: 'Rust programming language' },
	{ backend: 'hackernews', name: 'Hacker News', kind: 'fallback', query: 'Rust programming language' },
	{ backend: 'x', name: 'X (Grok Build)', kind: 'x', query: 'tweets about open source' },
]

/** Load the provider with `config`; `lines` receives its diagnostics. */
function loadProvider(config, lines) {
	let provider
	const logger = { warn: (line) => lines.push(String(line)), info() {}, debug() {}, error: (line) => lines.push(String(line)) }
	plugin.apply({ web: { registerSearchProvider: (registered) => { provider = registered } }, logger }, config)
	return provider
}

/** The reason inside a provider error or diagnostic line, without its framing. */
function reasonOf(text) {
	const tried = /Tried: (.*?)\.?(?: A free Tavily API key.*)?$/su.exec(text)
	const body = tried === null ? text.replace(/^free-web-search: "[^"]*": /u, '') : tried[1]
	// The first clause names the cause; the rest repeats advice the summary gives.
	return body.replace(/\s+/gu, ' ').split('; ')[0].trim()
}

async function doctor(flags) {
	const base = process.env.SEARXNG_BASE_URL === undefined ? {} : { searxngBaseURL: process.env.SEARXNG_BASE_URL }
	const rows = await Promise.all(PROBES.map(async (probe) => {
		const mode = probe.backend === 'tavily'
			? (process.env.TAVILY_API_KEY ? 'free key' : 'keyless')
			: probe.needs === undefined ? (probe.backend === 'x' ? 'Grok plan' : 'keyless') : 'key'
		if (probe.needs !== undefined && !process.env[probe.needs]) return { probe, mode: '-', state: 'off', detail: `not set up (${probe.needs})` }
		if (probe.optIn === true && !flags.has('--all')) return { probe, mode, state: 'off', detail: 'opt-in, not checked (--all)' }
		if (probe.backend === 'x' && !flags.has('--x')) return { probe, mode, state: 'off', detail: 'not checked (--x; takes up to 27 s)' }
		const lines = []
		const provider = loadProvider({ ...base, backends: [probe.backend], cacheTtlSeconds: 0 }, lines)
		const started = Date.now()
		try {
			const result = await provider.search({ query: probe.query, maxResults: 5 })
			const ms = Date.now() - started
			if (probe.backend === 'x' && result.sources.length === 0) return { probe, mode, state: 'fail', ms, detail: reasonOf(lines.join('; ')) }
			return { probe, mode, state: 'ok', ms, detail: `${result.sources.length} results` }
		} catch (error) {
			return { probe, mode, state: 'fail', ms: Date.now() - started, detail: reasonOf(lines.length > 0 ? lines.join('; ') : String(error?.message ?? error)) }
		}
	}))

	if (flags.has('--json')) {
		console.log(JSON.stringify(rows.map((row) => ({ backend: row.probe.backend, kind: row.probe.kind, state: row.state, mode: row.mode, ms: row.ms, detail: row.detail })), null, 2))
	} else {
		const width = Math.max(...rows.map((row) => row.probe.name.length))
		let kind
		for (const row of rows) {
			if (row.probe.kind !== kind) {
				kind = row.probe.kind
				console.log(`\n${bold({ web: 'General web', specialised: 'Specialised sources', fallback: 'Fallback', x: 'X posts' }[kind])}`)
			}
			const mark = row.state === 'ok' ? green('✓') : row.state === 'fail' ? red('✗') : dim('·')
			const time = row.ms === undefined ? '      ' : `${(row.ms / 1000).toFixed(1)} s`.padStart(6)
			const detail = row.state === 'fail' ? red(row.detail) : row.state === 'off' ? dim(row.detail) : row.detail
			console.log(`  ${mark} ${row.probe.name.padEnd(width)}  ${dim(row.mode.padEnd(9))} ${time}  ${detail}`)
		}
		const web = rows.filter((row) => row.probe.kind === 'web' && row.state === 'ok')
		const floor = rows.filter((row) => row.probe.kind === 'fallback' && row.state === 'ok')
		console.log('')
		if (web.length > 0) console.log(green(`Web search works: ${web.map((row) => row.probe.name).join(', ')} ${web.length === 1 ? 'answers' : 'answer'} from this machine.`))
		else if (floor.length > 0) console.log(red('No general web backend answers; searches fall back to Wikipedia and Hacker News only.'))
		else console.log(red('Nothing answers from this machine. Check the network connection.'))
		if (!process.env.TAVILY_API_KEY) console.log(dim('Tip: a free Tavily key (TAVILY_API_KEY, tavily.com, no card) lifts the keyless limit of about ten searches a day.'))
	}
	return rows.some((row) => row.state === 'ok' && row.probe.kind !== 'x') ? 0 : 1
}

async function search(words, flags) {
	const query = words.join(' ').trim()
	if (query.length === 0) {
		console.error('Usage: dsh-free-web-search search <query> [--max <n>] [--json]')
		return 2
	}
	const lines = []
	const base = process.env.SEARXNG_BASE_URL === undefined ? {} : { searxngBaseURL: process.env.SEARXNG_BASE_URL }
	const provider = loadProvider(base, lines)
	const started = Date.now()
	let result
	try {
		result = await provider.search({ query, maxResults: flags.max })
	} catch (error) {
		console.error(red(String(error?.message ?? error)))
		return 1
	}
	if (flags.has('--verbose')) for (const line of lines) console.error(dim(line))
	if (flags.has('--json')) {
		console.log(JSON.stringify(result, null, 2))
		return 0
	}
	const columns = Math.max(Math.min(process.stdout.columns ?? 100, 110), 60)
	if (result.content !== undefined) console.log(`${dim(result.content)}\n`)
	result.sources.forEach((source, index) => {
		const number = `${String(index + 1).padStart(2)}. `
		console.log(`${number}${bold(source.title ?? source.url)}`)
		console.log(`    ${paint('36', source.url)}`)
		if (source.snippet !== undefined) {
			const room = columns - 4
			const text = source.snippet.replace(/\s+/gu, ' ')
			console.log(`    ${dim(text.length > room * 2 ? `${text.slice(0, room * 2 - 1)}…` : text)}`)
		}
	})
	console.log(`\n${dim(`${result.sources.length} ${result.sources.length === 1 ? 'result' : 'results'} in ${((Date.now() - started) / 1000).toFixed(1)} s`)}`)
	return 0
}

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((word) => word.startsWith('--')))
const maxAt = rest.indexOf('--max')
flags.max = maxAt >= 0 && /^\d+$/u.test(rest[maxAt + 1] ?? '') ? Number(rest[maxAt + 1]) : 8
const words = rest.filter((word, index) => !word.startsWith('--') && !(maxAt >= 0 && index === maxAt + 1))

let code
if (command === 'doctor') code = await doctor(flags)
else if (command === 'search') code = await search(words, flags)
else {
	console.log([
		'Usage:',
		'  dsh-free-web-search doctor [--x] [--all] [--json]   check every backend from this machine',
		'  dsh-free-web-search search <query> [--max <n>] [--json] [--verbose]   run one search as the agent would',
		'',
		'Keys are read from the environment: TAVILY_API_KEY, BRAVE_SEARCH_API_KEY; SearXNG from SEARXNG_BASE_URL.',
	].join('\n'))
	code = command === undefined || command === '--help' || command === 'help' ? 0 : 2
}
process.exitCode = code
