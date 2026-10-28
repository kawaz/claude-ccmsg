# DR-0032: リポ分離と規約ファーストの作り直し (daemon / protocol / webui)

Status: Accepted (2026-09-08。骨子は kawaz 裁定、細部は統括判断)
Date: 2026-09-07
Sponsor: kawaz (2026-09-07)「この機に抜本的な作り直し」「リポ分離を基本方針」「規約ファーストで」「プロトコルも一度見直す」
関連: [docs/findings/2026-09-07-webui-component-inventory.md](../findings/2026-09-07-webui-component-inventory.md)、[docs/issue/2026-09-07-multi-host-cluster.md](../issue/2026-09-07-multi-host-cluster.md)、[docs/design/webui-architecture.md](../design/webui-architecture.md) (Draft、本 DR 確定後に再構成)

## 1. 背景

webui の棚卸しで、client 37k 行のうち TSX 側に負債が集中していること (全状態購読 7 個、`AppState` 39 フィールド 1 オブジェクト、store 外のミニ store 10 箇所、参照 0 の export 37 個、二重実装の群) が実測で出た。同時に、複数ホストの daemon を mesh で束ねる計画(multi-host-cluster) があり、version の違う daemon 同士が同じ契約で話す必要が生じる。

モノリポは初期の成長には向いていたが、機能追加が積み上がった現在は、各側が把握すべきコンテキストが互いに混ざり、契約 (protocol) が「同じツリーで一緒に変える」運用のため版付きの規律を持たない。

## 2. 決定

### 2.1 リポ構成

| リポ | 責務 | 含むもの |
|---|---|---|
| **protocol** | 契約の正本。型・op・event・エラーコード・版 | schema と TS 型、互換規則、変更手順 |
| **ccmsg** (daemon) | セッション管理・通信制御・API (UDS / WS / HTTP) | daemon、cli、`plugins/claude`、`plugins/codex` |
| **webui** | 表示と操作。daemon とは契約だけで話す | preact + `@preact/signals` の SPA (静的サイト) |

- **規約ファースト**: 変更はまず protocol で決め、daemon と webui はそれに従う。protocol の変更なしに片側が相手の内部構造を知る経路を作らない
- **webui は daemon から配信しない**。webui は自前の静的サイトとして caddy / tailscale のFQDN を持ち、daemon は API (WS / HTTP) だけを提供する。別 origin からの WS になるので、daemon の origin 制限 (DR-0004 の identity pinning) は「許可する origin の設定」に変える
- **状態層は `@preact/signals`** (QUESTIONS WA-Q1 = a)。DR-0005 §1 の action/reducer は「state module に集約した更新関数 = action」に読み替えて supersede (WA-Q3 = a)

### 2.2 進め方

新系 (protocol v2 の daemon + 新 webui + 新 plugin) は **別 instance として横に立て、旧系(現行 daemon + webui + plugin) は凍結して放置する** (kawaz)。instance ごとに socket /
state dir / room の記録が `iss` 由来のパスで分離されるので、両系が共有するものは読み取り専用の外部資源 (`claude agents`、`sessions/<pid>.json`、transcript、hyoui) だけ。daemon が v1 と v2 を両受けする必要は無い。

1. protocol を版付きの契約として切り出す。session 系オブジェクトは最初から `instance` を持つ
2. 新 daemon を新 instance (別 FQDN / socket / state dir) として起動し、新 webui を別リポ・別 FQDN で繋ぐ
3. 画面ごとに新 webui を作る。移す対象は [webui-rebuild-checklist](../design/webui-rebuild-checklist.md)
   で決め、参照 0 / テスト未 import の部品は移植しない
