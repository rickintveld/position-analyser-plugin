import { parseJournal } from './events'
import { computeReview } from './review'
import { computeStats } from './stats'
import { buildTrades } from './trades'
import type { Answers, Event, JournalEntry, JobStatus, Run, Trades } from './types'

// The deterministic part of /rocket:analyse, served as the tool
// mcp__rocket__mt5: finds the MetaTrader 5 terminals on this machine (Windows,
// or wine on macOS and Linux), decodes their logs, rebuilds the trades and
// computes the statistics and the review, and keeps one pipeline per run that the pane draws.
// Read-only towards MetaTrader: it only reads logs and writes under the home
// folder (ROCKET_HOME, default <user home>/.config/rocket).

// What the engine needs from the host: files and a few environment variables,
// handed in by the hooks module (only it may hold the engine interface).
export type Io = {
  read: (path: string) => Promise<string>
  readBytes: (path: string) => Promise<{ base64: string }>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<{ name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
  env: Env
}

export type Env = {
  OS?: string
  HOME?: string
  USERPROFILE?: string
  APPDATA?: string
  ProgramFiles?: string
  'ProgramFiles(x86)'?: string
  ROCKET_HOME?: string
  ROCKET_MT5_PATHS?: string
}

const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'success', 'failed', 'warning', 'skipped', 'canceled']

const STAGES = [
  { name: 'discover', jobs: ['terminals'] },
  { name: 'read', jobs: ['journal', 'experts'] },
  { name: 'parse', jobs: ['events', 'trades', 'failed'] },
  { name: 'analyse', jobs: ['pnl', 'stats', 'review'] },
]

export type Terminal = { index: number; path: string; label: string }

// Paths with forward slashes everywhere: Windows takes them too.
const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const join = (...parts: string[]) => parts.map(slash).join('/')

export const isWindows = (env: Env) => env.OS === 'Windows_NT'

const userHome = (env: Env) => slash(env.HOME || env.USERPROFILE || '')

export function homeDir(env: Env) {
  return env.ROCKET_HOME ? slash(env.ROCKET_HOME) : join(userHome(env), '.config/rocket')
}

const now = () => Math.floor(Date.now() / 1000)

// --- dates ---------------------------------------------------------------

// YYYY-MM-DD or YYYYMMDD -> YYYY-MM-DD, or an error for anything not a calendar day
export function day(input: string): string {
  const d = input.replace(/-/g, '')
  if (!/^\d{8}$/.test(d)) throw new Error(`not a date: ${input} (use YYYY-MM-DD)`)
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  const t = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) throw new Error(`not a date: ${input}`)
  return iso
}

const shiftDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// --- files ---------------------------------------------------------------

// MT5 writes UTF-16LE (with a BOM); a copy may already be UTF-8.
export function decode(base64: string): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0 && bytes[3] === 0)
  // the plugin environment's TextDecoder knows UTF-8 only: UTF-16LE by hand,
  // code unit by code unit (surrogate pairs join up in the string)
  if (!utf16) return new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')
  const chunks: string[] = []
  for (let i = 0; i < bytes.length - 1; i += 8192) {
    const units: number[] = []
    for (let j = i; j < Math.min(i + 8192, bytes.length - 1); j += 2) units.push((bytes[j] ?? 0) | ((bytes[j + 1] ?? 0) << 8))
    chunks.push(String.fromCharCode(...units))
  }
  return chunks.join('').replace(/^\uFEFF/, '')
}

const list = (io: Io, dir: string) => io.list(dir).catch(() => [])
const dirs = async (io: Io, dir: string) => (await list(io, dir)).filter(e => e.kind === 'dir').map(e => join(dir, e.name))
const exists = (io: Io, path: string) => io.exists(path).catch(() => false)

// --- run state -------------------------------------------------------------

export async function current(io: Io): Promise<{ dir: string; run: Run }> {
  const home = await homeDir(io.env)
  const id = (await io.read(`${home}/current`).catch(() => '')).trim()
  if (id === '') throw new Error('no run; start one with action "start"')
  const dir = `${home}/runs/${id}`
  const text = await io.read(`${dir}/status.json`).catch(() => '')
  if (text === '') throw new Error(`run ${id} not found`)
  return { dir, run: JSON.parse(text) as Run }
}

