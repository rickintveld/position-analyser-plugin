import { round2 } from './trades'
import type { Answers, Level, Reflect, Review, ReviewGroup, Split, Tag, TagKind, Trade, TradeReview, Trades } from './types'

// What the trader did, from trades.ts: facts to learn from, not statistics
// (those are in the charts). Every trade gets tags, each with the fact behind
// it; a period gets its patterns: how trades on plan did against trades with a
// leak, what each tag cost in R, and which trades to reflect on.
//
//   good  plan_followed  SL and TP at open, never loosened, closed by SL/TP only
//         protected      SL moved to break-even or better
//         scaled_out     part of the position taken off in profit
//   leak  no_sl          opened without a stop loss
//         sl_widened     SL moved away from the entry, or removed
//         tp_removed     TP taken off
//         closed_early   closed by hand in profit below half the planned R
//         over_plan      lost more than the 1R planned
//         stop_out       closed by the broker
//         revenge        opened soon after a loss
//         size_up        more lots than the losing trade before, same symbol
//         streak         opened after losses in a row that day
//   note  tp_pulled      TP moved closer to the entry
//         tp_extended    TP moved further away
//         cut_short      closed by hand at a loss before the SL
//
// Only what the logs show: the price after a close is not in them, so a tag
// never says what would have happened.

export const LIMITS = { revenge_min: 15, early_share: 0.5, over_plan_r: -1.1, streak: 2 }

const KIND: Record<string, TagKind> = {
  plan_followed: 'good', protected: 'good', scaled_out: 'good',
  no_sl: 'leak', sl_widened: 'leak', tp_removed: 'leak', closed_early: 'leak', over_plan: 'leak',
  stop_out: 'leak', revenge: 'leak', size_up: 'leak', streak: 'leak',
  tp_pulled: 'note', tp_extended: 'note', cut_short: 'note',
}
const ORDER = Object.keys(KIND)

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const pct = (part: number, whole: number) => (whole === 0 ? null : round2((part * 100) / whole))
const seconds = (at: string) => Date.UTC(+at.slice(0, 4), +at.slice(5, 7) - 1, +at.slice(8, 10), +at.slice(11, 13), +at.slice(14, 16), +at.slice(17, 19)) / 1000
const minutes = (from: string, to: string) => Math.round((seconds(to) - seconds(from)) / 60)
// MT5 writes "sl: 0.00" for no stop loss
const level = (x: number | null) => (x === null || x === 0 ? null : x)
const signed = (r: number) => `${r > 0 ? '+' : ''}${r}R`
const closedBy = (t: Trade) => t.exits[t.exits.length - 1]?.reason ?? null

// P/L of a set of trades, only when every one has a P/L in one currency.
function money(trades: Trade[]): { net: number | null; currency: string | null } {
  const currencies = [...new Set(trades.map(t => t.currency))]
  if (trades.length === 0 || trades.some(t => t.pnl === null) || currencies.length > 1) return { net: null, currency: null }
  return { net: round2(sum(trades.map(t => t.pnl ?? 0))), currency: currencies[0] ?? null }
}

function split(trades: Trade[]): Split {
  const rs = trades.map(t => t.r).filter((r): r is number => r !== null)
  return {
    n: trades.length,
    wins: trades.filter(t => (t.move ?? 0) > 0).length,
    losses: trades.filter(t => (t.move ?? 0) < 0).length,
    sum_r: rs.length === 0 ? null : round2(sum(rs)),
    avg_r: rs.length === 0 ? null : round2(sum(rs) / rs.length),
    net: money(trades).net,
  }
}

// How the SL and TP moved between two levels of a position.
function moves(t: Trade) {
  const sign = t.side === 'buy' ? 1 : -1
  const out = { slWidened: [] as string[], tpRemoved: false, tpPulled: 0, tpExtended: 0 }
  t.levels.slice(1).forEach((next, i) => {
    const prev = t.levels[i] as Level
    const [ps, ns, pt, nt] = [level(prev.sl), level(next.sl), level(prev.tp), level(next.tp)]
    if (ps !== null && ns === null) out.slWidened.push(`${ps} → none`)
    else if (ps !== null && ns !== null && (ns - ps) * sign < 0) out.slWidened.push(`${ps} → ${ns}`)
    if (pt !== null && nt === null) out.tpRemoved = true
    else if (pt !== null && nt !== null && (nt - pt) * sign < 0) out.tpPulled++
    else if (pt !== null && nt !== null && (nt - pt) * sign > 0) out.tpExtended++
  })
  return out
}

