import type { EngineInterface, Register } from 'claude-code'

// The live pane. While a run of /rocket:analyse works it draws the
// run's pipeline (<home>/runs/<current>/status.json, kept by
// bin/rocket) in a GitLab pipeline-graph style; once the run has
// finished with success the pipeline makes way for the charts of stats.json.
// The top left holds the mascot, the rocket (assets/mascot.svg, as pixels
// in the terminal: assets/mascot-pixels.svg).

type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'warning' | 'skipped' | 'canceled'
type RunStatus = 'running' | 'success' | 'failed' | 'canceled'

type Job = { status: JobStatus; note: string; started_at: number | null; finished_at: number | null }

type Run = {
  id: string
  range: { from: string; to: string }
  accounts?: string[]
  status: RunStatus
  active_stage: string
  summary: string
  notes: { at: number; text: string }[]
  started_at: number
  finished_at: number | null
  stages: { name: string; jobs: string[] }[]
  jobs: Record<string, Job>
}

type Tally = { n: number; wins: number; losses: number; net: number | null; win_rate: number | null }

type Group = {
  id: string
  label: string
  trades: number
  closed: number
  open: number
  failed: number
  money: { ok: boolean; why?: string; currency?: string }
  currency: string | null
  wins: number
  losses: number
  breakeven: number
  win_rate: number | null
  net: number | null
  avg_win: number | null
  avg_loss: number | null
  rrr: number | null
  avg_r: number | null
  planned_rr: number | null
  profit_factor: number | null
  best_symbol: (Tally & { symbol: string }) | null
  by_symbol: (Tally & { symbol: string })[]
  by_side: { buy: Tally; sell: Tally }
  by_hour: (Tally & { hour: number })[]
  by_day: (Tally & { date: string })[]
  equity: { at: string; symbol: string; pnl: number; cum: number }[]
  day_win_rate: number | null
  largest_win: number | null
  largest_loss: number | null
  avg_hold_win: number | null
  avg_hold_loss: number | null
}

type Stats = { range: { from: string; to: string }; groups: Group[] }

type Segment = { text: string; color?: string; bg?: string; dim?: boolean; bold?: boolean }

const PANE = 'rocket'
const TITLE = 'Trading Rocket'
const TICK_MS = 125
const IDLE_EVERY = 8 // idle: look for a new run once a second
const PILL_INNER = 17
const MASCOT_CELLS = { columns: 10, rows: 5 } // about square: a cell is twice as tall as wide
const SPINNER = ['◐', '◓', '◑', '◒']
const ACCENT = '#7c5cff'
// Profit green, loss red, as traders read them; a number always carries its
// sign as well, so colour is never the only cue.
const PROFIT = '#22c55e'
const LOSS = '#ef4444'

const ICON: Record<JobStatus, string> = {
  pending: '○',
  running: '◐',
  success: '✔',
  failed: '✖',
  warning: '!',
  skipped: '⊘',
  canceled: '⊘',
}

const COLOR: Record<JobStatus, string> = {
  pending: 'inactive',
  running: 'suggestion',
  success: 'success',
  failed: 'error',
  warning: 'warning',
  skipped: 'inactive',
  canceled: 'inactive',
}

// Box-drawing junction for the connector bus between two stages, keyed by
// up/down/left/right.
const JUNCTION: Record<string, string> = {
  '0011': '─', '0111': '┬', '1111': '┼', '1011': '┴', '1110': '┤', '1101': '├',
  '1010': '┘', '1001': '└', '0110': '┐', '0101': '┌', '1100': '│',
  '0010': '─', '0001': '─', '1000': '│', '0100': '│',
}

let home: string | undefined
let run: Run | undefined
let stats: Stats | undefined
let raw = ''
let statsFor = ''
let frame = 0
let openedFor = ''
let mascotSvg: string | undefined
let mascotLines: Segment[][] = []
let mascotPng = '' // base64
let canShowImages = false

// --- formatting --------------------------------------------------------------

const pad = (text: string, width: number) => text.slice(0, width).padEnd(width)
const padStart = (text: string, width: number) => text.slice(0, width).padStart(width)

const thousands = (n: number, digits = 2) => {
  const [int = '0', dec] = Math.abs(n).toFixed(digits).split('.')
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec === undefined ? '' : `.${dec}`)
}
const money = (n: number | null, currency: string | null) =>
  n === null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${thousands(n)}${currency ? ` ${currency}` : ''}`
const ratio = (n: number | null) => (n === null ? '–' : n.toFixed(2))
const percent = (n: number | null) => (n === null ? '–' : `${Math.round(n)}%`)
const tone = (n: number | null) => (n === null || n === 0 ? undefined : n > 0 ? PROFIT : LOSS)

const duration = (job: Job, now: number) => {
  if (job.started_at === null) return ''
  const s = (job.finished_at ?? now) - job.started_at
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

const clock = (s: number) => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`
}

const period = (range: { from: string; to: string }) => (range.from === range.to ? range.from : `${range.from} → ${range.to}`)

const accountsLabel = (accounts: string[]) => `account${accounts.length > 1 ? 's' : ''} ${accounts.join(', ')}`

const iconOf = (status: JobStatus) =>
  status === 'running' ? (SPINNER[frame % SPINNER.length] ?? ICON.running) : ICON[status]

const runColor = (status: RunStatus) => COLOR[status === 'running' ? 'running' : status]

// --- the pipeline, as text ---------------------------------------------------

function grid(current: Run, now: number): Segment[][] {
  const stages = current.stages
  const counts = stages.map(stage => stage.jobs.length)
  const height = Math.max(...counts) * 3
  const hr = '─'.repeat(PILL_INNER)
  const blank = ' '.repeat(PILL_INNER + 2)
  const rows: Segment[][] = []

  rows.push(
    stages.flatMap((stage, i) => [
      { text: pad(stage.name, PILL_INNER + 2), bold: true },
      ...(i < stages.length - 1 ? [{ text: '   ' }] : []),
    ]),
  )

  for (let r = 0; r < height; r++) {
    const slot = Math.floor(r / 3)
    const part = r % 3
    const row: Segment[] = []

    stages.forEach((stage, i) => {
      const id = stage.jobs[slot]
      const job = id === undefined ? undefined : current.jobs[id]
      if (id === undefined || job === undefined) {
        row.push({ text: blank })
      } else {
        const color = COLOR[job.status]
        const isQuiet = ['pending', 'skipped', 'canceled'].includes(job.status)
        if (part === 0) row.push({ text: `╭${hr}╮`, color })
        if (part === 2) row.push({ text: `╰${hr}╯`, color })
        if (part === 1) {
          row.push(
            { text: '│ ', color },
            { text: iconOf(job.status), color },
            { text: ` ${pad(id, 9)}`, dim: isQuiet },
            { text: ` ${padStart(duration(job, now), 3)}`, dim: true },
            { text: ' │', color },
          )
        }
      }

      if (i < stages.length - 1) {
        const left = counts[i] ?? 0
        const right = counts[i + 1] ?? 0
        const busEnd = (Math.max(left, right) - 1) * 3 + 1
        if (r >= 1 && r <= busEnd) {
          const hasLeft = part === 1 && slot < left
          const hasRight = part === 1 && slot < right
          const key = `${r > 1 ? 1 : 0}${r < busEnd ? 1 : 0}${hasLeft ? 1 : 0}${hasRight ? 1 : 0}`
          row.push({ text: `${hasLeft ? '─' : ' '}${JUNCTION[key] ?? ' '}${hasRight ? '─' : ' '}`, dim: true })
        } else {
          row.push({ text: '   ' })
        }
      }
    })
    rows.push(row)
  }

  return rows
}

