---
description: Analyse your MetaTrader 5 trades from the terminal logs - the charts in the pane, and per trade and per period what went well, what leaked and what to work on, with reflection questions
argument-hint: "[account ...] [date | from to | 'this week' | 'last 7 days']"
allowed-tools: mcp__rocket__mt5, Read, AskUserQuestion
---

# /rocket:analyse

Help the trader learn from their own trades in the MetaTrader 5 logs on this machine (Windows, or
wine on macOS and Linux): what went well, what cost money, and what to work on next. The
statistics are in the pane: it shows the pipeline while the data is gathered and turns into the
charts as soon as `review` is done, so the trader has them in view while you write the report and
ask the reflection questions. The report is about the trader's actions, not the numbers again.

**Read-only.** Install nothing, change nothing in MetaTrader 5, never write into its folders.
Everything goes through the `mcp__rocket__mt5` tool, which keeps its state under the user's
`.config/rocket` folder (or `ROCKET_HOME`). Use no shell commands for this: the tool works the
same on every platform, a shell does not.

**Never invent numbers.** Every figure comes from what the tool returns (`trades`, `review`,
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
5. `{action: "review"}`: what the trader did, trade by trade and per period; the answer is the
   review (also `<dir>/review.json`). Each trade has `no` (its # in the account's table),
   `clean` (no leak) and `tags`, each with `code`, `kind` (`good`, `leak`, `note`) and `fact`
   (the evidence, with the numbers). Each group (`all` first when there are several accounts,
   then one per account) has `plan_score` (% of closed trades without a leak), `on_plan` against
   `off_plan` (n, wins, losses, `sum_r`, `avg_r`, `net`), `tags` (per code: how often, which
   trades, `sum_r`, `net`), `failed` by reason, `max_loss_streak` and `busiest_day`. `reflect`
   lists the trades to ask about; `journal` on a trade holds the trader's earlier answers.
   `review` ends the run with success: the pane now shows the charts. Do not call `finish`
   after it.

   The tags: good `plan_followed` (SL and TP at open, never loosened, closed by SL/TP),
   `protected` (SL to break-even or better), `scaled_out` (part taken off in profit); leak
   `no_sl`, `sl_widened` (moved away from the entry or removed), `tp_removed`, `closed_early`
   (by hand in profit below half the planned R), `over_plan` (lost more than 1R), `stop_out`,
   `revenge` (opened within `limits.revenge_min` minutes of a loss), `size_up` (more lots than
   the losing trade before, same symbol), `streak` (after losses in a row that day); note
   `tp_pulled`, `tp_extended`, `cut_short` (closed by hand at a loss before the SL).

## 3. The report

**No statistics in the text.** Win rate, profit factor, P&L per day, symbol, hour and side,
average win and loss, hold times: the pane shows them all. Do not repeat them. The report is about
what the trader did and what they can do differently.

**Tone: direct, by facts.** Say plainly what happened and what it cost, as a coach who has the
logs in front of them: "You moved the SL from 2000 to 1995 and lost 1.5R on a trade planned at
1R." No softening, no praise without evidence, no moralising, no guesses about feelings or
intentions: those come from the trader, in the reflection. Good trades get the same directness:
"SL and TP set, left alone, TP hit at +2R. That is the trade to repeat." The logs do not show the
price after a close, so never say what would have happened ("TP would have been hit").

`{action: "table"}` (markdown). Per account (heading: account number + broker/server):

- The table from `table`, unchanged.

### Per trade

Under the table, every trade with a `leak` or `good` tag gets its own short block, in table order:

> **#3 · sell XAUUSD · +0.4R** · ✗ closed early · ✗ revenge · ✗ after 2 losses
> What happened: the facts of its tags, as one or two sentences.
> Why it matters: the cost or the gain in R (and money when known), plainly.
> Next time: one concrete action that follows from the facts ("leave the TP at 1970 or close
> only at a level you wrote down before entering").

Mark good tags with ✓ and leaks with ✗; notes (`tp_pulled`, `tp_extended`, `cut_short`) go in
"what happened" without a mark. Trades with only notes or no tags at all go together in one line
("#5, #6: nothing to remark"). A trade with an earlier `journal` entry: quote the trader's own
lesson beside it. An open trade: say it is still open, review only what is known so far.

### Patterns this period

Per group (all accounts first when there are several), from the review's group:

- **On plan against off plan**: `plan_score`, then `on_plan` and `off_plan` side by side (trades,
  `sum_r`, `net`). This is the mirror: "the 3 trades where you deviated cost −2.1R together; the
  one you left alone made +1R."
- **What works**: the `good` tags with their trades. Strengths first.
- **What leaks**: the `leak` tags, most frequent first, each with its trades and `sum_r` (and
  `net`). Name the pattern behind them when the facts show one (revenge and size_up together:
  "after a loss you go back in quicker and bigger").
- Failed orders by reason, only when there are any (`No money` means the size was too big for
  the account), and `max_loss_streak` / `busiest_day` when they connect to a leak.

### One focus

End the analysis with **one** focus for the next period: the leak that cost the most R, turned
into a rule the trader can check next time with `/rocket:analyse` ("no new trade within 15 minutes
of a loss", "the SL only moves towards the profit"). Measurable, not "more discipline".

## 4. Reflection

Always, unless `reflect` is empty. Per trade in `reflect` (at most three), ask with AskUserQuestion, in the user's language, naming the
trade (#no, side, symbol, the fact that put it in the list: `costliest_leak`, `best_on_plan` or
`after_loss`). One call, up to four questions, each with 2-4 short options (the user can always
type their own):

- **setup**: what was the reason to enter? (options from what the trade shows, e.g. "breakout",
  "pullback", "no clear setup")
- **plan**: did you follow your plan? ("yes", "no, I changed it during the trade", "I had no
  plan")
- **feeling**: what drove the decision that the tag points at? ("confidence", "fear of missing
  out", "winning back a loss", "fear of losing the profit")
- **lesson**: what do you take from it? (options drawn from the facts; their own words welcome)

Keep each answer with `{action: "reflect", account, position, answers: {setup, plan, feeling,
lesson}}` (only what was answered). Then reflect it back in two or three sentences: tie their
answers to the facts ("you say you wanted the loss back; the log shows you were in again after 2
minutes with twice the lots"). If the user skips the questions, accept that without comment.

End by telling the user they can reopen the charts with `/rocket-pane`.

If the user stops you before `review`, finish with `canceled` and the reason. Never leave a run
on `running`.