// The tags of one trade; `earlier` are the account's closed trades in closing
// order, `no` a trade's number in the account's table.
function tagsOf(t: Trade, earlier: Trade[], no: (t: Trade) => number): Tag[] {
  const tags: Tag[] = []
  const tag = (code: string, fact: string) => tags.push({ code, kind: KIND[code] ?? 'note', fact })
  const closed = t.status === 'closed'
  const m = moves(t)
  const open = t.levels.find(l => l.kind === 'open')
  const by = closedBy(t)

  if (open !== undefined && level(open.sl) === null) {
    const set = t.levels.find(l => l.kind === 'modify' && level(l.sl) !== null)
    tag('no_sl', set === undefined ? 'opened without a stop loss and never set one' : `opened without a stop loss; SL set ${minutes(open.at, set.at)} min later`)
  }
  if (m.slWidened.length > 0) tag('sl_widened', `SL moved away from the entry ${m.slWidened.length}×: ${m.slWidened.join(', ')}`)
  if (m.tpRemoved) tag('tp_removed', 'TP taken off')
  if (m.tpPulled > 0) tag('tp_pulled', `TP moved closer to the entry ${m.tpPulled}×`)
  if (m.tpExtended > 0) tag('tp_extended', `TP moved further away ${m.tpExtended}×`)

  if (closed && by === 'manual' && t.r !== null && t.r > 0 && t.planned_rr !== null && t.r < LIMITS.early_share * t.planned_rr) {
    tag('closed_early', `closed by hand at ${signed(t.r)} of a planned ${t.planned_rr}R`)
  }
  if (closed && by === 'manual' && t.r !== null && t.r < 0 && t.r > -1) tag('cut_short', `closed by hand at ${signed(t.r)}, before the SL`)
  if (closed && t.r !== null && t.r < LIMITS.over_plan_r) tag('over_plan', `lost ${-t.r}R where 1R was planned`)
  if (t.exits.some(x => x.reason === 'stop_out')) tag('stop_out', 'closed by the broker: stop out')

  if (t.sl_at_breakeven) tag('protected', `SL moved to break-even or better${closed && by === 'sl' ? ', then stopped there' : ''}`)
  const first = t.exits[0]
  if (t.exits.length > 1 && first !== undefined && first.price !== null && t.entry !== null && (first.price - t.entry) * (t.side === 'buy' ? 1 : -1) > 0) {
    tag('scaled_out', `took ${first.volume ?? 'part'} of ${t.volume ?? '?'} lots off in profit at ${first.price}`)
  }
  const onPlan =
    closed && open !== undefined && level(open.sl) !== null && level(open.tp) !== null &&
    m.slWidened.length === 0 && !m.tpRemoved && m.tpPulled === 0 && m.tpExtended === 0 &&
    t.exits.every(x => x.reason === 'sl' || x.reason === 'tp')
  if (onPlan) tag('plan_followed', `SL and TP set at open and left alone; closed by ${by === 'tp' ? 'TP' : 'SL'}${t.r === null ? '' : ` at ${signed(t.r)}`}`)

  // what came before, on the same account
  if (t.open_at !== null) {
    const openAt = t.open_at
    const before = earlier.filter(e => e.close_at !== null && e.close_at <= openAt)
    const last = before[before.length - 1]
    if (last !== undefined && (last.move ?? 0) < 0 && last.close_at !== null && minutes(last.close_at, openAt) <= LIMITS.revenge_min) {
      tag('revenge', `opened ${minutes(last.close_at, openAt)} min after the loss of #${no(last)}${last.symbol === t.symbol ? ', same symbol' : ''}`)
    }
    const lastSame = [...before].reverse().find(e => e.symbol === t.symbol)
    if (lastSame !== undefined && (lastSame.move ?? 0) < 0 && lastSame.volume !== null && t.volume !== null && t.volume > lastSame.volume) {
      tag('size_up', `${lastSame.volume} → ${t.volume} lots after the loss of #${no(lastSame)}`)
    }
    let run = 0
    for (const e of [...before].reverse()) {
      if ((e.close_at ?? '').slice(0, 10) !== openAt.slice(0, 10) || (e.move ?? 0) >= 0) break
      run++
    }
    if (run >= LIMITS.streak) tag('streak', `opened after ${run} losses in a row that day`)
  }

  return tags.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code))
}

