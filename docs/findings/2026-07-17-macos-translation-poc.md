# macOS Translation.framework headless PoC

- Date: 2026-07-17
- Related: [DR-0023](../decisions/DR-0023-daemon-local-translation.md)
- Environment: macOS 26.5.2 (25F84), macOS SDK 26.5, Apple Swift 6.3.3, arm64

## 判明した事実

1. **`TranslationSession` は Swift CLI から UI なしで直接利用できる。** `Foundation` と `Translation` だけを import した Mach-O CLI を `swiftc` で単発コンパイルし、`NSApplication` / RunLoop / SwiftUI `.translationTask` を起動せずに en→ja 翻訳できた。生成バイナリの直接依存にも AppKit / SwiftUI は含まれない。
2. **stdin/stdout helper CLI の構成は成立する。** pipe から受けた UTF-8 テキストを `TranslationSession(installedSource:target:)` に渡し、翻訳結果だけを stdout に返す試行が終了コード 0 で成功した。
3. **en→ja モデルは検証機にインストール済みだった。** `LanguageAvailability.status(from:to:)` は `installed`、session の `isReady` は翻訳前から `true` だった。`prepareTranslation()` は成功した。
4. **未インストール言語は headless session からダウンロード要求できない。** en→ar は `supported` だが未インストールで、`TranslationSession(installedSource:target:)` は `canRequestDownloads=false`、`isReady=false`、`prepareTranslation()` は `TranslationError.notInstalled` (`Languages must be downloaded on-device.`) になった。プログラムはダウンロード要求へ遷移せずエラーを返した。
5. **日英混在テキストは丸ごと翻訳できる。** 改行なしで英語から日本語へ切り替わる入力では英語部分だけが日本語化され、既存の日本語部分は同一文字列のまま保持された。日本語だけの入力も同一文字列で返った。
6. **複数段落の改行は保持された。** 空行を挟む 3 段落の入力は、段落境界の `\n\n` を保ったまま英語段落だけが翻訳され、日本語段落は同一文字列のまま残った。
7. **短い英文 1 件の翻訳処理は 3 試行で 1,319.914–1,396.205 ms、10 件バッチは 6,623.983–7,330.883 ms だった。** いずれも新しい CLI プロセスで測定した。session 準備は約 80–88 ms、プロセス全体の wall time は 1 件で 1.41–1.85 秒、10 件で 6.71–7.42 秒だった。
8. **非常に短い英文の自動言語判定は失敗しうる。** `LanguageAvailability.status(for: "Hello, world.", to: ja)` は `unableToIdentifyLanguage` になった一方、source を `en` と明示した session で同じ文を翻訳すると `こんにちは、世界。` が返った。

## 実用的な示唆 / ベストプラクティス

- **DR-0023 Phase 1 の stdin/stdout helper CLI 設計は成立する。メニューバー常駐 `.app` は不要。** 公開 API だけで headless CLI が実動し、pipe 入出力まで確認できた。
- helper は source/target を明示して `TranslationSession(installedSource:target:)` を使う。短文の自動言語判定を前提にしない。
- 初回利用前提として、必要な言語モデルが OS にインストール済みか `LanguageAvailability` で確認する。未インストール時は helper 内からダウンロード UI を出そうとせず、daemon から「端末の翻訳言語をダウンロードする」旨を案内するエラーを返す。
- host 翻訳は入力を改行や日本語判定で分割せず、まず全文を 1 リクエストとして渡せる。今回の英日混在 3 category（改行なし混在、複数段落混在、日本語のみ）では既存日本語と改行が保持された。
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
