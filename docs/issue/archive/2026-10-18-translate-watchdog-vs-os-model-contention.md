---
title: daemon の translate watchdog が、OS の on-device モデルの混雑中に正常な翻訳を「詰まった」と判断して helper を kill しうる
status: resolved
category: bug
created: 2026-10-18T14:25:44+09:00
last_read: 2026-10-18T18:07:42+09:00
open_entered: 2026-10-18T14:25:44+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T18:24:42+09:00
discard_reason:
pending_reason:
close_reason: ["finding/2026-07-17-macos-translation-poc","dr/DR-0023","implemented"]
blocked_by:
origin: 自リポ TODO
---

# daemon の translate watchdog が、OS の on-device モデルの混雑中に正常な翻訳を「詰まった」と判断して helper を kill しうる

## 現象

daemon の翻訳サービス (packages/daemon/src/translate-helper.ts) の watchdog は、入力の長さに比例した期限 (基本 10 秒 + 100 文字ごとに 1 秒。短い 1 文なら 11 秒) を超えた request を「helper が詰まった」とみなし、helper を kill して失敗を返す。前提は「Translation.framework は短い文を約 2 秒で返す」(同ファイルのコメント、2026-07-18 の計測)。

この前提は、OS の on-device モデルが混んでいる間は成り立たない。Translation.framework の推論は OS の 3B モデル (modelmanagerd 配下) を他の利用者と共有している。OS 自身の文章解析 (mediaanalysisd から呼ばれる textunderstandingd の TextPersonExtraction) が走っている間は、1 文の翻訳が 10〜30 秒かかる。その間に webui で翻訳を開くと、helper は詰まっておらず待たされているだけなのに、watchdog が kill して翻訳が失敗しうる (webui での再現は未確認。推論の時間と watchdog の値からの推定)。

## 観測 (2026-10-18、macOS、modelmanagerd のログ)

- OS の文章解析が始まった時刻: 11:13 / 12:14 / 13:14 / 14:13 (ほぼ 1 時間ごと、各 2〜3 分)。解析の request は 1 件 14〜44 秒。
- その時間帯に重なった翻訳の request:

| 時刻 | 翻訳の所要 | 重なっていた解析の request |
|---|---|---|
| 13:15:17 | 12.49 s | 13:14:59 → 13:15:37 (38.18 s) |
| 13:15:40 | 30.62 s | 13:15:40 → 13:16:24 (44.00 s) |
| 13:16:11 | 13.24 s | 同上 |
| 14:15:23 | 10.49 s | 14:15:04 → 14:15:33 (29.19 s) |
| 14:15:43 | 16.99 s | 14:15:40 → 14:16:04 (23.64 s) |

- 解析が走っていない時の翻訳は、1 文でほぼ 0.5 秒前後 (helper の起動から数えて 1.2〜1.6 秒)。
- 解析が見えないのに 3.5〜3.7 秒かかった翻訳が 3 件あった (13:16:27 / 13:41:12 / 13:49:42)。原因は特定できていない。
- どの依頼も優先度は background で決まっていた (modelmanagerd の "Resolved priority ... to background")。翻訳が解析より優先される経路は見当たらない。
- CPU の負荷 (load average 27) だけでは翻訳は遅くならなかった (1.2〜1.6 秒)。
- 計測の経緯と表の出どころは archive の issue just-test-one-timeout-unidentified。

## watchdog の前提が崩れる条件

- OS の他の利用者 (少なくとも OS の文章解析) が同じモデルで推論している間。1 時間ごとに数分起きる
- 観測の最大値は 30.6 秒で、短い入力の期限 11 秒の約 3 倍

## 改善案の候補 (裏取りしてから採否を決めて)

当事者の判断に委ねる。どれも未検証:

1. 固定の期限ではなく「進んでいるか」を観測して判断する。例: helper から心拍や進捗を返させる。または OS 側の混雑 (他の利用者の推論中) が見えるならそれを待ちの理由として扱う。Translation.framework / modelmanagerd がそうした信号を外に出しているかは未調査
2. 期限を超えたら kill せず、もう少し待つか再試行する。詰まったのか待たされているのかを区別できないと、本当に詰まった時 (14.7k 文字で返らなかった観測がある) の回復が遅れる
3. 期限を超えた時に失敗ではなく「保留中」として webui に返し、後から結果を届ける。protocol と webui の表示に手が要る

あわせて、期限の値の根拠 (2026-07-18 の計測) を混雑時の分布で測り直す必要がある。

## 関連

- test 側の扱い: translate-helper.test の実物の翻訳の test は、service の watchdog に 25 秒を渡している (commit lmptxuyq)。OS の解析と重なると 30 秒台で落ちうる。製品の watchdog の扱いが決まったら合わせて見直す

## 再現と対応 (2026-10-18)

- 再現: modelmanagerd のログで OS の文章解析 (TextPersonExtraction) の開始を待ち、そこから 4 分間、daemon の翻訳サービス (当時の既定の watchdog、短い入力で 11 s) で短い 1 文を途切れなく送った。315 件中 1 件が 11.0 s で「timed out after 11000ms; helper killed」になった。解析は 18:13 に始まった (この日は 17:41 にも。毎時同じ分ではない)
- 混雑時の分布 (成功 314 件): p50 0.63 s / p90 0.67 s / p99 3.6 s / 最大 10.8 s。解析の開始から 50 秒の間に 10.8 / 5.0 / 7.9 / 6.5 / 3.6 s。本文の表の最大は 30.6 s
- 改善案 1 (進み具合で判断) の裏取り: helper は答えるまで stdout / stderr に何も出さず、プロセスは待ちでも詰まりでも生きている。Translation.framework の `translations(from:)` は 1 回の await で途中経過を返さない。modelmanagerd のログには request の形成が出るが OS のログで公開 API ではない。よって採らない
- 詰まりは実在する: 14.7k 文字の 1 段落を helper に送ると、推論の request が約 2 分で 208 件作られた後に止まり、推論のプロセスの CPU 0 % のまま 12 分返らなかった。期限による回復は要る
- 改善案 2・3: 2 (期限超過で待ち足す・再試行) は詰まりとの区別が付かない点で 1 と同じ。3 (保留中として返す) は protocol と webui の変更が要り、期限を混雑より長くすれば要らない
- 対応: 期限を `60s + 1s/100 文字、上限 240s` にした (commit xlkqlxmy)。基本 60 s は観測した最大の待ち 30.6 s の 2 倍。数字は findings (docs/findings/2026-07-17-macos-translation-poc.md) に記録し、DR-0023 に addendum §7 を足した。仕様の test「1 文の request の期限が混雑時の最大の待ちより長い」を足した (旧値 11 s では落ちる)
- 関連の test: translate-helper.test の実物の翻訳は、固定の 25 s でなく製品の既定の期限で走らせるようにした (遅い時に落ちるのは製品も詰まりと判断する時だけ)
- 残り: 詰まった長文の回復は最大 240 s 待つ。webui からの取り消し (op の cancel) は無い