function group(id: string, label: string, trades: Trade[], reviews: Map<Trade, TradeReview>, failed: Trades['failed']): ReviewGroup {
  const closed = trades.filter(t => t.status === 'closed' && t.move !== null)
  const clean = closed.filter(t => reviews.get(t)?.clean)
  const off = closed.filter(t => !reviews.get(t)?.clean)
  const codes = [...new Set(trades.flatMap(t => reviews.get(t)?.tags.map(x => x.code) ?? []))]
  const kinds: TagKind[] = ['leak', 'good', 'note']
  const tags = codes
    .map(code => {
      const ts = trades.filter(t => reviews.get(t)?.tags.some(x => x.code === code))
      return { code, kind: KIND[code] ?? 'note', n: ts.length, trades: ts.map(t => `${t.account} #${reviews.get(t)?.no ?? '?'}`), sum_r: split(ts).sum_r, net: money(ts).net }
    })
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || b.n - a.n || (a.sum_r ?? 0) - (b.sum_r ?? 0))
  const reasons = new Map<string, number>()
  for (const f of failed) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1)
  let streak = 0
  let longest = 0
  for (const t of [...closed].sort((a, b) => ((a.close_at ?? '') < (b.close_at ?? '') ? -1 : 1))) {
    streak = (t.move ?? 0) < 0 ? streak + 1 : 0
    longest = Math.max(longest, streak)
  }
  const perDay = new Map<string, number>()
  for (const t of trades) if (t.open_at !== null) perDay.set(t.open_at.slice(0, 10), (perDay.get(t.open_at.slice(0, 10)) ?? 0) + 1)
  const busiest = [...perDay.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]
  return {
    id,
    label,
    closed: closed.length,
    clean: clean.length,
    plan_score: pct(clean.length, closed.length),
    currency: money(closed).currency,
    on_plan: split(clean),
    off_plan: split(off),
    tags,
    failed: [...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([reason, n]) => ({ reason, n })),
    max_loss_streak: longest,
    busiest_day: busiest === undefined ? null : { date: busiest[0], n: busiest[1] },
  }
}

// Up to three trades to ask the trader about: the costliest leak, the best
// trade on plan, and a trade opened right after a loss.
function toReflect(reviews: TradeReview[]): Reflect[] {
  const closed = reviews.filter(r => r.status === 'closed')
  const score = (r: TradeReview) => r.r ?? r.pnl ?? 0
  const picks: Reflect[] = []
  const pick = (r: TradeReview | undefined, why: Reflect['why']) => {
    if (r !== undefined && !picks.some(p => p.n === r.n)) picks.push({ n: r.n, no: r.no, account: r.account, position: r.position, why })
  }
  pick([...closed.filter(r => !r.clean)].sort((a, b) => score(a) - score(b))[0], 'costliest_leak')
  pick([...closed.filter(r => r.clean)].sort((a, b) => score(b) - score(a))[0], 'best_on_plan')
  pick(closed.find(r => r.tags.some(t => ['revenge', 'size_up', 'streak'].includes(t.code)) && !picks.some(p => p.n === r.n)), 'after_loss')
  return picks
}

// `journal`: the trader's earlier answers, by "<account>/<position>".
export function computeReview(all: Trades, journal: Record<string, Answers> = {}): Review {
  const reviews = new Map<Trade, TradeReview>()
  for (const a of all.accounts) {
    const own = all.trades.filter(t => t.account === a.account)
    const closedInOrder = own
      .filter(t => t.status === 'closed' && t.close_at !== null)
      .sort((x, y) => ((x.close_at ?? '') < (y.close_at ?? '') ? -1 : (x.close_at ?? '') > (y.close_at ?? '') ? 1 : x.n - y.n))
    const no = (t: Trade) => own.indexOf(t) + 1
    own.forEach((t, i) => {
      const tags = tagsOf(t, closedInOrder.filter(e => e !== t), no)
      reviews.set(t, {
        n: t.n,
        no: i + 1,
        account: t.account,
        position: t.position,
        symbol: t.symbol,
        side: t.side,
        open_at: t.open_at,
        close_at: t.close_at,
        status: t.status,
        r: t.r,
        planned_rr: t.planned_rr,
        pnl: t.pnl,
        currency: t.currency,
        clean: !tags.some(x => x.kind === 'leak'),
        tags,
        journal: journal[`${t.account}/${t.position}`] ?? null,
      })
    })
  }
  const accounts = all.accounts.map(a =>
    group(
      a.account,
      [a.account, a.server ?? a.broker].filter(Boolean).join(' · '),
      all.trades.filter(t => t.account === a.account),
      reviews,
      all.failed.filter(f => f.account === a.account),
    ),
  )
  const list = all.trades.map(t => reviews.get(t)).filter((r): r is TradeReview => r !== undefined)
  return {
    range: all.range,
    limits: LIMITS,
    trades: list,
    groups: accounts.length > 1 ? [group('all', 'All accounts', all.trades, reviews, all.failed), ...accounts] : accounts,
    reflect: toReflect(list),
  }
}
