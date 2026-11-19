#!/usr/bin/env node
/**
 * Build `docs/demo.svg`: an animated terminal recording of the command line.
 * Every scene runs the real command against the live services and records
 * what it printed, so the picture shows actual output, not a mock-up.
 *
 *   node scripts/make-demo.mjs
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)

const SCENES = [
	{ args: ['search', "TypeError: Cannot read properties of undefined (reading 'map')", '--max', '4'], note: 'An error message: answered Stack Overflow questions come first' },
	{ args: ['search', 'rust release notes site:blog.rust-lang.org past month', '--max', '3'], note: 'A site and a time window, read from the query' },
	{ args: ['doctor'], note: 'Which sources answer from this machine' },
]
const COLS = 96
const CHAR = 7.85
const LINE = 19
const PAD = 18
const HOLD = 7 // seconds one scene stays up
const STEP = 0.09 // seconds between output lines

const escape = (text) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
const clip = (text) => (text.length > COLS ? `${text.slice(0, COLS - 1)}…` : text)
const quote = (word) => (/^[\w./:-]+$/u.test(word) ? word : `"${word}"`)

/** The colour class of one output line. */
function classOf(line) {
	if (/^\s+https?:\/\//u.test(line)) return 'url'
	if (/^\s*\d+\. /u.test(line)) return 'title'
	if (/^\s+✓/u.test(line)) return 'ok'
	if (/^\s+✗/u.test(line)) return 'bad'
	if (/^\s+·/u.test(line) || /^\d+ results? in|^Tip:/u.test(line)) return 'dim'
	if (/^Web search works/u.test(line)) return 'ok'
	if (/^(General web|Specialised sources|Fallback|X posts)$/u.test(line)) return 'title'
	return /^\s{4}/u.test(line) ? 'dim' : 'plain'
}

const scenes = []
for (const scene of SCENES) {
	const { stdout } = await run(process.execPath, [join(root, 'cli.js'), ...scene.args], { env: { ...process.env, NO_COLOR: '1' }, timeout: 60000 })
	const lines = stdout.replace(/\n+$/u, '').split('\n').filter((line, index, all) => !(line === '' && all[index - 1] === ''))
	scenes.push({ ...scene, command: `dsh-free-web-search ${scene.args.filter((word, index, all) => word !== '--max' && all[index - 1] !== '--max').map(quote).join(' ')}`, lines: lines.map(clip) })
}

const rows = Math.max(...scenes.map((scene) => scene.lines.length)) + 3
const width = Math.round(COLS * CHAR + PAD * 2)
const height = rows * LINE + PAD * 2 + 34
const total = scenes.length * HOLD
const percent = (seconds) => `${((seconds / total) * 100).toFixed(2)}%`

let css = ''
let body = ''
scenes.forEach((scene, index) => {
	const begin = index * HOLD
	const end = begin + HOLD - 0.4
	const items = [
		{ cls: 'note', text: `# ${scene.note}`, at: 0 },
		{ cls: 'prompt', text: `$ ${clip(scene.command)}`, at: 0.3 },
		...scene.lines.map((text, line) => ({ cls: classOf(text), text, at: 1.1 + line * STEP })),
	]
	items.forEach((item, row) => {
		if (item.text === '') return
		const name = `s${index}r${row}`
		const from = begin + item.at
		css += `@keyframes ${name}{0%,${percent(Math.max(from - 0.01, 0))}{opacity:0}${percent(from + 0.12)},${percent(end)}{opacity:1}${percent(end + 0.3)},100%{opacity:0}}.${name}{animation:${name} ${total}s linear infinite}`
		body += `<text class="${item.cls} ${name}" x="${PAD}" y="${PAD + 34 + (row + 1) * LINE}" xml:space="preserve">${escape(item.text)}</text>`
	})
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Terminal recording: dsh-free-web-search answering an error query, a filtered query, and checking its sources">
<style>
text{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;fill:#c9d1d9;opacity:0}
.note{fill:#8b949e;font-style:italic}.prompt{fill:#f0f6fc;font-weight:600}.title{fill:#f0f6fc;font-weight:600}
.url{fill:#58a6ff}.dim{fill:#8b949e}.ok{fill:#3fb950}.bad{fill:#f85149}.plain{fill:#c9d1d9}
${css}
</style>
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="34" rx="10" fill="#161b22"/><rect y="24" width="${width}" height="10" fill="#161b22"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
${body}
</svg>
`
writeFileSync(join(root, 'docs', 'demo.svg'), svg)
console.log(`docs/demo.svg: ${scenes.length} scenes, ${width}x${height}, ${(svg.length / 1024).toFixed(1)} kB`)