4. 新系を入れる前に、旧 plugin の最終 patch で **PATH への symlink と「PATH の新版へ self-exec」
   (DR-0007) を止める**。旧系は plugin cache 内の絶対パスで閉じ、PATH の `ccmsg` は新系が専有する(旧セッションの hook / skill / `reply_via` は既に絶対パスを使っている)
   - **決定 (2026-10-18、実装済み)**: launcher (`bin/ccmsg`) は自分の plugin の CLI だけを起動する。PATH の `ccmsg` へ self-exec せず、PATH の symlink も書き換えない (DR-0007 §2 の自己更新と §4 の注記の self-exec を止める)。v2 の有無に依らない v1 自身の理由で決める:
     - hook と skill は plugin root の絶対パスで launcher を起動するので、どの版が動くかは Claude Code が解決した plugin root で決まる。PATH の `ccmsg` は利用者が置くもので、名前が同じ別の配布物 (別の plugin の CLI や手書きの wrapper) が占めることもある。版を比べて PATH 側へ exec すると、plugin の外にある物が hook の動作を決め、名前が同じだけの別物に hook を渡しうる
     - 版は cache のパスの形 (`<marketplace>/<plugin>/<version>`) から読むしかなく、marketplace や plugin の名前が変わると黙って読めなくなる (regex を今の名前に合わせても次の改名で同じことが起きる)
     - shell や launchd のスクリプトから使う口は、PATH に置く別の launcher にする (次の決定)
   - **決定 (2026-10-28)**: PATH に置く launcher (`packages/cli/path-launcher.sh`) は、Claude Code が今 install している ccmsg-v1 の版の `bin/ccmsg` に毎回 exec する。plugin を update しても PATH 側には何もしない。launchd のように plugin cache が PATH に乗らない所から `ccmsg` を呼ぶための口で、hook と module の経路 (上の決定) は変えない
     - 版は Claude Code の記録 `<config dir>/plugins/installed_plugins.json` の `plugins["ccmsg-v1@ccmsg-v1"]` のうち user scope の項目の `installPath` で決める。版の比較も cache のパスの形の解釈もしない (install 中の版と cache の最大の版は、update 前の版の残りや downgrade で一致しない)。plugin か marketplace を改名すると key が合わなくなるが、黙らず「install されていない」と言って止まり、key と plugin.json / marketplace.json の名前の一致はテストが固定する。project / local scope の項目はどの project の claude の物かで決まり、PATH から呼ばれる launcher はどの project にも居ないので見ない
     - config dir は `CLAUDE_CONFIG_DIR`、未設定か空なら Claude Code の既定の `~/.claude`。CLI (hello の `config_dir`) と daemon (起動の既定の effort を読む config dir) と同じ規則にして、launcher が選ぶ版と、その CLI が自分の config dir と思う所をずらさない。`~/.claude*` を探して選ぶことはしない (§2.3 の「instance は自分の config home だけを見る」と同じで、版の違う config dir が複数ある時にどれを選ぶかの規則を持ち込まない)。`~/.claude` を config dir にしない環境で `CLAUDE_CONFIG_DIR` を引き継がない呼び出し元 (launchd) は、呼び出し側が `CLAUDE_CONFIG_DIR` を渡す
     - 委譲先を決められない時 (記録が無い・JSON として読めない・user scope の項目が無い・`installPath` に `bin/ccmsg` が無い・jq が無い) は、原因と対処を 1 行 stderr に出して exit 1。委譲先は起動しない
     - POSIX sh で書き、bun 無しで起動する (bun は委譲先の `bin/ccmsg` が要り、無ければそちらが言う)。記録は jq で読む。sh だけで JSON を正しく読む手段は無く、自前の解析は記録の書式 (改行・escape) に依存する。macOS は `/usr/bin/jq` を持ち、launchd の PATH に乗る
     - plugin の `bin/` には置かない。Claude Code は plugin の `bin/` をセッションの PATH に足す (2026-10-28 観測: セッションの PATH に `<cache>/ccmsg-v1/ccmsg-v1/<version>/bin`) ので、そこに置くと全セッションの PATH に 2 つ目の名前として乗る
     - `just install-launcher [dest]` (既定 `~/.local/bin/ccmsg`) が **copy** で置く。symlink にしない: cache の版ディレクトリを指すと update で古い版が消えた時に切れ、repo の checkout を指すと作業中の未 commit の編集が launchd の動作に即座に効き、checkout の移動で切れる。launcher 自身が変わった時は install-launcher を打ち直す
     - dest に既にある物は、launcher の copy (2 行目の目印の行が同じ) なら置き換え、それ以外 (symlink を含む) は上書きせず止める。利用者が置いた wrapper や手張りの symlink をどかすのは利用者の判断
5. **切替は config home (= instance) 単位で一気に**行う: その config home で旧 marketplace の plugin を
   disable し、`ccmsg plugin install claude --config-home <dir>` を入れる。同じ config home に 2 種類のplugin が同時に有効な期間を作らない。走行中の旧セッションは subscribe の Monitor と絶対パスで寿命まで旧系と話せる。gateway の通知先 (webhook) は新 instance を追加登録する
6. 日常利用が新系に移った時点で旧系 (daemon / `packages/webui` / 旧 plugin) を停止・削除。旧 room の
   履歴は移行しない (必要な間は旧 webui で読む)

