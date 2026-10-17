import { expect, mock, test, type TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const HOME = '/home/trader/.config/rocket'
const RUN = '20260106-090000'

// A small mascot on a rounded tile.
const MASCOT =
  '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="10" fill="#10213a"/>' +
  '<rect x="10" y="20" width="10" height="20" fill="#3987e5"/><rect x="30" y="10" width="10" height="20" fill="#e66767"/></svg>'

const job = (status: string, note = '') => ({ status, note, started_at: 100, finished_at: status === 'running' ? null : 104 })
const pending = { status: 'pending', note: '', started_at: null, finished_at: null }

const RUNNING = {
  id: RUN,
  range: { from: '2026-01-05', to: '2026-01-06' },
  accounts: ['11111111'],
  status: 'running',
  active_stage: 'parse',
  summary: '',
  notes: [{ at: 103, text: 'two terminals' }],
  started_at: 100,
  updated_at: 105,
  finished_at: null,
  stages: [
    { name: 'discover', jobs: ['terminals'] },
    { name: 'read', jobs: ['journal', 'experts'] },
    { name: 'parse', jobs: ['events', 'trades', 'failed'] },
    { name: 'analyse', jobs: ['pnl', 'stats'] },
    { name: 'report', jobs: ['table', 'story'] },
  ],
  jobs: {
    terminals: job('success', '1 terminal(s): net.metaquotes.wine.metatrader5'),
    journal: job('success', '2 day log(s) decoded'),
    experts: job('skipped', 'no expert logs in this period'),
    events: job('success', '31 events'),
    trades: job('running', 'rebuilding positions'),
    failed: pending,
    pnl: pending,
    stats: pending,
    table: pending,
    story: pending,
  },
}

const tally = (n: number, wins: number, net: number | null) => ({ n, wins, losses: n - wins, net, win_rate: n ? (wins * 100) / n : null })

const group = (id: string, label: string) => ({
  id,
  label,
  trades: 4,
  closed: 4,
  open: 0,
  failed: 1,
  money: { ok: true, currency: 'USD' },
  currency: 'USD',
  wins: 2,
  losses: 2,
  breakeven: 0,
  win_rate: 50,
  net: 1890,
  avg_win: 1500,
  avg_loss: -555,
  rrr: 2.7,
  avg_r: 0.4,
  planned_rr: 2,
  profit_factor: 2.7,
  best_symbol: { symbol: 'XAUUSD', ...tally(3, 2, 2000) },
  by_symbol: [
    { symbol: 'XAUUSD', ...tally(3, 2, 2000) },
    { symbol: 'EURUSD', ...tally(1, 0, -110) },
  ],
  by_side: { buy: tally(3, 2, 2000), sell: tally(1, 0, -110) },
  by_day: [
    { date: '2026-01-05', ...tally(3, 2, 1890) },
    { date: '2026-01-06', ...tally(1, 0, -1000) },
  ],
  equity: [
    { at: '2026-01-05 09:00:20', symbol: 'XAUUSD', pnl: 1000, cum: 1000 },
    { at: '2026-01-05 09:02:20', symbol: 'XAUUSD', pnl: 2000, cum: 3000 },
    { at: '2026-01-05 09:03:30', symbol: 'EURUSD', pnl: -110, cum: 2890 },
    { at: '2026-01-06 09:00:20', symbol: 'XAUUSD', pnl: -1000, cum: 1890 },
  ],
  day_win_rate: 50,
  largest_win: 2000,
  largest_loss: -1000,
  avg_hold_win: 140,
  avg_hold_loss: 65,
  by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hour === 9 ? tally(3, 1, -1110) : hour === 14 ? tally(1, 1, 2000) : tally(0, 0, 0)) })),
})

const STATS = {
  range: RUNNING.range,
  groups: [group('all', 'All accounts'), group('11111111', '11111111 · Demo-Server1'), group('22222222', '22222222 · Demo-Server2')],
}

const setup = (on: On, served: { status?: object; current?: string }, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: 105_000 })
  mock.env(on, { ROCKET_HOME: HOME, TERM_PROGRAM: 'Apple_Terminal', ...env })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('fs.read', async ($, e) => {
    if (e.path === `${HOME}/current` && served.current !== undefined) return { value: `${served.current}\n` }
    if (e.path === `${HOME}/runs/${RUN}/status.json` && served.status !== undefined) return { value: JSON.stringify(served.status) }
    if (e.path === `${HOME}/runs/${RUN}/stats.json`) return { value: JSON.stringify(STATS) }
    if (e.path.endsWith('/assets/mascot.png') && e.as === 'bytes') return { value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } } as never
    if (e.path.endsWith('/assets/mascot.svg') || e.path.endsWith('/assets/mascot-pixels.svg')) return { value: MASCOT }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  return clock
}

const mount = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'rocket',
    surface,
    component: 'Pane',
    requestId: 'rocket',
    props: { title: 'Trading Rocket', isFocused: false, bodyColumns: 140, placement: 'dock' } as never,
  })

