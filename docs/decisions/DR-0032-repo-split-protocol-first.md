# DR-0032: リポ分離と規約ファーストの作り直し (daemon / protocol / webui)

Status: Accepted (2026-09-08。骨子は kawaz 裁定 r278m37〜m67、細部は統括判断)
Date: 2026-09-07
Sponsor: kawaz r278m37/m38 (2026-09-07)「この機に抜本的な作り直し」「リポ分離を基本方針」「規約ファーストで」「プロトコルも一度見直す」
関連: [docs/findings/2026-09-07-webui-component-inventory.md](../findings/2026-09-07-webui-component-inventory.md)、
[docs/issue/2026-09-07-multi-host-cluster.md](../issue/2026-09-07-multi-host-cluster.md)、
[docs/design/webui-architecture.md](../design/webui-architecture.md) (Draft、本 DR 確定後に再構成)

## 1. 背景

webui の棚卸しで、client 37k 行のうち TSX 側に負債が集中していること (全状態購読 7 個、
`AppState` 39 フィールド 1 オブジェクト、store 外のミニ store 10 箇所、参照 0 の export 37 個、
二重実装の群) が実測で出た。同時に、複数ホストの daemon を mesh で束ねる計画
(multi-host-cluster) があり、version の違う daemon 同士が同じ契約で話す必要が生じる。

モノリポは初期の成長には向いていたが、機能追加が積み上がった現在は、各側が把握すべき
コンテキストが互いに混ざり、契約 (protocol) が「同じツリーで一緒に変える」運用のため
版付きの規律を持たない。

## 2. 決定

### 2.1 リポ構成

| リポ | 責務 | 含むもの |
|---|---|---|
| **protocol** | 契約の正本。型・op・event・エラーコード・版 | schema と TS 型、互換規則、変更手順 |
| **ccmsg** (daemon) | セッション管理・通信制御・API (UDS / WS / HTTP) | daemon、cli、`plugins/claude`、`plugins/codex` |
| **webui** | 表示と操作。daemon とは契約だけで話す | preact + `@preact/signals` の SPA (静的サイト) |

- **規約ファースト**: 変更はまず protocol で決め、daemon と webui はそれに従う。protocol の
  変更なしに片側が相手の内部構造を知る経路を作らない
- **webui は daemon から配信しない**。webui は自前の静的サイトとして caddy / tailscale の
  FQDN を持ち、daemon は API (WS / HTTP) だけを提供する。別 origin からの WS になるので、
  daemon の origin 制限 (DR-0004 の identity pinning) は「許可する origin の設定」に変える
- **状態層は `@preact/signals`** (QUESTIONS WA-Q1 = a)。DR-0005 §1 の action/reducer は
  「state module に集約した更新関数 = action」に読み替えて supersede (WA-Q3 = a)

### 2.2 進め方

新系 (protocol v2 の daemon + 新 webui + 新 plugin) は **別 instance として横に立て、旧系
(現行 daemon + webui + plugin) は凍結して放置する** (kawaz r278m59)。instance ごとに socket /
state dir / room の記録が `iss` 由来のパスで分離されるので、両系が共有するものは読み取り専用の
外部資源 (`claude agents`、`sessions/<pid>.json`、transcript、hyoui) だけ。daemon が v1 と v2 を
両受けする必要は無い。

1. protocol を版付きの契約として切り出す。session 系オブジェクトは最初から `instance` を持つ
2. 新 daemon を新 instance (別 FQDN / socket / state dir) として起動し、新 webui を別リポ・別 FQDN で繋ぐ
3. 画面ごとに新 webui を作る。移す対象は [webui-rebuild-checklist](../design/webui-rebuild-checklist.md)
   で決め、参照 0 / テスト未 import の部品は移植しない
4. 新系を入れる前に、旧 plugin の最終 patch で **PATH への symlink と「PATH の新版へ self-exec」
   (DR-0007) を止める**。旧系は plugin cache 内の絶対パスで閉じ、PATH の `ccmsg` は新系が専有する
   (旧セッションの hook / skill / `reply_via` は既に絶対パスを使っている)
5. **切替は config home (= instance) 単位で一気に**行う: その config home で旧 marketplace の plugin を
   disable し、`ccmsg plugin install claude --config-home <dir>` を入れる。同じ config home に 2 種類の
   plugin が同時に有効な期間を作らない。走行中の旧セッションは subscribe の Monitor と絶対パスで寿命まで
   旧系と話せる。gateway の通知先 (webhook) は新 instance を追加登録する
6. 日常利用が新系に移った時点で旧系 (daemon / `packages/webui` / 旧 plugin) を停止・削除。旧 room の
   履歴は移行しない (必要な間は旧 webui で読む)