### 2.3 コンポーネント整理に持ち込む規約 (クラスタ化由来)

クラスタの単位は **instance** (= 1 config home につき 1 daemon、kawaz)。同じ PC の複数 instance (personal / emrd …) もメンバーになる。host は instance の属性の 1 つ。

- session 系オブジェクトは `instance` 属性を持つ (紐付けは最低 1 回で足りる)
- per-instance の値 (接続状態・hello の能力フラグ) と全体の値を混ぜない
- room id は instance を含意する
- instance は自分の config home だけを見る (`~/.claude*` の自動検出は廃止)

### 2.4 配布 (kawaz)

- `ccmsg` (daemon + CLI) を `bun install -g` / `brew install` で入れ、これを入口にする
- エージェント側の plugin は `ccmsg plugin <install|update> <claude|codex> [--config-home <dir>]`
  で ccmsg が配る。Claude Code はローカルパスの marketplace として登録し、codex はその拡張機構に合わせる
- config home は instance が 1 つずつ持つ (§2.3)。install 時の `--config-home` はそのinstance の対象を指定する
- これにより plugin cache 内のソースを `bun run` する構造 (DR-0007 の PATH 自己更新含む) は不要になる

## 3. 細部の確定 (統括判断、異論があれば直す)

- plugin は `ccmsg` 1 リポに daemon + cli + `plugins/claude` + `plugins/codex` を同梱、分離は protocol とwebui だけ。リポは `kawaz/ccmsg` / `kawaz/ccmsg-protocol` / `kawaz/ccmsg-webui`
- **互換経路は持たない**。protocol の世代が違う相手とは話さず、webui には更新 / リロードの警告を出す
- **protocol の配布**: npm registry の `@ccmsg` org 配下に publish する (`@ccmsg/protocol`。`ccmsg` 本体も`bun install -g` の経路が npm なので揃う。unscoped の `ccmsg` は第三者が取得済みなので本体・webui も`@ccmsg/*` に置く)。`ccmsg` と `ccmsg-webui` は package.json で版を固定して依存する
- **版付け**: 契約の世代は `PROTOCOL_VERSION` (整数)。package の版は semver で、世代を上げる変更はmajor を上げる。同一世代内の追加 (任意フィールド・任意 op) は minor
- **DR / docs の振り分け**: リポを分ける時点で、webui 固有の DR (0005 / 0010 / 0014 の UI 部 / 0015 /
  0018 / 0020〜0022 / 0024〜0026 / 0031) は新 webui リポの設計文書へ内容を移し、本リポの INDEX には移管先を残す。protocol 固有 (0003 / 0006 / 0011 / 0016 / 0017 / 0029) は contract リポの DESIGN とop 表に吸収済みのものから Superseded にする
- **instance の起動**: 常駐。`ccmsg daemon add <config home>` で登録し、`ccmsg service register` が監督者(`ccmsg daemon supervise`) を launchd / systemd に登録して instance を子として保つ
- **エージェント側 plugin の配布**: marketplace ではなく `ccmsg plugin install <agent>` が正本 (対称な`status` / `uninstall`、receipt で自分が書いた変更だけを戻す)。Claude Code にはローカル marketplace 経由でネイティブの plugin 機構に乗せる。先行事例調査は kawaz/ccmsg `docs/research/2026-09-08-plugin-distribution-survey.md`
- **instance 間認証**: [mesh-peer-auth](../design/mesh-peer-auth.md) / [mesh-self-identification](../design/mesh-self-identification.md)
  (自己識別の「全 peer 到達必須」は緩和して採用)

## 4. 却下した案

- **モノリポ内で新 package として作り直す**: 並走はできるが、契約の規律が同じツリーの中で緩みやすく、コンテキストも減らない。mesh のための契約版管理が別途必要になる
- **現 webui の段階的リファクタ** (webui-architecture Draft §8 の移行順): 購読層の置換自体は正しいが、二重実装や参照 0 の部品をそのまま引き継ぐ。「今の形の再現」を目的にしない(kawaz)

## 5. 影響

- 契約変更が 2〜3 リポをまたぐ。「先に protocol で決める」を守らないとモノリポより遅くなる
- release / bump / CI が 3 本になる
- DR-0004 (origin 制限)、DR-0005 (配信形態と state 層) の一部を supersede する。DR-0001 §1 (single host) と DR-0002 §4 (後方互換なし) の前提も、mesh の契約方針 (§3) が決まった時点で変わる
