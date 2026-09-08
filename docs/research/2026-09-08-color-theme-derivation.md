# テーマ入力からのカラー自動算出

調査日: 2026-09-08

対象は Bun でバンドルする React Web UI と、その単一 `app.css` にある light / dark のデザイントークンである。現状の全数棚卸しは `docs/findings/2026-09-08-webui-color-inventory.md`、既存規約は `docs/design/design-tokens.md` を参照する。

## 結論 (要約)

- **基本色空間は OKLCH、任意の二色間の補間は OKLab が適する。** OKLCH は `L`・`C`・`h` を別々に操作でき、同一 hue の階調生成に向く。OKLab は直交座標なので、無彩色近傍で意味を失う hue を直接扱わずに補間できる。
- **同一色系列は relative `oklch()`、既存二色の中間は `color-mix(in oklab, ...)` で導出する。** 現行の markdown 面色導出は後者の適切な利用例である。
- **CSS だけで大半の派生色は作れるが、アクセシビリティを保証できない。** WCAG 2 のコントラスト比は sRGB 相対輝度から計算するため、OKLCH の `L` 差だけでは合否を判定できない。生成時またはテスト時に最終表示色を検査する必要がある。
- **brand 一色だけを入力にするのは不十分である。** `success` / `warning` / `danger` / `info` は意味を持つため、brand から機械的に hue を回転して作らず、独立した既定 seed を持たせる。
- **light と dark は単純反転ではない。** 同じ hue を共有しても、背景・文字・境界・高彩度色の `L` と `C` はテーマごとに別設計が必要である。
- **全色を一体系へ統合しない。** UI semantic token と発話者面は自動算出の対象にする一方、Shiki の構文色とグラフ系列色はそれぞれ独立した色体系として維持する。

## 推奨方針

**ビルド時生成を正本とし、CSS の実行時導出は局所的な関係色に使う。**

1. 人が選ぶ入力を neutral seed、brand seed、状態色 seed、カテゴリ hue として定義する。
2. Bun の生成スクリプトで light / dark の primitive palette と semantic token を生成する。
3. 生成時に sRGB gamut mapping と WCAG 2 コントラスト検査を行い、制約を満たせなければビルドを失敗させる。
4. CSS では hover、selected、focus、面からの距離、半透明 overlay など、現在の文脈との関係で決まる色だけを `color-mix()` や relative `oklch()` で導出する。
5. React 側は semantic token のみを参照し、seed からの色計算を TSX に持ち込まない。

CSS は cascade と現在の surface を知っているため局所関係の導出に強い。生成スクリプトは反復探索、gamut 判定、全組み合わせのコントラスト検査、結果の固定と差分レビューに強い。この責務境界を維持する。

## 1. 色空間の比較

| 色空間 | 長所 | 弱点 | 用途 |
|---|---|---|---|
| HSL | CSS で広く使え、hue・saturation・lightness が直感的 | 数値差と知覚差が一致せず、同じ `L` でも hue により明るさが大きく異なる | 既存値の互換用途。新規 palette の正本にはしない |
| CIELAB / CIELCH | 知覚均一性を意図した標準色空間 | 特に青付近の hue curvature など、画面 UI の補間で不自然さが出る場合がある | 外部仕様との互換用途 |
| OKLab | sRGB / Display-P3 の補間で比較的均一。無彩色を含む二色間補間に扱いやすい | 人が hue / chroma を直接調整しにくい | `color-mix(in oklab, ...)`、transition |
| OKLCH | `L`・`C`・`h` を独立に操作できる | `C=0` 近傍では hue が powerless。指定色が表示 gamut 外になり得る | primitive scale、brand・状態色・発話者色 |

### 使い分け

- 同一 hue の階調生成: OKLCH
- 任意の二色間の補間: OKLab
- 白・黒・灰色を端点に含む補間: OKLab
- カテゴリ色: OKLCH でカテゴリごとに hue を固定し、テーマ別の共通 `L/C` recipe を適用

CSS Color 4 は、円筒座標で chroma がほぼゼロの色相を powerless hue として扱う。白・黒・灰色に「元の hue が保存されている」と仮定してはならない。色相環上の補間経路自体に意味がある場合だけ、OKLCH の `shorter hue`、`longer hue`、`increasing hue`、`decreasing hue` を明示する。

### gamut mapping

OKLCH は sRGB より広い色を表現できる。有効な CSS 値でも表示機器の gamut 外になり得るため、重要色をブラウザの表示時変換だけに委ねない。

生成時には次を行う。

1. 対象 gamut を原則 sRGB とする。
2. gamut 外なら hue と lightness を原則維持し、chroma を下げて収める。
3. mapping 後の実色でコントラストと色差を検査する。
4. Display-P3 は progressive enhancement とし、sRGB fallback も生成する。

