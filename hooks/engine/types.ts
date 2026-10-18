// The shapes the engine writes (trades.json, stats.json, status.json) and the
// pane reads.

export type Side = 'buy' | 'sell'

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'warning' | 'skipped' | 'canceled'
export type RunStatus = 'running' | 'success' | 'failed' | 'canceled'

export type Job = { status: JobStatus; note: string; started_at: number | null; finished_at: number | null }

export type Run = {
  id: string
  range: { from: string; to: string }
  accounts: string[]
  status: RunStatus
  active_stage: string
  summary: string
  notes: { at: number; text: string }[]
  started_at: number
  updated_at: number
  finished_at: number | null
  stages: { name: string; jobs: string[] }[]
  jobs: Record<string, Job>
}

// One journal line that matters, from events.ts.
export type Event =
  | (EventBase & { type: 'auth'; server?: string; broker?: string })
  | (EventBase & { type: 'failed'; text: string; reason: string })
  | (EventBase & { type: 'open_req'; side: Side; volume: number | null; symbol: string; sl: number | null; tp: number | null })
  | (EventBase & {
      type: 'close_req' | 'trigger'
      side: Side
      volume: number | null
      symbol: string
      position: string
      position_side: Side
      entry: number | null
      reason: string
    })
  | (EventBase & { type: 'deal'; deal: string; side: Side; volume: number | null; symbol: string; price: number | null; order: string })
  | (EventBase & { type: 'modify'; position: string; sl: number | null; tp: number | null })

export type EventBase = { terminal: number; account: string; at: string; seq: number }

export type Exit = { at: string; price: number | null; volume: number | null; reason: string; deal: string }

// The SL/TP of a position over time: what the open request asked for (when it
// was logged), then every confirmed modify.
export type Level = { at: string; kind: 'open' | 'modify'; sl: number | null; tp: number | null }

export type Trade = {
  n: number
  account: string
  position: string
  terminal: number
  symbol: string
  side: Side
  volume: number | null
  open_at: string | null
  entry: number | null
  sl_initial: number | null
  tp_initial: number | null
  sl: number | null
  tp: number | null
  sl_changes: number
  tp_changes: number
  levels: Level[]
  exits: Exit[]
  status: 'closed' | 'open'
  close_at: string | null
  exit: number | null
  closed_by: string | null
  move: number | null
  contract: number | null
  contract_source: 'user' | 'default' | 'unknown'
  currency: string | null
  pnl: number | null
  r: number | null
  planned_rr: number | null
  sl_at_breakeven: boolean
}

export type Failed = { account: string; at: string; text: string; reason: string }

export type Account = { account: string; server?: string; broker?: string }

export type Trades = {
  range: { from: string; to: string }
  only: string[]
  seen: string[]
  accounts: Account[]
  trades: Trade[]
  failed: Failed[]
}

export type Tally = { n: number; wins: number; losses: number; net: number | null; win_rate: number | null }

export type Group = {
  id: string
  label: string
  trades: number
  closed: number
  open: number
  failed: number
  money: { ok: boolean; why?: string; currency?: string | null }
  currency: string | null
  wins: number
  losses: number
  breakeven: number
  win_rate: number | null
  day_win_rate: number | null
  net: number | null
  avg_win: number | null
  avg_loss: number | null
  rrr: number | null
  avg_r: number | null
  planned_rr: number | null
  profit_factor: number | null
  largest_win: number | null
  largest_loss: number | null
  avg_hold_win: number | null
  avg_hold_loss: number | null
  equity: { at: string; symbol: string; pnl: number; cum: number }[]
  by_day: (Tally & { date: string })[]
  best_symbol: (Tally & { symbol: string }) | null
  by_symbol: (Tally & { symbol: string })[]
  by_side: { buy: Tally; sell: Tally }
  by_hour: (Tally & { hour: number })[]
}

export type Stats = { range: { from: string; to: string }; groups: Group[] }

// What the trader did, trade by trade and per period, from review.ts.
export type TagKind = 'good' | 'leak' | 'note'

export type Tag = { code: string; kind: TagKind; fact: string }

export type Answers = Record<string, string>

export type TradeReview = {
  n: number
  no: number
  account: string
  position: string
  symbol: string
  side: Side
  open_at: string | null
  close_at: string | null
  status: 'closed' | 'open'
  r: number | null
  planned_rr: number | null
  pnl: number | null
  currency: string | null
  clean: boolean
  tags: Tag[]
  journal: Answers | null
}

export type Split = { n: number; wins: number; losses: number; sum_r: number | null; avg_r: number | null; net: number | null }

export type ReviewGroup = {
  id: string
  label: string
  closed: number
  clean: number
  plan_score: number | null
  currency: string | null
  on_plan: Split
  off_plan: Split
  tags: { code: string; kind: TagKind; n: number; trades: string[]; sum_r: number | null; net: number | null }[]
  failed: { reason: string; n: number }[]
  max_loss_streak: number
  busiest_day: { date: string; n: number } | null
}

export type Reflect = { n: number; no: number; account: string; position: string; why: 'costliest_leak' | 'best_on_plan' | 'after_loss' }

export type Review = {
  range: { from: string; to: string }
  limits: { revenge_min: number; early_share: number; over_plan_r: number; streak: number }
  trades: TradeReview[]
  groups: ReviewGroup[]
  reflect: Reflect[]
}

export type JournalEntry = { account: string; position: string; symbol: string; open_at: string | null; run: string; saved_at: number; answers: Answers }
