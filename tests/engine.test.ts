import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { JOURNALS } from './fixtures/journals'

// The engine (mcp__rocket__mt5) end to end against an in-memory file system:
// an MT5 terminal laid out as on macOS (wine) and as on Windows, the journals
// in UTF-16LE with CRLF, as MT5 writes them.

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Files = Map<string, string> // path -> base64 bytes

const utf16 = (text: string) => {
  let bin = '\xff\xfe'
  for (const ch of text.replace(/\n/g, '\r\n')) {
    const c = ch.charCodeAt(0)
    bin += String.fromCharCode(c & 0xff, c >> 8)
  }
  return btoa(bin)
}
const utf8 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const fromUtf8 = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))

// A terminal folder with terminal64.exe or origin.txt and its journals.
function terminal(files: Files, dir: string, origin?: string) {
  if (origin === undefined) files.set(`${dir}/terminal64.exe`, '')
  else files.set(`${dir}/origin.txt`, utf16(origin))
  for (const [name, text] of Object.entries(JOURNALS)) files.set(`${dir}/logs/${name}`, utf16(text))
}

function fileSystem(on: On, files: Files, env: Record<string, string>) {
  mock.env(on, env)
  // This host is not Windows, so it resolves C:/… against its working directory: undo that.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^.*\/(?=[A-Za-z]:\/)/, '')
  on('fs.read', async ($, e) => {
    const bytes = files.get(norm(e.path))
    if (bytes === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: e.as === 'bytes' ? { base64: bytes } : fromUtf8(bytes) } as never
  })
  on('fs.write', async ($, e) => {
    files.set(norm(e.path), utf8(e.text))
    return { value: undefined } as never
  })
  on('fs.exists', async ($, e) => {
    const p = norm(e.path)
    return { value: files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)) } as never
  })
  on('fs.list', async ($, e) => {
    const p = `${norm(e.path)}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(p)) continue
      const [name, ...rest] = key.slice(p.length).split('/')
      if (name) names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__rocket__${e.name}` } }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
}

const mt5 = async ($: Engine, input: Record<string, unknown>) => {
  const answer = (await $.tool.call({ tool: 'mcp__rocket__mt5', ...input } as never)) as { result?: unknown; deny?: string; text?: string }
  if (answer.deny !== undefined) throw new Error(answer.deny)
  const text = String(answer.result ?? answer.text ?? '')
  return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text
}

