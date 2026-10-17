#!/usr/bin/env zsh

# Smoke test of bin/rocket against a fake MT5 terminal built from
# tests/fixtures/journal (anonymised, UTF-8 there, UTF-16LE + CRLF as MT5
# writes them here) and a throwaway state dir: zsh tests/cli.zsh

set -o errexit -o pipefail -o nounset

PA=${0:A:h:h}/bin/rocket
FIXTURES=${0:A:h}/fixtures
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export ROCKET_HOME=$TMP/home
failures=0

check() {
    local what=$1 want=$2 got=$3
    if [[ $got == $want ]]; then
        print -- "ok   $what"
    else
        print -- "FAIL $what: want '$want', got '$got'"
        (( ++failures ))
    fi
}

# A terminal the way the MetaQuotes app installs one.
TERMINAL="$TMP/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5"
mkdir -p "$TERMINAL/logs" "$TERMINAL/MQL5/Logs"
touch "$TERMINAL/terminal64.exe"
for f in $FIXTURES/journal/*.log; do
    sed 's/$/\r/' $f | iconv -f UTF-8 -t UTF-16LE > "$TERMINAL/logs/${f:t}"
done
export ROCKET_MT5_PATHS="$TMP/Application Support"

status() { $PA run status | jq -r "$1"; }
trade() { jq -r --arg p $1 ".trades[] | select(.position == \$p) | $2" $($PA run dir)/trades.json; }
group() { jq -r --arg id $1 ".groups[] | select(.id == \$id) | $2" $($PA run dir)/stats.json; }

# run
$PA run start --from 2026-01-05 --to 20260106 >/dev/null
check "range" "2026-01-05 2026-01-06" "$(status '"\(.range.from) \(.range.to)"')"
check "five stages" "discover read parse analyse report" "$(status '[.stages[].name] | join(" ")')"
check "bad date refused" 1 "$($PA run start --date 2026-13-45 2>/dev/null; print $?)" || true

# steps
$PA discover >/dev/null
check "terminal found" "net.metaquotes.wine.metatrader5" "$(jq -r '.[0].label' $($PA run dir)/terminals.json)"
check "terminals job" success "$(status .jobs.terminals.status)"
$PA read >/dev/null
check "two journals decoded" "2 day log(s) decoded" "$(status .jobs.journal.note)"
check "no expert logs" skipped "$(status .jobs.experts.status)"
$PA parse >/dev/null
check "trades job" "5 trade(s) on 2 account(s)" "$(status .jobs.trades.note)"
check "failed order" "warning|1 failed order(s): 1× No money" "$(status '"\(.jobs.failed.status)|\(.jobs.failed.note)"')"
check "broker and server" "Example Broker Ltd Demo-Server1" "$(jq -r '.accounts[] | select(.account == "11111111") | "\(.broker) \(.server)"' $($PA run dir)/trades.json)"

# trades
check "closed by TP" "tp 2030 2000" "$(trade 1001 '"\(.closed_by) \(.exit) \(.pnl)"')"
check "SL to break-even seen" "true 1 2000" "$(trade 1001 '"\(.sl_at_breakeven) \(.sl_changes) \(.sl_initial)"')"
check "realised and planned R" "2 2" "$(trade 1001 '"\(.r) \(.planned_rr)"')"
check "partial then SL" "partial → sl -110 2" "$(trade 1003 '"\(.closed_by) \(.pnl) \(.exits | length)"')"
check "close of a position opened before the logs" "null 1995 1000 manual" "$(trade 999 '"\(.open_at) \(.entry) \(.pnl) \(.closed_by)"')"
check "trigger logged after its deal" "sl 2050 -1000" "$(trade 1010 '"\(.closed_by) \(.exit) \(.pnl)"')"
check "position over midnight" "2026-01-05 2026-01-06 closed" "$(trade 2001 '"\(.open_at[0:10]) \(.close_at[0:10]) \(.status)"')"
check "unknown contract size" "null null" "$(trade 2001 '"\(.pnl) \(.contract)"')"

# stats
$PA analyse >/dev/null
check "pnl warns about US30" warning "$(status .jobs.pnl.status)"
check "groups" "all 11111111 22222222" "$($PA run status >/dev/null; jq -r '[.groups[].id] | join(" ")' $($PA run dir)/stats.json)"
check "account win rate" "50 2 2" "$(group 11111111 '"\(.win_rate) \(.wins) \(.losses)"')"
check "account money" "1890 1500 -555 2.7 USD" "$(group 11111111 '"\(.net) \(.avg_win) \(.avg_loss) \(.rrr) \(.currency)"')"
check "best symbol" "XAUUSD 2000" "$(group 11111111 '"\(.best_symbol.symbol) \(.best_symbol.net)"')"
check "buy and sell" "3 1 1" "$(group 11111111 '"\(.by_side.buy.n) \(.by_side.sell.n) \(.by_side.sell.losses)"')"
check "open hours (a trade without open time not counted)" "9:4" "$(group all '.by_hour | map(select(.n > 0)) | map("\(.hour):\(.n)") | join(",")')"
check "no money across unknown sizes" "null false" "$(group all '"\(.net) \(.money.ok)"')"
check "win rate without money" "100" "$(group 22222222 .win_rate)"
check "equity curve" "1000,3000,2890,1890" "$(group 11111111 '.equity | map(.cum) | join(",")')"
check "net per day" "2026-01-05:2890,2026-01-06:-1000" "$(group 11111111 '.by_day | map("\(.date):\(.net)") | join(",")')"
check "day win rate" 50 "$(group 11111111 .day_win_rate)"
check "largest win and loss" "2000 -1000" "$(group 11111111 '"\(.largest_win) \(.largest_loss)"')"
check "hold time of the winners (the orphan has none)" 70 "$(group 11111111 .avg_hold_win)"

# table
check "table rows" 5 "$($PA table | grep -c '^| [0-9]')"
check "open time unknown in table" 1 "$($PA table | grep -c '| unknown | buy | XAUUSD | 1 | 1995 | 2005 |')"

# one account
$PA run start --from 2026-01-05 --to 2026-01-06 --account 11111111 >/dev/null
check "account filter kept" '["11111111"]' "$(status '.accounts | tojson')"
$PA discover >/dev/null && $PA read >/dev/null && $PA parse >/dev/null && $PA analyse >/dev/null
check "only that account's trades" "4 trade(s) on 1 account(s)" "$(status .jobs.trades.note)"
check "only that account's failures" "1" "$(jq '.failed | length' $($PA run dir)/trades.json)"
check "one group, no 'all'" "11111111" "$(jq -r '[.groups[].id] | join(" ")' $($PA run dir)/stats.json)"
$PA run start --date 2026-01-05 --account 99999999 >/dev/null
$PA discover >/dev/null && $PA read >/dev/null && $PA parse >/dev/null
check "unknown account warns" "warning|account 99999999 not in the logs of this period; seen: 11111111, 22222222" "$(status '"\(.jobs.trades.status)|\(.jobs.trades.note)"')"
check "account must be digits" 1 "$($PA run start --account abc 2>/dev/null; print $?)" || true

# finish
$PA run start --from 2026-01-05 --to 2026-01-06 >/dev/null
$PA job table running "writing" && $PA run finish success "5 trades"
check "finish skips pending" "success skipped canceled" "$(status '"\(.status) \(.jobs.story.status) \(.jobs.table.status)"')"
check "unknown job refused" 1 "$($PA job nope success 2>/dev/null; print $?)" || true

if (( failures )); then
    print -- "$failures failure(s)"
    exit 1
fi
print -- "all passed"
