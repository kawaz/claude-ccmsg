# macOS Translation.framework headless PoC

- Date: 2026-07-17
- Related: [DR-0023](../decisions/DR-0023-daemon-local-translation.md)
- Environment: macOS 26.5.2 (25F84), macOS SDK 26.5, Apple Swift 6.3.3, arm64

## 判明した事実

1. **`TranslationSession` は Swift CLI から UI なしで直接利用できる。** `Foundation` と `Translation` だけを import した Mach-O CLI を `swiftc` で単発コンパイルし、`NSApplication` / RunLoop / SwiftUI `.translationTask` を起動せずに en→ja 翻訳できた。生成バイナリの直接依存にも AppKit / SwiftUI は含まれない。
2. **stdin/stdout helper CLI の構成は成立する。** pipe から受けた UTF-8 テキストを `TranslationSession(installedSource:target:)` に渡し、翻訳結果だけを stdout に返す試行が終了コード 0 で成功した。
3. **en→ja モデルは検証機にインストール済みだった。** `LanguageAvailability.status(from:to:)` は `installed`、session の `isReady` は翻訳前から `true` だった。`prepareTranslation()` は成功した。
4. **未インストール言語は headless session からダウンロード要求できない。** en→ar は `supported` だが未インストールで、`TranslationSession(installedSource:target:)` は `canRequestDownloads=false`、`isReady=false`、`prepareTranslation()` は `TranslationError.notInstalled` (`Languages must be downloaded on-device.`) になった。プログラムはダウンロード要求へ遷移せずエラーを返した。
5. **日英混在テキストは丸ごと翻訳できるが、同じ文中の日本語が保たれるのは敬体の時だけ。** 改行なしで英語から日本語へ切り替わる入力では英語部分が日本語化される。既存の日本語部分は、敬体 (「ここから日本語です。」) なら同一文字列のまま残るが、常体なら敬体に書き換わる (「検証済みの結果だけを述べる。」→「検証済みの結果のみを述べます。」、「原因はまだ分からない。」→「原因はまだわかりません。」、2026-10-18 の追加検証)。日本語だけの入力は常体・敬体とも同一文字列で返った。
6. **空行 (`\n\n`) は保たれるが、単独の改行 (`\n`) は空行に広がる。** 空行を挟む 3 段落の入力は、段落境界の `\n\n` を保ったまま英語段落だけが翻訳され、日本語段落は同一文字列のまま残った。一方、1 行ずつ `\n` で区切った入力 (2 行、3 行、箇条書き 3 項目) は、どれも各行の間が `\n\n` になって返った (2026-10-18 の追加検証)。daemon の翻訳サービスは、テキストを空行で段落に分けて 1 段落ずつ batch の要素として送り、訳の中の連続する改行を 1 つに畳んで元の行の構造に戻している。
7. **短い英文 1 件の翻訳処理は 3 試行で 1,319.914–1,396.205 ms、10 件バッチは 6,623.983–7,330.883 ms だった。** いずれも新しい CLI プロセスで測定した。session 準備は約 80–88 ms、プロセス全体の wall time は 1 件で 1.41–1.85 秒、10 件で 6.71–7.42 秒だった。
8. **非常に短い英文の自動言語判定は失敗しうる。** `LanguageAvailability.status(for: "Hello, world.", to: ja)` は `unableToIdentifyLanguage` になった一方、source を `en` と明示した session で同じ文を翻訳すると `こんにちは、世界。` が返った。
9. **バッククォートの中は、コードらしい語なら残り、普通の英語なら訳される。** `` `just test` `` / `` `git status` `` / `` `translateWatchdogTimeoutMs` `` はバッククォートごと残ったが、`` `not measured` `` は「測定されていない」とかぎ括弧付きで訳され、バッククォートが消えた (2026-10-18 の追加検証)。

## 実用的な示唆 / ベストプラクティス

