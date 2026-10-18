<p align="center">
  <img src="assets/mascot.png" alt="Trading Rocket" width="96" height="96">
</p>

# Trading Rocket — Claude Code plugins for traders

One plugin, `rocket`, short to type: every tool is a `/rocket:<command>`.

## /rocket:analyse

Analyse your MetaTrader 5 trades straight from the terminal logs on your computer. No broker API,
no exports, no add-ons inside MetaTrader: the plugin reads the journal MT5 already writes,
rebuilds every trade and shows you what the data says.

```
/rocket:analyse 1234 last 30 days
```

### Watch it work

While Claude works, a pane beside the conversation shows the pipeline live: it finds your MT5
terminals, decodes the logs, rebuilds the trades and computes the numbers, each step with what it
found.

![The pipeline in the Claude Code app: discover, read, parse, analyse and report, with a note per step](assets/claude-gui-pipeline.png)

### Your trading dashboard

When the run is done, the pipeline makes way for your dashboard, while Claude writes the trade
table, a line per trade on how it went and what stands out.

![The dashboard in the Claude Code app: KPI cards, the cumulative P&L curve, net daily P&L, performance by symbol, trade time and long vs short, beside Claude's trade report](assets/claude-gui-overview.png)

- **Net P&L**, **trade win %** and **day win %**
- **Profit factor** and **average win / average loss** (your realised RRR), plus the planned R:R
  from your initial SL/TP
- **Cumulative P&L** curve and **net P&L per day**
- **Performance by symbol**, with your best symbol
- **Trade time performance**: the result per hour you opened
- **Long vs short**
- **Largest win and loss**, and how long you hold winners and losers

## Install

In Claude Code, add the marketplace and install the plugin from it:

```
/plugin marketplace add rickintveld/position-analyser-plugin
/plugin install rocket@trading-rocket
```

Or from a shell:

```
claude plugin marketplace add rickintveld/position-analyser-plugin
claude plugin install rocket@trading-rocket
```

Update later with `/plugin marketplace update trading-rocket`.

Works on **Windows** and **macOS** (MetaTrader 5 through the MetaQuotes app, CrossOver or any
wine prefix), and on Linux with wine. Nothing else to install: everything runs inside the plugin.

## Use

```
/rocket:analyse                             # today, all accounts
/rocket:analyse yesterday
/rocket:analyse 2026-10-01 2026-10-15
/rocket:analyse this week
/rocket:analyse 1234 last 7 days            # one account
/rocket:analyse 1234 5678 this month        # several accounts
```

A bare number is an account number; a date has dashes or is written in words.

The numbers are in the pane. In the chat Claude goes through what you did, so you can learn from
it, good and bad, in plain facts:

- **Per trade**: the trade table per account (open/close time, side, symbol, lots, entry, exit,
  how it was closed, P/L), then every trade that has something to learn from: what happened
  (plan followed, SL moved to break-even, SL moved away from the entry, no SL, closed early by
  hand, back in right after a loss, more lots after a loss, …), what it cost or made in R, and
  what to do next time.
- **Patterns this period**: trades on plan against trades where you deviated, what works, what
  leaks and what each leak cost in R, and failed orders.
- **One focus** for the next period: a rule you can check with the next `/rocket:analyse`.
- **Reflection**: a few questions about the trades that matter most (your setup, whether you
  followed your plan, what drove the decision, your lesson). Your answers are kept in
  `.config/rocket/journal.json` and come back the next time that trade is reviewed.

`/rocket-pane` reopens the pane with the last run.

## For the nerds: the terminal

Prefer Claude Code in a terminal? Same pipeline, same dashboard, drawn in text.

![The pipeline in the terminal: box-drawn job pills per stage, with a note per step](assets/claude-terminal-pipeline.png)

![The dashboard in the terminal: boxed KPI cards, a braille line chart of the cumulative P&L and block bars per day, symbol, hour and side](assets/claude-terminal-overview.png)

- In a narrow terminal the pane waits instead of opening by itself; widen the window or run
  `/rocket-pane` to open it.
- The logo shows in terminals that can display pictures (Ghostty, kitty); other terminals show
  the header text without it.
- The cumulative P&L is a braille line chart (2×4 dots per character), green above zero and red
  below.

### How it works

The numbers are computed by the plugin's own engine (TypeScript, `hooks/engine/`), not by the
model, so they are the same every time. Claude drives it through the tool `mcp__rocket__mt5`:

1. `discover` finds every MT5 terminal: on Windows the data folders in
   `%APPDATA%\MetaQuotes\Terminal\` and portable installs in Program Files; on macOS and Linux the
   same inside wine (`~/Library/Application Support`: the MetaQuotes app, CrossOver bottles, other
   wrappers; `~/.wine`).
2. `read` decodes the UTF-16 journals (`logs/YYYYMMDD.log`) and expert logs (`MQL5/Logs`) of the
   period, plus a day either side for positions that run over midnight.
3. `parse` rebuilds positions from the `Trades` lines: opening deals, `close #N` requests,
   SL/TP/stop out triggers, partial closes, SL/TP modifications and failed orders, per account.
4. `analyse` computes P/L and the statistics.
5. `review` tags every trade with what the trader did (good, leak or note, each with the fact
   behind it) and the patterns per period; `reflect` keeps the trader's answers in the journal.

**P/L is an estimate** without commission and swap: price move × lots × contract size. Default
contract sizes are XAU 100 oz, XAG 5000 oz and 100,000 for 6-letter FX pairs; for anything else
(indices, crypto, CFDs) Claude looks in the expert logs or asks you. Win rate and the per-hour,
per-symbol and long/short counts never need the contract size.

**Read-only.** Nothing is installed in or changed in MetaTrader. Everything the plugin writes
goes to `.config/rocket` in your user folder (override with `ROCKET_HOME`). Terminals in other
places: `ROCKET_MT5_PATHS` (folders separated by `;` on Windows, `:` elsewhere), or tell Claude
the folder (MT5: File → Open Data Folder).

### Develop

```
claude plugin test .         # the engine (macOS, Windows, Linux layouts) and the pane
claude plugin validate .
claude --plugin-dir .        # a session with this checkout loaded
```

See `CLAUDE.md` for the layout.
