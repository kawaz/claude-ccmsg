# say-command: 発声コマンドの契約

## コンテキスト

daemon は、セッションの tool `say` の呼び出しと許可依頼 (tool `permit`) を声で知らせる ([DR-0045](../decisions/DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6)。声を出すのは config の `say_command` で指定された 1 つのコマンド (以下、発声コマンド) で、無ければ ccmsg に同梱の組み込みの発声コマンドが macOS の `/usr/bin/say` で読み上げる。この文書は daemon と発声コマンドの間の取り決めの正本で、発声コマンドを書く人と daemon を実装する人の両方が読む。

取り決めの芯は「daemon は型の決まった入力を 1 発声につき 1 回渡して終わりを待つだけで、どう声にするか (どの声・どの端末・鳴らすかどうか) は発声コマンドが全部持つ」こと。読み上げ辞書は daemon が当て、当てる前の文と当てた後の文を両方渡す。

## config

| キー | 既定 | 内容 |
|---|---|---|
| `say_command` | 組み込み | 発声コマンドの argv (空でない文字列の配列)。先頭は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前。daemon の起動時に実行できるファイルの絶対パスに固定し、見つからなければ daemon は起動しない (`launch_command` と同じ読み方、[launch-command](./launch-command.md)) |

```json
{
  "say_command": ["~/bin/ccmsg-say"]
}
```

## 呼ばれ方

| 項目 | 内容 |
|---|---|
| argv | `say_command` の配列そのまま (先頭は daemon が config を読んだ時に固定した絶対パス)。daemon は引数を足さず、shell を介さない |
| cwd | daemon の cwd |
| 環境 | daemon の環境をそのまま継ぐ |
| stdin | 入力の JSON (UTF-8) を 1 つ書いて閉じる。末尾に改行は付かない (最後の byte は `}`)。`read` のように改行までを読む道具では取りこぼすので、`cat` や `jq` で全部を読む |
| stdout | 捨てる |
| process group | 発声コマンドは自分の process group を持って起こされる (setsid)。timeout の SIGKILL は group に送られ、発声コマンドが起こした発声のプログラムも一緒に止まる |
| 回数と順 | 発声 1 回につき 1 回。daemon の中で直列で、前の発声コマンドが終わってから次を起こす (声が重ならない) |
| 待ち | 1 回 120 秒。超えると process group に SIGKILL を送って次の発声へ進む |

## 入力

形は `packages/protocol` の `SayCommandInputSchema`。

| field | 型 | 意味 |
|---|---|---|
| `kind` | `say` / `permit` | 何の発声か。`say` は tool `say` の呼び出し (subagent / teammate のものも含む)、`permit` は許可依頼 |
| `session_id` | 文字列 (空でない) | 発声を起こしたセッションの id。subagent / teammate の say はその親のセッション |
| `text` | 文字列 | 書かれた文。`say` は tool の `text`、`permit` は依頼の `voice` |
| `spoken` | 文字列 | `text` に読み上げ辞書を当てた文 (`<config dir>/say-dictionary.tsv` を同梱の辞書に重ねたもの)。声にするのはこちら |
| `session` | object (任意) | `session_id` のセッションの、発声を頼まれた時点の行。op `peers` (`ccmsg peers`) の各行と同じ形 (`PeerInfoSchema`) で、欄 (`name` / `cwd` / `vcs` / `repository` 等) はその版の `ccmsg peers` に従う。daemon がそのセッションを持っていない時は無い |
| `url` | 文字列 (任意) | その say / 許可依頼のバブルを webui で開く URL。`<webui_url>/s/<session_id>/timeline/<位置>` で、`<webui_url>` は op `ping` の返事の `webui_url` (webui を開く外の origin の先頭) の発声の時点の値。daemon に webui の URL が無い時 (loopback だけで開いている、HTTP が off) は無い。位置は下の表 |

```json
{"kind":"say","session_id":"5a900000-0000-4000-8000-000000000001","text":"daemon を再起動した","spoken":"デーモン を再起動した","session":{"sid":"5a900000-0000-4000-8000-000000000001","name":"ccmsg","repo":"claude-ccmsg","ws":"main","cwd":"/work/claude-ccmsg"}}
```

(`session` は一部の欄だけを示した)

`url` の位置は、webui が自分でそのバブルへ移る時と同じ URL ([webui-url-grammar](./webui-url-grammar.md)。組み立ては protocol の `timelineHref` を webui と共有する)。

| 何の発声か | `url` の path | 開いた時 |
|---|---|---|
| main の say | `/s/<sid>/timeline/<その呼び出しの行の uuid>` | TL がその行の say のバブルを選び、TL 表示領域の一番上に置く |
| 許可依頼 | `/s/<sid>/timeline/<その permit の呼び出しの行の uuid>` | 同上 (🔐 のフィルタの「TL に移動」が着地する URL と同じ) |
| subagent / teammate の say | `/s/<sid>/timeline/head?filter=say` | 🔔 のフィルタ。そのバブルは worker の transcript の行で、親の TL に時刻の位置で合流させて描かれ、位置 (選択) を持たない ([DR-0050](../decisions/DR-0050-timeline-notification-badges.md) §10)。フィルタは新しいものを一番下に並べて末尾から見せる |

```json
{"kind":"permit","session_id":"5a900000-0000-4000-8000-000000000001","text":"bucket policy の変更の許可をお願いします。","spoken":"bucket policy の変更の許可をお願いします。","url":"https://ccmsg.example.ts.net/s/5a900000-0000-4000-8000-000000000001/timeline/0b7c3e2a-1f40-4c39-9a51-6f2d8e4a7b10"}
```

- 発声コマンドは使う欄だけを読み、知らない欄は無視する。`session` は `ccmsg peers` の行なので版によって欄が増減し、daemon も入力に欄を足すことがある。知らない欄で断ると、ccmsg を上げた時に声が止まる
- 使う欄が無い・型が違う時は、推測で補って鳴らさず、0 以外で終わって理由を stderr に書く

## 戻り方

- **終了コード**: 0 は発声した (または鳴らさないと決めた)。0 以外は daemon.log に `say: <コマンド> exited <コード>: <stderr の最初の行>` の 1 行で残る。daemon は終了コードをそれ以上解釈せず、次の発声へ進む
- **stderr**: 0 以外で終わる時の理由。daemon.log には最初の行だけが残るので、要点を先頭に書く
- **速やかに終わる**: 発声が終わったら終わる。120 秒を超えると止められる

## 組み込みの発声コマンド

config に `say_command` が無い時、daemon は同梱の TypeScript `packages/daemon/src/default-say-command.ts` を daemon と同じ bun で起こす (`[<daemon の bun>, <スクリプト>]`)。新しい依存は要らない。スクリプトがすることは次のとおり。

- stdin の JSON から `spoken` だけを読む (`SayCommandInputSchema` の `spoken` の形で、他の欄は見ない)。JSON でない、`spoken` が文字列で無い時は理由を stderr に書いて 2 で終わる
- `/usr/bin/say` が実行できるファイルでなければ (macOS 以外)、そのことを stderr に書いて 1 で終わる
- `[/usr/bin/say, "--", <spoken>]` を起こし、その終了コードで終わる。`--` は `-` で始まる文を say のオプションとして読ませないため (実測: `say -o <file> "-v テスト"` は本文を読まずに exit 0、`--` を付けると発声する)

声や出力先を変えたい、別の端末で鳴らしたい (スマートフォンへ通知を送り、押すと `url` を開く等)、`kind` や `session_id` で鳴らし分けたい環境は、自前の発声コマンドを書いて `say_command` に置く。

## テストの daemon

テストの run の lifeline (`CCMSG_TEST_LIFELINE`、テストの preload が立てる) の下で起きた daemon は、config に `say_command` が無ければ何も起こさず、発声ごとに daemon.log に `say: not spoken (a test's daemon with no say_command): kind=<kind> session=<sid>` の 1 行を書く。`say_command` を書いた daemon は、lifeline の下でもそのコマンドを起こす。発声を確かめるテストは、stdin を記録するだけの発声コマンドを config の `say_command` に書く。

- テストの daemon は鳴らさない: 組み込みは、テストを走らせている手元で声を出す
- lifeline はテストの run が起こした daemon の印で、preload が全部のテストに立てる。これに掛けると、黙らせる網が 1 か所に集まり、`say_command` を書き忘れたテストの daemon も鳴らない
- 本番の daemon が発声コマンドを受け取る道は config の `say_command` 1 本で、それと並ぶ環境変数を持たない