- **DR-0023 Phase 1 の stdin/stdout helper CLI 設計は成立する。メニューバー常駐 `.app` は不要。** 公開 API だけで headless CLI が実動し、pipe 入出力まで確認できた。
- helper は source/target を明示して `TranslationSession(installedSource:target:)` を使う。短文の自動言語判定を前提にしない。
- 初回利用前提として、必要な言語モデルが OS にインストール済みか `LanguageAvailability` で確認する。未インストール時は helper 内からダウンロード UI を出そうとせず、daemon から「端末の翻訳言語をダウンロードする」旨を案内するエラーを返す。
- host 翻訳に渡す時、空行で区切った段落の構造と敬体の日本語は保たれるが、段落の中の改行と、英語と同じ文に混ざった常体の日本語は保たれない (5、6)。行の構造は daemon が段落ごとに送って戻す。混在した日本語の書き換えと、バッククォートの中の英語の翻訳 (9) は手当てしていない: webui は日本語の比率が 0.1 を超える段落を翻訳に回さないので、翻訳に回るのは英語が主の段落に短い日本語が混ざったものだけで、書き換わるのは訳のタブの表示だけ (原文のタブはそのまま)。
- 10 件は個別プロセス起動ではなく 1 session の batch API にまとめる。今回の 10 件バッチ中央値 6.738 秒は、短文 1 件中央値 1.391 秒の単純な 10 倍より短い。
- session 準備は翻訳本体より短いが、短文 1 件でも全体で約 1.5 秒かかる。Phase 1 ではまず都度起動でも成立するが、連続リクエストの UI 応答性を重視するなら helper/session の常駐化を別途比較する価値がある。

## 検証の詳細

PoC コードと実行ログはリポジトリ外の scratchpad `translation-poc/` に置いた。非公開 API は使用していない。

### 検証マトリクス

| 項目 | 試行 | 実出力 | 判定 |
|---|---|---|---|
| (a) headless 動作 | `swiftc -parse-as-library -framework Translation` で CLI をビルドし、terminal から直接実行 | `build_exit=0`, `run_exit=0`, `pair_status=installed`, `is_ready_before=true` | OK。NSApplication / RunLoop 不要 |
| (a) UI framework 依存 | 生成バイナリを `otool -L` と `nm -u` で確認 | 直接依存は Translation, Foundation, libSystem, Swift runtime。`AppKit|SwiftUI|NSApplication` の undefined symbol は 0 件 | OK。CLI 自身は UI framework 非依存 |
| Phase 1 入出力形 | `printf '<混在テキスト>' \| ./stdin-helper` | 終了コード 0、stderr 空、stdout に翻訳結果のみ | OK。stdin/stdout helper が成立 |
| (b) en→ja | `Hello, world.` を source=en, target=ja で翻訳 | `こんにちは、世界。` | OK |
| モデル有無 | en→ja の availability と session readiness | `pair_status=installed`, `can_request_downloads=false`, `is_ready_before=true`, `prepareTranslation()` 成功 | en→ja は利用可能 |
| 未インストールモデル | `supported` の en→ar で installed-only session を準備 | `can_request_downloads=false`, `is_ready_before=false`, `TranslationError.notInstalled`, `Languages must be downloaded on-device.` | helper から自動ダウンロード不可。事前導入案内が必要 |
| (c) 改行なし混在 | `The build completed successfully.ここから日本語です。続きはそのままです。` | `ビルドが正常に完了しました。ここから日本語です。続きはそのままです。` | OK。既存日本語を保持 |
| (c) 複数段落 | 英語 / 日本語 / 英語の 3 段落を `\n\n` 区切りで一括翻訳 | `最初の段落は英語です。\n\nこれは日本語の段落です。\n\n第三段落も英語です。` | OK。改行と日本語段落を保持 |
| (c) 日本語のみ | `これは最初から日本語です。` | `これは最初から日本語です。` | OK。同一文字列で返る |
| (c) 常体の混在 (2026-10-18) | `Keep the output concise.検証済みの結果だけを述べる。` ほか 2 件 | `出力を簡潔に保ちます。検証済みの結果のみを述べます。` | NG。常体の日本語が敬体に書き換わる |
| (c) 常体の日本語のみ (2026-10-18) | `これは最初から日本語だ。` | `これは最初から日本語だ。` | OK。同一文字列で返る |
| (c) 段落内の改行 (2026-10-18) | 1 行ずつ `\n` で区切った 2 行 / 3 行 / 箇条書き 3 項目 | 各行の間が `\n\n` になる | NG。改行が空行に広がる |
| (c) バッククォート (2026-10-18) | `` `just test` `` / `` `git status` `` / `` `translateWatchdogTimeoutMs` `` / `` `not measured` `` | 前 3 つは残る。`not measured` は「測定されていない」 | コードらしい語は残り、英語の句は訳される |
| (d) 短文 1 件 | 新規プロセス × 3、`This is latency trial N.` | operation: 1390.630 / 1396.205 / 1319.914 ms。wall: 1.85 / 1.48 / 1.41 s | 中央値 operation 1390.630 ms、wall 1.48 s |
| (d) 10 件バッチ | 新規プロセス × 3、`translations(from:)` | operation: 7330.883 / 6623.983 / 6738.140 ms。全試行 `result_count=10`。wall: 7.42 / 6.71 / 6.83 s | 中央値 operation 6738.140 ms、wall 6.83 s |
| 短文の言語自動判定 | `status(for: "Hello, world.", to: ja)` | `TranslationError.unableToIdentifyLanguage`, `The language could not be automatically detected.` | source 明示が必要 |

