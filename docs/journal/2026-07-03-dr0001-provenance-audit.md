# DR-0001 出所監査と全面書き直し

## 発端

kawaz が旧 DR-0001 (2026-06-29 起草、Proposed のまま) を確認し「僕が話した内容と全然違う」と指摘。claude-session-analysis (CSA) で関連セッションの会話ログを遡って全文突き合わせを実施した。

## 判明した伝達経路と劣化点

kawaz の設計は 4 段階で伝達されており、劣化は 3 段目以降で発生していた:

1. **kawaz スケッチ** (kawaz/die セッション `911732b3`、6/29 04:00・04:28) — room protocol の全要素 (本文込み push / mid / member seq / move / leave / 冪等 room 作成) が逐語で存在
2. **die → cmux-msg メッセージ** (`20260629T043026-4712cc83.md`) — die の AI による構造化。**スケッチに忠実** (劣化なし)
3. **cmux-msg 側 issue 化** — v2-proposal issue は骨子 7 行に圧縮され、プロトコル意味論 (push 本文込み / move の定義 / mids fetch / 宛先フィルタ) が脱落。全文は「archive 参照」のポインタのみ
4. **旧 DR-0001 起草** (cmux-msg セッション `a6e0898f` turn 8) — メッセージ読了 (04:49) から起草 (11:27) まで 6.5h の別作業を挟み、スケッチ詳細はコンテキストから消失した状態で執筆。kawaz レビューなしで commit + push

## 旧 DR-0001 の主な問題 (実発言との突き合わせ結果)

- **番号誤帰属**: kawaz の「レビュー回答 1〜5」(6/29 10:41) は直前報告の「次セッション候補アクション 1〜5」への回答だが、issue が「codex Critical 1〜5 への決着」と解釈。結果、kawaz が発言していない「supervision 詳細に同意」「auth = tailscale で回答済み (mTLS/token 不要)」「migration 方針 OK」が kawaz 名義で記録された
- **設計の反転**: codex 提案「push は通知のみ、本文取得は pull」が Decision 化され、kawaz スケッチ「通知に本文展開済みで受信 (read の 1 ターンが無駄)」と真逆になった
- **設計要素の消失**: member seq identity (0 = kawaz 予約) / move イベントの定義 / leave / 宛先外 metadata 通知 + mids fetch / membership 駆動の room 発見
- **根拠の捏造**: 「kawaz は bun 慣れあり、開発速度で勝る」「Go は daemon 安定性で強い trade-off があるが統一が上回る」— kawaz の実発言は「実績はどちらも問題ないという認識」のみ
- **選択肢の無断確定**: 既読メタデータ「隣にもう 1 ファイルか sqlite でも良いか」(2 択提示) → sqlite 確定、「ui は別サブプロジェクトでも良い」→ monorepo 確定 等

## 対処

- 一次資料を本リポに verbatim 収蔵: `docs/research/2026-06-29-kawaz-design-statements.md` (発言逐語集) + `docs/research/2026-06-29-die-v2-proposal-message.md` (die メッセージ全文コピー)
- DR-0001 を一次資料準拠で全面書き直し。attribution 規約 ([kawaz] / [提案] / [保留]) を導入し、決定の出所を明示
- README (ja/en) の過大主張 (「(1)–(4) を構造解決」) を正確化、ローカル jj 親構成の記述を削除

## 書き直しと同時に確定した新決定 (2026-07-03、逐語は design-statements §5)

- `to` = mention (アテンション指定)。room 内は全員に本文配送
- 既読管理レス (BBS モデル): server 側 cursor なし、読者が since-mid を持つ
- room ID は daemon 発行 + 同時開設は daemon が直列化して重複排除
- 新規参加者への初期配信は上限付き全履歴 (N は実装時調整)
- 導出提案 (kawaz 裁可待ち): sqlite を MVP から外し、永続状態を JSONL のみにする

## 再発防止の構造 (事実のみ)

- DR の根拠となる一人称の設計発言は、ポインタでなく **リポ内に逐語で収蔵** してから DR を書く (コンテキスト落ち・パラフレーズ変質の遮断)
- DR には attribution 規約を置き、「ユーザ決定」と「エージェント/レビュアー提案」を混ぜない
- ユーザの番号付き回答を記録する時は、**何の番号リストへの回答か**を明記する
