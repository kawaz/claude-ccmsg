# Caddy を tsnet (caddy-tailscale) で独立した tailnet ノードにすると何が変わるか

- Date: 2026-10-26
- 対象: caddy-tailscale plugin (main の `de41b249af4f`)、Caddy v2.11.7、tailscale.com v1.102.2 の tsnet、gVisor (`573d5e7127a8`)。一次資料 (source と README) を読んだだけで、plugin 入りの binary の取得・実行とノード登録は行っていない
- 方法: 各 repo の source を file:line で読んだ。実機の通信は無いので、下の事実は全部「source 上そう読める」であって、観測ではない

## 動機

Caddy を tsnet (caddy-tailscale plugin) で独立した tailnet ノードにすると、(a) この Mac 自身から繋げるか、(b) QUIC の packet の IP fragment (macOS の IPv4 socket で DF が効かず、quic-go が 1280 を超える packet を utun 宛てに出して kernel が割る件、`2026-10-25-safari-reload-freeze.md`) の挙動が変わるか、を一次資料で調べた。

## 判明した事実

1. **HTTP/3 は実装上対応している**
   - plugin は `tailscale/udp` を登録し (`module.go#L34-L39`、commit `de41b249af4f`)、Caddy の h3 listener を `tsnet.Server.ListenPacket` に接続する (`module.go#L155-L241`)
   - Caddy v2.11.7 の QUIC listener は `net.PacketConn` を受ける (`modules/caddyhttp/server.go#L1049-L1082` → `listeners.go#L426-L486`)
   - tsnet v1.102.2 の `ListenPacket` は UDP4 / UDP6 の明示 IP に限る (`tsnet/tsnet.go#L1305-L1355`)。plugin は tailnet IP のうち IPv4 を優先する (`module.go#L191-L224`)
   - 実通信は未検証
2. **build**
   - plugin は tag が無く、main の SHA `de41b249af4f` (最終 push 2026-08-26)。go.mod は Caddy v2.10.2 / tailscale.com v1.102.2 / quic-go v0.54.0
   - 本番の Caddy v2.11.7 との build の互換は未検証
   - Caddy の公式 build server の download URL に `&p=github.com%2Ftailscale%2Fcaddy-tailscale` を足せば、今と同じ経路で取れる見込み。取得と実行は未検証
3. **tsnet にしても fragment は消えない (source 上)**
   - tailscale v1.102.2 の netstack は MTU 1280 の仮想 NIC (`wgengine/netstack/netstack.go#L384-L393`)、UDP は gVisor (`#L1829-L1870`)、WireGuard への注入は `#L1045-L1093`
   - gVisor の `ipv4/ipv4.go#L604-L628` は、ローカルで生成した 1280 超の packet を `handleFragments` で IP fragment に分ける。DF の `ErrMessageTooLong` になるのは forwarded packet の時だけ。`ipv6/ipv6.go#L892-L915` も、ローカルで生成した packet を送信元で fragment する
   - つまり macOS の kernel が行っている fragment が、gVisor の中での fragment に変わるだけ
   - 実際の QUIC の packet size と、wire 上の packet は未検証
4. **この Mac 自身からの到達**
   - tsnet は既定 (fake TUN) で `netstack.ProcessLocalIPs=true` になる (`tsnet.go#L868-L884`)。self-addressed の packet は gVisor に直接 loopback される (`netstack.go#L1079-L1086`)
   - source 上は、同じ Mac から実験ノードに届く経路がある。実通信は未検証
5. **認証**
   - ノードの登録には、ephemeral を許す auth key (または tag 付きの OAuth。README#L46-L53 は、OAuth で生成した token では ephemeral の設定が効かないと書く) が要る
   - 接続元から実験ノードへの tcp/443 と udp/443 を許す tailnet の ACL / Grants が要る
   - `module.go#L267-L295` が、Ephemeral / StateDir / 認証を `tsnet.Server` に渡す

### 認証と state (source のみ)

- `auth_key` は文字列 (plugin `app.go:115-120,183-187`)。node → global → 環境変数 `TS_AUTHKEY_<NODE 大文字>` → `TS_AUTHKEY` の順に選び (`module.go:309-330`)、tsnet 側で `TS_AUTH_KEY` にも fallback する (`tsnet.go:722-729`)。明示した値には Caddy の placeholder 展開が効くので `{env.TS_AUTHKEY}` と `{file./absolute/path}` が使える (Caddy v2.11.7 `replacer.go:350-385`、file は 1 MiB まで・末尾の改行を除く)。素のパスや `file://` は展開されずそのまま key の文字列になる。コマンドや pipe から値を得る口は無い
- `state_dir` の `tailscaled.state` に登録済みのノードがあれば auth key 無しで起動できる (README:156-163、`module.go:291-295,372-393`、`tsnet.go:219-251,918-968`)。初回登録を別プロセスで済ませて Caddy の常時起動には auth key を渡さない構成は source 上は可能。別プロセス間の引き継ぎと同時起動の禁止は実機未検証
- `ephemeral true` は global か node block (`app.go:126-135,193-202`、node が優先 `module.go:342-349`)。tailnet 上のノードは切断後に消えるが、ローカルの `tailscaled.state` は ephemeral でも作られ、停止時に消す実装は見つからない (`tsnet.go:918-932`)。消えた ephemeral ノードの state を次回に auth key 無しで再利用できるかは未検証

## 未確認

- 事実 1 〜 5 の実通信と実機での挙動 (HTTP/3 の疎通、packet size、wire 上の fragment、Mac 自身からの到達)
- plugin と Caddy v2.11.7 の build の互換
- 公式 build server の経路で plugin 入りの binary が取れるか
- `auth_key` の受け口 (placeholder / file のどちらで渡せるか)
- 初回登録の後、`state_dir` だけで (auth key 無しに) 起動できるか

## 構成案 (本番に触れない別プロセス)

別の config / storage / admin port の Caddy を立てる。

- global: `tailscale { <node> { ephemeral true; hostname <distinct>; state_dir <scratch>; auth_key … } }` と `servers { protocols h1 h2 h3 }`
- site: `https://<実験用 DNS 名> { bind tailscale/<node>; tls { dns route53 { 既存の DNS-01 } }; reverse_proxy 127.0.0.1:8642 }` (README#L200-L304)
- DNS は実験ノードの Tailscale IP に向ける
- auth key は Caddy の常時起動には渡さず、初回登録だけ別に行って `state_dir` を残す構成が望ましい。ただし `auth_key` の受け口と、`state_dir` だけでの起動の可否は未確認 (上の「未確認」)

## 結論

tsnet は「この Mac 自身から繋ぐ」「ノードを分ける」には効くが、fragment 問題の切り分け・対処にはならない。fragment の切り分けは、内側 IPv6 (kernel の v6 は DF が効く) の実験で行う。