const start = ($: Engine) =>
  $.session.start({ cwd: '/Users/trader', surface: 'terminal', isInteractive: true })

test('while a run works the pane draws its pipeline, mascot top left', async ($, on) => {
  const clock = setup(on, { current: RUN, status: RUNNING })
  await start($)
  await clock.advance(1_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: '◆ trading rocket' })).toBeDefined()
    expect(await ui.find({ text: '2026-01-05 → 2026-01-06' })).toBeDefined()
    expect(await ui.find({ text: ' · account 11111111' })).toBeDefined()
    expect(await ui.find({ text: / trades: rebuilding positions/ })).toBeDefined()
    expect(await ui.find({ text: /2 day log\(s\) decoded/ })).toBeDefined()
    expect(await ui.find({ text: /two terminals/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ text: /╭─+╮/ })).toBeDefined()
      expect(await ui.find({ text: '▀' })).toBeDefined() // the mascot in half blocks
      expect(await ui.find({ text: /WIN RATE/ })).toBeUndefined()
    } else {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBe(2)
      expect(String(svgs[0]?.props.alt)).toContain('mascot')
      const pipeline = String(svgs[1]?.props.source)
      expect(pipeline).toContain('<g class="running">')
      expect(pipeline.match(/<g class=/g)?.length).toBe(10) // a pill per job
    }
    await ui.unmount()
  }
})

test('a run that finished with success swaps the pipeline for the charts', async ($, on) => {
  const served: { status?: object; current?: string } = { current: RUN, status: RUNNING }
  const clock = setup(on, served)
  await start($)
  await clock.advance(1_000)

  served.status = {
    ...RUNNING,
    status: 'success',
    summary: '4 trades · 50% win · +1,890 USD',
    finished_at: 130,
    jobs: Object.fromEntries(Object.keys(RUNNING.jobs).map(id => [id, job('success')])),
  }
  await clock.advance(1_000) // between runs the pane looks once a second

  const terminal = await mount($, 'terminal')
  expect(await terminal.find({ text: /╭─+╮ $/ })).toBeDefined() // cards, not the pipeline's pills
  expect(await terminal.find({ text: 'discover' })).toBeUndefined()
  for (const label of ['Net P&L', 'Trade win %', 'Profit factor', 'Day win %', 'Avg win/loss (RRR)', 'Daily net cumulative P&L', 'Net daily P&L', 'Performance by symbol', 'Trade time performance', 'Long vs short']) {
    expect(await terminal.find({ text: label })).toBeDefined()
  }
  expect(await terminal.find({ text: '$1,890.00' })).toBeDefined()
  expect(await terminal.find({ text: '50%' })).toBeDefined()
  expect(await terminal.find({ text: '2.70' })).toBeDefined()
  expect(await terminal.find({ text: ' XAUUSD ' })).toBeDefined()
  expect(await terminal.find({ text: /−\$1,000\.00$/ })).toBeDefined() // the losing day
  expect(await terminal.find({ text: /11111111 · Demo-Server1/ })).toBeDefined() // a line per account
  expect(await terminal.find({ text: '▀' })).toBeDefined() // the mascot stays
  await terminal.unmount()

  const desktop = await mount($, 'desktop')
  const svgs = await desktop.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(2)
  const charts = svgs[1]
  // an image that fills the pane's width: an interactive frame would need a fixed size
  expect(charts?.props.isInteractive).toBeUndefined()
  expect(String(charts?.props.source)).toContain('width="640"')
  const source = String(charts?.props.source)
  for (const text of ['Net P&amp;L', 'Trade win %', 'Profit factor', 'Day win %', 'Avg win/loss trade', 'Daily net cumulative P&amp;L',
    'Net daily P&amp;L', 'Performance by symbol', 'Trade time performance', '>Long<', '>Short<', 'Largest win', '$1,890.00', '−$555.00']) {
    expect(source).toContain(text)
  }
  expect(String(charts?.props.alt)).toContain('trade win 50%, profit factor 2.70')
  await desktop.unmount()
})

test('a terminal that shows pictures gets the logo itself, not pixels', async ($, on) => {
  const clock = setup(on, { current: RUN, status: RUNNING }, { TERM_PROGRAM: 'ghostty' })
  await start($)
  await clock.advance(1_000)

  const ui = await mount($, 'terminal')
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' })
  expect(image?.props.columns).toBe(10)
  expect(await ui.find({ text: '▀' })).toBeUndefined()
  expect(await ui.find({ text: '◆ trading rocket' })).toBeDefined()
  await ui.unmount()
})

test('without a run the pane says how to start one', async ($, on) => {
  const clock = setup(on, {})
  await start($)
  await clock.advance(1_000)

  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: /no analysis yet · start one with \/rocket:analyse/ })).toBeDefined()
  await ui.unmount()
})
