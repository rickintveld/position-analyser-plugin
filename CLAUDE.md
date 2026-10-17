# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trading Rocket's public Claude Code plugin `rocket` (marketplace `trading-rocket`, `.claude-plugin/`).
The plugin name is short on purpose: every tool is a command `/rocket:<name>` (`commands/<name>.md`);
add new tools as commands here rather than as new plugins. The first, `/rocket:analyse`, analyses MetaTrader 5
trades from the terminal logs: a trade table per account, then win rate, average RRR, best symbol,
trade open hour, buy vs sell, average win and average loss. Read-only towards MetaTrader. Never
commit real logs or account numbers: fixtures are anonymised (`11111111`, `Example Broker Ltd`).

- Runs on Windows, macOS and Linux with nothing to install: all logic is TypeScript inside the
  plugin. Never add a step that needs a shell, `jq`, `awk` or another tool the user may lack.
- `commands/analyse.md` is `/rocket:analyse [accounts] [period]`: the model-driven workflow. It
  calls the tool `mcp__rocket__mt5` step by step and writes the report (table, a line per trade,
  failures, statistics) from the tool's answers. The model never computes numbers itself.
- `hooks/engine/` is the deterministic part, pure TypeScript: `events.ts` turns journal lines into
  events (the log line shapes it knows are at its top), `trades.ts` rebuilds trades from them,
  `stats.ts` computes the statistics, `pipeline.ts` finds the terminals, decodes the logs
  (UTF-16LE by hand: the plugin environment's `TextDecoder` knows UTF-8 only) and keeps the run
  state; `types.ts` holds the shapes of the JSON files. The engine never touches `$`: the hooks
  module may not hand `$` to another file, so it passes an `Io` (files) and an `Env` (the
  environment variables it reads, by name) instead.
- `hooks/register.tsx` is the hooks module: it registers the tool `mt5` (`mcp__rocket__mt5`, one
  `action` per call) and serves it from the engine, and draws the live pane: the pipeline while a
  run is `running`, the charts of `stats.json` once it finished with `success`.
- A new log line shape needs a line in `tests/fixtures/journals.ts` and a check in
  `tests/engine.test.ts`.

Checks: `claude plugin test .` (engine end to end on an in-memory file system laid out as
macOS/wine, Windows and Linux; the pane); `claude plugin validate .`; type-check with `tsc -p .`
once `.claude-plugin/types/` exists (the engine writes it when it loads the plugin; it is
gitignored).

## State layout

`ROCKET_HOME` (default `<user home>/.config/rocket`, the user home being `HOME` or, on Windows,
`USERPROFILE`):

- `current` — the id of the run the pane shows.
- `runs/<id>/status.json` — `{id, range: {from, to}, status (running|success|failed|canceled),
  active_stage, summary, notes[≤20], started_at, finished_at, stages[{name, jobs[]}], jobs{id:
  {status, note, started_at, finished_at}}}`. Stages: discover [terminals] → read [journal,
  experts] → parse [events, trades, failed] → analyse [pnl, stats] → report [table, story].
- `runs/<id>/terminals.json`, `logs/<terminal>/{journal,experts}/YYYYMMDD.log` (decoded UTF-8),
  `trades.json`, `stats.json`. Paths use `/` on every platform.

## Conventions

- Terminals (`findTerminals`): a folder with `logs/` and `terminal64.exe` or `origin.txt`. Windows
  (`OS=Windows_NT`): `%APPDATA%/MetaQuotes/Terminal/*` (labelled from `origin.txt`) and Program
  Files; elsewhere every wine `drive_c` up to three levels under `~/Library/Application Support`,
  CrossOver bottles and `~/.wine`. `paths` / `ROCKET_MT5_PATHS` (`;` on Windows, `:` elsewhere)
  replace the search. A file over 4 MiB cannot be read by the plugin; `read` reports it.
- The engine's output must stay identical to the first (zsh/awk/jq) version, which was checked
  on real logs (147 trades, 9 accounts); `round2` rounds half away from zero as jq did.
- Trade matching (`trades.ts`): a deal is a close when it matches a pending close request or
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
