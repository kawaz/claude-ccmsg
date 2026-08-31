/** TL 右端のフロートパネル (`.tl-auto-open-float`) が、開いている間に TL 項目の
 * クリック選択を塞がないようにするための判断ロジック。
 *
 * パネルは `position: fixed` で TL の上に重なるため、素朴に置くと (a) パネルの
 * 真下にある項目は物理的にクリックできず、(b) パネル外クリックで閉じる規約の
 * せいで、届く項目を選んでもその瞬間にパネルが畳まれる。fork / dump は「項目を
 * 選ぶ → その位置に対して操作する」流れなので、両方を潰さないと選択を変えながら
 * パネルを使えない。DOM を触る側 (Timeline.tsx) から判断だけを切り出している。
 */

/** `Node.contains` だけを使う。テストから DOM 無しで叩けるようにするための
 * 最小面 (use-fab-popup.ts と同じ流儀)。 */
export interface ContainerLike {
  contains(node: unknown): boolean;
}

/** パネル外クリックでパネルを畳んでよいか。
 *
 * `list` は TL 項目が並ぶ要素 (`.tl-lines`)。ここへのクリックは **項目の選択**
 * であって「パネルから離れる操作」ではないので閉じない — 閉じてしまうと
 * 「パネルを開いたまま fork 地点を選び直す」ができず、選ぶたびに開き直す羽目に
 * なる。パネル自身の中も当然閉じない。それ以外 (sidebar / toolbar / composer
 * など) は従来どおり畳む。 */
export function shouldCloseSidePanel(
  target: unknown,
  panel: ContainerLike | null,
  list: ContainerLike | null,
): boolean {
  if (!panel) return false;
  if (panel.contains(target)) return false;
  if (list?.contains(target)) return false;
  return true;
}

/** パネルに場所を譲っても TL 本文に残す最低幅 (px = 10rem)。バルーンが 1 行に
 * 数語しか入らなくなる手前の値で、これを割り込むくらいなら重なりを許す。
 * 実測 (1280px + sidebar) の TL 列 530px / パネル 365px はこの範囲に収まり、
 * 重なりはゼロになる。 */
export const TL_SIDE_PANEL_MIN_CONTENT_PX = 160;

/** パネルを開いている間、TL の列が右側に空けておく幅 (px)。
 *
 * パネルは重ねるのではなく **場所を譲らせる**: sessions sidebar と同じ「開いたら
 * 押しのける」挙動に揃えると、パネルの真下に隠れて押せない項目が原理的に消える。
 * `panelWidth` にはつまみ (18px) も含まれるので、その分まで空ければパネル全体が
 * 項目の外に出る。
 *
 * ただし TL 側が潰れきると本文が読めなくなるため、本文に最低 `minContentWidth`
 * だけは残す。パネルがそれより広い狭幅ビューポート (パネルは `max-width: 100vw`)
 * では重なりが残るが、そこは元から何も収まらない領域で、現状より悪くはならない。 */
export function sidePanelReserveWidth(
  open: boolean,
  panelWidth: number,
  timelineWidth: number,
  minContentWidth: number,
): number {
  if (!open) return 0;
  const room = timelineWidth - minContentWidth;
  if (!(room > 0)) return 0;
  return Math.max(0, Math.min(panelWidth, room));
}