### headless CLI の実出力

ビルドと実行:

```text
build_exit=0
run_exit=0
pair_status=installed
can_request_downloads=false
is_ready_before=true
prepare_ms=17.015
is_ready_after=true
case=short
input="Hello, world."
output="こんにちは、世界。"
translate_ms=1367.401
```

生成バイナリの直接リンク先:

```text
/System/Library/Frameworks/Translation.framework/Versions/A/Translation
/usr/lib/libSystem.B.dylib
/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation
/usr/lib/libobjc.A.dylib
/usr/lib/swift/libswiftCore.dylib
...Swift runtime libraries...
```

`nm -u` の `AppKit|SwiftUI|NSApplication` 検索結果は空だった。

### stdin/stdout 試行

入力:

```text
The first line is English.ここは日本語です。

The final paragraph stays separated.
```

実出力:

```text
build_exit=0
pipeline_exit=0
--- stdout ---
最初の行は英語です。ここは日本語です。

最後の段落は別々に残ります。
--- stderr ---
```

### 混在テキスト

改行なし混在:

```text
input="The build completed successfully.ここから日本語です。続きはそのままです。"
output="ビルドが正常に完了しました。ここから日本語です。続きはそのままです。"
translate_ms=653.952
```

複数段落混在:

```text
input="The first paragraph is in English.\n\nこれは日本語の段落です。\n\nThe third paragraph is also in English."
output="最初の段落は英語です。\n\nこれは日本語の段落です。\n\n第三段落も英語です。"
translate_ms=1075.120
```

日本語のみ:

```text
input="これは最初から日本語です。"
output="これは最初から日本語です。"
translate_ms=269.182
```

### 混在テキストの追加検証 (2026-10-18)

macOS 26 の同じ検証機で、daemon が使う helper (`packages/translate-helper/main.swift` のビルド) に 1 テキスト 1 リクエストで 14 件を 2 回ずつ送った。2 回の出力はすべて一致した。

| 入力 | 出力 |
|---|---|
| ``Keep the output concise.検証済みの結果だけを述べる。If the test has not run, write `not measured` rather than claiming that the change is safe.`` | `出力を簡潔に保ちます。検証済みの結果のみを述べます。テストが実行されていない場合は、変更が安全であると主張するのではなく、「測定されていない」と書きます。` |
| `Keep the output concise.検証済みの結果だけを述べる。` | `出力を簡潔に保ちます。検証済みの結果のみを述べます。` |
| `The build failed.原因はまだ分からない。Check the log first.` | `ビルドに失敗しました。原因はまだわかりません。まずログを確認してください。` |
| `The build completed successfully.ここから日本語です。続きはそのままです。` | `ビルドが正常に完了しました。ここから日本語です。続きはそのままです。` |
| `これは最初から日本語だ。` | `これは最初から日本語だ。` |
| ``Run `just test` and then `git status` before you commit.`` | ``コミットする前に、`just test`を実行し、次に`git status`を実行します。`` |
| ``Call `translateWatchdogTimeoutMs` with the total length.`` | ``合計長さで`translateWatchdogTimeoutMs`を呼び出します。`` |
| `First, open the file.\nThen read the first line.\nFinally, close it.` | `まず、ファイルを開きます。\n\nそれから最初の行を読んでください。\n\n最後に、それを閉じてください。` |
| `This is the first line.\nThis is the second line.` | `これは最初の行です。\n\nこれは2番目の行です。` |
| `- Install the model.\n- Restart the daemon.\n- Open the webui.` | `- モデルをインストールします。\n\n- デモンを再起動します。\n\n- webuiを開きます。` |
| `The first paragraph is in English.\n\nこれは日本語の段落です。\n\nThe third paragraph is also in English.` | `最初の段落は英語です。\n\nこれは日本語の段落です。\n\n第三段落も英語です。` |

