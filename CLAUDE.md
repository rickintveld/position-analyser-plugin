# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trading Rocket's public Claude Code plugin `rocket` (marketplace `trading-rocket`, `.claude-plugin/`).
The plugin name is short on purpose: every tool is a command `/rocket:<name>` (`commands/<name>.md`);
add new tools as commands here rather than as new plugins. The first, `/rocket:analyse`, analyses MetaTrader 5
trades from the terminal logs: a trade table per account, then win rate, average RRR, best symbol,
trade open hour, buy vs sell, average win and average loss. Read-only towards MetaTrader. Never
commit real logs or account numbers: fixtures are anonymised (`11111111`, `Example Broker Ltd`).

- `commands/analyse.md` is `/rocket:analyse [period]`: the model-driven workflow. It runs
  the script step by step and writes the report (table, a line per trade, failures, statistics)
  from the script's JSON. The model never computes numbers itself.
- `bin/rocket` (zsh; needs `jq`, `awk`, `iconv`) is the deterministic part: run state,
  `discover`, `read`, `parse`, `analyse`, `table`. Each step reports its own pipeline jobs.
- `lib/events.awk` turns journal lines into JSON events; `lib/trades.jq` rebuilds trades from them;
  `lib/stats.jq` computes the statistics. The log line shapes they know are documented at the top
  of each file; a new shape needs a fixture line in `tests/fixtures/journal/` and a check in
  `tests/cli.zsh`.
- `hooks/register.tsx` is the live pane (a Claude Code hooks module): the pipeline while a run is
  `running`, the charts of `stats.json` once it finished with `success`.

Checks: `zsh -n bin/rocket`; `zsh tests/cli.zsh`; `claude plugin test .`;
`claude plugin validate .`; type-check with `tsc -p .` once `.claude-plugin/types/` exists (the
engine writes it when it loads the plugin; it is gitignored).

## State layout

`$ROCKET_HOME` (default `~/.config/rocket`):

- `current` — the id of the run the pane shows.
- `runs/<id>/status.json` — `{id, range: {from, to}, status (running|success|failed|canceled),
  active_stage, summary, notes[≤20], started_at, finished_at, stages[{name, jobs[]}], jobs{id:
  {status, note, started_at, finished_at}}}`. Stages: discover [terminals] → read [journal,
  experts] → parse [events, trades, failed] → analyse [pnl, stats] → report [table, story].
- `runs/<id>/terminals.json`, `logs/<terminal>/{journal,experts}/YYYYMMDD.log` (decoded UTF-8),
  `events.jsonl`, `trades.json`, `stats.json`.

## Conventions

- Every write to `status.json` goes through `jq_edit` (atomic tmp + `mv` under a `mkdir` lock).
  `set -o errexit -o pipefail -o nounset` is on: guard optional args with `${1:-}`, and
  never name a zsh variable `path` (it is tied to `PATH`).
- Trade matching (`lib/trades.jq`): a deal is a close when it matches a pending close request or
  SL/TP/stop out trigger of the same account, side, symbol and volume (first come first served),
  otherwise it opens position `#<order>`. A close whose position opened before the logs read
  becomes a trade with open time `null` and the entry from the close request. A trigger logged
  after its deal takes back an unrequested opening of the same minute.
- Statistics: win/loss from the price move (always known); money figures only when every closed
  trade of a group has a P/L in one currency, else `null` with `money.why`. Different currencies
  are never added up.
- Job ids are at most 9 characters: the pane's pills are `PILL_INNER` wide. The pane draws the
  pipeline as box-drawing text in the terminal and as one SVG elsewhere (`grid` / `pipelineSvg`),
  and the charts as text bars in the terminal and one interactive SVG elsewhere (`dashboardLines`
  / `dashboardSvg`). Keep each pair in step.
- The charts are a trading-journal dashboard (TradeZella-like): KPI cards (net P&L, trade win %
  gauge, profit factor ring, day win % gauge, avg win/loss bar), the cumulative P&L curve, net P&L
  per day, performance by symbol, by hour opened, long vs short, and largest win/loss and hold times.
  Profit green, loss red, as traders read them, always with a sign beside the number. On the
  desktop one interactive SVG of cards (`dashboardSvg`, hover `<title>`s); in the terminal boxed
  cards and block bars (`dashboardLines`). Check a change by rendering it and looking at it, in
  light and dark.

## The logo

The top left of the pane, in both views, is the logo: the rocket, white on a black rounded tile.
The pane is React, but each surface has its own elements, so it is drawn two ways, or not at all:

- Desktop, editor, mobile (`Svg`): `assets/mascot.svg`, the vector itself, 72×72.
- A terminal that shows pictures (kitty, Ghostty; detected from `TERM_PROGRAM`, `TERM`,
  `KITTY_WINDOW_ID`): `assets/mascot.png` through the terminal's `Image` element,
  `MASCOT_CELLS` (10×5 cells, about square). The PNG is the SVG rendered at 160×160 with a
  transparent background; re-render it when the SVG changes.
- Any other terminal (Terminal.app, iTerm2, tmux) only has text cells: no logo there, the header
  text alone. Never replace the logo with a pixel or text imitation.

Change the two together.
