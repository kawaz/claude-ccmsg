/** `target` を scroller (`container`) の表示領域の一番上、sticky な toolbar の
 * 直下に置く scrollTop。toolbar は container の中で sticky なので、モバイル幅
 * で 2 行以上に折り返しても実測の下端を使う (固定の scroll-margin では足りず
 * 対象がヘッダの裏に隠れた、kawaz r35 mid=51)。 */
export function topBelowToolbar(container: HTMLElement, target: HTMLElement): number {
  const toolbar = container.querySelector<HTMLElement>(".tl-toolbar");
  const toolbarBottom =
    toolbar?.getBoundingClientRect().bottom ?? container.getBoundingClientRect().top;
  return target.getBoundingClientRect().top - toolbarBottom + container.scrollTop;
}