// --- the pipeline, as SVG (desktop, editor, mobile: proportional text) -------

const G = { pill: 168, height: 34, pitch: 46, gap: 36, title: 26, pad: 2 }

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif'

const PIPELINE_STYLE =
  `text{font:13px ${FONT};fill:#1f1f1f}` +
  '.b{font-weight:600}.d{fill:#707070}.n{font-variant-numeric:tabular-nums}' +
  '.l{stroke:#c2c2c2}.p{fill:#ffffff}.w{stroke:#ffffff}' +
  '.pending,.skipped,.canceled{color:#a0a0a0}.running{color:#2f6fde}.success{color:#2e9d4f}' +
  '.failed{color:#d1453b}.warning{color:#c77d00}' +
  '@media (prefers-color-scheme:dark){text{fill:#e6e6e6}.d{fill:#9a9a9a}.l{stroke:#4d4d4d}' +
  '.p{fill:#262626}.w{stroke:#262626}.pending,.skipped,.canceled{color:#777777}.running{color:#7aa7ff}' +
  '.success{color:#4eba65}.failed{color:#ff6b6b}.warning{color:#ffc107}}'

function statusSvg(status: JobStatus, x: number, y: number): string {
  const ring = `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>`
  const dot = `<circle cx="${x}" cy="${y}" r="7.5" fill="currentColor"/>`
  const mark = (d: string) => `<path d="${d}" class="w" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  switch (status) {
    case 'success':
      return dot + mark(`M${x - 3.5} ${y}l2.5 2.5l4.5-5`)
    case 'failed':
      return dot + mark(`M${x - 3} ${y - 3}l6 6M${x + 3} ${y - 3}l-6 6`)
    case 'warning':
      return dot + mark(`M${x} ${y - 3.5}v4M${x} ${y + 3.5}v0`)
    case 'running':
      return (
        `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3"/>` +
        `<path d="M${x} ${y - 6.5}a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">` +
        `<animateTransform attributeName="transform" type="rotate" from="0 ${x} ${y}" to="360 ${x} ${y}" dur="1s" repeatCount="indefinite"/></path>`
      )
    case 'skipped':
    case 'canceled':
      return ring + `<path d="M${x - 4.5} ${y + 4.5}l9-9" stroke="currentColor" stroke-width="1.5"/>`
    default:
      return ring
  }
}

function pipelineSvg(current: Run, now: number): { source: string; alt: string } {
  const stages = current.stages
  const counts = stages.map(stage => stage.jobs.length)
  const width = stages.length * G.pill + (stages.length - 1) * G.gap + 2 * G.pad
  const height = G.title + Math.max(...counts) * G.pitch + G.pad
  const left = (i: number) => G.pad + i * (G.pill + G.gap)
  const middle = (slot: number) => G.title + slot * G.pitch + G.height / 2 + 1
  const out: string[] = []

  stages.forEach((stage, i) => {
    out.push(`<text x="${left(i) + 2}" y="16" class="b">${xml(stage.name)}</text>`)

    if (i < stages.length - 1) {
      const [from, to] = [counts[i] ?? 0, counts[i + 1] ?? 0]
      const bus = left(i) + G.pill + G.gap / 2
      const lines = [
        ...Array.from({ length: from }, (_, s) => `M${left(i) + G.pill} ${middle(s)}H${bus}`),
        ...Array.from({ length: to }, (_, s) => `M${bus} ${middle(s)}H${left(i + 1)}`),
        `M${bus} ${middle(0)}V${middle(Math.max(from, to) - 1)}`,
      ]
      out.push(`<path d="${lines.join('')}" class="l" fill="none" stroke-width="1.5" stroke-linecap="round"/>`)
    }

    stage.jobs.forEach((id, slot) => {
      const job = current.jobs[id]
      if (job === undefined) return
      const [x, y] = [left(i), middle(slot)]
      const isQuiet = ['pending', 'skipped', 'canceled'].includes(job.status)
      out.push(
        `<g class="${job.status}">` +
          `<rect x="${x + 0.75}" y="${y - G.height / 2 + 0.75}" width="${G.pill - 1.5}" height="${G.height - 1.5}" rx="${G.height / 2 - 1}" class="p" stroke="currentColor" stroke-width="1.5"/>` +
          statusSvg(job.status, x + 19, y) +
          `<text x="${x + 34}" y="${y + 4.5}"${isQuiet ? ' class="d"' : ''}>${xml(id)}</text>` +
          `<text x="${x + G.pill - 14}" y="${y + 4.5}" class="d n" text-anchor="end">${duration(job, now)}</text>` +
          `</g>`,
      )
    })
  })

  const alt = stages.map(stage => `${stage.name}: ${stage.jobs.map(id => `${id} ${current.jobs[id]?.status ?? ''}`).join(', ')}`).join('; ')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${PIPELINE_STYLE}</style>${out.join('')}</svg>`
  return { source, alt }
}

// --- the dashboard: shared --------------------------------------------------

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }

// $1,234.56 / −$549.12 / +$491.62 (signed) / € and £ alike; other currencies as a code.
const cash = (n: number | null, currency: string | null, signed = false) => {
  if (n === null) return '–'
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : ''
  const unit = currency === null ? '' : (SYMBOL[currency] ?? `${currency} `)
  return `${sign}${unit}${thousands(n)}`
}

// Axis labels: $1.2K, −$300
const short = (n: number, currency: string | null) => {
  const unit = currency === null ? '' : (SYMBOL[currency] ?? '')
  const a = Math.abs(n)
  const body = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '')}K` : `${Math.round(a)}`
  return `${n < 0 ? '−' : ''}${unit}${body}`
}

