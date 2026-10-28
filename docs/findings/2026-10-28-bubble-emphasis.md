# 許可依頼 (permit) と say のバブルを TL の中で目立たせる

- Date: 2026-10-28
- 課題 (kawaz 2026-10-28): permit と say のバブルが目立たず TL の中で探しにくい。既存の吹き出しの色相だけを変えた作りで全体に暗く沈み、エージェント間通信 (ccmsg) のバブルと見分けがつかない
- 対象: 作業コピーの daemon (v0.201.0) を隔離して起動し (`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ディレクトリ、HTTP は `127.0.0.1:18652`)、playwright-cli の Chromium で webui を開いた。`set-color-scheme` でライト / ダークを切り替えた
- fixture: `CCMSG_CLAUDE_CONFIG_DIRS` に一時ディレクトリの config dir を 1 つだけ渡し、`sessions/<pid>.json` を `sleep` のプロセスの pid で書いた (sid は乱数、名前は `🤖ccmsg-verify-bubble`)。transcript には、ユーザの発話、assistant の応答、別セッションから届いた ccmsg 1 通、このセッションが送った ccmsg 1 通 (Bash の `ccmsg post`)、PushNotification 1 回を置いた。その sid で session として hello し、permit を 2 件、say を 2 件記録し、user として 1 件目の permit と 1 件目の say を既読にした。実セッションには何も届けていない
- 撮り方: 1000x2300 の窓で ccmsg の折り畳みを開き、`.tl-lines` を要素ごと撮った。390 幅は 390x2600

## スクリーンショット

リポには入れず、作業の一時ディレクトリに置いた。

| | ライト | ダーク |
|---|---|---|
| before | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/before-light.png` | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/before-dark.png` |
| after | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/after-light.png` | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/after-dark.png` |
| Sessions 一覧 (after) | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/after-sessions-list.png` (未読の say の 🔔 と未読の許可依頼の 🔐) | |

TL の画像はどれも上から: ユーザの発話 → assistant → ccmsg (受信) → ccmsg (送信) → PushNotification → assistant → 既読と未読の permit 各 1 件と say 各 1 件 (同じ時刻に記録したので、並びは撮った回ごとに入れ替わる)。

## before で観測したこと

- permit の面と枠は info (青、hue 250)。直接の ccmsg の吹き出しは `--peer-bubble-bg` (青)。ライトでは両方とも淡い青の面で、違いは permit に 1px の枠があることだけ
- say は琥珀の淡い面と左の罫 3px。room の ccmsg (`--member-hue`) と同じ明度・彩度の面と左の罫の作りで、色相だけが違う
- permit は未読と既読で見た目が全く同じ (未読かを見た目に出していなかった)。say の未読と既読の差は左の罫の彩度だけ

## 何をどう変えたか

区別は色相でなく、明度・枠・形で付ける。ccmsg (エージェント間の情報) は変えず、色の付いた面だけの吹き出しのまま。未読と既読ではバブルの見た目を変えず (kawaz 2026-10-28)、アイコンと確認ボタンの有無で見分ける。

| 対象 | before | after |
|---|---|---|
| permit の面 | info の淡い青 | TL の地より明るい札 (`--card-surface`: ライト `--bg`、ダーク `--gray-4`) |
| permit の枠 | info の 1px | 墨 (`--gray-11`) の 2px + 影 (`--elevation-shadow`) |
| permit の送り手の行 | 小さい灰色の字 | 本文の幅いっぱいの帯を墨 (`--gray-11`) で塗り、字は地の色 (ライトは濃い灰の帯に白字、ダークは明るい灰の帯に暗い字)。アイコンを `--font-size-3xl` に |
| permit の「許可する」 | 白地に info の枠 | accent の塗り + 太字、余白を広く |
| permit の未読 / 既読 | 見分けが無い | 帯のアイコンが 🔐 / 🔓。見た目は同じ |
| say の形 | 角丸 0.5rem の札、左の罫 3px | 角丸 0.9rem の札。アイコンを左の列に立て (2rem の円、地の色に琥珀の輪)、送り手・本文・足元を右の列に並べる (`.say` を grid、`.say-meta` を `display: contents`) |
| say の面と枠 | 琥珀の淡い面 + 左の罫 3px (未読は彩度高、既読は低) | 琥珀の面 (`--warn-3`) + 琥珀の枠 2px で全周を囲む (`--warn-8`)、本文は `--fg-strong`。未読 / 既読とも同じ |
| say の未読 / 既読 | 左の罫の彩度 | アイコンが 🔔 / 🔕 と既読ボタンの有無。PushNotification (既読を持たない) は 🔔 |
| Sessions 一覧の未読の say の印 | 📣 | 🔔 (DR と code のコメント、README、say の tool が返す文も 🔔 に揃えた) |

ダークでも同じ規則で成立する: 帯と枠の `--gray-11` はダークでは明るい側の段に反転するので、地から遠い明度という関係は変わらない。札の面と影は `light-dark()` でライト / ダークを 1 か所に書いた。

## permit が 3 件並んだ時の帯の明度

未読と既読で見た目を変えないので、permit は既読になっても帯と枠が残り、何件も並ぶ場面が増える。fixture に permit を 3 件 (うち 1 件は既読) 続けて記録し、1000x1000 で並べて撮った。

| 帯と枠 | ライト | ダーク |
|---|---|---|
| 文字色 `--fg` | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/three-permits-light.png` | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/three-permits-dark.png` |
| 1 段明るい `--gray-11` (採用) | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/three-permits-gray11-light.png` | `/var/folders/dh/c2l61lq50878qz2hchwrcwwr0000gn/T/tmp.zVmvisKNMo/tmp.k9KjPw0Bk5/shots/three-permits-gray11-dark.png` |

- `--fg` では、3 件の墨の帯と 2px の墨の枠が画面の縦をほぼ埋め、塗りの「許可する」より帯と枠のほうが先に目に入る。依頼ごとに押すべきものは「許可する」なので、強さの順が逆になる
- `--gray-11` にすると帯と枠は 1 段軽くなり、「許可する」(accent の塗り) が画面で一番強い要素になる。ccmsg の淡い面とも say の琥珀とも、明度と形の差は保たれる。帯の字との明度差はライトで L 0.48 対白、ダークで L 0.78 対 `--bg` で、どちらも読める
- `--gray-11` の画像は撮影時に style を差し込んで撮った。CSS に入れた後の after の画像 (上の表) も `--gray-11` で撮り直している

## 確かめていないこと

- Safari (iOS / macOS) での見た目。Chromium だけで撮った
- 「許可する」/「既読」を押した瞬間にアイコンが替わるところをブラウザで見ること。既読のアイコンは既読にした記録を描いたもの (上の画像) で確かめ、押した後に 🔓 / 🔕 に替わり class が変わらないことは DOM の test (`packages/webui/test/permit-request.dom.test.ts`、`packages/webui/test/say-read.dom.test.ts`) で固定した
- 同じ TL に permit が何件も並んだ時の重さ (今回は 2 件)
