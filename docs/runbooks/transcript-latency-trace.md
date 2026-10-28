# Runbook: Timeline 更新遅延の切り分け (trace.jsonl)

- Last Updated: 2026-10-28

## 適用ケース

webui の Timeline が「セッションは動いているのに追従が遅い / 止まって見える」
状態になったとき、**どの境界で時間が消えたか**を特定する。推測せずに`trace.jsonl` を読む。

## 何が記録されるか

transcript の 1 行が file に書かれてからブラウザの DOM に載るまでの各境界を、1 本の JSONL に時刻付きで残す。相関キーは **`(sid, start, end)`** = daemon がwire に載せた byte 範囲。全境界の行がこの 3 つを共有するので jq で束ねられる。

| kind | comp | 意味 |
|---|---|---|
| `transcript_read` | daemon | module の push を合図に完全な行を読み終えた (`bytes` / `lines`。`source` が `push` = push の時の読み、`retry` = まだ書かれていない行を待つ読み直し、[DR-0045](../decisions/DR-0045-say-speaks-in-tool-shown-from-transcript.md) §2) |
| `wire_write` | daemon | 購読者へ送信 (`subscriber` は購読者の連番、`entry_ts`) |
| `ws_receive` | webui | タブが WS で受信 |
| `store_dispatch` | webui | reducer が反映し終えた |
| `dom_commit` | webui | 追記行が document に載った |

`entry_ts` は読んだ行自身の `.timestamp` = Claude Code がその行を書いた時刻。
ファイル書き込みより前のレイテンシ (セッション側の遅延) はここに出る。

補足:

- **場所**: `<stateDir>/trace.jsonl` (通常 `~/.local/state/ccmsg/trace.jsonl`。
  `CCMSG_STATE_DIR` を設定していればそのディレクトリ)。10MB で `trace.jsonl.1`
  に 1 世代だけローテーションする
- **daemon 側は全配信を記録**する。**ブラウザ側は間引かれる**: 受信→DOM が1 秒を超えた配信は必ず記録、それ以外は 20 件に 1 件(`packages/webui/src/client/trace.ts` の `SLOW_DELIVERY_MS` /
  `HEALTHY_SAMPLE_EVERY`)。**遅い配信は取り逃さない**設計なので、「遅かったのに webui の行が無い」は「タブに届いていない」を意味する
- ブラウザ側 3 点の時刻は**タブの時計**で打つ。daemon と時計がずれている環境では daemon↔webui をまたぐ差分に下駄が乗る (webui 3 点どうしの差分は無事)
- 行が読めた時だけ記録する。まだ書かれていない行を待つ読み直しのうち、何も読めなかった回は残らない

## 手順

### 1. 対象 sid の配信が記録されているか見る

```bash
sid=<対象の sid>
jq -c --arg sid "$sid" 'select(.sid == $sid)' ~/.local/state/ccmsg/trace.jsonl | tail -20
```

### 2. 境界ごとの所要時間に分解する

各配信を 1 行にして、境界の差分 (ms) を出す。**遅い境界を探す**のが目的:

```bash
jq -s --arg sid "$sid" '
  def ms: (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000 + (.[20:23] | tonumber);
  map(select(.sid == $sid))
  | group_by([.start, .end])
  | map({
      end: .[0].end,
      t: (map({key: .kind, value: (.ts | ms)}) | from_entries),
      entry: (map(.entry_ts // empty) | first | if . == null then null else ms end),
      source: (map(.source // empty) | first)
    })
  | map(select(.t.dom_commit))
  | map({
      end,
      source,
      entry_to_read: ((.t.transcript_read - .entry) | round),
      read_to_wire:  (.t.wire_write - .t.transcript_read),
      wire_to_ws:    (.t.ws_receive - .t.wire_write),
      ws_to_store:   (.t.store_dispatch - .t.ws_receive),
      store_to_dom:  (.t.dom_commit - .t.store_dispatch),
      total_ms:      ((.t.dom_commit - .entry) | round)
    })
' ~/.local/state/ccmsg/trace.jsonl
```

