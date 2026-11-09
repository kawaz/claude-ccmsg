# DR-0051: Files の編集モードでもシンタックス着色を保つ (contenteditable + CSS Custom Highlight API)

- Status: Accepted (2026-11-10、kawaz 裁定) — ✅ 実装済み (`components/CodeEditor.tsx`、`editor-syntax.ts`、`editor-text.ts`、`syntax-highlights.ts`、`highlight.ts` の `loadBlockTokenizer` / `grammarStatesEqual`)
- Date: 2026-11-10

## Context

Files タブのビューア (`FileViewer.tsx`) は Shiki で着色して表示する (`highlight.ts`)。「編集」に入ると素の `<textarea>` に替わり、着色が消える。編集中も閲覧と同じ色で読みたい (kawaz 2026-11-09)。

textarea を透明にして背後に着色した `<pre>` を重ねる古典的な方法は採らない。フォントの計測とスクロールの同期を JS で持つことになり、ブラウザの振る舞いを自前で真似る形になるため。

## Decision

### 1. 目的

編集中も、閲覧と同じテーマの色で本文を着色する。保存される本文は、今の textarea の編集と同じになるようにする (改行・空白・タブ・末尾改行)。

増やしたくないもの:

- 編集領域の DOM の組み替え (着色のために本文を span に割らない。DOM の中身はブラウザの編集に任せる)
- ブラウザが持つ振る舞いの自前の実装 (キャレット・選択・undo・IME・貼り付けはブラウザのもの)
- 着色の計算の経路 (閲覧と同じハイライタ・同じ 2 テーマを使う)

### 2. 方式と実測

編集領域は `contenteditable="plaintext-only"` の div にする。着色は CSS Custom Highlight API で行う。色 (light / dark の組と text-decoration) ごとに Highlight の名前 `ccmsg-syntax-N` を 1 つ作り、`::highlight(名前)` の規則を adopted stylesheet に足して、トークンの範囲を登録する。ダークテーマは閲覧側の `.shiki-tok` と同じく `prefers-color-scheme` で切り替える。

実測は headless Chromium 157 と Playwright WebKit 26.6 で行った。サンプルは `FileViewer.tsx` を繰り返したもので、tsx の文法・2 テーマ。

1 打鍵ごとに全体を再トークン化すると重すぎる (1 打鍵あたり):

| 行数 | Chromium | WebKit |
|---|---|---|
| 1000 | 約 300ms | 128ms |
| 5000 | 約 1540ms | 661ms |

増分トークン化 (§3) で、Range を表示中の行だけ登録すると、1 打鍵の着色の計算は Chromium で次のとおり。全体から作り直した結果と、登録する範囲が完全に一致することを確かめた。

| 行数 | 1 打鍵の着色の計算 |
|---|---|
| 1000 | 5ms |
| 5000 | 7.5ms |

**範囲は StaticRange で作り、表示中の行 ±20 行だけ登録する。** live Range を Highlight に登録していると、WebKit では文書のどこで DOM が変わっても、その後の描画が範囲の数に対して超線形に重くなった。

| 登録した live Range の数 | WebKit: 編集領域で打鍵 | WebKit: 編集領域の外の DOM 変更 |
|---|---|---|
| 1176 | 233ms | 未計測 |
| 4281 | 2581ms | 2564ms |
| 8615 | 9767ms | 9724ms |

同じ数でも StaticRange なら、編集領域で打鍵 150ms / 270ms、編集領域の外の DOM 変更 33ms だった。Chromium はどれも約 33ms (2 フレーム) で差が出ない。

live Range が使えない理由は別にもある。両エンジンとも Enter でキャレットの前のテキストノードを作り直すので、そこに掛かっていた live Range は潰れる。編集に追従させることはどのみちできず、範囲は打鍵ごとに作り直す。

**本文は 200 行ごとのテキストノードに分けて置く。** ブラウザの 1 打鍵の編集処理 (beforeinput → input) は、キャレットのあるテキストノードの大きさに比例して重くなる。分け方ごとの実測は次のとおり。

| 分け方 (4800 行・185KB) | Chromium | WebKit |
|---|---|---|
| 1 つのノード | 24ms | 12ms |
| 200 行ごと | 5〜6ms | 5〜6ms |

