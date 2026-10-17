---
description: Analyse your MetaTrader 5 trades from the terminal logs - a trade table per account, then win rate, RRR, best symbol, open hours, buy vs sell and average win/loss as charts in the pane
argument-hint: "[account ...] [date | from to | 'this week' | 'last 7 days']"
allowed-tools: mcp__rocket__mt5, Read
---

# /rocket:analyse

Give an overview of the user's trades from the MetaTrader 5 logs on this machine (Windows, or
wine on macOS and Linux) and the statistics behind them. The pane shows the pipeline while you
work and turns into charts when the run finishes with success.

**Read-only.** Install nothing, change nothing in MetaTrader 5, never write into its folders.
Everything goes through the `mcp__rocket__mt5` tool, which keeps its state under the user's
`.config/rocket` folder (or `ROCKET_HOME`). Use no shell commands for this: the tool works the
same on every platform, a shell does not.

**Never invent numbers.** Every figure comes from what the tool returns (`trades`, `analyse`,
`table`). Something unknown is written as "unknown". Every P/L is an estimate without commission
and swap; say so.

**Language.** Answer in the language the user writes in. The pipeline notes stay in English.

Each call is `mcp__rocket__mt5` with an `action` and its fields. A failed step comes back as an
error with the reason.

## 1. Accounts and period

Arguments: `$ARGUMENTS`, in any order, for example `1234 last 7 days` or `this week 1234 5678`.

- **Account numbers**: a bare number without dashes or slashes (`1234`, `21014178`) is an MT5
  account number; several are allowed. None: all accounts.
- **Period**: a date with dashes or in words, or a period ("yesterday", "this week", "1 to 15
  October", "2026-10-01 2026-10-15"). "Last N days" is N days up to and including today. Work the
  from and to dates (`YYYY-MM-DD`) out from today's date. None: today.
- Unsure whether something is an account or a date (an 8-digit number that is also a valid
  `YYYYMMDD`, say): ask once with AskUserQuestion.

`{action: "start", from, to, accounts}` (or `date` for one day). This opens the pane; its answer
holds the run's folder (`dir`).

## 2. The pipeline

Run the steps in order; each one reports its own jobs to the pane, so do not report those
yourself. Stop at the first step that fails: `{action: "finish", status: "failed", summary:
"<why>"}` and tell the user what is missing.

1. `{action: "discover"}`: finds every MT5 terminal. On Windows the data folders in
   `%APPDATA%\MetaQuotes\Terminal\` and portable installs in Program Files; on macOS and Linux
   the same inside wine (the MetaQuotes app, CrossOver bottles, `~/.wine`, other wrappers).
   Nothing found: ask the user where the terminal's folder is (MT5: File → Open Data Folder) and
   call again with `paths: ["<that folder>"]`.
2. `{action: "read"}`: decodes the terminal journals (`logs/YYYYMMDD.log`) and expert logs
   (`MQL5/Logs/`) of the period, one day either side for positions over midnight.
   A `journal` warning "no journal" means there are no logs for that period: tell the user and
   finish with `canceled`. `unreadable` lists logs it could not read (over 4 MiB).
3. `{action: "parse"}`: rebuilds the trades per account, only the requested accounts when given.
   An answer with `missing` means those account numbers have no trades or failed orders in the
   period: tell the user which accounts were seen (`seen`), finish with `canceled` and offer to
   run again with one of those or a longer period.
4. `{action: "analyse"}`: P/L and statistics; the answer is the statistics. Contract size
   defaults: XAU 100 oz, XAG 5000 oz, 6-letter FX pairs 100,000 per lot; anything else is
   unknown. On a `pnl` warning, read the expert logs (`<dir>/logs/<n>/experts/`, with Read) for
   the contract size; if found, call `parse` with `contracts: {"SYMBOL": size}` and `analyse`
   again. Otherwise ask the user once with AskUserQuestion, or leave it unknown.

## 3. The report

`{action: "job", job: "table", status: "running", note: "writing the trade table"}`, then build
the report from `{action: "table"}` (markdown), `{action: "trades"}` (every trade with its
fields, and the failed orders) and the statistics from `analyse`. Per account (heading: account
number + broker/server):

- The table from `table` (#, open time, side, symbol, lots, entry, exit, close time, how closed:
  manual / SL / TP / stop out / partial, P/L ≈).

`job` table `success` with "<n> trades", then `job` story `running` with "trade by trade":

- Under the table, one line per trade on how it went, from the trade's fields: `sl_initial`,
  `tp_initial`, `sl`/`tp` (final), `sl_changes`, `tp_changes`, `sl_at_breakeven`, `exits`,
  `closed_by`, `r` (realised R). For example "SL moved to break-even, then closed by hand below
  TP", "TP pulled in twice, closed at 0.5R".
- The net result per account, the failed orders (`failed`, with their reason) and anything that
  stands out (positions still open, trades without an open in the period, repeated failures).
  Look at the expert logs for context on failures if useful.

Then the statistics (the first group is all accounts together when there are several; money
figures are null when currencies differ or a contract size is unknown, and `money.why` says why):

- net P&L, win rate (wins / losses / break-even), profit factor, day win % (`day_win_rate`),
  largest win and loss, average hold time of winners and losers (`avg_hold_win`/`avg_hold_loss`,
  seconds), the run of the cumulative P&L (`equity`) and the best and worst day (`by_day`),
  average RRR (`rrr`: average win ÷ average loss; also `planned_rr` from the initial SL/TP and
  `avg_r`), best symbol, trade open time per hour (the best and the worst hours), buy vs sell,
  average win and average loss.
- Close with the total over all accounts. Different currencies are never added together.

`job` story `success`, then `{action: "finish", status: "success", summary: "<one line: trades,
win rate, net>"}`. The pane now shows the charts. Tell the user they can reopen it with
`/rocket-pane`.

If the user stops you halfway, finish with `canceled` and the reason. Never leave a run on
`running`.