export async function save(io: Io, dir: string, run: Run) {
  run.updated_at = now()
  await io.write(`${dir}/status.json`, JSON.stringify(run, null, 2))
}

export async function job(io: Io, id: string, status: string, note = '') {
  if (!JOB_STATUSES.includes(status as JobStatus)) throw new Error(`unknown status ${status} (${JOB_STATUSES.join(' ')})`)
  const { dir, run } = await current(io)
  const job = run.jobs[id]
  if (job === undefined) throw new Error(`unknown job ${id}`)
  const t = now()
  job.status = status as JobStatus
  job.note = note
  if (status === 'running') {
    job.started_at = t
    job.finished_at = null
    run.active_stage = STAGES.find(s => s.jobs.includes(id))?.name ?? run.active_stage
  } else if (status === 'pending') {
    job.started_at = null
    job.finished_at = null
  } else {
    job.started_at ??= t
    job.finished_at = t
  }
  await save(io, dir, run)
}

export async function start(io: Io, input: { from?: string; to?: string; date?: string; accounts?: string[] }) {
  const from = input.date ? day(input.date) : input.from ? day(input.from) : today()
  const to = input.date ? day(input.date) : input.to ? day(input.to) : today()
  if (from > to) throw new Error(`from ${from} is after to ${to}`)
  const accounts = (input.accounts ?? []).map(String)
  for (const a of accounts) if (!/^\d+$/.test(a)) throw new Error(`an account number is digits, got '${a}'`)

  const home = await homeDir(io.env)
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  let id = stamp
  for (let n = 1; await exists(io, `${home}/runs/${id}`); n++) id = `${stamp}-${n}`
  const t = now()
  const run: Run = {
    id,
    range: { from, to },
    accounts,
    status: 'running',
    active_stage: 'discover',
    summary: '',
    notes: [],
    started_at: t,
    updated_at: t,
    finished_at: null,
    stages: STAGES,
    jobs: Object.fromEntries(STAGES.flatMap(s => s.jobs).map(j => [j, { status: 'pending', note: '', started_at: null, finished_at: null }])),
  }
  const dir = `${home}/runs/${id}`
  await save(io, dir, run)
  await io.write(`${home}/current`, `${id}\n`)
  return { run: id, dir, range: run.range, accounts }
}

export async function note(io: Io, text: string) {
  const { dir, run } = await current(io)
  run.notes = [...run.notes, { at: now(), text }].slice(-20)
  await save(io, dir, run)
}

export async function finish(io: Io, status: string, summary = '') {
  if (!['success', 'failed', 'canceled'].includes(status)) throw new Error('finish takes success, failed or canceled')
  const { dir, run } = await current(io)
  const t = now()
  for (const job of Object.values(run.jobs)) {
    if (job.status === 'running') Object.assign(job, { status: 'canceled', finished_at: t })
    else if (job.status === 'pending') job.status = 'skipped'
  }
  Object.assign(run, { status, summary, finished_at: t })
  await save(io, dir, run)
  return { status, summary }
}

// --- the steps -------------------------------------------------------