1 行ずつに分けると、段落の挿入 (execCommand の insertParagraph) が 4800 ノードで 12 秒かかった。実際の Enter は insertLineBreak で、ノードの数が増えても重くならなかった (200 行ごとに分けて Chromium 約 8ms / WebKit 約 10ms)。

アプリに組み込んだ状態で 4800 行のファイルを編集した時の、1 打鍵の同期の所要 (ブラウザの編集処理と着色の合計) は次のとおり。textarea の編集処理は 1〜2ms で、この差は着色の代わりに払うコスト。

| ブラウザ | 1 打鍵の同期の所要 |
|---|---|
| Chromium | 14〜18ms |
| WebKit | 23〜25ms |

### 3. 増分トークン化

本文を 10 行の片 (ブロック) に分け、片ごとに「前の片の終わりの文法の状態」から続けてトークン化した結果を持つ (`IncrementalSyntax`)。

- 編集があったら、変わった最初の行を含む片から作り直す
- 変更範囲より後ろで前回の片の境目に着地し、文法の状態が前回と同じなら、そこから後ろは前回の結果を使い回して打ち切る
- 1 文字の編集で作り直すのは、ふつう 1 片 (10 行) だけ

文法の状態の比較は、shiki の公開 API に無い。`highlight.ts` の `grammarStatesEqual` 1 か所だけが、内部の `GrammarState.getInternalStack()` (shiki の型では @internal) と、vscode-textmate の `StateStack.equals()` に依存する。挙動は `highlight.test.ts` で固定し、shiki の更新で内部が変わったらテストで気づけるようにした。比べられない時 (メソッドが無い・例外・状態が取れない) は「等しくない」を返す。その場合、打ち切りが起きずに変更位置から末尾まで作り直す。色は正しいまま遅くなるだけで、これが全体の再トークン化への退避になる。

トークン化し直しは時間で区切る。

- 1 回の処理 (打鍵・スクロール・1 フレーム) でトークン化に使うのは 8ms まで
- 打鍵とスクロールでは、表示中の行までを先に進める
- 残りは `requestAnimationFrame` ごとに 8ms ずつ進める。`requestIdleCallback` は Safari が既定で持たないので使わない (MDN browser-compat-data: preview・設定のフラグのみ)
- 文法の状態は前の行から順にしか決まらないので、先に済ませられるのは「表示中の行まで」であって「表示中の行だけ」ではない
- まだ済んでいない行は、前回の結果 (古い色) で塗る

最悪のケースは、ファイルの先頭のコメントの開き `/*` を消して、後ろ全体をコードとしてトークン化し直す時。4800 行での実測は次のとおり。

| ブラウザ | 末尾まで塗り替わる時間 | フレームの間隔の最大 |
|---|---|---|
| Chromium | 68 フレーム・約 1.1 秒 | 25ms |
| WebKit | 68 フレーム・約 1.5 秒 | 105ms |

開いた直後の全体のトークン化も同じ仕組みで進む (Chromium で約 1 秒・最大 23ms)。

**IME の変換中も再着色を止めない。** StaticRange は DOM に追従しないので、変換中に止めると、変換中の文字より後ろの色が変換中の文字数ぶんずれる (次の行まで誤着色した)。Highlight は IME が依存する DOM と選択範囲に触れない。CDP の `Input.imeSetComposition` で変換を再現し、変換中に塗り直しても確定後の本文と undo が正しいこと、変換中の色がずれないことを確かめた (Chromium)。

### 4. 本文の扱い

- **末尾の番兵**: contenteditable は、末尾の改行の後ろにキャレットを置ける行を作らない。DOM には本文の後ろに改行を 1 つ足して置き、取り出す時は末尾が改行なら 1 つ落とす (`editor-text.ts`)。ブラウザは最終行に文字を打つと末尾の改行を置き換えることがあるので、末尾が改行でない時は落とさない。番兵を足さないと、次のような操作で textarea と結果が違った (14 シナリオ中 9 件)
  - 最終の空行に打つと `"abcd\n"` になる
  - 全部消すと `"\n"` が残る

  番兵を足すと、両エンジンとも 14 件中 13 件で textarea と同じ結果になった。残る 1 件は undo の粒度の違い (textarea は Enter と入力をまとめて戻す)
