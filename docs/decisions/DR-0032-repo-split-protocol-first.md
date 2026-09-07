# DR-0032: リポ分離と規約ファーストの作り直し (daemon / protocol / webui)

Status: Proposed (骨子は kawaz 裁定済み、細部は棚卸し後に確定)
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

1. protocol を版付きの契約として切り出す。最初の契約変更として session 系オブジェクトに
   `instance` を足す (クラスタ化の前提、現 webui には影響しない任意フィールド)
2. 新 webui を別リポ・別 FQDN で並走させる (同じ daemon に接続)
3. 画面ごとに新 webui へ移す。移す対象は棚卸しの一覧から「残す機能のチェックリスト」を
   作って決め、参照 0 / テスト未 import の部品は移植せず落とす候補とする
4. 日常利用が新 webui に移った時点で旧 webui (`packages/webui`) を削除

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

## 3. 未確定 (棚卸し後に確定)

裁定済み (r278m41): plugin は `ccmsg` 1 リポに daemon + cli + `plugins/claude` + `plugins/codex`
を同梱し、分離は protocol と webui だけ。リポは `kawaz/ccmsg` / `kawaz/ccmsg-protocol` /
`kawaz/ccmsg-webui`。

- protocol の配布形態 (パッケージレジストリで publish するか、`ccmsg` リポからの export か)
- protocol の版付け規則 (`PROTOCOL_VERSION` の整数か semver か、互換の判定)
- DR / docs の振り分け (webui 固有の DR を新リポへ移し、INDEX に移管先を残す)
- 旧 webui の削除時期と、それまでの並走の運用 (bump / release の 2 本立て)
- 移行中の protocol 変更をどう扱うか (旧 webui は追従しない = 凍結、で足りるか)
- instance の起動タイミング (常駐か、その config home のセッションが最初に `ccmsg` を呼んだ時か)

## 4. 却下した案

- **モノリポ内で新 package として作り直す**: 並走はできるが、契約の規律が同じツリーの中で
  緩みやすく、コンテキストも減らない。mesh のための契約版管理が別途必要になる
- **現 webui の段階的リファクタ** (webui-architecture Draft §8 の移行順): 購読層の置換自体は
  正しいが、二重実装や参照 0 の部品をそのまま引き継ぐ。「今の形の再現」を目的にしない
  (kawaz r278m33)

## 5. 影響

- 契約変更が 2〜3 リポをまたぐ。「先に protocol で決める」を守らないとモノリポより遅くなる
- release / bump / CI が 3 本になる
- DR-0004 (origin 制限)、DR-0005 (配信形態と state 層) の一部を supersede する