// Data folders of every MT5 terminal: on Windows the per-user folders
// (%APPDATA%/MetaQuotes/Terminal/<id>) and portable installs under Program
// Files; on macOS and Linux the same inside each wine prefix (a drive_c: the
// MetaQuotes app, CrossOver bottles, ~/.wine, other wrappers). A terminal is
// a folder with a logs folder and terminal64.exe or origin.txt.
// `paths` (or ROCKET_MT5_PATHS) replaces the search.
export async function findTerminals(io: Io, paths: string[] = []): Promise<Terminal[]> {
  const windows = isWindows(io.env)
  const own = paths.length > 0 ? paths : (io.env.ROCKET_MT5_PATHS ?? '').split(windows ? ';' : ':').filter(Boolean)
  const home = userHome(io.env)
  const candidates: string[] = []
  const inPrefix = async (drive: string) => {
    candidates.push(...(await dirs(io, join(drive, 'Program Files'))), ...(await dirs(io, join(drive, 'Program Files (x86)'))))
    for (const user of await dirs(io, join(drive, 'users'))) candidates.push(...(await dirs(io, join(user, 'AppData/Roaming/MetaQuotes/Terminal'))))
  }
  // drive_c folders up to three levels under `root`
  const prefixes = async (root: string, depth = 3) => {
    let level = [slash(root)]
    for (let i = 0; i < depth && level.length > 0; i++) {
      const next: string[] = []
      for (const dir of level) {
        for (const entry of await list(io, dir)) {
          if (entry.kind !== 'dir') continue
          if (entry.name === 'drive_c') await inPrefix(join(dir, entry.name))
          else if (!entry.name.startsWith('.')) next.push(join(dir, entry.name))
        }
      }
      level = next
    }
  }

  if (own.length > 0) {
    for (const path of own) {
      candidates.push(slash(path), ...(await dirs(io, path)))
      await prefixes(path)
    }
  } else if (windows) {
    const appdata = io.env.APPDATA
    if (appdata) candidates.push(...(await dirs(io, join(appdata, 'MetaQuotes/Terminal'))))
    for (const pf of [io.env.ProgramFiles, io.env['ProgramFiles(x86)']]) if (pf) candidates.push(...(await dirs(io, pf)))
  } else {
    await prefixes(join(home, 'Library/Application Support'), 3)
    await prefixes(join(home, 'Library/Application Support/CrossOver/Bottles'), 2)
    if (await exists(io, join(home, '.wine/drive_c'))) await inPrefix(join(home, '.wine/drive_c'))
  }

  const found: string[] = []
  for (const dir of [...new Set(candidates)]) {
    const names = new Set((await list(io, dir)).map(e => e.name))
    if (names.has('logs') && (names.has('terminal64.exe') || names.has('origin.txt'))) found.push(dir)
  }
  found.sort()
  const terminals: Terminal[] = []
  for (const [index, path] of found.entries()) {
    // Under AppData the folder is an id; origin.txt names the install it belongs to.
    let label = path.startsWith(home) ? path.slice(home.length + 1) : path
    label = label.replace(/^Library\/Application Support\//, '').replace(/\/drive_c\/.*/, '')
    if (/\/MetaQuotes\/Terminal\/[^/]+$/.test(path)) {
      const origin = await io.readBytes(join(path, 'origin.txt')).then(b => decode(b.base64).trim()).catch(() => '')
      const install = slash(origin).split('/').pop()
      label = windows ? `${install || 'MetaTrader 5'} (${path.split('/').pop()?.slice(0, 8)})` : `${label} (${path.split('/').pop()?.slice(0, 8)})`
    } else if (windows) {
      label = path.split('/').pop() ?? path
    }
    terminals.push({ index, path, label })
  }
  return terminals
}

export async function discover(io: Io, paths: string[] = []) {
  const { dir } = await current(io)
  await job(io, 'terminals', 'running', 'looking for MetaTrader 5 data folders')
  const terminals = await findTerminals(io, paths)
  if (terminals.length === 0) {
    await job(io, 'terminals', 'failed', 'no MetaTrader 5 terminal found')
    throw new Error('no terminal found; pass `paths` with the folder holding terminal64.exe (or its data folder)')
  }
  await io.write(`${dir}/terminals.json`, JSON.stringify(terminals, null, 2))
  await job(io, 'terminals', 'success', `${terminals.length} terminal(s): ${terminals.map(t => t.label).join(', ')}`)
  return terminals
}

export async function read(io: Io) {
  const { dir, run } = await current(io)
  const terminals = JSON.parse(await io.read(`${dir}/terminals.json`).catch(() => 'null')) as Terminal[] | null
  if (terminals === null) throw new Error('run discover first')
  // one day either side, for positions that run over midnight
  const days: string[] = []
  for (let d = shiftDay(run.range.from, -1); d <= shiftDay(run.range.to, 1); d = shiftDay(d, 1)) days.push(d.replace(/-/g, ''))

  await job(io, 'journal', 'running', `decoding journals ${run.range.from} → ${run.range.to}`)
  await job(io, 'experts', 'running', 'decoding expert logs')
  const count = { journal: 0, experts: 0 }
  const tooBig: string[] = []
  for (const t of terminals) {
    for (const [kind, folder] of [['journal', 'logs'], ['experts', 'MQL5/Logs']] as const) {
      const present = new Set((await list(io, join(t.path, folder))).map(e => e.name))
      for (const name of days) {
        if (!present.has(`${name}.log`)) continue
        const bytes = await io.readBytes(join(t.path, folder, `${name}.log`)).catch((e: unknown) => {
          tooBig.push(`${t.label} ${kind} ${name} (${String(e).slice(0, 60)})`)
          return undefined
        })
        if (bytes === undefined) continue
        await io.write(`${dir}/logs/${t.index}/${kind}/${name}.log`, decode(bytes.base64))
        count[kind]++
      }
    }
  }
  if (count.journal === 0) await job(io, 'journal', 'warning', `no journal for ${run.range.from} → ${run.range.to}`)
  else await job(io, 'journal', tooBig.length ? 'warning' : 'success', `${count.journal} day log(s) decoded${tooBig.length ? `; could not read ${tooBig.join(', ')}` : ''}`)
  if (count.experts === 0) await job(io, 'experts', 'skipped', 'no expert logs in this period')
  else await job(io, 'experts', 'success', `${count.experts} expert log(s), for context`)
  return { ...count, unreadable: tooBig }
}

export async function parse(io: Io, contracts: Record<string, number> = {}) {
  const { dir, run } = await current(io)
  const terminals = JSON.parse(await io.read(`${dir}/terminals.json`).catch(() => '[]')) as Terminal[]
  await job(io, 'events', 'running', 'reading Trades and Network lines')
  const events: Event[] = []
  for (const t of terminals) {
    for (const entry of await list(io, `${dir}/logs/${t.index}/journal`)) {
      const name = entry.name.replace(/\.log$/, '')
      const text = await io.read(`${dir}/logs/${t.index}/journal/${entry.name}`)
      events.push(...parseJournal(text, `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}`, t.index))
    }
  }
  await job(io, 'events', 'success', `${events.length} events`)

  await job(io, 'trades', 'running', 'rebuilding positions')
  const trades = buildTrades(events, { from: run.range.from, to: run.range.to, contracts, only: run.accounts ?? [] })
  await io.write(`${dir}/trades.json`, JSON.stringify(trades, null, 2))
  const missing = trades.only.filter(a => !trades.seen.includes(a))
  if (missing.length > 0) {
    await job(io, 'trades', 'warning', `account ${missing.join(', ')} not in the logs of this period; seen: ${trades.seen.join(', ') || 'none'}`)
    return { accounts: trades.accounts, trades: trades.trades.length, missing, seen: trades.seen }
  }
  const open = trades.trades.filter(t => t.status === 'open').length
  await job(io, 'trades', 'success', `${trades.trades.length} trade(s) on ${trades.accounts.length} account(s)${open > 0 ? `, ${open} still open` : ''}`)

  if (trades.failed.length > 0) {
    const reasons = new Map<string, number>()
    for (const f of trades.failed) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1)
    const summary = [...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, n]) => `${n}× ${r}`).join(', ')
    await job(io, 'failed', 'warning', `${trades.failed.length} failed order(s): ${summary}`)
  } else {
    await job(io, 'failed', 'success', 'none')
  }
  return { accounts: trades.accounts, trades: trades.trades.length, open, failed: trades.failed.length }
}

