# The numbers the report and the charts show, from trades.json (lib/trades.jq).
#
#   jq -f stats.jq trades.json
#
# One group per account, plus "all" when there is more than one account.
# Win/loss comes from the price move, so it is known for every closed trade;
# money figures (net, average win/loss, RRR, P/L per symbol, hour and side)
# only when every closed trade of the group has a P/L in one and the same
# currency, otherwise they are null and `money` says why.

def round2: if . == null then null else (. * 100 | round) / 100 end;
def avg: map(select(. != null)) | if length == 0 then null else add / length end;
def epoch: strptime("%Y-%m-%d %H:%M:%S") | mktime;
def held: if .open_at == null or .close_at == null then null else (.close_at | epoch) - (.open_at | epoch) end;
def pct($part; $whole): if $whole == 0 then null else $part * 100 / $whole | round2 end;

# Wins, losses and P/L of a set of closed trades; $money tells whether P/L counts.
def tally($money):
  {n: length,
   wins: map(select(.move > 0)) | length,
   losses: map(select(.move < 0)) | length,
   net: (if $money then map(.pnl) | add // 0 | round2 else null end)}
  | . + {win_rate: pct(.wins; .n)};

def group($id; $label; $trades; $failed):
  ($trades | map(select(.status == "closed" and .move != null))) as $closed
  | ($closed | map(.currency) | unique) as $currencies
  | (if $closed == [] then {ok: false, why: "no closed trades"}
     elif ($closed | any(.pnl == null)) then {ok: false, why: "contract size unknown for " + ($closed | map(select(.pnl == null) | .symbol) | unique | join(", "))}
     elif ($currencies | length) > 1 then {ok: false, why: "several currencies: " + ($currencies | join(", "))}
     else {ok: true, currency: $currencies[0]} end) as $money
  | ($closed | map(select(.move > 0))) as $wins
  | ($closed | map(select(.move < 0))) as $losses
  | ($wins | map(.pnl) | avg) as $avg_win
  | ($losses | map(.pnl) | avg) as $avg_loss
  | ($closed | group_by(.symbol) | map({symbol: .[0].symbol} + tally($money.ok))
     | sort_by(if $money.ok then -.net else -.win_rate end, -.n)) as $symbols
  | {
      id: $id,
      label: $label,
      trades: ($trades | length),
      closed: ($closed | length),
      open: ($trades | map(select(.status == "open")) | length),
      failed: ($failed | length),
      money: $money,
      currency: $money.currency,
      wins: ($wins | length),
      losses: ($losses | length),
      breakeven: ($closed | map(select(.move == 0)) | length),
      win_rate: pct($wins | length; $closed | length),
      net: (if $money.ok then $closed | map(.pnl) | add | round2 else null end),
      # share of trading days that ended in profit (by P/L, else by more wins than losses)
      day_win_rate: ($closed | group_by((.close_at // .open_at)[0:10])
                     | pct(map(select(if $money.ok then (map(.pnl) | add) > 0 else (map(select(.move > 0)) | length) > (map(select(.move < 0)) | length) end)) | length; length)),
      avg_win: (if $money.ok then $avg_win | round2 else null end),
      avg_loss: (if $money.ok then $avg_loss | round2 else null end),
      # average win divided by the size of the average loss
      rrr: (if $money.ok and $avg_win != null and $avg_loss != null and $avg_loss != 0 then $avg_win / ($avg_loss | fabs) | round2 else null end),
      # realised R per trade (move / initial SL distance) and the planned reward:risk
      avg_r: ($closed | map(.r | select(. != null)) | avg | round2),
      planned_rr: ($closed | map(.planned_rr | select(. != null)) | avg | round2),
      profit_factor: (if $money.ok and ($losses | length) > 0
                      then ($wins | map(.pnl) | add // 0) / ($losses | map(.pnl) | add | fabs) | round2 else null end),
      best_symbol: ($symbols[0] // null),
      by_symbol: $symbols,
      by_side: ($closed | {buy: (map(select(.side == "buy")) | tally($money.ok)),
                           sell: (map(select(.side == "sell")) | tally($money.ok))}),
      largest_win: (if $money.ok then $wins | map(.pnl) | max else null end),
      largest_loss: (if $money.ok then $losses | map(.pnl) | min else null end),
      # average holding time in seconds, of winners and of losers
      avg_hold_win: ($wins | map(held) | avg | if . == null then null else round end),
      avg_hold_loss: ($losses | map(held) | avg | if . == null then null else round end),
      # the cumulative P/L after each closed trade, in closing order
      equity: (if $money.ok
               then $closed | sort_by(.close_at // .open_at)
                    | reduce .[] as $t ([]; . + [{at: ($t.close_at // $t.open_at), symbol: $t.symbol, pnl: $t.pnl,
                                                  cum: ((.[-1].cum // 0) + $t.pnl | round2)}])
               else [] end),
      by_day: ($closed | group_by((.close_at // .open_at)[0:10]) | map({date: (.[0].close_at // .[0].open_at)[0:10]} + tally($money.ok))),
      by_hour: [range(0; 24) as $h
                | {hour: $h} + ($closed | map(select(.open_at != null and (.open_at[11:13] | tonumber) == $h)) | tally($money.ok))]
    };

. as $all
| ($all.accounts | map(
    .account as $a
    | group($a; ([$a, (.server // .broker // empty)] | join(" · ")); $all.trades | map(select(.account == $a)); $all.failed | map(select(.account == $a)))
  )) as $accounts
| {
    range: $all.range,
    groups: ((if ($accounts | length) > 1 then [group("all"; "All accounts"; $all.trades; $all.failed)] else [] end) + $accounts)
  }
