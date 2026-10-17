import type { Event, Side } from './types'

// Turns MetaTrader 5 terminal journal lines (tab separated: code, level, time,
// source, message) into the events trades.ts rebuilds positions from:
// auth (server/broker per account), open_req, close_req, trigger (SL/TP/stop
// out), deal, modify (a confirmed SL/TP change) and failed.
//
//   '12345678': market sell 2.55 XAUUSD sl: 4186.70 tp: 4178.72
//   '12345678': deal #14967716 sell 2.55 XAUUSD at 4182.60 done (based on order #15305734)
//   '12345678': market buy 2.55 XAUUSD, close #15305734 sell 2.55 XAUUSD 4182.60
//   '12345678': stop loss triggered #N buy 2.98 XAUUSD 4186.39 sl: 4183.09 [...]
//   '12345678': modify #N sell 2.55 XAUUSD -> sl: 4186.70, tp: 4178.11 done in 12.548 ms
//   '12345678': failed market buy 4.62 XAUUSD sl: 4153.00 tp: 4159.39 [No money]

// A number from a token like "4186.70," or "#123"; null when there is none.
const num = (token: string | undefined): number | null => {
  const s = (token ?? '').replace(/[^0-9.-]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const side = (token: string | undefined): Side => (token === 'sell' ? 'sell' : 'buy')
const other = (s: Side): Side => (s === 'buy' ? 'sell' : 'buy')

// "#15305734" -> "15305734"; "#15305734)" -> "15305734"
const id = (token: string | undefined) => (token ?? '').replace(/^#/, '').replace(/\)$/, '')

export function parseJournal(text: string, date: string, terminal: number): Event[] {
  const events: Event[] = []
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const fields = raw.replace(/\r$/, '').split('\t')
    const source = fields[3]
    if (source !== 'Trades' && source !== 'Network') return
    const full = fields[4] ?? ''
    const m = /^'(\d+)': (.*)$/.exec(full)
    if (m === null) return
    const account = m[1] ?? ''
    const msg = m[2] ?? ''
    const t = msg.split(' ').filter(s => s !== '')
    const base = { terminal, account, at: `${date} ${(fields[2] ?? '').slice(0, 8)}`, seq: i + 1 }
    const after = (label: string) => {
      const k = t.indexOf(label)
      return k < 0 || k === t.length - 1 ? null : num(t[k + 1])
    }

    if (source === 'Network') {
      if (msg.startsWith('authorized on ')) {
        const server = msg.slice(14).replace(/ through .*/, '').replace(/ \(.*/, '')
        events.push({ ...base, type: 'auth', server })
      } else if (msg.startsWith('terminal synchronized with ')) {
        events.push({ ...base, type: 'auth', broker: msg.slice(27).replace(/:.*/, '') })
      }
      return
    }

    if (msg.startsWith('failed ')) {
      const reason = /\[([^\]]*)\]$/.exec(msg)?.[1] ?? ''
      events.push({ ...base, type: 'failed', text: msg.slice(7).replace(/ \[[^\]]*\]$/, ''), reason })
      return
    }

    // market buy 2.55 XAUUSD, close #15305734 sell 2.55 XAUUSD 4182.60
    if (t[0] === 'market' && t[4] === 'close') {
      events.push({
        ...base,
        type: 'close_req',
        side: side(t[1]),
        volume: num(t[2]),
        symbol: (t[3] ?? '').replace(/,$/, ''),
        position: id(t[5]),
        position_side: side(t[6]),
        entry: num(t[9]),
        reason: 'manual',
      })
      return
    }

    // market sell 2.55 XAUUSD sl: 4186.70 tp: 4178.72
    if (t[0] === 'market' && (t[1] === 'buy' || t[1] === 'sell')) {
      events.push({ ...base, type: 'open_req', side: side(t[1]), volume: num(t[2]), symbol: t[3] ?? '', sl: after('sl:'), tp: after('tp:') })
      return
    }

    // stop loss triggered #N buy 2.98 XAUUSD 4186.39 sl: 4183.09 [...]
    const trigger = /^(stop loss|take profit|stop out) triggered #/.exec(msg)
    if (trigger !== null) {
      const reason = trigger[1] === 'stop loss' ? 'sl' : trigger[1] === 'take profit' ? 'tp' : 'stop_out'
      const k = reason === 'stop_out' ? 2 : 3
      const positionSide = side(t[k + 1])
      events.push({
        ...base,
        type: 'trigger',
        reason,
        position: id(t[k]),
        position_side: positionSide,
        side: other(positionSide),
        volume: num(t[k + 2]),
        symbol: t[k + 3] ?? '',
        entry: num(t[k + 4]),
      })
      return
    }

    // deal #14967716 sell 2.55 XAUUSD at 4182.60 done (based on order #15305734)
    if (t[0] === 'deal' && t[5] === 'at' && / done /.test(msg)) {
      events.push({
        ...base,
        type: 'deal',
        deal: id(t[1]),
        side: side(t[2]),
        volume: num(t[3]),
        symbol: t[4] ?? '',
        price: num(t[6]),
        order: id(t[t.length - 1]),
      })
      return
    }

    // modify #N sell 2.55 XAUUSD -> sl: 4186.70, tp: 4178.11 done in 12.548 ms
    if (t[0] === 'modify' && t[5] === '->' && / done in /.test(msg)) {
      events.push({ ...base, type: 'modify', position: id(t[1]), sl: after('sl:'), tp: after('tp:') })
    }
  })
  return events
}