const hold = (s: number | null) => {
  if (s === null) return '–'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// Round axis steps: 1, 2, 2.5 or 5 times a power of ten.
const niceStep = (span: number, ticks: number) => {
  const raw = span / Math.max(1, ticks)
  const power = 10 ** Math.floor(Math.log10(raw || 1))
  return ([1, 2, 2.5, 5, 10].find(f => f * power >= raw) ?? 10) * power
}

const axis = (lo: number, hi: number, ticks = 4) => {
  // the axis always includes zero, so the step comes from the span with zero in it
  const step = niceStep(Math.max(hi, 0) - Math.min(lo, 0) || 1, ticks)
  const min = Math.floor(Math.min(lo, 0) / step) * step
  const max = Math.ceil(Math.max(hi, 0) / step) * step || step
  const values: number[] = []
  for (let v = min; v <= max + step / 2; v += step) values.push(Math.round(v * 100) / 100)
  return { min, max, values }
}

// --- the dashboard as text (terminal) ---------------------------------------

const CARD = 22

// A row of cards: rounded boxes, title, big value, a detail line.
function cardRow(cards: { title: string; value: Segment; detail: Segment[] }[]): Segment[][] {
  const inner = CARD - 2
  const fit = (segments: Segment[]) => {
    let left = inner - 2
    const out: Segment[] = []
    for (const s of segments) {
      const text = s.text.slice(0, Math.max(0, left))
      left -= text.length
      out.push({ ...s, text })
    }
    return [...out, { text: ' '.repeat(Math.max(0, left)) }]
  }
  const edge = (l: string, r: string) => cards.flatMap(() => [{ text: `${l}${'─'.repeat(inner)}${r} `, dim: true }])
  const body = (pick: (c: (typeof cards)[number]) => Segment[]) =>
    cards.flatMap(c => [{ text: '│ ', dim: true }, ...fit(pick(c)), { text: ' │ ', dim: true }])
  return [
    edge('╭', '╮'),
    body(c => [{ text: c.title, dim: true }]),
    body(c => [{ ...c.value, bold: true }]),
    body(c => c.detail),
    edge('╰', '╯'),
  ]
}

// A split meter of `width` cells: green share, then red.
const split = (good: number, bad: number, width: number): Segment[] => {
  const total = good + bad
  const g = total === 0 ? 0 : Math.round((good / total) * width)
  return total === 0
    ? [{ text: '░'.repeat(width), dim: true }]
    : [{ text: '█'.repeat(g), color: PROFIT }, { text: '█'.repeat(width - g), color: LOSS }]
}

// Braille cells hold 2×4 dots; bit of the dot at (column, row) in a cell.
const DOT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const
const CURVE = { width: 64, height: 8 } // cells

// A line chart of `values` (evenly spaced) in braille: y labels at the top,
// zero and bottom, a dotted zero line, each column green above zero and red below.
function curveLines(values: number[], currency: string | null, from: string, to: string): Segment[][] {
  const [W2, H4] = [CURVE.width * 2, CURVE.height * 4]
  const scale = axis(Math.min(...values), Math.max(...values))
  const yOf = (v: number) => Math.round(((scale.max - v) / (scale.max - scale.min)) * (H4 - 1))
  const xOf = (i: number) => Math.round((i / Math.max(1, values.length - 1)) * (W2 - 1))
  const cells = Array.from({ length: CURVE.height }, () => new Array<number>(CURVE.width).fill(0))
  const sign = new Array<number>(CURVE.width).fill(0)
  const dot = (x: number, y: number) => {
    const row = cells[Math.floor(y / 4)]
    if (row !== undefined) row[Math.floor(x / 2)] = (row[Math.floor(x / 2)] ?? 0) | DOT[x % 2 as 0 | 1][y % 4 as 0 | 1 | 2 | 3]
  }
  // straight segments between the points, every dot column filled in
  for (let i = 1; i < values.length; i++) {
    const [x0, x1] = [xOf(i - 1), xOf(i)]
    const [v0, v1] = [values[i - 1] ?? 0, values[i] ?? 0]
    for (let x = x0; x <= x1; x++) {
      const t = x1 === x0 ? 1 : (x - x0) / (x1 - x0)
      const v = v0 + (v1 - v0) * t
      const [ya, yb] = [yOf(v), yOf(v0 + (v1 - v0) * Math.min(1, t + 1 / Math.max(1, x1 - x0)))]
      // two dots thick, so the line reads as a line and not as a dotted trail
      for (let y = Math.min(ya, yb); y <= Math.max(ya, yb) + 1; y++) dot(x, Math.min(y, H4 - 1))
      sign[Math.floor(x / 2)] = v >= 0 ? 1 : -1
    }
  }
  const zeroRow = Math.floor(yOf(0) / 4)
  const label = (row: number) => {
    const v = row === 0 ? scale.max : row === CURVE.height - 1 ? scale.min : row === zeroRow ? 0 : undefined
    return { text: v === undefined ? '        ' : padStart(short(v, currency), 7) + ' ', dim: true }
  }
  const out: Segment[][] = cells.map((row, r) => [
    label(r),
    ...row.map((bits, i) =>
      bits === 0
        ? { text: r === zeroRow ? '┈' : ' ', dim: true }
        : { text: String.fromCharCode(0x2800 + bits), color: (sign[i] ?? 0) < 0 ? LOSS : PROFIT },
    ),
  ])
  const dates = `${from.slice(5, 10)}${' '.repeat(Math.max(1, CURVE.width - 10))}${to.slice(5, 10)}`
  out.push([{ text: '        ' }, { text: dates, dim: true }])
  return out
}

function dashboardLines(g: Group): Segment[][] {
  const c = g.currency
  const lines: Segment[][] = []
  const grossWin = g.avg_win === null ? 0 : g.avg_win * g.wins
  const grossLoss = g.avg_loss === null ? 0 : Math.abs(g.avg_loss) * g.losses
  const daysWon = g.by_day.filter(d => (d.net ?? d.wins - d.losses) > 0).length

  lines.push(
    ...cardRow([
      { title: 'Net P&L', value: { text: cash(g.net, c), color: tone(g.net) }, detail: [{ text: `${g.closed} trades`, dim: true }] },
      { title: 'Trade win %', value: { text: percent(g.win_rate) }, detail: [...split(g.wins, g.losses, 10), { text: ` ${g.wins}W ${g.losses}L`, dim: true }] },
      { title: 'Profit factor', value: { text: ratio(g.profit_factor) }, detail: split(grossWin, grossLoss, 18) },
      { title: 'Day win %', value: { text: percent(g.day_win_rate) }, detail: [...split(daysWon, g.by_day.length - daysWon, 10), { text: ` ${daysWon}/${g.by_day.length}`, dim: true }] },
      {
        title: 'Avg win/loss (RRR)',
        value: { text: ratio(g.rrr) },
        detail: [{ text: short(g.avg_win ?? 0, c), color: PROFIT }, { text: ' / ', dim: true }, { text: short(g.avg_loss ?? 0, c), color: LOSS }],
      },
    ]),
  )
  if (!g.money.ok) lines.push([{ text: `  money figures unknown: ${g.money.why ?? ''}`, color: 'warning' }])
  lines.push([])

  // cumulative P&L: a line chart in braille dots, green above zero, red below
  if (g.equity.length > 0) {
    const last = g.equity[g.equity.length - 1]?.cum ?? 0
    lines.push([{ text: 'Daily net cumulative P&L', bold: true }, { text: `  ${cash(last, c, true)}`, color: tone(last) }])
    lines.push(...curveLines([0, ...g.equity.map(p => p.cum)], c, g.equity[0]?.at ?? '', g.equity[g.equity.length - 1]?.at ?? ''))
    lines.push([])
  }

  // net P&L per day
  if (g.by_day.length > 0) {
    lines.push([{ text: 'Net daily P&L', bold: true }])
    const max = Math.max(...g.by_day.map(d => Math.abs(d.net ?? d.n)), 1)
    for (const d of g.by_day.slice(-10)) {
      const cells = Math.max(1, Math.round((Math.abs(d.net ?? d.n) / max) * 30))
      lines.push([
        { text: `  ${d.date.slice(5)}  `, dim: true },
        { text: '█'.repeat(cells), color: tone(d.net) ?? ACCENT },
        { text: `${' '.repeat(31 - cells)}${cash(d.net, c, true)}`, color: tone(d.net) },
        { text: `  ${d.n} trades · ${percent(d.win_rate)}`, dim: true },
      ])
    }
    lines.push([])
  }

  // symbols, long/short, hours
  const best = g.best_symbol
  lines.push([
    { text: 'Performance by symbol', bold: true },
    { text: '  best', dim: true },
    ...(best === null ? [{ text: '–' }] : [{ text: ` ${best.symbol} ` }, { text: cash(best.net, c, true), color: tone(best.net) }]),
  ])
  const symbolMax = Math.max(...g.by_symbol.map(s => Math.abs(s.net ?? s.n)), 1)
  for (const s of g.by_symbol.slice(0, 6)) {
    const cells = Math.max(1, Math.round((Math.abs(s.net ?? s.n) / symbolMax) * 30))
    lines.push([
      { text: `  ${pad(s.symbol, 10)}` },
      { text: '█'.repeat(cells), color: tone(s.net) ?? ACCENT },
      { text: `${' '.repeat(31 - cells)}${cash(s.net, c, true)}`, color: tone(s.net) },
      { text: `  ${s.n} trades · ${percent(s.win_rate)}`, dim: true },
    ])
  }
  lines.push([])

  lines.push([{ text: 'Trade time performance', bold: true }, { text: '  net P&L by hour opened', dim: true }])
  const hours = g.by_hour.filter(h => h.n > 0)
  const hourMax = Math.max(...hours.map(h => Math.abs(h.net ?? h.n)), 1)
  for (const h of hours) {
    const cells = Math.max(1, Math.round((Math.abs(h.net ?? h.n) / hourMax) * 30))
    lines.push([
      { text: `  ${String(h.hour).padStart(2, '0')}:00     `, dim: true },
      { text: '█'.repeat(cells), color: tone(h.net) ?? ACCENT },
      { text: `${' '.repeat(31 - cells)}${cash(h.net, c, true)}`, color: tone(h.net) },
      { text: `  ${h.n} trades · ${percent(h.win_rate)}`, dim: true },
    ])
  }
  lines.push([])
  lines.push([{ text: 'Long vs short', bold: true }])
  for (const side of ['buy', 'sell'] as const) {
    const t = g.by_side[side]
    lines.push([
      { text: `  ${pad(side === 'buy' ? 'long' : 'short', 10)}` },
      ...split(t.wins, t.losses, 20),
      { text: `  ${pad(percent(t.win_rate), 5)}`, bold: true },
      { text: ` ${pad(`${t.n} trades`, 11)}`, dim: true },
      { text: cash(t.net, c, true), color: tone(t.net) },
    ])
  }
  lines.push([])

  lines.push([
    { text: '  largest win ', dim: true },
    { text: cash(g.largest_win, c, true), color: PROFIT },
    { text: '   largest loss ', dim: true },
    { text: cash(g.largest_loss, c, true), color: LOSS },
    { text: `   avg hold  winners ${hold(g.avg_hold_win)} · losers ${hold(g.avg_hold_loss)}`, dim: true },
  ])
  return lines
}

// --- the dashboard as SVG (desktop, editor, mobile) -------------------------

const DASH_STYLE =
  `text{font:13px ${FONT};fill:#1b1d29}` +
  '.card{fill:#ffffff;stroke:#e6e7ee}.t{font-size:13px;font-weight:600;fill:#5b5f72}.v{font-size:26px;font-weight:700;letter-spacing:-.02em}' +
  '.s{font-size:12px;fill:#8a8fa3}.a{font-size:11px;fill:#8a8fa3}.n{font-variant-numeric:tabular-nums}.b{font-weight:600}' +
  '.grid{stroke:#eef0f4}.zero{stroke:#c9ccd6}.track{fill:#eceef3}.trk{stroke:#eceef3}.pill{fill:#f1edff}.pt{fill:#7c5cff;font-size:11px;font-weight:600}' +
  '.up{fill:#22c55e}.dn{fill:#ef4444}.uS{stroke:#22c55e}.dS{stroke:#ef4444}.ut{fill:#16a34a}.dt{fill:#dc2626}.gr{fill:#c9ccd6}' +
  'g.hov:hover .hl{opacity:.75}' +
  '@media (prefers-color-scheme:dark){text{fill:#e9eaf0}.card{fill:#171a22;stroke:#262a35}.t{fill:#a4a9bb}.s,.a{fill:#7d8296}' +
  '.grid{stroke:#232733}.zero{stroke:#3a3f4d}.track{fill:#262b36}.trk{stroke:#262b36}.pill{fill:#2a2346}.pt{fill:#a891ff}' +
  '.up{fill:#2fd06f}.dn{fill:#f25c5c}.uS{stroke:#2fd06f}.dS{stroke:#f25c5c}.ut{fill:#34d399}.dt{fill:#f87171}.gr{fill:#4a4f5e}}'

// Points on a circle (deg: 180 = left, 0 = right, measured upwards)
const polar = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)] as const

