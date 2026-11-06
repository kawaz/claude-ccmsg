# Changelog

claude-ccmsg の版ごとの変更点。新しい版が上。[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、1 版を数行の箇条書きにする。版の見出しは `## v<版>` で、その下の 1 行目に日付を書く (web UI の版の表示がこの見出しへのリンクになっている)。最も下の節より前の版は載せていないので、git の履歴の `Release v<版>` の commit を見る。

## v0.215.0

2026-11-06

- 版ごとの変更点をリポ直下の `CHANGELOG.md` に書く運用を始めた (この版から)。`just bump-version` と `just push` は新版の節が無いと止まる
- web UI の版の表示 (Timeline 下の状態行の `ccmsg v…` / `claude v…`、GLOBALS の daemon と Claude Code の版) が、それぞれの CHANGELOG の版の見出しを新しいタブで開くリンクになった