### 2.3 コンポーネント整理に持ち込む規約 (クラスタ化由来)

クラスタの単位は **instance** (= 1 config home につき 1 daemon、kawaz r278m41)。同じ PC の
複数 instance (personal / emrd …) もメンバーになる。host は instance の属性の 1 つ。

- session 系オブジェクトは `instance` 属性を持つ (紐付けは最低 1 回で足りる)
- per-instance の値 (接続状態・hello の能力フラグ) と全体の値を混ぜない
- room id は instance を含意する
- instance は自分の config home だけを見る (`~/.claude*` の自動検出は廃止)

### 2.4 配布 (kawaz r278m40)

- `ccmsg` (daemon + CLI) を `bun install -g` / `brew install` で入れ、これを入口にする
- エージェント側の plugin は `ccmsg plugin <install|update> <claude|codex> [--config-home <dir>]`
  で ccmsg が配る。Claude Code はローカルパスの marketplace として登録し、codex はその
  拡張機構に合わせる
- config home は instance が 1 つずつ持つ (§2.3)。install 時の `--config-home` はその
  instance の対象を指定する
- これにより plugin cache 内のソースを `bun run` する構造 (DR-0007 の PATH 自己更新含む) は不要になる

## 3. 細部の確定 (統括判断、異論があれば直す)

- plugin は `ccmsg` 1 リポに daemon + cli + `plugins/claude` + `plugins/codex` を同梱、分離は protocol と
  webui だけ。リポは `kawaz/ccmsg` / `kawaz/ccmsg-protocol` / `kawaz/ccmsg-webui` (r278m41)
- **互換経路は持たない**。protocol の世代が違う相手とは話さず、webui には更新 / リロードの警告を出す
  (r278m58)
- **protocol の配布**: npm registry の `@ccmsg` org 配下に publish する (`@ccmsg/protocol`。`ccmsg` 本体も
  `bun install -g` の経路が npm なので揃う。unscoped の `ccmsg` は第三者が取得済みなので本体・webui も
  `@ccmsg/*` に置く)。`ccmsg` と `ccmsg-webui` は package.json で版を固定して依存する
- **版付け**: 契約の世代は `PROTOCOL_VERSION` (整数)。package の版は semver で、世代を上げる変更は
  major を上げる。同一世代内の追加 (任意フィールド・任意 op) は minor
- **DR / docs の振り分け**: リポを分ける時点で、webui 固有の DR (0005 / 0010 / 0014 の UI 部 / 0015 /
  0018 / 0020〜0022 / 0024〜0026 / 0031) は新 webui リポの設計文書へ内容を移し、本リポの INDEX には
  移管先を残す。protocol 固有 (0003 / 0006 / 0011 / 0016 / 0017 / 0029) は contract リポの DESIGN と
  op 表に吸収済みのものから Superseded にする
- **instance の起動**: 常駐。`ccmsg daemon add <config home>` で登録し、`ccmsg service register` が監督者
  (`ccmsg daemon supervise`) を launchd / systemd に登録して instance を子として保つ (r284 m25〜m34)
- **エージェント側 plugin の配布**: marketplace ではなく `ccmsg plugin install <agent>` が正本 (対称な
  `status` / `uninstall`、receipt で自分が書いた変更だけを戻す)。Claude Code にはローカル marketplace 経由で
  ネイティブの plugin 機構に乗せる。先行事例調査は kawaz/ccmsg `docs/research/2026-09-08-plugin-distribution-survey.md`
- **instance 間認証**: [mesh-peer-auth](../design/mesh-peer-auth.md) / [mesh-self-identification](../design/mesh-self-identification.md)
  (自己識別の「全 peer 到達必須」は緩和して採用)

## 4. 却下した案

- **モノリポ内で新 package として作り直す**: 並走はできるが、契約の規律が同じツリーの中で
  緩みやすく、コンテキストも減らない。mesh のための契約版管理が別途必要になる
- **現 webui の段階的リファクタ** (webui-architecture Draft §8 の移行順): 購読層の置換自体は
  正しいが、二重実装や参照 0 の部品をそのまま引き継ぐ。「今の形の再現」を目的にしない
  (kawaz r278m33)

## 5. 影響

- 契約変更が 2〜3 リポをまたぐ。「先に protocol で決める」を守らないとモノリポより遅くなる
- release / bump / CI が 3 本になる
- DR-0004 (origin 制限)、DR-0005 (配信形態と state 層) の一部を supersede する。DR-0001 §1
  (single host) と DR-0002 §4 (後方互換なし) の前提も、mesh の契約方針 (§3) が決まった時点で変わる
