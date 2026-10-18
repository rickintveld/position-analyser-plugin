import type { Account, Event, Exit, Failed, Side, Trade, Trades } from './types'

// Rebuilds trades from the events of events.ts (all terminals).
//
// A deal is a close when it matches a pending close (a "close #N" request or an
// SL/TP/stop out trigger) of the same account, side, symbol and volume, first
// come first served; otherwise it opens position #<order>. Positions are tracked
// per terminal; the same account seen by two terminals is merged on position id.
// `only` limits the output to those accounts (empty: all); `seen` lists every
// account in the period, so a caller can tell an unknown account number.

type Options = { from: string; to: string; contracts: Record<string, number>; only: string[] }

// half away from zero, as the first (jq) version rounded
const roundTo = (x: number | null, digits: number) => {
  if (x === null) return null
  const f = 10 ** digits
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f
}
export const round2 = (x: number | null) => roundTo(x, 2)
const round5 = (x: number | null) => roundTo(x, 5)

type Open = Omit<Trade, 'n' | 'status' | 'close_at' | 'exit' | 'closed_by' | 'move' | 'contract' | 'contract_source' | 'currency' | 'pnl' | 'r' | 'planned_rr' | 'sl_at_breakeven'> & {
  remaining: number | null
  requested: boolean
}

type Matchable = { account: string; side: Side; symbol: string; volume: number | null }
const same = (a: Matchable, b: Matchable) => a.account === b.account && a.side === b.side && a.symbol === b.symbol && a.volume === b.volume

// Contract size per lot: the user's override, else a stated default (metals,
// 6-letter FX pairs), else unknown.
const FX = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'SGD', 'HKD', 'MXN', 'ZAR', 'TRY', 'CNH']
const baseSymbol = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)

function contract(symbol: string, contracts: Record<string, number>): { size: number | null; source: Trade['contract_source'] } {
  const own = contracts[symbol] ?? contracts[baseSymbol(symbol)]
  if (own !== undefined) return { size: own, source: 'user' }
  const b = baseSymbol(symbol)
  if (b.startsWith('XAU')) return { size: 100, source: 'default' }
  if (b.startsWith('XAG')) return { size: 5000, source: 'default' }
  if (b.length === 6 && FX.includes(b.slice(0, 3)) && FX.includes(b.slice(3, 6))) return { size: 100000, source: 'default' }
  return { size: null, source: 'unknown' }
}

const quoteCurrency = (symbol: string) => {
  const b = baseSymbol(symbol)
  return b.length === 6 ? b.slice(3, 6) : null
}

type Close = Extract<Event, { type: 'close_req' | 'trigger' }>
type Deal = { at: string; price: number | null; volume: number | null; deal: string }

class Terminal {
  open = new Map<string, Open>()
  preq: Extract<Event, { type: 'open_req' }>[] = []
  pclose: Close[] = []
  trades: Open[] = []
  failed: (Failed & { terminal: number })[] = []
  accounts: Record<string, Omit<Account, 'account'>> = {}

  private closeWith(c: Close, d: Deal) {
    const key = `${c.account}/${c.position}`
    // a position opened before the logs we read: what the close request tells us
    const t: Open = this.open.get(key) ?? {
      account: c.account, position: c.position, terminal: c.terminal, symbol: c.symbol, side: c.position_side,
      volume: null, remaining: null, open_at: null, entry: c.entry, requested: true,
      sl_initial: null, tp_initial: null, sl: null, tp: null, sl_changes: 0, tp_changes: 0, levels: [], exits: [],
    }
    const exits: Exit[] = [...t.exits, { at: d.at, price: d.price, volume: d.volume, reason: c.reason, deal: d.deal }]
    const left = t.remaining === null ? 0 : (round5(t.remaining - (d.volume ?? 0)) ?? 0)
    if (left <= 0) {
      this.open.delete(key)
      this.trades.push({ ...t, exits, remaining: 0, volume: t.volume ?? exits.reduce((s, x) => s + (x.volume ?? 0), 0) })
    } else {
      this.open.set(key, { ...t, exits, remaining: left })
    }
  }

