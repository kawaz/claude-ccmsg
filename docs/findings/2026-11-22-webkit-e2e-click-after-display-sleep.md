# macOS で放置によるディスプレイのスリープの後、webkit headless のマウスの座標が狂い e2e の click が全部落ちる (実測)

- Date: 2026-11-22
- 対象: playwright 1.65.1 (webkit-2388、WebKit 27.2)、chromium 159.0.8154.6、bun 1.4.4、macOS 26.5.2 (Apple silicon)、内蔵ディスプレイ (scale 2) と外付けディスプレイ (scale 1) の 2 枚
- 動機: `just e2e` が 73 pass / 19 fail になり、落ちたのが全部 webkit で、どれも playwright の click が `<html lang="ja">…</html> intercepts pointer events` で 30 秒の時間切れだった。同じ日の早い時刻には 92 pass / 0 fail で、前に通っていた commit の上でも同じように落ちた
- 方法:
  - リポのコードを使わない最小ページ (`page.setContent` で button を 2 個置くだけ) で、webkit と chromium の `locator.click` を試した
  - 同じく最小ページで、`document` に capture で `mousemove` / `mousedown` / `click` の listener を付け、`page.mouse.move(150,125)` → `down` → `up` → `move(10,10)` で、ページに届いた `clientX` / `clientY` / `target` を記録した
  - `pmset -g log` と `log show` (WindowServer / loginwindow) で、ディスプレイの電源と画面のロックの時刻を見た
  - ディスプレイを `caffeinate -u -t 3` で起こし、`pmset displaysleepnow` で消し、別の webkit を起動したままにして、それぞれで同じ観測をし直した

## 判明した事実

### 落ちていた時の様子

- 最小ページでも webkit の click は落ちた (button の位置によらず、左上でも右下の `position: fixed` でも)。chromium は通った。リポのコードは関係しない
- `locator.boundingBox()` は正しい値 (`{x:100,y:100,width:100,height:50}`) で、`document.elementFromPoint` もその中心で BUTTON を返した
- ページに届いたマウスのイベントは座標が狂っていた: `mouse.move(150,125)` と `down` / `up` が `mousedown` / `click` として **(-1059, 1243)、target は HTML** で届き、`mousemove` は 1 件も届かなかった。playwright の hit target の確かめは、この狂った座標の先の `<html>` を見て「`<html>` が pointer を取っている」と報告していた

### いつから

- 22:44:06 に、放置によるディスプレイのスリープと画面のロックが同時に起きた (loginwindow の `kLWLockFromDisplayDim`、WindowServer で内蔵と外付けの両方が `target_state=off`)。92 pass の回はこれより前、落ちた回は全部後
- 22:44〜23:58 の WindowServer の display のログに、ディスプレイの構成が変わった記録は無かった。`NSScreen.screens` は落ちている間も 2 枚 (内蔵が主、外付けが上) を返していた

### 状態を変えての観測

| 状態 | ページに届いた座標 | webkit の click |
|---|---|---|
| 22:44 の放置のスリープ・ロックのまま | (-1059, 1243)、HTML、`mousemove` 無し | 落ちる |
| `caffeinate -u -t 3` で起こした直後 (ロックのまま) | (150, 125)、BUTTON | 通る |
| その後 `pmset displaysleepnow` で消した (ロックのまま) | (150, 125)、BUTTON | 通る |
| 消えたまま、別の webkit を起動しておく | (150, 125)、BUTTON | 通る |
| 起こした後の `just e2e` 全体 | — | 96 pass / 0 fail (52 秒) |

- **一度ディスプレイを起こすと、狂った状態から抜ける**。抜けた後は、ディスプレイが消えていることも、画面のロックも、別の webkit の同時起動も、それだけでは座標を狂わせない
- 狂った状態に入れ直すことはできなかった (`pmset displaysleepnow` では入らない)

### 未特定

- 何が座標を狂わせていたか。放置によるスリープ (`displaysleepnow` と経路が違う) か、スリープが長く続いたことかは分かっていない。webkit headless の窓は画面の外 (`screenX` / `screenY` が -10000) にあり、窓の座標と画面の座標の変換が、スリープの間に古い画面の情報で行われた、という見立ては未検証
- 起こすことで必ず抜けるかは 1 回の観測だけ

## 実用的な示唆

- webkit の e2e が `<html> intercepts pointer events` で軒並み落ち、chromium が通る時は、コードを疑う前にこの状態を疑う。最小ページで `mouse.down` の届く座標を見れば数秒で切り分けられる
- 抜け方: `caffeinate -u -t 3` でディスプレイを起こしてから回し直す (画面が点く。ロックは解かない)
