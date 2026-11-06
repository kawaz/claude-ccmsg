# Changelog

claude-ccmsg の版ごとの変更点。新しい版が上。[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、1 版を数行の箇条書きにする。版の見出しは `## v<版> <a id="v<版>"></a>` の形で、その下の 1 行目に日付を書く。web UI の版の表示はこのアンカー (`#v<版>`) へのリンクになっている。最も下の節より前の版は載せていないので、git の履歴の `Release v<版>` の commit を見る。

## v0.216.1 <a id="v0.216.1"></a>

2026-11-06

- 許可依頼 (permit) のバブルにも翻訳タブと既定タブの判定を付けた (止められた行動・intents・コマンドの説明を訳す。コマンド本文と添付のパスは原文のまま)
- `say` の `text` と `permit` の `voice` の入力 schema に `description: "日本語"` を付け、skill にも「日本語で書く」と書いた (読み上げと 🔔 に出る文は応答言語に依らず日本語)

## v0.216.0 <a id="v0.216.0"></a>

2026-11-06

- 翻訳比較タブに `ja(plamo)` を足した (DR-0049)。ブラウザがローカルの PLaMo 翻訳サーバ (config `translate_plamo_url`) に段落ごとに直接 fetch し、4 並列で逐次表示。glossary と context を既定で付ける。到達できない環境ではタブを出さない
- 英語主体の段落 (コードを除いて 20 文字以上、日本語比率 2 割未満) が 1 つでもある thinking / 応答は、既定で `ja(plamo)` を開く
- タブの順を `original / ja(plamo) / ja(browser) / ja(host)` にした
- findings: PLaMo と macOS host 翻訳の品質・速度の比較

## v0.215.2 <a id="v0.215.2"></a>

2026-11-06

- Status タブの再起動フォームの textarea でも ⌘+Enter (Ctrl+Enter) で送信できるようにした

## v0.215.1 <a id="v0.215.1"></a>

2026-11-06

- CHANGELOG の版のアンカーを `#v0.215.1` のように区切り付きにした (見出し行に明示アンカー)。web UI の `ccmsg v…` のリンクもそれを指す

## v0.215.0 <a id="v0.215.0"></a>

2026-11-06

- 版ごとの変更点をリポ直下の `CHANGELOG.md` に書く運用を始めた (この版から)。`just bump-version` と `just push` は新版の節が無いと止まる
- web UI の版の表示 (Timeline 下の状態行の `ccmsg v…` / `claude v…`、GLOBALS の daemon と Claude Code の版) が、それぞれの CHANGELOG の版の見出しを新しいタブで開くリンクになった