- **改行コード**: 開いた時の本文で決める。改行が全部 CRLF なら CRLF、それ以外 (LF・混在・改行なし) は LF。編集は LF で行い (CRLF は LF にして置く)、保存の時に CRLF へ戻す。混在するファイルは保存すると LF に揃う。CR だけの改行は改行として扱わず、そのまま残す
- **取り出し**: `textContent` を使う。`innerText` は U+00A0 を空白に変える
- **Tab**: `execCommand('insertText', false, '\t')` でタブ文字を入れ、フォーカスは移さない。変換中と修飾キー付きの Tab は奪わない。execCommand は非推奨だが、ブラウザの undo 履歴に積んだまま文字を入れる手段がほかに無い。1 文字の挿入にだけ使う。複数行を execCommand で入れると、Chromium / WebKit とも `<div>` が作られ、`textContent` から改行が消える
- **貼り付け**: ブラウザに任せる。Cmd+V では両エンジンとも単一のテキストノードのままで、クリップボードの CRLF は LF になった

### 5. 制約

- `::highlight()` で使えるのは color / background-color / text-decoration / text-shadow 等だけ。テーマの font-style / font-weight (markdown の見出し・強調・斜体、invalid.*、正規表現のエスケープ等) は編集中に落ちる (許容)。下線・取り消し線は text-decoration で出る
- 1 打鍵の同期の所要は textarea より大きい (§2)
- Custom Highlight API の無いブラウザでは着色しない (編集はできる)
- 着色は閲覧と同じく `HIGHLIGHT_MAX_BYTES` (200KB) 以下・対応する拡張子のファイルだけ
- 実機の Safari、macOS の実際の IME、iOS では確かめていない。複数行のテキストのドラッグ & ドロップも確かめていない

### 6. 対応ブラウザ (MDN browser-compat-data、2026-11-09 時点)

| 機能 | Chrome | Safari |
|---|---|---|
| CSS Custom Highlight API (`Highlight` / `CSS.highlights` / `::highlight()`) | 105 | 17.2 |
| `contenteditable="plaintext-only"` | 51 | 5 |
| `new StaticRange(init)` (コンストラクタ) | 90 | 13.1 |

Custom Highlight API は Baseline 2025 Newly available。Chrome は `plaintext-only` の要素の white-space を pre / pre-wrap に上書きする。

### 7. 閲覧側は変えない

閲覧は今の span (`.shiki-tok`) のまま。閲覧を Range 方式に寄せると、§2 の StaticRange と表示範囲だけの登録が閲覧にも要る。さらに画面内検索 (DR-0022) の Highlight と色が重なり、priority の設計も要る。

## Alternatives Considered

- **透明な textarea の背後に着色した pre を重ねる**: 不採用 (Context)
- **live Range で登録する**: 不採用。WebKit で超線形に重くなる (§2)
- **毎打鍵の全体再トークン化 + debounce**: 不採用。5000 行で 1.5 秒、主スレッドを止める (§2)
- **変換中は再着色を止める**: 不採用。StaticRange では色がずれる (§3)
- **EditContext API**: 不採用。Safari が未対応 (MDN browser-compat-data: Chrome 121 のみ)
- **CodeMirror 6 等のエディタ部品の導入**: 測っていない。ブラウザの機能で目的を満たせたため

## Consequences

- 編集モードは `CodeEditor` (contenteditable) になる。新規メモの編集 (`InboxNewEditor`) は今の textarea のまま
- `highlight.ts` は shiki の内部 API に 1 か所依存する。shiki の更新で `highlight.test.ts` の `grammarStatesEqual` が落ちたら、内部の変化を確かめる (落ちている間も色は正しく、編集が重くなるだけ)
- bun 1.4.2 では、プロセスで最初の 2 テーマのトークン化だけ light の色が途中から変わる (同じコードの 2 回目以降と違う)。node と Chromium / WebKit では起きない。テスト (`editor-syntax.test.ts`) は比べる前に 1 回捨てるトークン化をする

## 関連

- [DR-0008](./DR-0008-workspace-file-access.md) §6 — ビューアの着色 (後続の `highlight.ts`)
- [DR-0019](./DR-0019-fs-write-inbox.md) — Files からの書き込み
- [DR-0022](./DR-0022-in-view-search.md) — 画面内検索 (Custom Highlight API の別の利用者)
