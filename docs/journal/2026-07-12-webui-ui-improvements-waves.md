# webui UI 改善 4 Wave (v0.18.0 → v0.21.0) + 運用トラブル 2 件

kawaz の UI 改善要望リスト (2026-07-11 夜) を ultracode (Workflow 3 本、実装 12 worker +
Fable adversarial レビュー 3 本 + fix 3 本) で順次出荷した記録。kawaz 就寝中の自律進行。

## 出荷内容

- **v0.18.0 (Wave1)**: room rename (set_title op、✎ → Shift+Enter 確定 + isComposing)、
  Shiki 置換 (ts/js/jsx を tsx グラマー 1 本に集約、gzip 47.7→185KB で裁定許容)、
  timeline tools folding (▶ N items)、thinking markdown 表示、identicon アバター、
  Composer の Shift+Enter 送信統一
- **v0.19.0 (Wave2)**: claude agents --json 5s polling (~/.claude* 自動検出 = 複数
  CLAUDE_CONFIG_DIR、user subscriber 有りの時のみ)、SESSIONS 複数行化 (badge/sid/cwd/▷
  兄弟 ws)、transcript live tail (transcript_subscribe op、fs.watch 親dir + 2s backup poll
  ハイブリッド)、thinking 翻訳タブ original|ja (Chrome Translator API)、システム由来
  user メッセージの分類 (isMeta + リテラルタグ)、SessionView Rooms タブ、ping provenance
  (exe/script) + フッター表示、スプリッタ折り畳みボタン撤去 (kawaz 依頼)
- **v0.19.1**: CI Linux fail 根治 (下記)
- **v0.20.0 (Wave3)**: to 配信フィルタ (DR-0011: to 列挙 + 送信者 + u1 のみ配信、
  live/replay/join-snapshot 3 経路、不正 to は invalid_args)、invite op + SESSIONS 行の
  DnD 招待 (招待先へ snapshot 配送)、ROOM メンバー表示を repo名/ws 形式 (owner カット)、
  許可 Origin 永続化 (allowed-origins.json + ccmsg origins add/remove/list)
- **v0.21.0 (Wave4, DR-0012)**: room アーカイブ (archive_room op、表示整理のみ・
  post/配信は不変、リスト最下部の折り畳みへ)、kick op (admin 専用 ✕ ボタン、通常 leave
  と同一意味論、kick/leave 後は dedupEligible 解除 = dedup fold への msg 消失防止)、
  チャットメッセージ行に identicon、メンバーチップの非接続グレー + 打ち消し線、
  システム由来 user メッセージの folding 包含 (境界 = 本物のユーザ発話 + assistant text)、
  セッションリストの status セクション化 (Busy/Idle/Done/未起動、バッジ撤去)、
  クリック時デフォルト Timeline、モバイルサイドバー 85vw

## ハマり所 → 解決

- **ext4 の inode 再利用で live tail の rewrite 検知が CI でだけ fail**: unlink 直後の
  再作成が同じ ino を得る (APFS では起きない)。ino + birthtime + 「消失を観測したら次の
  出現で無条件リセット (sawMissing)」の 3 重判定で根治 (v0.19.1、CI 実環境で green 確認)
- **macOS/Bun の fs.watch は「close 後の同一パス再 watch」が無発火**になる (worker が
  最小再現で確認) → 親ディレクトリ watch + basename フィルタ。さらに高負荷時の FSEvents
  遅延対策で 2s backup poll 併用
- **リリース後も旧 daemon が旧 webui を配り続ける**: newer-wins upgrade は新 client の
  接触が引き金なので、push しただけでは発動しない。just push 後に最新実体で 1 回接触する
  `_local-daemon-upgrade` task を追加 (issue: post-release-daemon-upgrade-lag)
- **caddy reverse proxy 経由で app.js だけ 403**: html は Origin ヘッダ無しで通るが
  module script は crossorigin モードで Origin が付き、daemon の Origin 検証 (env +
  tailscale 自動のみ) が拒否。curl マトリクス (Origin 有無 × 経路) で確定。恒久対応は
  allowed-origins.json (mtime ゲート、チェック失敗時のみ再読込 = 追加が即時反映、happy
  path は fs 触らず)。caddy 側で Origin を書き換える対処は検証の無効化になるので不採用
  (canddy-app-proxy セッションと r5 で合意)
- **CCMSG_SID 無し post が u1 名義に化ける**のを実地で踏んだ (wip-proxy セッションから
  指摘)。issue: prevent-u1-masquerade-on-missing-sid に集約

## 設計判断 (詳細は DR / issue)

- DR-0011: to を mention → 配信フィルタへ。u1 は常時配信の例外 (webui 観察が壊れず、
  User にはエージェント的コンテキストコストが無い)。storage/read は不変 = mid の飛びで
  存在に気づき、読みたければ read で読める (kawaz 指示の意味論)
- Passkey 署名 post (kawaz 発案) は issue passkey-signed-post-antispoofing に評価付きで
  記録。リプレイ対策 (challenge に ts/nonce) と署名粒度 (post 単位 vs セッション単位) の
  すり合わせ待ち

## 残タスク (kawaz 判断待ち)

- Passkey 設計すり合わせ (上記 issue)
- システムメッセージのタイプ別リッチ表示タブ (分類 kind 実装済み、表示は素のまま + チップ)
- webui 作業操作系 (roadmap issue、「基本的な作業」の定義待ち)