const json = (files: Files, home: string, name: string) => {
  const id = fromUtf8(files.get(`${home}/current`) ?? '').trim()
  return JSON.parse(fromUtf8(files.get(`${home}/runs/${id}/${name}`) ?? '')) as Record<string, any>
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('macOS: a wine terminal, every kind of trade, the numbers', async ($, on) => {
  const files: Files = new Map()
  const home = '/Users/trader'
  terminal(files, `${home}/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5`)
  fileSystem(on, files, { HOME: home, TERM_PROGRAM: 'Apple_Terminal' })
  await start($)
  const H = `${home}/.config/rocket`

  const run = await mt5($, { action: 'start', from: '2026-01-05', to: '20260106' })
  expect(run.range).toEqual({ from: '2026-01-05', to: '2026-01-06' })
  expect(json(files, H, 'status.json').stages.map((s: { name: string }) => s.name)).toEqual(['discover', 'read', 'parse', 'analyse', 'report'])

  const terminals = await mt5($, { action: 'discover' })
  expect(terminals[0].label).toBe('net.metaquotes.wine.metatrader5')
  expect(await mt5($, { action: 'read' })).toEqual({ journal: 2, experts: 0, unreadable: [] })
  await mt5($, { action: 'parse' })
  const status = json(files, H, 'status.json')
  expect(status.jobs.trades.note).toBe('5 trade(s) on 2 account(s)')
  expect([status.jobs.failed.status, status.jobs.failed.note]).toEqual(['warning', '1 failed order(s): 1× No money'])
  expect(status.jobs.experts.status).toBe('skipped')

  const { trades, accounts } = json(files, H, 'trades.json')
  const trade = (position: string) => trades.find((t: { position: string }) => t.position === position)
  expect(accounts[0]).toEqual({ account: '11111111', server: 'Demo-Server1', broker: 'Example Broker Ltd' })
  expect(trade('1001')).toMatchObject({ closed_by: 'tp', exit: 2030, pnl: 2000, sl_at_breakeven: true, sl_changes: 1, sl_initial: 2000, r: 2, planned_rr: 2 })
  expect(trade('1003')).toMatchObject({ closed_by: 'partial → sl', pnl: -110 })
  expect(trade('1003').exits.length).toBe(2)
  expect(trade('999')).toMatchObject({ open_at: null, entry: 1995, pnl: 1000, closed_by: 'manual' }) // opened before the logs
  expect(trade('1010')).toMatchObject({ closed_by: 'sl', exit: 2050, pnl: -1000 }) // trigger logged after its deal
  expect(trade('2001')).toMatchObject({ status: 'closed', pnl: null, contract: null }) // over midnight, US30
  expect(trade('2001').open_at.slice(0, 10)).toBe('2026-01-05')
  expect(trade('2001').close_at.slice(0, 10)).toBe('2026-01-06')

  await mt5($, { action: 'analyse' })
  expect(json(files, H, 'status.json').jobs.pnl.status).toBe('warning') // US30
  const groups = json(files, H, 'stats.json').groups
  const g = (id: string) => groups.find((x: { id: string }) => x.id === id)
  expect(groups.map((x: { id: string }) => x.id)).toEqual(['all', '11111111', '22222222'])
  expect(g('11111111')).toMatchObject({ win_rate: 50, wins: 2, losses: 2, net: 1890, avg_win: 1500, avg_loss: -555, rrr: 2.7, currency: 'USD', day_win_rate: 50, largest_win: 2000, largest_loss: -1000, avg_hold_win: 70 })
  expect(g('11111111').best_symbol).toMatchObject({ symbol: 'XAUUSD', net: 2000 })
  expect(g('11111111').equity.map((p: { cum: number }) => p.cum)).toEqual([1000, 3000, 2890, 1890])
  expect(g('all')).toMatchObject({ net: null, money: { ok: false } }) // US30 has no contract size
  expect(g('22222222').win_rate).toBe(100)

  const table = await mt5($, { action: 'table' })
  expect(table.split('\n').filter((l: string) => /^\| \d/.test(l)).length).toBe(5)
  expect(table).toContain('| unknown | buy | XAUUSD | 1 | 1995 | 2005 |')

  await mt5($, { action: 'job', job: 'table', status: 'running', note: 'writing' })
  await mt5($, { action: 'finish', status: 'success', summary: '5 trades' })
  const done = json(files, H, 'status.json')
  expect([done.status, done.jobs.story.status, done.jobs.table.status]).toEqual(['success', 'skipped', 'canceled'])
})

test('Windows: the AppData terminal of a broker install, one account', async ($, on) => {
  const files: Files = new Map()
  const id = 'D0E8209F77C8CF37AD8BF550E51FF075'
  terminal(files, `C:/Users/trader/AppData/Roaming/MetaQuotes/Terminal/${id}`, 'C:\\Program Files\\Example MetaTrader 5')
  files.set('C:/Users/trader/AppData/Roaming/MetaQuotes/Terminal/Common/Files/x.txt', '') // not a terminal
  fileSystem(on, files, {
    OS: 'Windows_NT',
    USERPROFILE: 'C:\\Users\\trader',
    APPDATA: 'C:\\Users\\trader\\AppData\\Roaming',
    ProgramFiles: 'C:\\Program Files',
  })
  await start($)
  const H = 'C:/Users/trader/.config/rocket'

  await mt5($, { action: 'start', from: '2026-01-05', to: '2026-01-06', accounts: ['11111111'] })
  const terminals = await mt5($, { action: 'discover' })
  expect(terminals).toEqual([{ index: 0, path: `C:/Users/trader/AppData/Roaming/MetaQuotes/Terminal/${id}`, label: 'Example MetaTrader 5 (D0E8209F)' }])
  await mt5($, { action: 'read' })
  await mt5($, { action: 'parse' })
  expect(json(files, H, 'status.json').jobs.trades.note).toBe('4 trade(s) on 1 account(s)')
  await mt5($, { action: 'analyse' })
  const groups = json(files, H, 'stats.json').groups
  expect(groups.map((x: { id: string }) => x.id)).toEqual(['11111111'])
  expect(groups[0]).toMatchObject({ net: 1890, win_rate: 50 })
})

test('an unknown account, a bad date, no terminal', async ($, on) => {
  const files: Files = new Map()
  terminal(files, '/home/trader/.wine/drive_c/Program Files/MetaTrader 5')
  fileSystem(on, files, { HOME: '/home/trader' })
  await start($)

  await expect(mt5($, { action: 'start', date: '2026-13-45' })).rejects.toThrow('not a date')
  await expect(mt5($, { action: 'start', accounts: ['abc'] })).rejects.toThrow('digits')

  await mt5($, { action: 'start', date: '2026-01-05', accounts: ['99999999'] })
  expect((await mt5($, { action: 'discover' }))[0].label).toBe('.wine')
  await mt5($, { action: 'read' })
  const parsed = await mt5($, { action: 'parse' })
  expect(parsed.missing).toEqual(['99999999'])
  const status = json(files, '/home/trader/.config/rocket', 'status.json')
  expect([status.jobs.trades.status, status.jobs.trades.note]).toEqual(['warning', 'account 99999999 not in the logs of this period; seen: 11111111, 22222222'])

  await mt5($, { action: 'start' })
  await expect(mt5($, { action: 'discover', paths: ['/nowhere'] })).rejects.toThrow('no terminal found')
  await expect(mt5($, { action: 'job', job: 'nope', status: 'success' })).rejects.toThrow('unknown job')
})
