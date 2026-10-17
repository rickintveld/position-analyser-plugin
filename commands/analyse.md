---
description: Analyse your MetaTrader 5 trades from the terminal logs - a trade table per account, then win rate, RRR, best symbol, open hours, buy vs sell and average win/loss as charts in the pane
argument-hint: "[account ...] [date | from to | 'this week' | 'last 7 days']"
---

# /rocket:analyse

Give an overview of the user's trades from the MetaTrader 5 logs on this machine and the
statistics behind them. The pane shows the pipeline while you work and turns into charts when
the run finishes with success.

**Read-only.** Install nothing, change nothing in MetaTrader 5, never write into its folders.
All state goes to `$ROCKET_HOME` (default `~/.config/rocket`) through the
script below.

**Never invent numbers.** Every figure comes from `trades.json` / `stats.json` that the script
writes. Something unknown is written as "unknown". Every P/L is an estimate without commission
and swap; say so.

**Language.** Answer in the language the user writes in. The pipeline notes stay in English.

`PA="${CLAUDE_PLUGIN_ROOT}/bin/rocket"`. Call it with its full path every time; if
`${CLAUDE_PLUGIN_ROOT}` was not substituted, find the plugin folder with `claude plugin list`.
`$PA help` lists every subcommand.

## 1. Accounts and period

Arguments: `$ARGUMENTS`, in any order, for example `1234 last 7 days` or `this week 1234 5678`.

- **Account numbers**: a bare number without dashes or slashes (`1234`, `21014178`) is an MT5
  account number; several are allowed. None: all accounts.
- **Period**: a date with dashes or in words, or a period ("yesterday", "this week", "1 to 15
  October", "2026-10-01 2026-10-15"). "Last N days" is N days up to and including today. Work the
  from and to dates (`YYYY-MM-DD`) out from today's date. None: today.
- Unsure whether something is an account or a date (an 8-digit number that is also a valid
  `YYYYMMDD`, say): ask once with AskUserQuestion.

`$PA run start --from <from> --to <to> [--account <n> ...]` (or `--date <day>`). This opens the
pane. Keep the `dir` from its output: the run's files are there.

## 2. The pipeline

Run the steps in order; each one reports its own jobs to the pane, so do not report those
yourself. Stop at the first step that fails: `$PA run finish failed "<why>"` and tell the user
what is missing.

1. `$PA discover`: finds every MT5 terminal (the MetaQuotes wine app, CrossOver bottles,
   `~/.wine`, other wine wrappers). Nothing found: ask the user where `terminal64.exe` lives and
   re-run with `ROCKET_MT5_PATHS=<folder> $PA discover`.
2. `$PA read`: decodes the terminal journals (`logs/YYYYMMDD.log`) and expert logs
   (`MQL5/Logs/`) of the period, one day either side for positions over midnight.
   A `journal` warning means there are no logs for that period: tell the user which days do
   exist (`ls` on the terminal's `logs` folder) and finish with `canceled`.
3. `$PA parse`: rebuilds the trades per account, only the requested accounts when given. A
   `trades` warning "account … not in the logs of this period" means that number has no trades
   or failed orders in the period: tell the user which accounts were seen (`seen` in the output),
   finish with `$PA run finish canceled "<why>"` and offer to run again with one of those or a
   longer period. If symbols without a known contract size were
   traded (indices, crypto, CFDs), see step 4.
4. `$PA analyse`: P/L and statistics. Contract size defaults: XAU 100 oz, XAG 5000 oz,
   6-letter FX pairs 100,000 per lot; anything else is unknown. On a `pnl` warning, look in the
   expert logs (`<dir>/logs/*/experts/`) for the contract size; if found, run
   `$PA parse --contract SYMBOL=size` and `$PA analyse` again. Otherwise ask the user once with
   AskUserQuestion, or leave it unknown.

## 3. The report

`$PA job table running "writing the trade table"`, then build the report from `$PA table`,
`<dir>/trades.json` and `<dir>/stats.json`. Per account (heading: account number + broker/server):

- The table from `$PA table` (#, open time, side, symbol, lots, entry, exit, close time, how
  closed: manual / SL / TP / stop out / partial, P/L ≈).

`$PA job table success "<n> trades"`, then `$PA job story running "trade by trade"`:

- Under the table, one line per trade on how it went, from the trade's fields: `sl_initial`,
  `tp_initial`, `sl`/`tp` (final), `sl_changes`, `tp_changes`, `sl_at_breakeven`, `exits`,
  `closed_by`, `r` (realised R). For example "SL moved to break-even, then closed by hand below
  TP", "TP pulled in twice, closed at 0.5R".
- The net result per account, the failed orders (`failed` in trades.json, with their reason)
  and anything that stands out (positions still open, trades without an open in the period,
  repeated failures). Look at the expert logs for context on failures if useful.

Then the statistics, from `stats.json` (the first group is all accounts together when there are
several; money figures are null when currencies differ or a contract size is unknown, and
`money.why` says why):

- net P&L, win rate (wins / losses / break-even), profit factor, day win % (`day_win_rate`),
  largest win and loss, average hold time of winners and losers (`avg_hold_win`/`avg_hold_loss`,
  seconds), the run of the cumulative P&L (`equity`) and the best and worst day (`by_day`),
  average RRR (`rrr`: average win ÷ average loss; also
  `planned_rr` from the initial SL/TP and `avg_r`), best symbol, trade open time per hour (the
  best and the worst hours), buy vs sell, average win and average loss.
- Close with the total over all accounts. Different currencies are never added together.

`$PA job story success`, then `$PA run finish success "<one line: trades, win rate, net>"`.
The pane now shows the charts. Tell the user they can reopen it with
`/rocket-pane`.

If the user stops you halfway, finish with `$PA run finish canceled "<why>"`. Never leave a run
on `running`.