## 2. CSS 機能とブラウザ対応

```css
:root {
  color-scheme: light dark;

  --brand: oklch(0.58 0.19 255);
  --surface: light-dark(oklch(0.985 0.004 255), oklch(0.20 0.012 255));
  --text: light-dark(oklch(0.24 0.015 255), oklch(0.92 0.010 255));

  --brand-hover: color-mix(in oklab, var(--brand), var(--text) 12%);
  --brand-soft: color-mix(in oklab, var(--surface), var(--brand) 12%);
  --brand-dim: oklch(from var(--brand) calc(l - 0.08) c h);
}
```

- `oklch()`: primitive と semantic token の表現
- `color-mix(in oklab, ...)`: hover、selected、soft background、border
- relative color syntax: 元色の一部の channel だけを変更する導出
- `light-dark()`: light / dark のペア。利用には `color-scheme` が必要
- `@property`: hue、lightness、chroma の型付けと補間アニメーション

2026-09-08 時点の採用目安は次のとおり。iPadOS の主要ブラウザは WebKit の対応状況が実質的な下限となる。

| 機能 | Baseline の目安 | Safari の初期対応目安 | 判断 |
|---|---:|---:|---|
| `oklab()` / `oklch()` | 2023-05 Widely available | 15.4 | 採用可 |
| `color-mix()` | 2023-05 Widely available | 16.2 | 採用可。現行でも利用済み |
| relative color syntax | 2024-09 Newly available | 16.4 | 対象 iPadOS 下限を確認。現行でも利用済み |
| `light-dark()` | 2024-05 Newly available | 17.5 | 対応下限を上げるため、全面置換は慎重に判断 |
| `@property` | 2024-07 Widely available | 15.4 | typed input / animation に採用可 |

現行 CSS はすでに relative `oklch(from ...)` を使うため、実質的な下限は Safari / iPadOS 16.4 相当である。`light-dark()` を全面採用すると 17.5 相当へ上がる。既存の `@media (prefers-color-scheme: dark)` と `[data-theme]` は、互換性と明示テーマ上書きの点で引き続き有効である。

発話者 hue のような型付き入力には次の形を使える。

```css
@property --member-hue {
  syntax: "<number>";
  inherits: true;
  initial-value: 255;
}

:root {
  --member-surface-l: 0.96;
  --member-surface-c: 0.03;
  --member-border-l: 0.65;
  --member-border-c: 0.15;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --member-surface-l: 0.24;
    --member-surface-c: 0.025;
    --member-border-l: 0.65;
    --member-border-c: 0.12;
  }
}

:root[data-theme="dark"] {
  --member-surface-l: 0.24;
  --member-surface-c: 0.025;
  --member-border-l: 0.65;
  --member-border-c: 0.12;
}

.member-bubble {
  background: oklch(
    var(--member-surface-l) var(--member-surface-c) var(--member-hue)
  );
  border-color: oklch(
    var(--member-border-l) var(--member-border-c) var(--member-hue)
  );
}
```

## 3. 既存のパレット生成手法

| 手法 | 入力 | 出力 | dark の扱い | 示唆 |
|---|---|---|---|---|
| Tailwind CSS v4 | CSS theme variables。標準 palette は OKLCH | 50〜950 の段階と utility | dark variant で利用側が選択。palette の自動 dark 化ではない | OKLCH primitive scale の実例。semantic mapping は別途必要 |
| Radix Colors | hue ごとの light / dark palette | 背景、interactive、border、solid、text に対応する 12 段階 | light / dark を別設計。alpha scale も別 | 段階を role に対応させ、単純反色反転しない設計が参考になる |
| Material Color Utilities / HCT | source color、scheme variant、contrast level | tonal palette と dynamic color roles | light / dark scheme を別算出 | seed から一式を作る完成度は高いが、Material の role model 導入が大きい |
| Open Props | 既成 custom properties | hue ごとの段階 palette | semantic mapping は利用側 | 小さく利用できるが、任意 seed から本 UI 固有 role を生成するエンジンではない |
| Adobe Leonardo | key color、background、目標 contrast | adaptive palette | 背景ごとに再計算 | contrast を生成条件にする考え方が有用 |
| Culori | JS の色値・色空間 | 変換、補間、gamut mapping、色差 | theme semantics は持たない | Bun generator の低レベル計算部に適する |

**実装候補は Culori 等の低レベル色ライブラリをビルド時 generator に使い、Radix の role scale と Leonardo の contrast-driven generation を設計参考にすること。** 複数ライブラリを実行時に混在させるのではなく、実装責務は一つの generator に置く。

Material HCT は動的 scheme に強いが、既存の発話者 hue、検索色、Shiki、グラフ色まで Material role に寄せる必然性がない。Radix は role 設計の参考になるが、任意 seed から Radix 品質の scale を生成する API ではない。

