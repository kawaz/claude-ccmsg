# DR-0019: fs_write (webui Files からの新規ファイル作成、docs/inbox 先行)

Status: Accepted (IB-Q3=a、kawaz 2026-07-16)
Date: 2026-07-16
Sponsor: kawaz r26 mid=1 + 続く transcript 議論

## 1. 背景

kawaz が「AI に拾ってほしい雑なメモ・指示」を working copy にファイルとして置く
**inbox 運用**を開始した (置き場 = `docs/inbox/`、kawaz 裁定 2026-07-16、ccmsg リポで
先行運用)。AI は `jj status` 等で新規ファイルに気づいて拾い上げ (即対応 or 正式 issue 化)、
処理後に削除する。

現状ファイルを置くにはターミナル / エディタが要る。webui の Files ビューから新規ファイルを
作成できれば、スマホの webui だけで「雑メモを対象リポの docs/inbox/ に落とす → セッションが
拾う」が完結し、ccmsg が非同期指示のフル経路になる (kawaz: 「ccmsg だけで運用が回せる」)。

## 2. スコープ

### 2.1 やること (Phase W1: protocol + daemon)

- protocol に `fs_write` op を追加:
  ```ts
  export interface FsWriteRequest {
    op: "fs_write";
    sid: string;
    /** file path relative to the session root */
    path: string;
    /** UTF-8 text content */
    content: string;
  }
  ```
- daemon 側 (fs_list / fs_read と同じ containment 検査に加えて):
  - **書き込み可能パスの制限**: 初期実装は `docs/inbox/` 配下のみ許可 (path prefix 検査)。
    それ以外は `path_not_writable` エラー
  - **既存ファイルの上書き禁止**: 存在するパスへの write は `file_exists` エラー
    (inbox の意味論は「新規メモを置く」であって編集ではない)
  - 親ディレクトリ (`docs/inbox/`) が無ければ作成する (mkdir -p 相当。inbox 未導入リポ
    へも webui から置ける)
- 認可: webui (u1) からのみ。CLI 経路は既存の Write ツールがあるので不要

### 2.2 やること (Phase W2: webui UI)

- Files ビューの `docs/inbox/` ディレクトリ行 (または Files ヘッダ) に「+ メモ」ボタン
- クリック → ファイル名 (省略時 `YYYYMMDD-HHmm.md` 自動) + multiline 本文入力 → 作成
- 作成成功でツリー更新

### 2.3 やらないこと

- 任意パスへの書き込み・既存ファイル編集 (将来の別 DR。安全境界の設計が別物)
- バイナリ / 添付 (DR-0015 の領域)
- inbox 以外のディレクトリ選択 UI

## 3. 設計判断

### 3.1 なぜ docs/inbox/ 限定から始めるか

fs write は fs read と安全境界が違う (誤爆・上書き事故が不可逆)。inbox 限定なら:
- 意味論が「新規メモ追加のみ」で上書き不要 → file_exists 拒否で事故面を消せる
- path prefix が固定文字列 1 つで検査が単純
- 将来任意 write に広げる場合も、この op の上に許可 prefix リストを載せる形で拡張できる

### 3.2 DR-0018 (session launcher) との関係

どちらも「webui からの能動操作」拡張。認可 (u1 のみ)・path validation の考え方を揃えるが、
実装 Phase は独立 (依存なし)。

## 4. Phase 分割

- **Phase W0**: 本 DR + `docs/inbox/` ディレクトリ + README (このコミット)
- **Phase W1**: protocol + daemon fs_write + テスト
- **Phase W2**: webui Files UI

W1 以降は kawaz の DR 承認後に workflow で実装。

## 5. 関連

- DR-0008 (files view) — fs_list / fs_read の containment 検査の正本
- DR-0018 (session launcher) — 同系統の webui 能動操作
- `docs/inbox/README.md` — inbox 運用の意味論
