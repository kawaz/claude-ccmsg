# 端末ごとの webui の繋ぎ先 (IPv4 / IPv6)

前段 Caddy の HTTP/3 で iPhone / iPad の Safari が再読み込みで固まる件 (findings `2026-10-25-safari-reload-freeze.md`、原因未確定) への運用上の回避。端末ごとに繋ぎ先のホスト名を変える。

| 端末 | 繋ぎ先 | 経路 |
|---|---|---|
| Mac (PC) | 従来どおり `ccmsg_url` のホスト (Tailscale の IPv4) | Mac から自分の Tailscale の IPv6 宛ては TCP が繋がらない (下記) ので IPv4 のまま |
| iPhone / iPad | `ccmsg.v6-sandbox.kawaz.jp` (AAAA のみ、A は置かない) | Tailscale の IPv6。kernel の IPv6 は DF が効き、quic-go の packet が interface の MTU (1280) に収まるため、Tailscale の MTU と QUIC の fragment の問題を避けられる **かもしれない** (要経過観察) |

## Mac から自分の Tailscale IPv6 宛てが繋がらない (観測 2026-10-26)

この Mac 自身から自分の tailnet IPv6 宛ての TCP は timeout する。他の tailnet 端末 (iPhone / iPad) からは同じ IPv6 で届く (前段 Caddy の v6-sandbox の access log に h2 / h3 の 200 あり)。

| 宛先 | 結果 |
|---|---|
| `nc -6 -z <自分の Tailscale IPv6> 443` | Operation timed out |
| `curl -6 https://ccmsg.v6-sandbox.kawaz.jp/` | 8 秒 timeout (2/2) |
| 同じ名前を `--resolve ...:443:127.0.0.1` / `::1` に向ける | 200 |
| 自分の Tailscale IPv4 の 443 | 200 |
| `ping6 <自分の Tailscale IPv6>` | 通る |

`route -n get` では自分の IPv6 は `lo0` (flags LOCAL)。読み (未確定): macOS の Tailscale (network extension) が自分の tailnet IPv6 宛てを折り返さない。

## 経過観察で見るもの

- iPhone / iPad で `ccmsg.v6-sandbox.kawaz.jp` を使い続けて、daemon の版が上がった直後の青いボタン (再読み込み) で固まるかどうか
- 固まらなくなったら、fragment (findings の候補 1) の側が濃くなる。固まるなら候補 1 だけでは説明がつかない
- 固まった時は findings の「切り分けの実験」の手順 (pcap / qlog / Tailscale の metrics) で観測する

## 注意

- 通知やメッセージに入る `ccmsg_url` は IPv4 側のホストを指す。iPhone / iPad でその link を開くと IPv4 の経路に戻る
- `*.v6-sandbox.kawaz.jp` の DNS と cert の持ち物は privacy-personal の reference `v6-sandbox-zone` (AAAA の編集ロール、Caddy の site)
