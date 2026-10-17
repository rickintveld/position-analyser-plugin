# Trading Rocket — Claude Code plugins for traders

One plugin, `rocket`, short to type: every tool is a `/rocket:<command>`.

## /rocket:analyse

Analyse your MetaTrader 5 trades straight from the terminal logs on your Mac. No broker API,
no exports, no add-ons inside MetaTrader: the plugin reads the journal MT5 already writes,
rebuilds every trade and shows you what the data says.

- **Win rate** — wins, losses, break-even
- **Average RRR** — average win ÷ average loss, plus the planned R:R from your initial SL/TP
- **Best symbol** — P/L, trades and win rate per symbol
- **Trade open time** — trades and result per hour of the day
- **Buy & sell** — how your longs and shorts compare
- **Average win / average loss**, profit factor, day win %, largest win and loss, hold times
- **Cumulative P&L** curve and **net P&L per day**

While Claude works, a live pane shows the pipeline (discover → read → parse → analyse →
report). When the run is done, the pipeline makes way for a trading-journal dashboard: KPI cards
with gauges, the equity curve, daily P&L and the breakdowns above.

## Install

```
/plugin install rocket --marketplace rickintveld/position-analyser-plugin
```

Or add the marketplace first and pick the plugin from `/plugin`:

```
/plugin marketplace add rickintveld/position-analyser-plugin
```

Requirements: macOS with MetaTrader 5 (the MetaQuotes app, CrossOver or any wine prefix),
`zsh`, `jq` (built into macOS 15 and later; otherwise `brew install jq`), `awk` and `iconv`.

## Use

```
/rocket:analyse                       # today
/rocket:analyse yesterday
/rocket:analyse 2026-10-01 2026-10-15
/rocket:analyse this week
/rocket:analyse 1234 last 7 days            # one account
/rocket:analyse 1234 5678 this month        # several accounts
```

Claude gives you a trade table per account (open/close time, side, symbol, lots, entry, exit,
how it was closed: manual / SL / TP / stop out / partial, P/L), a line per trade on how it went
(SL moved to break-even, TP pulled in, …), failed orders, and the statistics above.
`/rocket-pane` reopens the pane with the last run.

## How it works

The numbers are computed by a script, not by the model, so they are the same every time:

1. `discover` finds every MT5 terminal (`terminal64.exe`) in `~/Library/Application Support`
   (MetaQuotes app, CrossOver bottles, other wine wrappers) and `~/.wine`.
2. `read` decodes the UTF-16 journals (`logs/YYYYMMDD.log`) and expert logs (`MQL5/Logs`) of the
   period, plus a day either side for positions that run over midnight.
3. `parse` rebuilds positions from the `Trades` lines: opening deals, `close #N` requests,
   SL/TP/stop out triggers, partial closes, SL/TP modifications and failed orders, per account.
4. `analyse` computes P/L and the statistics.

**P/L is an estimate** without commission and swap: price move × lots × contract size. Default
contract sizes are XAU 100 oz, XAG 5000 oz and 100,000 for 6-letter FX pairs; for anything else
(indices, crypto, CFDs) Claude looks in the expert logs or asks you. Win rate and the per-hour,
per-symbol and buy/sell counts never need the contract size.

**Read-only.** Nothing is installed in or changed in MetaTrader. Everything the plugin writes
goes to `~/.config/rocket` (override with `ROCKET_HOME`). Terminals in
other places: `ROCKET_MT5_PATHS=<folder>[:<folder>]`.

## Develop

```
zsh tests/cli.zsh            # the script against a fake terminal (tests/fixtures)
claude plugin test .         # the pane
claude plugin validate .
claude --plugin-dir .        # a session with this checkout loaded
```

`bin/rocket help` lists the script's subcommands. See `CLAUDE.md` for the layout.