  step(e: Event) {
    switch (e.type) {
      case 'auth': {
        const own = this.accounts[e.account] ?? {}
        if (e.server !== undefined) own.server = e.server
        if (e.broker !== undefined) own.broker = e.broker
        this.accounts[e.account] = own
        return
      }
      case 'failed':
        this.failed.push({ account: e.account, terminal: e.terminal, at: e.at, text: e.text, reason: e.reason })
        return
      case 'open_req':
        this.preq.push(e)
        return
      case 'close_req':
        this.pclose.push(e)
        return
      case 'trigger': {
        // Some builds log the trigger after its deal, which then looked like an
        // unrequested opening in the same minute: take that deal back as the close.
        const loose = [...this.open.entries()].find(
          ([, t]) => !t.requested && t.exits.length === 0 && same(t, e) && (t.open_at ?? '').slice(0, 16) === e.at.slice(0, 16),
        )
        if (loose === undefined) {
          this.pclose.push(e)
        } else {
          const [key, t] = loose
          this.open.delete(key)
          this.closeWith(e, { at: t.open_at ?? e.at, price: t.entry, volume: t.volume, deal: t.position })
        }
        return
      }
      case 'modify': {
        const t = this.open.get(`${e.account}/${e.position}`)
        if (t === undefined) return
        if (e.sl !== t.sl) t.sl_changes++
        if (e.tp !== t.tp) t.tp_changes++
        t.sl_initial ??= e.sl
        t.tp_initial ??= e.tp
        t.sl = e.sl
        t.tp = e.tp
        t.levels = [...t.levels, { at: e.at, kind: 'modify', sl: e.sl, tp: e.tp }]
        return
      }
      case 'deal': {
        const ci = this.pclose.findIndex(c => same(c, e))
        if (ci >= 0) {
          const [c] = this.pclose.splice(ci, 1)
          if (c !== undefined) this.closeWith(c, e)
          return
        }
        const ri = this.preq.findIndex(r => same(r, e))
        const req = ri >= 0 ? this.preq.splice(ri, 1)[0] : undefined
        this.open.set(`${e.account}/${e.order}`, {
          account: e.account, position: e.order, terminal: e.terminal, symbol: e.symbol, side: e.side,
          volume: e.volume, remaining: e.volume, open_at: e.at, entry: e.price, requested: req !== undefined,
          sl_initial: req?.sl ?? null, tp_initial: req?.tp ?? null, sl: req?.sl ?? null, tp: req?.tp ?? null,
          sl_changes: 0, tp_changes: 0, exits: [],
          levels: req === undefined ? [] : [{ at: e.at, kind: 'open', sl: req.sl, tp: req.tp }],
        })
      }
    }
  }
}

function finish(t: Open, contracts: Record<string, number>): Omit<Trade, 'n'> {
  const sign = t.side === 'buy' ? 1 : -1
  const closed = t.exits.reduce((s, x) => s + (x.volume ?? 0), 0)
  const exit = closed === 0 ? null : t.exits.reduce((s, x) => s + (x.price ?? 0) * (x.volume ?? 0), 0) / closed
  const c = contract(t.symbol, contracts)
  const risk = t.sl_initial !== null && t.sl_initial !== 0 && t.entry !== null ? Math.abs(t.entry - t.sl_initial) : null
  const reasons = [...new Set(t.exits.map(x => x.reason))].sort()
  const isClosed = t.remaining === 0
  const last = t.exits[t.exits.length - 1]
  const { remaining: _remaining, requested: _requested, ...rest } = t
  return {
    ...rest,
    status: isClosed ? 'closed' : 'open',
    close_at: isClosed ? (last?.at ?? null) : null,
    exit: round5(exit),
    closed_by:
      t.exits.length === 0 ? null
      : t.exits.length > 1 ? `partial${isClosed ? ` → ${last?.reason ?? ''}` : ''}`
      : !isClosed ? 'partial'
      : (reasons[0] ?? null),
    move: exit === null || t.entry === null ? null : round5((exit - t.entry) * sign),
    contract: c.size,
    contract_source: c.source,
    currency: c.size === null ? null : quoteCurrency(t.symbol),
    pnl:
      c.size === null || t.entry === null || t.exits.length === 0
        ? null
        : round2(t.exits.reduce((s, x) => s + ((x.price ?? 0) - (t.entry ?? 0)) * sign * (x.volume ?? 0) * (c.size ?? 0), 0)),
    r: risk === null || risk === 0 || exit === null || t.entry === null ? null : round2(((exit - t.entry) * sign) / risk),
    planned_rr: risk === null || risk === 0 || t.tp_initial === null || t.tp_initial === 0 || t.entry === null ? null : round2(Math.abs(t.tp_initial - t.entry) / risk),
    sl_at_breakeven: t.sl === null || t.sl === 0 || t.entry === null || t.sl_changes === 0 ? false : (t.sl - t.entry) * sign >= 0,
  }
}