## 4. コントラスト保証

### WCAG 2

WCAG 2.2 の 1.4.3 は通常文字に 4.5:1、大きい文字に 3:1 を要求する。1.4.11 は UI component と graphical object に、隣接色との 3:1 を基準とする。生成器では少なくとも次を全数検査する。

- `fg` / `bg`: 4.5:1 以上
- `fg-muted` / 実際に載る各 surface: 文字サイズに応じた基準
- `accent-fg` / `accent`: 再利用安全性を考え 4.5:1 以上
- `success` / `warning` / `danger` / `info` の文字と各 surface: 4.5:1 以上
- focus ring / 隣接背景、input border / 隣接背景: 3:1 以上
- 検索 highlight foreground / 各 highlight: 4.5:1 以上
- bubble foreground / 各発話者 surface: 4.5:1 以上

alpha 色は単体で検査せず、想定背景へ compositing した実色を検査する。

### APCA

APCA は明暗極性、文字サイズ、weight に応じた知覚コントラストを扱う。ただし WCAG 3 は標準化途上であり、APCA を WCAG 2 適合判定の代替にしない。

1. 合否ゲート: WCAG 2.2 contrast ratio
2. 品質診断: APCA。小さい muted text、dark theme、色付き文字の比較に使う

### OKLCH `L` 差

`ΔL` は surface hierarchy の初期設計には便利だが、コントラスト保証ではない。同じ `L` でも chroma、hue、gamut mapping、sRGB 変換後の値により相対輝度が変わる。

- `ΔL`: surface と border の段階設計
- WCAG ratio: 適合判定
- APCA: typography を含む品質診断
- `ΔEOK`: 系列色間の識別性と gamut mapping 前後の変化量

## 5. CSS 実行時生成とビルド時生成

| 観点 | CSS 実行時 | Bun ビルド時 |
|---|---|---|
| 入力変更の即時反映 | 強い | 再生成が必要 |
| cascade / 現在の surface | 強い | 利用箇所を完全には知らない |
| 二色の混色・channel 操作 | 簡潔 | ライブラリが必要 |
| 条件を満たすまで `L/C` を探索 | 困難 | 容易 |
| gamut mapping の制御・記録 | ブラウザ依存 | 明示可能 |
| WCAG / APCA の全組み合わせ検査 | CSS 単体では不可 | CI gate にできる |
| fallback | 宣言が複雑 | RGB fallback を同時生成できる |
| runtime theme editor | 強い | クライアント側で同じ generator が必要 |

将来ユーザーが任意の brand 色を実行時に選べるようにする場合も、未検査の CSS 式を直接適用しない。Web Worker またはクライアント側 generator でビルド時と同じ検証関数を実行し、合格した token set のみ適用する。

### 設計パターン候補

- **2 層・CSS 中心:** input token から semantic token を CSS で直接導出する。実行時変更は容易だが、全組み合わせのコントラスト保証と gamut 制御が弱い。固定された少数の検証済み seed に限る場合の候補。
- **3 層・ビルド時生成:** input → primitive scale → semantic / component token とする。生成物は増えるが、制約探索、差分レビュー、CI 検査ができる。本 UI の第一候補。
- **3 層・実行時 generator:** 3 層構造を維持し、ブラウザ上の同一生成器で任意入力を検証してから適用する。ユーザー編集が必須になった場合の候補であり、初期実装には不要。

## 本 UI 向けの入力モデル

```ts
type ThemeSeeds = {
  neutralHue: number;
  brand: string;
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
  categoryHue: {
    user: number;
    peer: number;
    assistant: number;
    agent: number;
    say: number;
  };
};
```

状態色を brand の hue 回転で作ると、brand が赤・黄・緑の場合に意味色と衝突する。状態色は独立した既定値とし、必要なら入力で上書きする。

生成する層は次の三つに分ける。

1. **primitive:** `neutral-*`, `brand-*`, `success-*`, `warning-*`, `danger-*`, `info-*`
2. **semantic:** `bg`, `bg-alt`, `fg`, `fg-muted`, `fg-strong`, `border`, `accent`, `accent-fg`, `success`, `warn`, `danger`, `info`, `overlay`, `shadow-*`, `focus-ring`
3. **component:** bubble、search、cache ring、markdown。semantic token または現在の surface から導出

初期値が同じでも、変更理由と必要コントラストが異なる semantic role は別 token にする。例えば `accent` と `focus-ring` は同一 primitive を参照できるが、同じ token にはしない。

## 現行トークンへの適用

