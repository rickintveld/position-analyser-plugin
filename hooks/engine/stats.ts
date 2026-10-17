import { round2 } from './trades'
import type { Group, Stats, Tally, Trade, Trades } from './types'

// The numbers the report and the charts show, from trades.ts.
//
// One group per account, plus "all" when there is more than one account.
// Win/loss comes from the price move, so it is known for every closed trade;
// money figures (net, average win/loss, RRR, P/L per symbol, hour and side)
// only when every closed trade of the group has a P/L in one and the same
// currency, otherwise they are null and `money.why` says why.

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const avg = (xs: (number | null)[]) => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length === 0 ? null : sum(ok) / ok.length
}
const pct = (part: number, whole: number) => (whole === 0 ? null : round2((part * 100) / whole))
const pnl = (t: Trade) => t.pnl ?? 0
const day = (t: Trade) => (t.close_at ?? t.open_at ?? '').slice(0, 10)
const seconds = (at: string) => Date.UTC(+at.slice(0, 4), +at.slice(5, 7) - 1, +at.slice(8, 10), +at.slice(11, 13), +at.slice(14, 16), +at.slice(17, 19)) / 1000
const held = (t: Trade) => (t.open_at === null || t.close_at === null ? null : seconds(t.close_at) - seconds(t.open_at))

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const map = new Map<string, T[]>()
  for (const x of xs) map.set(key(x), [...(map.get(key(x)) ?? []), x])
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

// Wins, losses and P/L of a set of closed trades; `money` tells whether P/L counts.
const tally = (trades: Trade[], money: boolean): Tally => {
  const wins = trades.filter(t => (t.move ?? 0) > 0).length
  return {
    n: trades.length,
    wins,
    losses: trades.filter(t => (t.move ?? 0) < 0).length,
    net: money ? round2(sum(trades.map(pnl))) : null,
    win_rate: pct(wins, trades.length),
  }
}

function group(id: string, label: string, trades: Trade[], failed: number): Group {
  const closed = trades.filter(t => t.status === 'closed' && t.move !== null)
  const currencies = [...new Set(closed.map(t => t.currency))]
  const unknown = [...new Set(closed.filter(t => t.pnl === null).map(t => t.symbol))].sort()
  const money: Group['money'] =
    closed.length === 0 ? { ok: false, why: 'no closed trades' }
    : unknown.length > 0 ? { ok: false, why: `contract size unknown for ${unknown.join(', ')}` }
    : currencies.length > 1 ? { ok: false, why: `several currencies: ${currencies.map(c => c ?? '').sort().join(', ')}` }
    : { ok: true, currency: currencies[0] ?? null }
  const ok = money.ok
  const wins = closed.filter(t => (t.move ?? 0) > 0)
  const losses = closed.filter(t => (t.move ?? 0) < 0)
  const avgWin = avg(wins.map(t => t.pnl))
  const avgLoss = avg(losses.map(t => t.pnl))
  const symbols = groupBy(closed, t => t.symbol)
    .map(([symbol, ts]) => ({ symbol, ...tally(ts, ok) }))
    .sort((a, b) => (ok ? (b.net ?? 0) - (a.net ?? 0) : (b.win_rate ?? 0) - (a.win_rate ?? 0)) || b.n - a.n)
  const days = groupBy(closed, day)
  let cum = 0

  return {
    id,
    label,
    trades: trades.length,
    closed: closed.length,
    open: trades.filter(t => t.status === 'open').length,
    failed,
    money,
    currency: money.currency ?? null,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.filter(t => t.move === 0).length,
    win_rate: pct(wins.length, closed.length),
    // share of trading days that ended in profit (by P/L, else by more wins than losses)
    day_win_rate: pct(
      days.filter(([, ts]) => (ok ? sum(ts.map(pnl)) > 0 : ts.filter(t => (t.move ?? 0) > 0).length > ts.filter(t => (t.move ?? 0) < 0).length)).length,
      days.length,
    ),
    net: ok ? round2(sum(closed.map(pnl))) : null,
    avg_win: ok ? round2(avgWin) : null,
    avg_loss: ok ? round2(avgLoss) : null,
    // average win divided by the size of the average loss
    rrr: ok && avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round2(avgWin / Math.abs(avgLoss)) : null,
    // realised R per trade (move / initial SL distance) and the planned reward:risk
    avg_r: round2(avg(closed.map(t => t.r))),
    planned_rr: round2(avg(closed.map(t => t.planned_rr))),
    profit_factor: ok && losses.length > 0 ? round2(sum(wins.map(pnl)) / Math.abs(sum(losses.map(pnl)))) : null,
    largest_win: ok && wins.length > 0 ? Math.max(...wins.map(pnl)) : null,
    largest_loss: ok && losses.length > 0 ? Math.min(...losses.map(pnl)) : null,
    // average holding time in seconds, of winners and of losers
    avg_hold_win: ((x: number | null) => (x === null ? null : Math.round(x)))(avg(wins.map(held))),
    avg_hold_loss: ((x: number | null) => (x === null ? null : Math.round(x)))(avg(losses.map(held))),
    // the cumulative P/L after each closed trade, in closing order
    equity: ok
      ? [...closed]
          .sort((a, b) => ((a.close_at ?? a.open_at ?? '') < (b.close_at ?? b.open_at ?? '') ? -1 : (a.close_at ?? a.open_at ?? '') > (b.close_at ?? b.open_at ?? '') ? 1 : 0))
          .map(t => {
            cum = round2(cum + pnl(t)) ?? 0
            return { at: t.close_at ?? t.open_at ?? '', symbol: t.symbol, pnl: pnl(t), cum }
          })
      : [],
    by_day: days.map(([date, ts]) => ({ date, ...tally(ts, ok) })),
    best_symbol: symbols[0] ?? null,
    by_symbol: symbols,
    by_side: { buy: tally(closed.filter(t => t.side === 'buy'), ok), sell: tally(closed.filter(t => t.side === 'sell'), ok) },
    by_hour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      ...tally(closed.filter(t => t.open_at !== null && Number(t.open_at.slice(11, 13)) === hour), ok),
    })),
  }
}

export function computeStats(all: Trades): Stats {
  const accounts = all.accounts.map(a =>
    group(
      a.account,
      [a.account, a.server ?? a.broker].filter(Boolean).join(' · '),
      all.trades.filter(t => t.account === a.account),
      all.failed.filter(f => f.account === a.account).length,
    ),
  )
  return {
    range: all.range,
    groups: accounts.length > 1 ? [group('all', 'All accounts', all.trades, all.failed.length), ...accounts] : accounts,
  }
}