const byKey = <T>(key: (x: T) => string | null) => (a: T, b: T) => {
  const [x, y] = [key(a), key(b)]
  return x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const map = new Map<string, T[]>()
  for (const x of xs) map.set(key(x), [...(map.get(key(x)) ?? []), x])
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
}

export function buildTrades(events: Event[], { from, to, contracts, only }: Options): Trades {
  const inRange = (day: string | null | undefined) => {
    const d = (day ?? '').slice(0, 10)
    return d >= from && d <= to
  }
  const wanted = (account: string) => only.length === 0 || only.includes(account)

  const terminals = groupBy(events, e => String(e.terminal).padStart(6, '0')).map(list => {
    const t = new Terminal()
    for (const e of [...list].sort((a, b) => (a.at.slice(0, 10) < b.at.slice(0, 10) ? -1 : a.at.slice(0, 10) > b.at.slice(0, 10) ? 1 : a.seq - b.seq))) t.step(e)
    return { trades: [...t.trades, ...t.open.values()], failed: t.failed, accounts: t.accounts }
  })

  // The trade a terminal knows most about wins when two terminals saw it.
  const richness = (t: Open) => (t.open_at !== null ? 4 : 0) + (t.remaining === 0 ? 2 : 0) + t.exits.length / 1000
  const merged = groupBy(terminals.flatMap(t => t.trades), t => `${t.account}/${t.position}`).map(
    group => [...group].sort((a, b) => richness(a) - richness(b))[group.length - 1]!,
  )
  const inPeriod = merged
    .map(t => finish(t, contracts))
    .filter(t => inRange(t.open_at ?? t.close_at))
    .sort(byKey(t => t.open_at ?? t.close_at))

  const failedAll = terminals.flatMap(t => t.failed)
  const seen = [...new Set([...inPeriod.map(t => t.account), ...failedAll.filter(f => inRange(f.at)).map(f => f.account)])].sort()
  const trades = inPeriod.filter(t => wanted(t.account))
  const known: Record<string, Omit<Account, 'account'>> = Object.assign({}, ...terminals.map(t => t.accounts))

  // a failure two terminals both logged counts once: per line, the most any terminal saw
  const failed = groupBy(failedAll, f => JSON.stringify([f.account, f.at, f.text]))
    .flatMap(group => {
      const perTerminal = groupBy(group, f => String(f.terminal).padStart(6, '0'))
      return perTerminal.reduce((best, g) => (g.length >= best.length ? g : best), [] as typeof group)
    })
    .map(({ terminal: _terminal, ...f }) => f)
    .filter(f => inRange(f.at) && wanted(f.account))
    .sort(byKey(f => f.at))

  return {
    range: { from, to },
    only,
    seen,
    accounts: [...new Set([...trades.map(t => t.account), ...failed.map(f => f.account)])].sort().map(a => ({ account: a, ...(known[a] ?? {}) })),
    trades: trades.map((t, i) => ({ ...t, n: i + 1 })),
    failed,
  }
}
