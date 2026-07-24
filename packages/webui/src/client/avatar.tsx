/** @jsxImportSource preact */
// 決定論的アバター生成 (identicon 系)。
import type { ComponentChildren } from "preact";
//
// ライブラリ選定メモ (2026-07-11):
// minidenticons / jdenticon / boring-avatars を検討したが、いずれも
// 「文字列 → 疑似乱数 → 図形/色」という中身は数十行程度の自己完結ロジックで、
// 外部 npm 依存を増やすメリット (見た目の作り込み) がこのアプリのニーズ
// (セッション/メンバーを一目で区別できれば十分) に対して割に合わない。
// 依存ゼロで bundle サイズへの影響が皆無、preact の JSX でそのまま SVG を
// 組み立てられる自前実装を採用した。
//
// アルゴリズム: FNV-1a で seed 文字列を 32bit ハッシュ化 → mulberry32 で
// 疑似乱数列に展開 → 色相 (hue) と 5x5 グリッド (左右対称、GitHub identicon
// と同じ発想) の塗りセルを決定する。同じ seed からは常に同じ見た目になる。

const GRID_SIZE = 5;
const GRID_COLS_HALF = 3; // 中央列 + 左右対称の半分 = ceil(5/2)

function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG。1 つの 32bit ハッシュから任意個の [0,1) 乱数列を安定に導出する。 */
function mulberry32(seedInt: number): () => number {
  let a = seedInt;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface IdenticonSpec {
  hue: number;
  /** [row][col] (col は 0..GRID_COLS_HALF-1、左右対称に描画する) */
  cells: boolean[][];
}

/** seed 文字列から identicon の基調色相 (0-359) を導出する。
 * buildSpec と同じ導出式 (mulberry32 の第 1 出力) を使うので、Avatar の
 * 前景/背景色と一致する。TimelineItem がメッセージカードを送信者ごとに
 * 色分けする用途 (kawaz 2026-07-20: 「アイコンカラーをベースに彩度とか
 * 調整して色付けして下さい」) に export している。 */
export function hueForSeed(seed: string): number {
  return Math.floor(mulberry32(fnv1a(seed))() * 360);
}

/** 第 2 アクセント hue (kawaz 2026-07-24: 「アイコンとは別の位置ソースとして
 * セッション ID をシードとしたアクセントカラー」)。hueForSeed とは独立した
 * salt 付き seed から導出するので、第 1 hue がたまたま近い 2 者でも第 2 hue は
 * 高確率で分かれる。バルーンのボーダー / ハイライト / グラデーション等の
 * アクセント装飾に使い、identicon 本体の色 (= hueForSeed) は据え置く。 */
export function hueForSeed2(seed: string): number {
  return hueForSeed(`accent:${seed}`);
}

function buildSpec(seed: string): IdenticonSpec {
  const rand = mulberry32(fnv1a(seed));
  const hue = Math.floor(rand() * 360);
  const cells: boolean[][] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowCells: boolean[] = [];
    for (let col = 0; col < GRID_COLS_HALF; col++) {
      rowCells.push(rand() > 0.55);
    }
    cells.push(rowCells);
  }
  return { hue, cells };
}

/** seed 文字列 (セッション sid・メンバー sid 等) から決定論的に生成する
 * identicon。同じ seed には常に同じ図形・色が対応する。 */
export function Avatar({ seed, size = 20 }: { seed: string; size?: number }) {
  const { hue, cells } = buildSpec(seed);
  const fg = `hsl(${hue} 65% 45%)`;
  const bg = `hsl(${hue} 55% 92%)`;
  const rects = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_COLS_HALF; col++) {
      if (!cells[row][col]) continue;
      const mirroredCol = GRID_SIZE - 1 - col;
      rects.push(<rect key={`${row}-${col}`} x={col} y={row} width={1} height={1} fill={fg} />);
      if (mirroredCol !== col) {
        rects.push(
          <rect
            key={`${row}-${mirroredCol}`}
            x={mirroredCol}
            y={row}
            width={1}
            height={1}
            fill={fg}
          />,
        );
      }
    }
  }
  return (
    <svg
      class="avatar"
      width={size}
      height={size}
      viewBox={`0 0 ${GRID_SIZE} ${GRID_SIZE}`}
      style={{ borderRadius: "3px", flex: "0 0 auto", verticalAlign: "middle" }}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={GRID_SIZE} height={GRID_SIZE} fill={bg} />
      {rects}
    </svg>
  );
}

/** User (u1, 管理者) 専用の固定アイコン。seed に依存せず常に同じ人型アイコンで、
 * 他のセッション/メンバーの identicon と一目で区別できるようにする。 */
export function UserAvatar({ size = 20 }: { size?: number }) {
  return (
    <svg
      class="avatar avatar-user"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ borderRadius: "3px", flex: "0 0 auto", verticalAlign: "middle" }}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={20} height={20} fill="hsl(210 20% 88%)" />
      <circle cx={10} cy={7.5} r={3.5} fill="hsl(210 25% 45%)" />
      <path d="M2.5 19c0-4.5 3.4-7.5 7.5-7.5S17.5 14.5 17.5 19z" fill="hsl(210 25% 45%)" />
    </svg>
  );
}

/** アイコン + 名前ラベルの一体コンポーネント (kawaz 指示 2026-07-15):
 * 「avatar と名前」は 1 つの識別子なので、両者の間隔は外側レイアウトの
 * gap や名前側の padding に左右されず常にここ (.avatar-label の gap) だけで
 * 決まる。Avatar/UserAvatar 自身は margin を持たない (持たせると使用側の
 * flex gap と二重加算され、打ち消しの margin-right:0 !important ハックが
 * 増殖していく — 本コンポーネント導入前の実状)。inline-flex なので文中に
 * 置いても行として自然に並び、途中改行で icon と名前が泣き別れしない。 */
export function AvatarLabel({
  seed,
  size = 16,
  children,
}: {
  /** identicon の seed (sid 等)。省略時は UserAvatar (u1 固定アイコン)。 */
  seed?: string;
  size?: number;
  /** 名前ラベル (テキストや <code> 等)。 */
  children: ComponentChildren;
}) {
  return (
    <span class="avatar-label">
      {seed !== undefined ? <Avatar seed={seed} size={size} /> : <UserAvatar size={size} />}
      {children}
    </span>
  );
}
