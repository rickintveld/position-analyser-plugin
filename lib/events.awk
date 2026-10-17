# Turns MetaTrader 5 terminal journal lines (UTF-8, tab separated:
# code, level, time, source, message) into one JSON event per line for
# lib/trades.jq. Run with -v date=YYYY-MM-DD -v terminal=<index>.
#
# Events: auth (server/broker per account), open_req, close_req, trigger
# (SL/TP/stop out), deal, modify (confirmed SL/TP change) and failed.

BEGIN { FS = "\t" }

function esc(s) {
    gsub(/\\/, "\\\\", s)
    gsub(/"/, "\\\"", s)
    return s
}

function num(s) {
    gsub(/[^0-9.\-]/, "", s)
    return s == "" ? "null" : s + 0
}

function head(type) {
    return "{\"type\":\"" type "\",\"terminal\":" terminal ",\"account\":\"" account "\",\"at\":\"" date " " substr($3, 1, 8) "\",\"seq\":" NR
}

# The value after a label token ("sl:", "tp:") in t[1..n], or null.
function after(label,    i) {
    for (i = 1; i < n; i++) if (t[i] == label) return num(t[i + 1])
    return "null"
}

{ sub(/\r$/, "") }

$4 != "Trades" && $4 != "Network" { next }

{
    msg = $5
    if (msg !~ /^'[0-9]+': /) next
    account = substr(msg, 2, index(msg, "':") - 2)
    msg = substr(msg, index(msg, "': ") + 3)
    n = split(msg, t, " ")
}

$4 == "Network" && msg ~ /^authorized on / {
    server = substr(msg, 15)
    sub(/ through .*/, "", server)
    sub(/ \(.*/, "", server)
    print head("auth") ",\"server\":\"" esc(server) "\"}"
    next
}

$4 == "Network" && msg ~ /^terminal synchronized with / {
    broker = substr(msg, 28)
    sub(/:.*/, "", broker)
    print head("auth") ",\"broker\":\"" esc(broker) "\"}"
    next
}

$4 != "Trades" { next }

msg ~ /^failed / {
    reason = msg
    if (reason ~ /\[[^]]*\]$/) { sub(/.*\[/, "", reason); sub(/\]$/, "", reason) } else reason = ""
    text = substr(msg, 8)
    sub(/ \[[^]]*\]$/, "", text)
    print head("failed") ",\"text\":\"" esc(text) "\",\"reason\":\"" esc(reason) "\"}"
    next
}

# market buy 2.55 XAUUSD, close #15305734 sell 2.55 XAUUSD 4182.60
t[1] == "market" && t[5] == "close" {
    sym = t[4]; sub(/,$/, "", sym)
    print head("close_req") ",\"side\":\"" t[2] "\",\"volume\":" num(t[3]) ",\"symbol\":\"" esc(sym) "\",\"position\":\"" substr(t[6], 2) "\",\"position_side\":\"" t[7] "\",\"entry\":" num(t[10]) ",\"reason\":\"manual\"}"
    next
}

# market sell 2.55 XAUUSD sl: 4186.70 tp: 4178.72
t[1] == "market" && (t[2] == "buy" || t[2] == "sell") {
    print head("open_req") ",\"side\":\"" t[2] "\",\"volume\":" num(t[3]) ",\"symbol\":\"" esc(t[4]) "\",\"sl\":" after("sl:") ",\"tp\":" after("tp:") "}"
    next
}

# stop loss triggered #N buy 2.98 XAUUSD 4186.39 sl: 4183.09 [...]
msg ~ /^(stop loss|take profit|stop out) triggered #/ {
    reason = msg ~ /^stop loss/ ? "sl" : msg ~ /^take profit/ ? "tp" : "stop_out"
    k = reason == "stop_out" ? 3 : 4
    side = t[k + 1]
    print head("trigger") ",\"reason\":\"" reason "\",\"position\":\"" substr(t[k], 2) "\",\"position_side\":\"" side "\",\"side\":\"" (side == "buy" ? "sell" : "buy") "\",\"volume\":" num(t[k + 2]) ",\"symbol\":\"" esc(t[k + 3]) "\",\"entry\":" num(t[k + 4]) "}"
    next
}

# deal #14967716 sell 2.55 XAUUSD at 4182.60 done (based on order #15305734)
t[1] == "deal" && t[6] == "at" && msg ~ / done / {
    print head("deal") ",\"deal\":\"" substr(t[2], 2) "\",\"side\":\"" t[3] "\",\"volume\":" num(t[4]) ",\"symbol\":\"" esc(t[5]) "\",\"price\":" num(t[7]) ",\"order\":\"" substr(t[n], 2, length(t[n]) - 2) "\"}"
    next
}

# modify #N sell 2.55 XAUUSD -> sl: 4186.70, tp: 4178.11 done in 12.548 ms
t[1] == "modify" && t[6] == "->" && msg ~ / done in / {
    print head("modify") ",\"position\":\"" substr(t[2], 2) "\",\"sl\":" after("sl:") ",\"tp\":" after("tp:") "}"
    next
}
