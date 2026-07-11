---
title: リリース後 daemon が旧バージョンのまま配信され続けるギャップの改善
status: open
category: design
created: 2026-07-12T01:22:01+09:00
last_read:
open_entered: 2026-07-12T01:22:01+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# リリース後 daemon が旧バージョンのまま配信され続けるギャップの改善

## 概要

リリース (`just push`) 後、新バージョンの client が daemon に接触するまで
旧 daemon (= 旧 webui bundle 含む) が配信され続けるギャップがある。
newer-wins upgrade の仕組み自体はあるが、**誰も新バージョンで接触しない限り
発動しない**ため、実質的なリリース反映が遅延する。

## 背景

v0.18.0 を `just push` で出荷したが、既存セッション群は旧 plugin cache
(0.17.0) の実体で subscribe し続けていたため newer-wins upgrade が発動せず、
webui の新機能 (Shift+Enter 送信) が使えなかった (2026-07-12)。手動で
0.18.0 実体から rooms を叩いて upgrade を発動させることで解決した。

改善候補 (トレードオフ含む):

- **(a) push 直後に新実体で 1 回 daemon 接触**: `just push` の
  `_local-plugin-reload` 後、新実体の `bin/ccmsg` で 1 回 daemon に接触して
  upgrade を即時発動する task を追加する。最小構成でこのリポ内 (justfile)
  だけで完結し、確実性も高い。ただし「push した端末だけ」しか即時反映され
  ず、他端末の旧セッションは従来どおり自然接触待ちになる
- **(b) webui 側でバナー通知**: webui が ping の version と自身のビルド版を
  比較し、「新しい daemon が利用可能、リロードして」バナーを出す。ユーザ
  主導のリロードで反映されるので UX 的には親切だが、daemon 自体の upgrade
  発動条件 (= newer-wins) を変えるものではなく、根治ではなく気づきの提供に
  留まる
- **(c) daemon の self-upgrade 定期検知**: daemon 自身が plugin cache 内の
  新バージョン存在を定期検知して self-upgrade する。env / 実体パスの解決が
  複雑になり実装コストが重い

(a) を第一候補として提案する: 最小・確実・このリポ内で完結し、push した
本人 (= 直後に使う可能性が最も高い当事者) には即座に効く。

## 受け入れ条件

- [ ] `just push` 実行後、新バージョンの daemon への upgrade が (少なくとも
      push した端末上では) 手動介入なしに発動する
- [ ] 対象 candidate ((a)/(b)/(c) のいずれか、または組み合わせ) を選定し、
      選ばなかった案の理由を記録する

## TODO

<!-- wip 時のみ -->
