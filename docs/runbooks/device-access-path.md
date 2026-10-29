# 端末ごとの webui の繋ぎ先 (IPv4 / IPv6)

前段 Caddy の HTTP/3 で iPhone / iPad の Safari が再読み込みで固まる件 (findings `2026-10-25-safari-reload-freeze.md`、原因未確定) への運用上の回避。端末ごとに繋ぎ先のホスト名を変える。

| 端末 | 繋ぎ先 | 経路 |
|---|---|---|
| Mac (PC) | `ccmsg.kawaz-mbp.kawaz.jp` (= `ccmsg_url`、A のみ) または `ccmsg.v4-kawaz-mbp.kawaz.jp` | Tailscale の IPv4。Mac から自分の Tailscale の IPv6 宛ては TCP が繋がらない (下記) ので IPv4 を使う |
| iPhone / iPad | `ccmsg.v6-kawaz-mbp.kawaz.jp` (AAAA のみ、A は置かない) | Tailscale の IPv6。kernel の IPv6 は DF が効き、quic-go の packet が interface の MTU (1280) に収まるため、Tailscale の MTU と QUIC の fragment の問題を避けられる **かもしれない** (要経過観察) |

## Mac から自分の Tailscale IPv6 宛てが繋がらない (観測 2026-10-26)

この Mac 自身から自分の tailnet IPv6 宛ての TCP は timeout する。他の tailnet 端末 (iPhone / iPad) からは同じ IPv6 で届く (前段 Caddy の access log に h2 / h3 の 200 あり)。

| 宛先 | 結果 |
|---|---|
| `nc -6 -z <自分の Tailscale IPv6> 443` | Operation timed out |
| `curl -6 https://ccmsg.v6-kawaz-mbp.kawaz.jp/` | 8 秒 timeout (2/2) |
| 同じ名前を `--resolve ...:443:127.0.0.1` / `::1` に向ける | 200 |
| 自分の Tailscale IPv4 の 443 | 200 |
| `ping6 <自分の Tailscale IPv6>` | 通る |

`route -n get` では自分の IPv6 は `lo0` (flags LOCAL)。読み (未確定): macOS の Tailscale (network extension) が自分の tailnet IPv6 宛てを折り返さない。

## 経過観察の結果

- 2026-10-28 (kawaz、iPhone): `ccmsg.v6-kawaz-mbp.kawaz.jp` に切り替えてから、青いボタンの再読み込みでほぼ待たされなくなった。IPv4 経路でだけ止まる、という観測が 1 端末で積み上がった。切り分けとしては findings の候補 1 (IPv4 経路での QUIC packet の fragment) の側が濃い

## 経過観察で見るもの

- iPhone / iPad で `ccmsg.v6-kawaz-mbp.kawaz.jp` を使い続けて、daemon の版が上がった直後の青いボタン (再読み込み) で固まるかどうか
- 固まらなくなったら、fragment (findings の候補 1) の側が濃くなる。固まるなら候補 1 だけでは説明がつかない
- 固まった時は findings の「切り分けの実験」の手順 (pcap / qlog / Tailscale の metrics) で観測する

## 注意

- 通知やメッセージに入る `ccmsg_url` は IPv4 側の名前 (`ccmsg.kawaz-mbp.kawaz.jp`)。webui の中で描く link は今の origin に差し替わる (DR-0043 §7) が、通知アプリ等から直接開くと IPv4 の経路になる
- 3 つの名前は daemon の `allowed-origins.json` に並び、先頭が `ccmsg_url` (DR-0043 §7)。GLOBALS の endpoint セレクタで切り替えられる