const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${Math.abs(from - to) > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

// A semicircle gauge: green for the good share from the left, red for the bad share from the right.
function gauge(cx: number, cy: number, good: number, bad: number, neutral = 0): string {
  const total = good + bad + neutral
  const r = 26
  const w = 7
  const parts: string[] = [`<path d="${arc(cx, cy, r, 180, 0)}" class="trk" stroke-width="${w}" fill="none" stroke-linecap="round"/>`]
  if (total > 0) {
    const g = (good / total) * 180
    const b = (bad / total) * 180
    if (good > 0) parts.push(`<path d="${arc(cx, cy, r, 180, 180 - g)}" class="uS" stroke-width="${w}" fill="none" stroke-linecap="round"/>`)
    if (bad > 0) parts.push(`<path d="${arc(cx, cy, r, b, 0)}" class="dS" stroke-width="${w}" fill="none" stroke-linecap="round"/>`)
  }
  parts.push(
    `<text x="${cx - r}" y="${cy + 20}" class="a n ut" text-anchor="middle">${good}</text>` +
      (neutral > 0 ? `<text x="${cx}" y="${cy + 20}" class="a n" text-anchor="middle">${neutral}</text>` : '') +
      `<text x="${cx + r}" y="${cy + 20}" class="a n dt" text-anchor="middle">${bad}</text>`,
  )
  return parts.join('')
}

// A ring: green share of the circle (gross profit), red for the rest.
function ring(cx: number, cy: number, good: number, bad: number): string {
  const r = 22
  const total = good + bad
  const parts = [`<circle cx="${cx}" cy="${cy}" r="${r}" class="trk" stroke-width="7" fill="none"/>`]
  if (total > 0) {
    const circumference = 2 * Math.PI * r
    const g = (good / total) * circumference
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" class="dS" stroke-width="7" fill="none"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" class="uS" stroke-width="7" fill="none" stroke-dasharray="${g.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    )
  }
  return parts.join('')
}

// The dashboard is laid out at its own width, one column, for a pane beside
// the transcript; the surface scales it to the pane's width as an image.
const W = 640
const GAP = 12
const PAD = 18

function dashboardSvg(g: Group): { source: string; alt: string } {
  const c = g.currency
  const out: string[] = []
  let y = 0
  const card = (x: number, top: number, w: number, h: number, title: string) =>
    out.push(`<rect x="${x + 0.5}" y="${top + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" class="card"/><text x="${x + PAD}" y="${top + 28}" class="t">${xml(title)}</text>`)
  const valueTone = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? ' ut' : ' dt')
  const right = (x: number, top: number, w: number, text: string) =>
    out.push(`<text x="${x + w - PAD}" y="${top + 28}" class="a" text-anchor="end">${text}</text>`)

  // --- KPI cards: three, then two
  {
    const kh = 112
    const w3 = (W - 2 * GAP) / 3
    const w2 = (W - GAP) / 2
    const daysWon = g.by_day.filter(d => (d.net ?? d.wins - d.losses) > 0).length
    const grossWin = g.avg_win === null ? 0 : g.avg_win * g.wins
    const grossLoss = g.avg_loss === null ? 0 : Math.abs(g.avg_loss) * g.losses

    let x = 0
    card(x, y, w3, kh, 'Net P&L')
    out.push(`<rect x="${x + 82}" y="${y + 14}" width="${String(g.closed).length * 7 + 14}" height="20" rx="10" class="pill"/><text x="${x + 89}" y="${y + 28}" class="pt n">${g.closed}</text>`)
    out.push(`<text x="${x + PAD}" y="${y + 74}" class="v n${valueTone(g.net)}">${xml(cash(g.net, c))}</text>`)
    out.push(`<text x="${x + PAD}" y="${y + 96}" class="s">${g.closed} closed${g.open ? ` · ${g.open} open` : ''}</text>`)

    x = w3 + GAP
    card(x, y, w3, kh, 'Trade win %')
    out.push(`<text x="${x + PAD}" y="${y + 74}" class="v n">${percent(g.win_rate)}</text>`)
    out.push(gauge(x + w3 - 48, y + 74, g.wins, g.losses, g.breakeven))

    x = 2 * (w3 + GAP)
    card(x, y, w3, kh, 'Profit factor')
    out.push(`<text x="${x + PAD}" y="${y + 74}" class="v n">${ratio(g.profit_factor)}</text>`)
    out.push(ring(x + w3 - 44, y + 68, grossWin, grossLoss))

    y += kh + GAP
    x = 0
    card(x, y, w2, kh, 'Day win %')
    out.push(`<text x="${x + PAD}" y="${y + 74}" class="v n">${percent(g.day_win_rate)}</text>`)
    out.push(`<text x="${x + PAD}" y="${y + 96}" class="s">${daysWon} of ${g.by_day.length} days in profit</text>`)
    out.push(gauge(x + w2 - 56, y + 74, daysWon, g.by_day.length - daysWon))

    x = w2 + GAP
    card(x, y, w2, kh, 'Avg win/loss trade')
    out.push(`<text x="${x + PAD}" y="${y + 68}" class="v n">${ratio(g.rrr)}</text>`)
    const bw = w2 - 2 * PAD
    const total = (g.avg_win ?? 0) + Math.abs(g.avg_loss ?? 0)
    const gw = total === 0 ? bw / 2 : ((g.avg_win ?? 0) / total) * bw
    out.push(
      `<rect x="${x + PAD}" y="${y + 80}" width="${Math.max(0, gw - 1)}" height="6" rx="3" class="up"/>` +
        `<rect x="${x + PAD + gw + 1}" y="${y + 80}" width="${Math.max(0, bw - gw - 1)}" height="6" rx="3" class="dn"/>` +
        `<text x="${x + PAD}" y="${y + 102}" class="a n ut">avg win ${xml(cash(g.avg_win, c))}</text>` +
        `<text x="${x + w2 - PAD}" y="${y + 102}" class="a n dt" text-anchor="end">avg loss ${xml(cash(g.avg_loss, c))}</text>`,
    )
    y += kh + GAP
  }

  // A plot area inside a full-width card, with y-axis labels and grid lines.
  const plotCard = (title: string, h: number, lo: number, hi: number) => {
    card(0, y, W, h, title)
    const plot = { left: 58, right: W - PAD, top: y + 48, bottom: y + h - 34 }
    const scale = axis(lo, hi)
    const yOf = (v: number) => plot.bottom - ((v - scale.min) / (scale.max - scale.min)) * (plot.bottom - plot.top)
    for (const v of scale.values) {
      out.push(`<path d="M${plot.left} ${yOf(v).toFixed(1)}H${plot.right}" class="${v === 0 ? 'zero' : 'grid'}" stroke-width="1"/>`)
      out.push(`<text x="${plot.left - 8}" y="${(yOf(v) + 4).toFixed(1)}" class="a n" text-anchor="end">${xml(short(v, c))}</text>`)
    }
    return { plot, yOf }
  }

  // --- cumulative P&L
  if (g.equity.length > 0) {
    const values = [0, ...g.equity.map(p => p.cum)]
    const h = 250
    const top = y
    const { plot, yOf } = plotCard('Daily net cumulative P&L', h, Math.min(...values), Math.max(...values))
    const last = values[values.length - 1] ?? 0
    out.push(`<text x="${W - PAD}" y="${top + 28}" class="n b${valueTone(last)}" text-anchor="end">${xml(cash(last, c, true))}</text>`)
    const xOf = (i: number) => plot.left + (i / Math.max(1, values.length - 1)) * (plot.right - plot.left)
    const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join('')
    const zero = yOf(0)
    const area = `${line}L${xOf(values.length - 1).toFixed(1)} ${zero.toFixed(1)}L${xOf(0).toFixed(1)} ${zero.toFixed(1)}Z`
    out.push(
      `<defs><clipPath id="above"><rect x="0" y="${plot.top - 10}" width="${W}" height="${(zero - plot.top + 10).toFixed(1)}"/></clipPath>` +
        `<clipPath id="below"><rect x="0" y="${zero.toFixed(1)}" width="${W}" height="${(plot.bottom - zero + 10).toFixed(1)}"/></clipPath>` +
        `<linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".35"/><stop offset="1" stop-color="#22c55e" stop-opacity=".02"/></linearGradient>` +
        `<linearGradient id="gDn" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ef4444" stop-opacity=".35"/><stop offset="1" stop-color="#ef4444" stop-opacity=".02"/></linearGradient></defs>`,
      `<path d="${area}" fill="url(#gUp)" clip-path="url(#above)"/><path d="${area}" fill="url(#gDn)" clip-path="url(#below)"/>`,
      `<path d="${line}" class="uS" fill="none" stroke-width="2.5" stroke-linejoin="round" clip-path="url(#above)"/>`,
      `<path d="${line}" class="dS" fill="none" stroke-width="2.5" stroke-linejoin="round" clip-path="url(#below)"/>`,
    )
    if (g.equity.length <= 60) {
      g.equity.forEach((p, i) => out.push(`<circle cx="${xOf(i + 1).toFixed(1)}" cy="${yOf(p.cum).toFixed(1)}" r="3" class="${p.cum >= 0 ? 'up' : 'dn'}"/>`))
    }
    const marks = [...new Set([0, Math.floor((g.equity.length - 1) / 2), g.equity.length - 1])]
    for (const i of marks) {
      const at = g.equity[i]?.at ?? ''
      const anchor = i === 0 ? 'start' : i === g.equity.length - 1 ? 'end' : 'middle'
      out.push(`<text x="${xOf(i + 1).toFixed(1)}" y="${plot.bottom + 22}" class="a n" text-anchor="${anchor}">${at.slice(5, 7)}/${at.slice(8, 10)}</text>`)
    }
    y += h + GAP
  }

  // --- net P&L per day
  if (g.by_day.length > 0) {
    const days = g.by_day.slice(-20)
    const nets = days.map(d => d.net ?? 0)
    const h = 220
    const { plot, yOf } = plotCard('Net daily P&L', h, Math.min(...nets), Math.max(...nets))
    const slot = (plot.right - plot.left) / days.length
    const bw = Math.min(34, slot * 0.62)
    const every = Math.ceil(days.length / 8) // at most 8 date labels
    days.forEach((d, i) => {
      const cx = plot.left + slot * (i + 0.5)
      const v = d.net ?? 0
      const [top, bottom] = v >= 0 ? [yOf(v), yOf(0)] : [yOf(0), yOf(v)]
      out.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bottom - top).toFixed(1)}" rx="4" class="${v < 0 ? 'dn' : 'up'}"/>`)
      if (i % every === 0) out.push(`<text x="${cx.toFixed(1)}" y="${plot.bottom + 22}" class="a n" text-anchor="middle">${d.date.slice(5, 7)}/${d.date.slice(8, 10)}</text>`)
    })
    y += h + GAP
  }

  // --- performance by symbol: a row per symbol, net from a zero line
  {
    const rows = g.by_symbol.slice(0, 8)
    const h = 52 + rows.length * 40
    card(0, y, W, h, 'Performance by symbol')
    if (g.best_symbol) right(0, y, W, `best <tspan class="b">${xml(g.best_symbol.symbol)}</tspan>`)
    const max = Math.max(...rows.map(s => Math.abs(s.net ?? s.n)), 1)
    const hasNeg = rows.some(s => (s.net ?? 0) < 0)
    const [lx, rx] = [150, W - 130]
    const zero = hasNeg ? (lx + rx) / 2 : lx
    const scale = (hasNeg ? (rx - lx) / 2 : rx - lx) / max
    rows.forEach((s, i) => {
      const ry = y + 50 + i * 40
      const v = s.net ?? s.n
      const w = Math.max(3, Math.abs(v) * scale)
      out.push(
        `<text x="${PAD}" y="${ry + 13}" class="b">${xml(s.symbol)}</text>` +
          `<text x="${PAD}" y="${ry + 29}" class="a">${s.n} trades · ${percent(s.win_rate)} win</text>` +
          `<rect x="${(v >= 0 ? zero : zero - w).toFixed(1)}" y="${ry + 6}" width="${w.toFixed(1)}" height="14" rx="4" class="${(s.net ?? 0) < 0 ? 'dn' : 'up'}"/>` +
          `<text x="${W - PAD}" y="${ry + 18}" class="n b${valueTone(s.net)}" text-anchor="end">${xml(cash(s.net, c, true))}</text>`,
      )
    })
    y += h + GAP
  }

  // --- trade time performance: net P&L per hour opened, 24 columns around zero
  {
    const h = 200
    card(0, y, W, h, 'Trade time performance')
    const best = [...g.by_hour].filter(t => t.n > 0).sort((a, b) => (b.net ?? b.n) - (a.net ?? a.n))[0]
    if (best) right(0, y, W, `best <tspan class="b">${String(best.hour).padStart(2, '0')}:00</tspan> · net P&amp;L by hour opened`)
    const nets = g.by_hour.map(t => t.net ?? t.n)
    const max = Math.max(...nets.map(Math.abs), 1)
    const [x0, x1] = [PAD, W - PAD]
    const [top, bottom] = [y + 48, y + h - 34]
    const hasNeg = nets.some(n => n < 0)
    const zero = hasNeg ? (top + bottom) / 2 : bottom
    const scale = (hasNeg ? (bottom - top) / 2 : bottom - top) / max
    const slot = (x1 - x0) / 24
    out.push(`<path d="M${x0} ${zero.toFixed(1)}H${x1}" class="zero" stroke-width="1"/>`)
    g.by_hour.forEach(t => {
      const v = t.net ?? t.n
      const bx = x0 + t.hour * slot
      const bh = Math.abs(v) * scale
      if (t.n > 0) {
        out.push(`<rect x="${(bx + 2).toFixed(1)}" y="${(v >= 0 ? zero - bh : zero).toFixed(1)}" width="${(slot - 4).toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" rx="3" class="${v < 0 ? 'dn' : 'up'}"/>`)
      }
      if (t.hour % 3 === 0) out.push(`<text x="${(bx + slot / 2).toFixed(1)}" y="${bottom + 22}" class="a n" text-anchor="middle">${String(t.hour).padStart(2, '0')}</text>`)
    })
    y += h + GAP
  }

  // --- long vs short, side by side
  {
    const h = 128
    const w2 = (W - GAP) / 2
    ;(['buy', 'sell'] as const).forEach((side, i) => {
      const t = g.by_side[side]
      const x = i * (w2 + GAP)
      card(x, y, w2, h, side === 'buy' ? 'Long' : 'Short')
      right(x, y, w2, `${t.n} trades`)
      const bw = w2 - 2 * PAD
      out.push(
        `<text x="${x + PAD}" y="${y + 66}" class="v n${valueTone(t.net)}" style="font-size:22px">${xml(cash(t.net, c, true))}</text>` +
          `<rect x="${x + PAD}" y="${y + 82}" width="${bw}" height="8" rx="4" class="track"/>` +
          (t.wins > 0 ? `<rect x="${x + PAD}" y="${y + 82}" width="${((t.wins / t.n) * bw).toFixed(1)}" height="8" rx="4" class="up"/>` : '') +
          (t.losses > 0 ? `<rect x="${(x + PAD + bw - (t.losses / t.n) * bw).toFixed(1)}" y="${y + 82}" width="${((t.losses / t.n) * bw).toFixed(1)}" height="8" rx="4" class="dn"/>` : '') +
          `<text x="${x + PAD}" y="${y + 110}" class="a">win rate <tspan class="b">${percent(t.win_rate)}</tspan> · ${t.wins}W ${t.losses}L</text>`,
      )
    })
    y += h + GAP
  }

  // --- extremes, two by two
  {
    const h = 84
    const w2 = (W - GAP) / 2
    const stats: [string, string, string][] = [
      ['Largest win', cash(g.largest_win, c, true), ' ut'],
      ['Largest loss', cash(g.largest_loss, c, true), ' dt'],
      ['Avg hold · winners', hold(g.avg_hold_win), ''],
      ['Avg hold · losers', hold(g.avg_hold_loss), ''],
    ]
    stats.forEach(([title, value, cls], i) => {
      const x = (i % 2) * (w2 + GAP)
      const top = y + Math.floor(i / 2) * (h + GAP)
      card(x, top, w2, h, title)
      out.push(`<text x="${x + PAD}" y="${top + 64}" class="n b${cls}" style="font-size:20px">${xml(value)}</text>`)
    })
    y += 2 * h + GAP
  }

  const height = Math.ceil(y)
  const alt =
    `${g.label}: net P&L ${cash(g.net, c)}, trade win ${percent(g.win_rate)}, profit factor ${ratio(g.profit_factor)}, ` +
    `day win ${percent(g.day_win_rate)}, average win/loss ${ratio(g.rrr)} (${cash(g.avg_win, c)} / ${cash(g.avg_loss, c)}), ` +
    `best symbol ${g.best_symbol?.symbol ?? '–'}, long ${g.by_side.buy.n} trades ${percent(g.by_side.buy.win_rate)}, ` +
    `short ${g.by_side.sell.n} trades ${percent(g.by_side.sell.win_rate)}, ` +
    `busiest hours: ${[...g.by_hour].sort((a, b) => b.n - a.n).filter(t => t.n > 0).slice(0, 3).map(t => `${t.hour}:00 (${t.n})`).join(', ')}`
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">` +
    `<style>${DASH_STYLE}</style>${out.join('')}</svg>`
  return { source, alt }
}

