# 状態行の select をその場に、FAB の effort を送信ボタンの左に、入力欄の左上のつまみを実機で確かめた

- Date: 2026-10-30
- 課題 (kawaz 2026-10-30)
  - 状態行の model / effort を押すと、別の行に旧 picker (✕ か Esc で閉じる行) が出る。その値の位置で select になるだけにする (DR-0041 §5、§6.4)
  - FAB の effort の select が 1 行を使っている。送信ボタンの左に置く (DR-0041 §6.3)
  - FAB のパネルは画面の下に付くので、入力欄の左上にも高さを変えるつまみが欲しい。目立たせず、場所を取らない (`docs/design/webui-architecture.md` §5)
- 対象: この変更の commit を一時 workspace に取り出し、そこから daemon (v0.209.1 の上の 3 commit) を隔離して起動した (`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ディレクトリ、HTTP は `127.0.0.1:18662`)。webui は playwright-cli の Chromium で開いた。デスクトップは 1280x800、モバイルは 390x844
- fixture: `CCMSG_CLAUDE_CONFIG_DIRS` に一時ディレクトリの config dir を 1 つだけ渡し、`sessions/<pid>.json` を `sleep` のプロセスの pid で書いた (sid は乱数、名前は `🤖ccmsg-verify-fab`)。transcript には user と assistant (model `claude-opus-5-5`、行の `effort` は `high`) を 1 行ずつ置いた。hooks module は無いので、[適用] の返事は `no_module`。実セッションには何も届けていない
- 操作: 状態行の値、つまみ、パネルのヘッダ、組み込みの右下のつまみは playwright-cli の `mousemove` / `mousedown` / `mouseup` で押した。select の option は DOM で値を入れて `change` を送った (`showPicker()` のネイティブの一覧は DOM にもスクリーンショットにも出ない)。位置と高さは `getBoundingClientRect()` と `style.height` を読んだ

## スクリーンショット

リポには入れず、作業の一時ディレクトリ `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/fabv.KLM8/shots/` に置いた。

| 状態 | デスクトップ (1280) | モバイル (390) |
|---|---|---|
| 状態行 (静止時) | `d-ctx-rest.png` | `m-rest.png` |
| 状態行の effort を押した (その位置が select) | `d-ctx-open.png` | `m-ctx-open.png` |
| 状態行で `📌medium` を選んだ (テキスト + [適用]) | `d-ctx-chosen.png` | `m-ctx-chosen.png` |
| 状態行の [適用] の返事 `no_module` | `d-ctx-applied-no-module.png` | |
| FAB を開いた (effort は送信ボタンの左) | `d-fab-open.png` | `m-fab-open.png` |
| FAB の effort を押した / `⏱️xhigh` を選んだ | | `m-fab-effort-open.png` / `m-fab-effort-chosen.png` |
| 入力欄の左上のつまみ (focus 無し) | `d-ring-blur.png` | |
| つまみのドラッグ前 / 中 / 後 | `d-grip-before.png` / `d-grip-dragging.png` / `d-grip-after.png` | `m-grip-before.png` / `m-grip-after.png` |
| 手で動かしたパネルでのドラッグ前 / 後 | `d-moved-before.png` / `d-moved-after.png` | |
| ダーク | | `m-fab-dark.png` |

## 観測

| # | 観測したいこと | 操作 | 結果 |
|---|---|---|---|
| 1 | 状態行の値がその位置で select になり、別の行・✕ が出ない | 状態行の `high` を押す | `high` の位置に select が描かれて focus を持った (`document.activeElement` が `select[aria-label="通しの上書き: effort"]`)。状態行の他の部分 (`42k / opus-5-5 / … / 3m40s`) はそのまま。別の行・✕・dialog は無い。群は `default: high` / `session: 📌low,📌medium,📌high,📌xhigh,📌max` (module が無いので 🏛️ は出ない、§6.1) |
| 2 | default 以外を選ぶと、選んだ値と [適用] | `📌medium` を選ぶ | `high` の位置が `📌medium` のテキストになり、横に [適用]。390 幅でも 1 行に収まった |
| 3 | [適用] の返事が `applied` 以外の時 | [適用] を押す | 値は default に戻って `high`、横に「このセッションには ccmsg の受け口 (hooks module) が無いので、今は効かない。…」。状態行は省略記号で切られず、理由が全部出た |
| 4 | FAB の effort が送信ボタンと同じ行、その左隣 | FAB を開く | デスクトップ: 行 y=735〜771 に 📎 (x 631〜667)、`high` (1143〜1172)、送信 (1181〜1251)。390 幅: 行 y=779〜814 に 📎 (23〜59)、`high` (253〜283)、送信 (291〜360) |
| 5 | 390 幅で effort を開いても、長い値を選んでも同じ行 | effort を押す、`⏱️xhigh` を選ぶ | 開いた select は x 187〜283、`⏱️xhigh` のテキストは 232〜283。どちらも送信 (291〜) の左で、行の高さは変わらない (779〜814) |
| 6 | 左上をドラッグすると上端がポインタに付いて動き、下端は動かない | デスクトップ: つまみ (y=568、上端から 7px) を掴んで y=400 へ | 入力欄の上端 561 → 393 (= 400 − 7)、下端 673 のまま、高さ 112 → 280。パネルの上端 519 → 351、下端 781 のまま。ドラッグの間も入力欄が focus を持ち続けた |
| 7 | 下へ行き過ぎた時 | y=400 から y=900 へ | 高さは min-height の 112 で止まった (`style.height` は `0px`) |
| 8 | 上へ行き過ぎた時 | y=568 から y=−50 へ | パネルの上端が画面の上端 0 で止まった (入力欄 631px) |
| 9 | 組み込みの右下と同じ高さを動かす | 右下の組み込みのつまみを 60px 上へ (250 → 190)、続けて左上を 50px 上へ | 組み込みで `style.height` が `190px`、左上はそこから `240px` (上端 483 → 433、下端 673 のまま) |
| 10 | 手で動かしたパネル (上端で置かれる) でも下端は動かない | ヘッダを掴んでパネルを動かし (`style.top` 286px)、つまみを 100px 上へ、続けて 160px 下へ | 上へ: パネル `style.top` 286 → 186、入力欄の下端 568 のまま、高さ 240 → 340。下へ: `style.top` 346、下端 568 のまま、高さ 180 |
| 11 | つまみからパネルのドラッグが始まらない | 6〜10 の全部 | 動かしていない時のパネルの `style.top` は空のまま (dom test でも同じことを固定) |
| 12 | モバイル幅のつまみ | 390 幅でつまみ (y=595) を y=395 へ | 入力欄の上端 588 → 388、下端 700 のまま、高さ 312 |
| 13 | つまみの見た目 | 静止時、hover、ダーク | 入力欄の内側の左上の角に斜線 2 本 (12px の箱、右下の組み込みのつまみを左上へ写した向き)。つまみは `position: absolute` で、開いた直後の入力欄は min-height の 112px のまま、つまみの分の余白は無い。hover と入力欄の focus で少し濃くなる。ダークでも見える |

## 確かめていないこと

- タッチでのドラッグ。つまみは `touch-action: none` と pointer capture で、マウスと同じ pointer イベントの経路を通るが、実機のタッチ (iPhone / iPad の Safari) では動かしていない
- Safari での見た目と、組み込みの右下の resize との高さの共有
- `showPicker()` で一覧が開くこと (ネイティブの一覧は DOM にもスクリーンショットにも出ない)