export async function readTrades(io: Io): Promise<Trades> {
  const { dir } = await current(io)
  const text = await io.read(`${dir}/trades.json`).catch(() => '')
  if (text === '') throw new Error('run parse first')
  return JSON.parse(text) as Trades
}

export async function analyse(io: Io) {
  const { dir } = await current(io)
  const trades = await readTrades(io)
  await job(io, 'pnl', 'running', 'P/L from contract sizes')
  const unknown = [...new Set(trades.trades.filter(t => t.contract === null).map(t => t.symbol))].sort()
  const defaults = [...new Set(trades.trades.filter(t => t.contract_source === 'default').map(t => `${t.symbol} ${t.contract}`))].sort()
  if (unknown.length > 0) await job(io, 'pnl', 'warning', `contract size unknown: ${unknown.join(', ')} (parse with contracts {SYMBOL: size})`)
  else await job(io, 'pnl', 'success', `estimate without commission/swap${defaults.length ? `; default size: ${defaults.join(', ')}` : ''}`)

  await job(io, 'stats', 'running', 'win rate, RRR, symbols, hours, buy/sell')
  const stats = computeStats(trades)
  await io.write(`${dir}/stats.json`, JSON.stringify(stats, null, 2))
  const g = stats.groups[0]
  await job(io, 
    'stats',
    'success',
    g === undefined ? 'no trades' : `${g.closed} closed · win rate ${g.win_rate ?? '–'}%${g.net !== null ? ` · net ${g.net} ${g.currency}` : ''}`,
  )
  return stats
}