// --- the mascot --------------------------------------------------------------

const rectsOf = (svg: string) => [...svg.matchAll(/<rect [^>]*>/g)].map(([tag]) => tag)

// The mascot (pixel art on a 10px grid, on a rounded tile) as text: two pixel
// rows per line with half blocks, the tile cropped to one pixel around the
// drawing with its corners cut.
function mascotText(svg: string): Segment[][] {
  const attr = (tag: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
  const pixel = new Map<string, string>()
  let bg: string | undefined
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1]

  for (const tag of rectsOf(svg)) {
    const fill = attr(tag, 'fill')?.toLowerCase()
    if (fill === undefined || !/^#[0-9a-f]{6}$/.test(fill)) continue
    if (Number(attr(tag, 'rx') ?? 0) > 0) {
      bg = fill
      continue
    }
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(n => Number(attr(tag, n) ?? 0) / 10) as [number, number, number, number]
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (fill === bg) pixel.delete(`${i},${j}`)
        else pixel.set(`${i},${j}`, fill)
      }
    }
    if (fill === bg) continue
    ;[minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x + w - 1), Math.max(maxY, y + h - 1)]
  }
  if (maxX < 0) return []

  const p = bg === undefined ? 0 : 1
  const [x0, x1, y0] = [minX - p, maxX + p, minY - p]
  let y1 = maxY + p
  if ((y1 - y0 + 1) % 2 === 1) y1++

  const colourAt = (i: number, j: number) => {
    const own = pixel.get(`${i},${j}`)
    if (own !== undefined || bg === undefined) return own
    if ((i === x0 || i === x1) && (j === y0 || j === y1)) return undefined
    if (j > maxY + p) return undefined
    return bg
  }

  const lines: Segment[][] = []
  for (let j = y0; j <= y1; j += 2) {
    const line: Segment[] = []
    for (let i = x0; i <= x1; i++) {
      const top = colourAt(i, j)
      const bottom = colourAt(i, j + 1)
      if (top !== undefined) line.push({ text: '▀', color: top, bg: bottom })
      else if (bottom !== undefined) line.push({ text: '▄', color: bottom })
      else line.push({ text: ' ' })
    }
    lines.push(line)
  }
  return lines
}