`entry_to_read` は、Claude Code が行を書いた時刻 (`entry_ts`) から daemon が読むまで。行は module の push より 20〜200 ms 後に書かれ、daemon はそれを 50 ms 間隔の読み直しで拾うので、健全時もこの程度は乗る (実測は [findings](../findings/2026-10-28-transcript-push-live-verify.md))。

### 3. 遅い境界から原因を絞る

| 大きい境界 | 意味 | 次に見るもの |
|---|---|---|
| `entry_to_read` | 行が書かれてから読むまでが遅い | push が届いているか (下記 4)。daemon.log の `gave up waiting` (待つ上限の 5 秒を過ぎた行は、次の push の読みまで届かない) |
| `read_to_wire` | daemon 内の送信が遅い | 配信サイズ (`bytes`)、daemon の負荷 |
| `wire_to_ws` | daemon が送ってからタブが受けるまでが遅い | ネットワーク経路、WS のバックプレッシャ、タブの背景スロットリング |
| `ws_to_store` | reducer が遅い | 配信サイズ、`needsResync` による再取得の有無 |
| `store_to_dom` | 再レンダーが遅い | Timeline の行数、fold/highlight のコスト |
| **`dom_commit` の行が無い** | タブまで届いていない or 描画されていない | 下記 5 |

### 4. module の push が届いているか

daemon は module の push を合図にしか jsonl を読まない。対象 sid の `transcript_read` が 1 行も無いなら、そのセッションから push が来ていない:

```bash
jq -r --arg sid "$sid" 'select(.sid == $sid and .kind == "transcript_read") | .source' \
  ~/.local/state/ccmsg/trace.jsonl | sort | uniq -c
```

push が来ないのは、セッションに hooks module が無い (module の無いセッションに live の Timeline は無い)、または module が push を持たない古い版のとき。後者はセッションの再起動で新しい版の module になる。

### 5. daemon は送ったのにブラウザの行が無い場合

**個々の配信に webui の行が無いのは正常**。健全時は 20 件に 19 件が間引かれるので、「webui の行が無い配信を探す」query はほぼ全件を拾ってしまい役に立たない。
見るのは **webui の行が途切れてからの経過**:

```bash
jq -s --arg sid "$sid" '
  def ms: (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000 + (.[20:23] | tonumber);
  map(select(.sid == $sid))
  | { last_wire:   (map(select(.kind == "wire_write"))  | last),
      last_commit: (map(select(.kind == "dom_commit")) | last) }
  | { last_wire_ts: .last_wire.ts, last_commit_ts: .last_commit.ts,
      wire_end: .last_wire.end, commit_end: .last_commit.end,
      gap_ms: (if .last_commit then ((.last_wire.ts | ms) - (.last_commit.ts | ms) | round) else null end) }
' ~/.local/state/ccmsg/trace.jsonl
```

判定:

- `gap_ms` が数秒以内、`commit_end` が `wire_end` に追いついている →
  ブラウザ側は生きている。遅延は手順 2 の境界内訳で見る(最後の配信が記録対象だった場合、commit は wire より後なので `gap_ms` は0 前後の負値になる。追いついている印)
- `gap_ms` が大きく `commit_end` が `wire_end` から大きく取り残されている、または `last_commit_ts` が null → **切り分けは daemon より下流**
  (WS 切断・タブの休止・`transcript_subscribe` の消失)。20 件に 1 件は必ず通るはずの報告が長時間途切れているので、間引きでは説明できない
- 1 秒超の配信は必ず記録されるので、`elapsed_ms` が大きい webui 行があればそれが遅延の実サンプル:

```bash
jq -c 'select(.kind == "dom_commit" and .elapsed_ms > 1000)' ~/.local/state/ccmsg/trace.jsonl | tail
```

## 再現環境で試すとき

本番 daemon を触らずに確認する場合は `.claude/skills/verify` の隔離 daemon 手順(`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を temp dir に、`CCMSG_HTTP_BIND` を空きポートに) を使う。`trace.jsonl` はその `CCMSG_STATE_DIR` 配下に出る。

## 関連

- `packages/daemon/src/trace.ts` — 書き出しとローテーション
- `packages/daemon/src/transcript.ts` — daemon 側 3 境界
- `packages/webui/src/client/trace.ts` — ブラウザ側 3 境界とサンプリング
