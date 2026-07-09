# mvp-followups の一括解消 + README 実態同期 + CI 新設

3 ワーカー並列 (CLI leave / CI 新設 / version mismatch テスト) + メイン (docs 系) で実施。v0.0.3 として push。

## やったこと

- **README ja/en の Status 実態同期**: 「Pre-MVP / 実装未着手 / DR-0001 Proposed」という stale 記述を実態 (DR-0001..0003 Accepted、daemon/cli/protocol 実装済み、webui 未着手) に更新。plugin としての install/update 手順が無かったので追加。
- **marketplace.json の `metadata.license` 除去**: `claude plugin validate` の「Unknown field」warning の根治。claude-plugin-reference で裏取りし、license 表明は plugin.json + LICENSE が正と確認。
- **CLI `leave` サブコマンド追加** (mvp-followups 受け入れ条件 3): daemon 側 op は実装済みだった。CLI 配線 + ヘルプ同期 + SKILL.md 追記。daemon leave op はテストゼロだったので統合テスト 4 件 (退出反映 / not_a_member 拒否 / エラー系 / jsonl 永続化と再起動後復元) を新設。
- **version mismatch 自動テスト** (受け入れ条件 2): test-only env シーム 2 つ (`CCMSG_VERSION_OVERRIDE` / `CCMSG_DAEMON_ENTRY`) を導入して DR-0002 §4 の upgrade 経路 3 輪郭をカバー。DI パラメータ / module mock は本番シグネチャ汚染のため不採用 (Design rationale はコード側)。
- **GitHub Actions CI 新設**: ubuntu/macos matrix で lint/typecheck/test。ubuntu で flock.ts の Linux (libc.so.6) 経路が恒常検証される (受け入れ条件 1 の担保手段)。

## ハマり所 / 判断

- **DR-0003 §4 と issue の矛盾**: DR には「CLI leave は未提供 (必要が観測されたら追加)」とあり、mvp-followups の受け入れ条件 3 (追加する) と食い違っていた。issue 側が後発の意図と判断して実装し、DR の当該記述を現状に更新した。
- **version mismatch テストのシーム**: bun test 実行時は `process.argv[1]` が test runner を指すため、daemonSpawnCmd の自動判定だけでは respawn 経路がテストから叩けない。`CCMSG_DAEMON_ENTRY` で entry を明示する形にした (既存 CCMSG_* env パターンに統一)。
- **`just push` の on-success-release**: ローカルに ccmsg marketplace が未登録のため plugin update が warn (push 自体は成功)。dogfood 開始時に `claude plugin marketplace add kawaz/claude-ccmsg` が必要。

## 残り / 次

- CI green 確認後、mvp-followups issue を close (受け入れ条件 1 は ubuntu CI の初回 green が判定材料)。
- webui は未着手のまま (後 phase)。着手前に locator-syntax issue の `#tNN` の t の意味を kawaz に確認。