// The logo: the SVG itself where the surface draws SVG (assets/mascot.svg); in
// a terminal that shows pictures (kitty, Ghostty) the same logo as a PNG
// (assets/mascot.png); elsewhere a small pixel rocket in half blocks
// (assets/mascot-pixels.svg), since such a terminal only has text cells.
async function loadMascot($: EngineInterface) {
  if (mascotSvg !== undefined) return
  mascotSvg = await $.fs.read(`${$.plugin.root}/assets/mascot.svg`).catch(() => '')
  mascotPng = await $.fs.read(`${$.plugin.root}/assets/mascot.png`, { as: 'bytes' }).then(b => b.base64).catch(() => '')
  const pixels = await $.fs.read(`${$.plugin.root}/assets/mascot-pixels.svg`).catch(() => '')
  mascotLines = pixels === '' ? [] : mascotText(pixels)
  const program = await $.env.get('TERM_PROGRAM')
  const term = await $.env.get('TERM')
  const kitty = await $.env.get('KITTY_WINDOW_ID')
  canShowImages = /ghostty/i.test(program ?? '') || /kitty/i.test(term ?? '') || kitty !== undefined
}

// --- state -------------------------------------------------------------------

async function poll($: EngineInterface) {
  home ??= (await $.env.get('ROCKET_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.config/rocket`

  const id = (await $.fs.read(`${home}/current`).catch(() => '')).trim()
  if (id === '') return

  const text = await $.fs.read(`${home}/runs/${id}/status.json`).catch(() => '')
  if (text === '') return

  if (text !== raw) {
    try {
      run = JSON.parse(text) as Run
      raw = text
    } catch {
      return // caught mid-write; the next tick reads it whole
    }
  }

  // The charts replace the pipeline once the run finished with success.
  if (run?.status === 'success' && statsFor !== run.id) {
    const json = await $.fs.read(`${home}/runs/${id}/stats.json`).catch(() => '')
    try {
      const parsed = json === '' ? undefined : (JSON.parse(json) as Stats)
      // stats.json of an older version lacks the newer fields
      stats = parsed && {
        ...parsed,
        groups: parsed.groups.map(g => ({
          ...g,
          by_day: g.by_day ?? [],
          equity: g.equity ?? [],
          day_win_rate: g.day_win_rate ?? null,
          largest_win: g.largest_win ?? null,
          largest_loss: g.largest_loss ?? null,
          avg_hold_win: g.avg_hold_win ?? null,
          avg_hold_loss: g.avg_hold_loss ?? null,
        })),
      }
      statsFor = run.id
    } catch {
      stats = undefined
    }
  }
  if (run?.status !== 'success') stats = undefined

  if (run?.status === 'running' && openedFor !== run.id) {
    openedFor = run.id
    void $.ui.open({ id: PANE, title: TITLE })
  }

  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadMascot($)
    await $.command.register({
      name: 'rocket-pane',
      description: 'Show the Trading Rocket pane (pipeline or charts of the last run)',
    })

    let tick = 0
    $.clock.every(TICK_MS, async () => {
      tick++
      const isRunning = run?.status === 'running'
      if (isRunning) frame++
      if (isRunning || tick % IDLE_EVERY === 0) await poll($)
    })

    return next(e)
  })

  on('command.run', { command: 'rocket-pane' }, async $ => {
    await poll($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return { text: 'Trading Rocket pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await loadMascot($)
    const nowMs = await $.clock.now()
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    // The terminal has no Svg element; elsewhere text is proportional, so the
    // pipeline and the charts are drawn as SVG there.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined

    const line = (segments: Segment[]) => (
      <Box flexDirection="row">
        {segments.length === 0 ? <Text> </Text> : segments.map(s => (
          <Text color={s.color} backgroundColor={s.bg} dimColor={s.dim} bold={s.bold} wrap="truncate">
            {s.text}
          </Text>
        ))}
      </Box>
    )

    // The mascot slot, top left, with the header lines beside it.
    const withMascot = (beside: Segment[][]) => {
      if (Svg !== undefined && mascotSvg) {
        return (
          <Box flexDirection="row">
            <Svg source={mascotSvg} alt="Trading Rocket mascot" width={72} height={72} />
            <Box flexDirection="column" marginLeft={3} justifyContent="center">{beside.map(line)}</Box>
          </Box>
        )
      }
      if (canShowImages && mascotPng !== '' && 'Image' in elements) {
        const { Image } = elements
        return (
          <Box flexDirection="row">
            <Image source={{ png: mascotPng }} columns={MASCOT_CELLS.columns} rows={MASCOT_CELLS.rows} alt=" " />
            <Box flexDirection="column" marginLeft={3} justifyContent="center">{beside.map(line)}</Box>
          </Box>
        )
      }
      if (mascotLines.length === 0) return <Box flexDirection="column">{beside.map(line)}</Box>
      const height = Math.max(mascotLines.length, beside.length)
      const top = Math.floor((height - beside.length) / 2)
      const width = mascotLines[0]?.length ?? 0
      const rows = Array.from({ length: height }, (_, i) => [
        ...(mascotLines[i] ?? [{ text: ' '.repeat(width) }]),
        { text: '   ' },
        ...(beside[i - top] ?? []),
      ])
      return <Box flexDirection="column">{rows.map(line)}</Box>
    }

    const brand: Segment = { text: '◆ trading rocket', color: ACCENT, bold: true }

    if (run === undefined) {
      return withMascot([[brand], [{ text: 'no analysis yet · start one with /rocket:analyse', dim: true }]])
    }

    const current = run
    const now = Math.floor(nowMs / 1000)
    const elapsed = (current.finished_at ?? now) - current.started_at

    // Charts: the run is done and its numbers are in.
    if (stats !== undefined && stats.groups.length > 0) {
      const [main, ...rest] = stats.groups as [Group, ...Group[]]
      const accounts = main.id === 'all' ? rest : []
      return (
        <Box flexDirection="column">
          {withMascot([
            [brand, { text: ' · ', dim: true }, { text: period(stats.range) }, { text: ` · ${main.label}`, dim: true }],
            [
              { text: `${main.trades} trades`, bold: true },
              { text: ` · ${main.open} open · ${main.failed} failed orders`, dim: true },
              { text: ' · P/L is an estimate without commission and swap', dim: true },
            ],
          ])}
          <Text> </Text>
          {Svg !== undefined ? <Svg {...dashboardSvg(main)} /> : dashboardLines(main).map(line)}
          {accounts.length > 0 && <Text> </Text>}
          {accounts.map(a =>
            line([
              { text: `  ${pad(a.label, 34)} `, dim: true },
              { text: pad(`${a.closed} trades`, 11) },
              { text: pad(`${percent(a.win_rate)} win`, 10) },
              { text: pad(`RRR ${ratio(a.rrr)}`, 10) },
              { text: money(a.net, a.currency), color: tone(a.net) },
            ]),
          )}
          {current.summary !== '' && <Text> </Text>}
          {current.summary !== '' && line([{ text: current.summary, bold: true }])}
        </Box>
      )
    }

    // The pipeline: while the run works, and when it ended without charts.
    const footer = current.stages
      .flatMap(stage => stage.jobs)
      .flatMap(id => {
        const job = current.jobs[id]
        return job === undefined ? [] : [{ id, job }]
      })
      .filter(({ job }) => job.note !== '' && !['pending', 'skipped'].includes(job.status))
    const running = footer.find(({ job }) => job.status === 'running')
    const headline =
      current.status !== 'running' ? current.summary || current.status : running ? `${running.id}: ${running.job.note}` : current.status

    return (
      <Box flexDirection="column">
        {withMascot([
          [
            brand,
            { text: ' · ', dim: true },
            { text: period(current.range) },
            ...(current.accounts?.length ? [{ text: ` · ${accountsLabel(current.accounts)}` }] : []),
            { text: ` · ${clock(elapsed)}`, dim: true },
          ],
          [
            { text: current.status === 'running' ? (SPINNER[frame % SPINNER.length] ?? '◐') : ICON[current.status], color: runColor(current.status) },
            { text: ` ${headline}` },
          ],
        ])}
        <Text> </Text>
        {Svg !== undefined ? <Svg {...pipelineSvg(current, now)} /> : grid(current, now).map(line)}
        <Text> </Text>
        {footer.map(({ id, job }) =>
          line([{ text: `${iconOf(job.status)} ${id}`, color: COLOR[job.status] }, { text: `  ${job.note}` }]),
        )}
        {current.notes.slice(-4).map(note => line([{ text: `› ${note.text}`, dim: true }]))}
      </Box>
    )
  })
}
