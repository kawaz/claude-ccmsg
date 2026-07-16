# DR-0023: daemon 経由のローカル翻訳 (Safari 等 Translator API 非対応ブラウザ対応)

Status: Proposed
Date: 2026-07-17
Sponsor: kawaz r26 mid=71

## 1. 背景

thinking の英日翻訳は現在 Chrome built-in Translator API (browser ローカル、無料) で、
Safari 等の非対応ブラウザではタブ自体を出していない。kawaz 要件:

- Safari でも翻訳したい
- リアルマネーコストをかけない = クラウド AI 翻訳は使わない
- daemon が動くホスト OS のローカル翻訳機能を daemon 経由で使えないか

## 2. 調査結果 (実機 macOS 26.5)

- **Translation.framework は存在する** (`/System/Library/Frameworks/Translation.framework`、
  translationd 同梱)。macOS 15+ の Swift API `TranslationSession` でプログラム利用可能
- **標準 CLI は無い** (`translate` 等は未収録)。Shortcuts の翻訳アクション経由
  (`shortcuts run`) という迂回はあるが、事前にユーザが Shortcut を作る必要があり配布に不向き
- 制約: TranslationSession は **UI コンテキスト前提の API** (SwiftUI の
  `.translationTask` modifier 経由が正規)。headless CLI からは
  非公開実装依存を避けつつ NSApplication レス動作の可否を PoC で確認する必要がある
  (framework 直 link の CLI で動く報告はあるが要実機検証)
- 言語モデルは初回に OS がダウンロード (設定 > 言語と地域 > 翻訳言語)。en→ja は
  ダウンロード済みなら完全オフライン

## 3. 設計案

### 3.1 構成 (kawaz 案の具体化)

- **translate-helper CLI (Swift、リポにバンドル)**: stdin で text (jsonl バッチ)、stdout に
  翻訳結果。Translation.framework を直 link。ビルド済みバイナリを release に同梱するか、
  初回に daemon が `swiftc` でビルド (Xcode CLT 必須) — 配布方式は PoC 後に決定
- **daemon**: 新 op `translate` (text[] → text[])。helper を子プロセスで呼ぶ (常駐 or
  都度起動は latency 実測で決定)。macOS 以外 / helper 不在ではエラー (webui はタブ非表示に
  フォールバック)
- **webui**: 排他フォールバックではなく**翻訳比較タブ** (kawaz mid=72)。thinking の
  タブ列を `original / ja(host) / ja(browser)` とし、利用可能な翻訳経路を全部並べる:
  - ja(host) = daemon translate op (macOS Translation.framework、辞書的で信頼度高め)
  - ja(browser) = Chrome built-in Translator API (AI 翻訳、勝手意訳の実績あり —
    kawaz: 「禿げてるね → そんな、かっこいいですよ！」級のクソ翻訳が起きる)
  - 経路が 1 つしか無い環境 (Safari = host のみ / daemon 非対応 OS + Chrome =
    browser のみ) はその 1 タブだけ出す。両方無ければ従来通り翻訳タブ非表示

### 3.2 判断根拠

- Shortcuts 経由はセットアップ依存 + 遅い (プロセス起動 ~秒) ので不採用
- クラウド API (DeepL free 等) は kawaz 要件 (ローカル以外不使用) で除外

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + **PoC**: (a) Swift CLI から TranslationSession が headless で動くか、(b) 日英混在テキストの扱い (kawaz mid=73) — 丸ごと投げて日本語部分を保持したまま英語部分だけ翻訳されるか / 改行が保存されるか、を実機検証 |
| Phase 1 | helper CLI 本実装 + daemon translate op |
| Phase 2 | webui フォールバック配線 |

PoC が NG (headless 不可) の場合の代替: メニューバー常駐の極小 .app として helper を
作る (UI コンテキストを満たす)、または断念して報告。

### 混在テキストの扱い (kawaz mid=73)

現行 browser 翻訳は改行 (段落) 単位で「日本語を含むか」を判定して翻訳可否を分岐している
(translate.ts) が、**改行を挟まず英→日に切り替わる段落**では前半の英語が未翻訳のまま残る
既知問題がある。host 翻訳では:

- **第一候補 = 丸ごと投げる**: TranslationSession が日本語部分を壊さず英語部分だけ訳し、
  改行も保存するなら分岐ロジック自体が不要 (PoC (b) で判定)
- 改行が保存されない場合のみ、改行区切り分割 → 各断片翻訳 → 改行 join に落とす。
  その場合も断片単位の日本語判定 skip が要るかは PoC の翻訳品質 (日本語をそのまま
  返すか) を見て決める

## 5. 関連

- kawaz r26 mid=71 (要件)
- packages/webui/src/client/translate.ts — 現行 browser Translator API 実装