| 現状 | 移行先 |
|---|---|
| `--bg`, `--bg-alt`, `--fg`, `--fg-muted`, `--fg-strong`, `--border` | neutral seed とテーマ別 tone recipe から生成 |
| `--accent`, `--accent-fg` | brand seed から生成し、foreground との contrast を検査 |
| `--danger`, `--warn` | status primitive から生成 |
| 成功系の直書き緑 | `--success` と `--success-soft` に集約 |
| 警告系の直書き黄・琥珀 | `--warn` と用途別 semantic token に集約 |
| エラー系の直書き赤 | `--danger` と `--danger-soft` に集約 |
| 発話者 bubble | category hue + 共通のテーマ別 `L/C` recipe |
| member hue の同形 `oklch()` | `--member-surface-l/c`, `--member-border-l/c`, `--member-hue` に集約 |
| avatar の `hsl()` | 同じ seed hue と OKLCH recipe へ統合し、light / dark を生成 |
| `rgba(0,0,0,α)` / `rgba(255,255,255,α)` | `--shadow-*`, `--overlay`, `--overlay-control-bg` |
| markdown 色 | 現行の surface-relative 導出を維持 |
| Shiki | 既存の light / dark theme を維持 |
| chart series | データ可視化専用 palette として別検査 |

## 生成アルゴリズム候補

1. seed を OKLCH へ変換する。
2. role ごとの目標 `L/C` recipe を light / dark 別に適用する。
3. sRGB gamut 外なら hue と `L` を原則維持し、`C` を二分探索で下げる。
4. foreground / background の必須組み合わせを compositing 後の sRGB で検査する。
5. 不合格なら role ごとに許可された channel だけを探索する。
   - text: 主に `L` を背景から遠ざける。
   - solid accent: foreground 候補を選び直し、それでも不足する場合は accent の `L/C` を調整する。
   - muted text: 許容範囲内で `L` を調整する。
   - semantic hue: 意味保持のため原則固定する。
6. 制約内で合格解がなければ生成エラーにする。
7. CSS custom properties、sRGB fallback、OKLCH 値、検査レポートを同時出力する。

```ts
for (const role of roles) {
  let color = applyRecipe(seeds, role, scheme);
  color = mapToSrgbByReducingChroma(color);
  color = searchAllowedChannels(color, role.constraints);
  assertContrastMatrix(role, color, resolvedSurfaces);
  emit(role.cssVariable, color);
}
```

## 検証マトリクス

| seed category | 探す反例 |
|---|---|
| 青・紫系 brand | 通常ケース。accent と peer / assistant の区別 |
| 黄・橙系 brand | solid accent のコントラスト、warning との衝突 |
| 赤・緑系 brand | danger / success との意味衝突、色覚多様性での識別 |
| 低彩度 brand | accent が neutral hierarchy に埋もれないか |
| Display-P3 高彩度 brand | sRGB mapping 後の chroma 低下とコントラスト |

各 seed について light / dark、system theme / explicit theme、通常・hover・selected・focus・disabled、主要 bubble surface、検索 highlight を数値とスクリーンショットで確認する。

## 実装時の受け入れ条件

- 色入力の正本が一箇所にあり、生成物を手編集しない。
- UI 色リテラルを semantic token へ移す。canvas probe や外部 protocol 値は用途を区別する。
- light / dark の全 semantic tokenが生成される。
- 定義済み contrast matrix が WCAG 2.2 基準を満たす。
- sRGB gamut mapping 前後の値と `ΔEOK` をレポートする。
- 少なくとも青紫、黄橙、赤緑の三 category で視覚回帰を持つ。
- Shiki と chart palette は UI semantic palette から分離する。
- catalog で seed、primitive、semantic、component、computed color、contrast を追跡できる。

## 参考 URL

- CSS Color Module Level 4: https://www.w3.org/TR/css-color-4/
- CSS Color Module Level 5: https://www.w3.org/TR/css-color-5/
- MDN `oklch()`: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch
- MDN `color-mix()`: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix
- MDN relative colors: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_colors/Relative_colors
- MDN `light-dark()`: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark
- MDN `@property`: https://developer.mozilla.org/en-US/docs/Web/CSS/@property
- WebKit, CSS `color-mix()`: https://webkit.org/blog/14205/css-color-mix/
- Tailwind CSS colors: https://tailwindcss.com/docs/colors
- Tailwind CSS theme variables: https://tailwindcss.com/docs/theme
- Radix Colors: https://www.radix-ui.com/colors
- Radix Colors scale: https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- Material Color Utilities: https://github.com/material-foundation/material-color-utilities
- Open Props colors: https://open-props.style/#colors
- Adobe Leonardo: https://leonardocolor.io/
- Adobe Leonardo repository: https://github.com/adobe/leonardo
- Culori: https://culorijs.org/
- WCAG 2.2 Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- WCAG 2.2 Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- APCA reference implementation: https://github.com/Myndex/SAPC-APCA
