---
title: iPad webapp への音声割り込み通知 (WebRTC audio track + TTS)
status: open
category: design
created: 2026-07-24T03:59:42+09:00
last_read:
open_entered: 2026-07-24T03:59:42+09:00
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

# iPad webapp への音声割り込み通知 (WebRTC audio track + TTS)

## 概要

iPad で ccmsg webapp を開いた状態で別アプリ (読書等) を前面にして待機しているとき、
仕事が止まったイベント (worker 完了 / 裁定依頼 / エラー) が発生したら「声で話しかけられる」
体験を実現したい。push 通知は非同期メッセージのイメージで無視されがちなため本命にせず、
将来の保険として別枠で検討する。

## 背景

kawaz は iPad で ccmsg webapp を開いた後、別アプリを操作しながら待機するスタイルで
使っている。現状は画面を見ないと状態変化に気づけない。iOS では Web Push はサイレント
不可、SpeechSynthesis はバックグラウンド発話不可という制約があり、通常の通知手段では
「別アプリ前面中でも音声で気づける」体験を作れない。

唯一の現実解として、ユーザアクション起点で開始した WebRTC の audio track は、iOS の
「音声再生中のページはサスペンドされない」仕様を利用してバックグラウンドでも維持でき、
そこに server-side で合成した TTS 音声を流し込めば実現できるという構想が出た。

## 設計方向 (検討メモ)

1. webui 側にユーザアクション起点の「音声通知 ON」トグルを用意し、押下時に daemon との
   WebRTC PeerConnection (audio track + DataChannel) を確立する。audio session を保持する
   ことで別アプリが前面でもページがサスペンドされない (iOS の音声再生中ページ維持仕様)
2. daemon 側でイベント (メッセージ着信・裁定依頼等) 発生時に TTS 合成 (macOS `say` や
   AVSpeechSynthesizer 等) し、audio track に流し込む。英略語のカタカナ変換規約
   (notification-tips ルール相当) を適用して読み上げを自然にする
3. 既存の `2026-07-10-webrtc-datachannel-transport` issue の DataChannel 構想と統合可能。
   同一 PeerConnection に音声とデータの両方を乗せれば、WS 代替 + keepalive 強化も兼ねられる
4. 電池コスト: 別アプリ使用中 (画面オン) は誤差程度、画面オフ常時維持だと数 %/h 程度と
   見積もられるが、今回の要件 (別アプリ使用中の待機) では問題にならない想定
5. ロック中に音声が止まるのは許容
6. tailnet 内での ICE/STUN 構成は要検討。同一 tailnet 内なら直結できて STUN 不要かもしれない

## 受け入れ条件

- [ ] webui にユーザ起点の音声通知 ON/OFF トグルがあり、ON にすると daemon との
      WebRTC 接続 (audio track) が確立する
- [ ] 別アプリを前面にしていても、daemon 発のイベントで音声が再生される
      (worker 完了 / 裁定依頼 👺 / エラー の少なくとも1種類で確認)
- [ ] ロック中は音声が止まる挙動が許容仕様として明記されている
- [ ] `2026-07-10-webrtc-datachannel-transport` との統合可否 (同一 PeerConnection 化) の
      方針が決まっている