// The trader's answers to the reflection questions, over every run:
// <home>/journal.json, one entry per position.
async function readJournal(io: Io): Promise<JournalEntry[]> {
  const text = await io.read(`${homeDir(io.env)}/journal.json`).catch(() => '')
  return text === '' ? [] : (JSON.parse(text) as { entries: JournalEntry[] }).entries
}

// What the trader did, trade by trade and per period (review.ts).
export async function review(io: Io) {
  const { dir } = await current(io)
  const trades = await readTrades(io)
  await job(io, 'review', 'running', 'what went well, what leaked')
  const journal = Object.fromEntries((await readJournal(io)).map(e => [`${e.account}/${e.position}`, e.answers]))
  const result = computeReview(trades, journal)
  await io.write(`${dir}/review.json`, JSON.stringify(result, null, 2))
  const g = result.groups[0]
  const leaks = g?.tags.filter(t => t.kind === 'leak').reduce((s, t) => s + t.n, 0) ?? 0
  const note = g === undefined || g.closed === 0 ? 'no closed trades' : `${g.clean}/${g.closed} on plan · ${leaks} leak(s)`
  await job(io, 'review', 'success', note)
  // The data is complete: the run ends here and the pane shows the charts while
  // the report and the reflection go on in the chat.
  await finish(io, 'success', `${trades.trades.length} trade(s) · ${note}`)
  return result
}

// Keeps the trader's answers about one trade of this run in the journal.
export async function reflect(io: Io, input: { account?: string; position?: string; answers?: Answers }) {
  const { run } = await current(io)
  const trades = await readTrades(io)
  const t = trades.trades.find(x => x.account === String(input.account ?? '') && x.position === String(input.position ?? ''))
  if (t === undefined) throw new Error(`no trade ${input.position ?? '?'} on account ${input.account ?? '?'} in this run`)
  const answers = Object.fromEntries(Object.entries(input.answers ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v !== ''))
  if (Object.keys(answers).length === 0) throw new Error('answers is empty')
  const entries = (await readJournal(io)).filter(e => !(e.account === t.account && e.position === t.position))
  const entry: JournalEntry = { account: t.account, position: t.position, symbol: t.symbol, open_at: t.open_at, run: run.id, saved_at: now(), answers }
  await io.write(`${homeDir(io.env)}/journal.json`, JSON.stringify({ entries: [...entries, entry] }, null, 2))
  return { saved: entry, entries: entries.length + 1 }
}

// Markdown tables per account, for the report.
export async function table(io: Io) {
  const all = await readTrades(io)
  const n = (x: number | null) => (x === null ? 'unknown' : String(x))
  const at = (x: string | null) => (x === null ? 'unknown' : `${x.slice(11, 16)} (${x.slice(5, 10)})`)
  const how = (x: string | null) => (x === null ? 'still open' : ({ manual: 'manual', sl: 'SL', tp: 'TP', stop_out: 'stop out' } as Record<string, string>)[x] ?? x)
  const out: string[] = []
  for (const a of all.accounts) {
    out.push(`### ${a.account} · ${[a.broker, a.server].filter(Boolean).join(' · ')}`, '')
    out.push('| # | open | side | symbol | lots | entry | exit | closed | how | P/L |', '|---|---|---|---|---|---|---|---|---|---|')
    all.trades
      .filter(t => t.account === a.account)
      .forEach((t, i) =>
        out.push(
          `| ${i + 1} | ${at(t.open_at)} | ${t.side} | ${t.symbol} | ${n(t.volume)} | ${n(t.entry)} | ${n(t.exit)} | ${at(t.close_at)} | ${how(t.closed_by)} | ${t.pnl === null ? 'unknown' : `≈ ${t.pnl} ${t.currency}`} |`,
        ),
      )
    out.push('')
  }
  return out.join('\n')
}
