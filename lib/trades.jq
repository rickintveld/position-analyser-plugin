# Rebuilds trades from the events of lib/events.awk (slurped, all terminals).
#
#   jq -s --arg from YYYY-MM-DD --arg to YYYY-MM-DD --argjson contracts '{"SYM": size}' \
#      --argjson only '["<account>", ...]' -f trades.jq
#
# `only` limits the output to those accounts (empty: all); `seen` lists every
# account in the period, so a caller can tell an unknown account number.
#
# A deal is a close when it matches a pending close (a "close #N" request or an
# SL/TP/stop out trigger) of the same account, side, symbol and volume, first
# come first served; otherwise it opens position #<order>. Positions are tracked
# per terminal; the same account seen by two terminals is merged on position id.

def round2: if . == null then null else (. * 100 | round) / 100 end;
def round5: if . == null then null else (. * 100000 | round) / 100000 end;
def sign: if .side == "buy" then 1 else -1 end;
def same($e): .account == $e.account and .side == $e.side and .symbol == $e.symbol and .volume == $e.volume;
def first_index(f): (to_entries | map(select(.value | f)) | first | .key) // null;

# Contract size per lot: the user's override, else a stated default (metals,
# 6-letter FX pairs), else unknown.
def fx: ["USD","EUR","GBP","JPY","CHF","AUD","NZD","CAD","SEK","NOK","DKK","PLN","HUF","CZK","SGD","HKD","MXN","ZAR","TRY","CNH"];
def base_symbol: ascii_upcase | gsub("[^A-Z]"; "") | .[0:6];
def contract($contracts):
  . as $s | ($contracts[$s] // $contracts[$s | base_symbol]) as $own
  | if $own != null then {size: $own, source: "user"}
    else ($s | base_symbol) as $b
    | if ($b | startswith("XAU")) then {size: 100, source: "default"}
      elif ($b | startswith("XAG")) then {size: 5000, source: "default"}
      elif ($b | length) == 6 and (fx | index($b[0:3])) != null and (fx | index($b[3:6])) != null then {size: 100000, source: "default"}
      else {size: null, source: "unknown"} end
    end;
def quote_currency: base_symbol | if length == 6 then .[3:6] else null end;

def new_trade($e; $req):
  {account: $e.account, position: $e.order, terminal: $e.terminal, symbol: $e.symbol, side: $e.side,
   volume: $e.volume, remaining: $e.volume, open_at: $e.at, entry: $e.price,
   requested: ($req != null), sl_initial: ($req.sl // null), tp_initial: ($req.tp // null),
   sl: ($req.sl // null), tp: ($req.tp // null), sl_changes: 0, tp_changes: 0, exits: []};

# A position closed before the logs we read: what the close request tells us.
def orphan($c):
  {account: $c.account, position: $c.position, terminal: $c.terminal, symbol: $c.symbol, side: $c.position_side,
   volume: null, remaining: null, open_at: null, entry: $c.entry, requested: true,
   sl_initial: null, tp_initial: null, sl: null, tp: null, sl_changes: 0, tp_changes: 0, exits: []};

def close_with($c; $e):
  "\($c.account)/\($c.position)" as $key
  | (.open[$key] // orphan($c)) as $t
  | ($t.exits + [{at: $e.at, price: $e.price, volume: $e.volume, reason: $c.reason, deal: $e.deal}]) as $exits
  | (if $t.remaining == null then 0 else ($t.remaining - $e.volume | round5) end) as $left
  | if $left <= 0
    then del(.open[$key]) | .trades += [$t + {exits: $exits, remaining: 0, volume: ($t.volume // ($exits | map(.volume) | add))}]
    else .open[$key] = ($t + {exits: $exits, remaining: $left})
    end;

def step($e):
  if $e.type == "auth" then .accounts[$e.account] += ($e | {server, broker} | with_entries(select(.value != null)))
  elif $e.type == "failed" then .failed += [$e | {account, terminal, at, text, reason}]
  elif $e.type == "open_req" then .preq += [$e]
  elif $e.type == "close_req" then .pclose += [$e]
  elif $e.type == "trigger" then
    # Some builds log the trigger after its deal, which then looked like an
    # unrequested opening in the same minute: take that deal back as the close.
    (.open | to_entries | map(select(.value.requested == false and .value.exits == [] and (.value | same($e))
      and .value.open_at[0:16] == $e.at[0:16])) | first) as $loose
    | if $loose == null then .pclose += [$e]
      else del(.open[$loose.key]) | close_with($e; $loose.value | {at: .open_at, price: .entry, volume, deal: .position})
      end
  elif $e.type == "modify" then
    "\($e.account)/\($e.position)" as $key
    | if .open[$key] == null then .
      else .open[$key] |= (
        .sl_changes += (if $e.sl != .sl then 1 else 0 end)
        | .tp_changes += (if $e.tp != .tp then 1 else 0 end)
        | .sl_initial = (.sl_initial // $e.sl) | .tp_initial = (.tp_initial // $e.tp)
        | .sl = $e.sl | .tp = $e.tp)
      end
  elif $e.type == "deal" then
    (.pclose | first_index(same($e))) as $ci
    | if $ci != null then .pclose[$ci] as $c | .pclose |= del(.[$ci]) | close_with($c; $e)
      else (.preq | first_index(same($e))) as $ri
      | (if $ri == null then null else .preq[$ri] end) as $req
      | (if $ri == null then . else .preq |= del(.[$ri]) end)
      | .open["\($e.account)/\($e.order)"] = new_trade($e; $req)
      end
  else . end;

def finish($contracts):
  sign as $sign | .entry as $entry
  | (.exits | map(.volume) | add) as $closed
  | (if $closed == null or $closed == 0 then null else (.exits | map(.price * .volume) | add) / $closed end) as $exit
  | (.symbol | contract($contracts)) as $c
  | (if .sl_initial != null and .sl_initial != 0 and .entry != null then (.entry - .sl_initial | fabs) else null end) as $risk
  | (.exits | map(.reason) | unique) as $reasons
  | . + {
      status: (if .remaining == 0 then "closed" else "open" end),
      close_at: (if .remaining == 0 then .exits[-1].at else null end),
      exit: ($exit | round5),
      closed_by: (if .exits == [] then null
                  elif (.exits | length) > 1 then "partial" + (if .remaining == 0 then " → " + .exits[-1].reason else "" end)
                  elif .remaining > 0 then "partial"
                  else $reasons[0] end),
      move: (if $exit == null or .entry == null then null else ($exit - .entry) * $sign | round5 end),
      contract: $c.size, contract_source: $c.source,
      currency: (if $c.size == null then null else (.symbol | quote_currency) end),
      pnl: (if $c.size == null or .entry == null or .exits == [] then null
            else (.exits | map((.price - $entry) * $sign * .volume * $c.size) | add) | round2 end),
      r: (if $risk == null or $risk == 0 or $exit == null then null else ($exit - .entry) * $sign / $risk | round2 end),
      planned_rr: (if $risk == null or $risk == 0 or .tp_initial == null or .tp_initial == 0 then null
                   else (.tp_initial - .entry | fabs) / $risk | round2 end),
      sl_at_breakeven: (if .sl == null or .sl == 0 or .entry == null or .sl_changes == 0 then false
                        else (.sl - .entry) * $sign >= 0 end)
    };

# The trade a terminal knows most about wins when two terminals saw it.
def richness: [(.open_at != null), (.status == "closed"), (.exits | length)];

def in_range($from; $to): ((.open_at // .close_at // .at)[0:10]) as $d | $d >= $from and $d <= $to;

. as $events
| ($contracts // {}) as $contracts
| ($events | group_by(.terminal) | map(
    sort_by(.at[0:10], .seq)
    | reduce .[] as $e ({open: {}, preq: [], pclose: [], trades: [], failed: [], accounts: {}}; step($e))
    | {trades: (.trades + (.open | to_entries | map(.value))), failed, accounts}
  )) as $terminals
| ($terminals | map(.trades) | add // []
   | group_by(.account + "/" + .position) | map(sort_by(richness) | last)
   | map(finish($contracts)) | map(select(in_range($from; $to))) | sort_by(.open_at // .close_at)) as $trades
| ($terminals | map(.accounts) | add // {}) as $known
| ($only // []) as $only
| def wanted: ($only | length) == 0 or (.account as $a | $only | index($a) != null);
  ([$trades[].account] + [$terminals[].failed[] | select(in_range($from; $to)) | .account] | unique) as $seen
| ($trades | map(select(wanted))) as $trades
| {
    range: {from: $from, to: $to},
    only: $only,
    seen: $seen,
    accounts: ([$trades[].account] + [$terminals[].failed[] | select(in_range($from; $to)) | select(wanted) | .account] | unique
               | map(. as $a | {account: $a} + ($known[$a] // {}))),
    trades: ($trades | to_entries | map(.value + {n: (.key + 1)}) | map(del(.remaining, .requested))),
    failed: ($terminals | map(.failed) | add // []
      # a failure two terminals both logged counts once: per line, the most any terminal saw
      | group_by([.account, .at, .text]) | map(group_by(.terminal) | max_by(length) | map(del(.terminal)) | .[])
      | map(select(in_range($from; $to) and wanted)) | sort_by(.at))
  }
