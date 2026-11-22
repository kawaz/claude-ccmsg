---
title: userscript の保存が config dir の userscript.ts を一時ファイルの rename で置き換えるので、symlink だと実ファイルになり、mode も変わる
status: open
category: bug
created: 2026-11-22
---

# userscript の保存が config dir の userscript.ts を一時ファイルの rename で置き換えるので、symlink だと実ファイルになり、mode も変わる

## 何が起きるか

`packages/daemon/src/userscript.ts` の書き込み (`userscript_write`、[DR-0057](../decisions/DR-0057-webui-userscript.md) §2) は、`<config dir>/userscript.ts` の隣に一時ファイルを書いてから rename する。`userscript.ts` が dotfiles の実ファイルへの symlink の時、rename が symlink そのものを実ファイルに置き換える。

- symlink が消え、dotfiles の側のファイルは古いまま残る (保存は dotfiles に届かない)
- 新しいファイルの mode は一時ファイルの作り方で決まり、元のファイルの mode は保たれない
- rename の前に fsync していないので、電源断で空のファイルが残りうる (未確認、コードを読んだだけ)

## 前例の直し方

同じ穴が `project-auto-mode.json` (DR-0063) にあり、`packages/daemon/src/project-auto-mode.ts` で次のように直した。

- 書き込み先は `realpath` で解いた実体の場所。一時ファイルは実体と同じディレクトリに作って rename する (symlink は残る)
- mode は元のファイルのものを保つ。ファイルが無ければ既定の mode
- 一時ファイルは rename の前に fsync する

## 決めること

- 同じ書き方を userscript にも入れるか。入れるなら書き込みの関数を共有にするか (config dir の人が手で書くファイルを daemon が書く所はこの 2 つ)
- 保存で作る `<state dir>/userscript.js` (daemon だけのファイル) も fsync するか