段落ごとに送って連続する改行を畳む daemon の翻訳サービスを通すと、上の 3 つの改行の例は `\n` 区切りのまま返った。

### OS の on-device モデルが混んでいる時の所要と、返らない長文 (2026-10-18)

翻訳の推論は OS の on-device モデル (modelmanagerd 配下) を OS 自身の文章解析 (textunderstandingd の TextPersonExtraction、ほぼ 1 時間ごとに数分) と共有している。daemon の翻訳サービス (既定の watchdog) で短い 1 文を途切れなく送り続け、解析の開始 (modelmanagerd のログ) から 4 分間を測った。

| 項目 | 値 |
|---|---|
| 翻訳した文 | 315 (成功 314、watchdog の kill 1) |
| 成功の所要 | p50 0.63 s / p90 0.67 s / p99 3.6 s / 最大 10.8 s |
| 遅かったもの | 解析の開始から 50 秒の間に 10.8 / 5.0 / 7.9 / 6.5 / 3.6 s。その間の 1 件が 11 s の期限 (当時の短い入力の値) で kill された |
| 同じ日の別の解析の時間帯 (modelmanagerd のログ) | 12.5 / 30.6 / 13.2 / 10.5 / 17.0 s |

解析が走っていない時は 1 文 0.5〜0.7 s。CPU の負荷だけでは遅くならない (load average 27 で 1.2〜1.6 s)。

返らない長文: 14.7k 文字の 1 段落を helper に送ると、modelmanagerd に推論の request が約 2 分で 208 件作られた後に止まり、推論のプロセスの CPU が 0 % のまま 12 分経っても答えが返らなかった (helper を kill して打ち切り)。その間 helper の stdout / stderr には何も出ず、プロセスは生きていた。待たされているだけの request と外から見分ける手がかりは無く、daemon の watchdog は固定の期限 (入力の長さに比例) で判断している (`packages/daemon/src/translate-helper.ts` の `WATCHDOG_BASE_MS`)。

### 未インストール言語モデル

availability を調べた候補のうち en→ar / en→ru が `supported`、en→ja / fr / de / es / ko / zh-Hans が `installed` だった。最初の未インストール候補 en→ar で直接 session を準備した結果:

```text
missing_candidate=Language(... languageCode: Optional(ar) ...)
can_request_downloads=false
is_ready_before=false
prepare_error_type=TranslationError
prepare_error=TranslationError(cause: Translation.TranslationError.Cause.notInstalled, ...)
prepare_error_description=Unable to Translate
prepare_failure_reason=Languages must be downloaded on-device.
```

### レイテンシ

各試行は新しい CLI プロセスで行い、`ContinuousClock` で session 準備と翻訳処理を分け、`/usr/bin/time -p` でプロセス全体も測定した。

| 種別 | operation 最小 | operation 中央値 | operation 最大 | prepare 中央値 | wall 中央値 |
|---|---:|---:|---:|---:|---:|
| 短文 1 件 | 1,319.914 ms | 1,390.630 ms | 1,396.205 ms | 82.856 ms | 1.48 s |
| 10 件バッチ | 6,623.983 ms | 6,738.140 ms | 7,330.883 ms | 81.729 ms | 6.83 s |

10 件バッチは 3 試行すべてで 10 件の response を返した。機能確認用の別試行でも `Batch sentence number 1.` から `10.` までがすべて日本語へ翻訳された。
