/** `target` を scroller (`container`) の表示領域の一番上、sticky な toolbar の
 * 直下に置く scrollTop。toolbar は container の中で sticky なので、モバイル幅
 * で 2 行以上に折り返しても実測の下端を使う (固定の scroll-margin では足りず
 * 対象がヘッダの裏に隠れた、kawaz r35 mid=51)。対象の `scroll-margin-top` の分
 * だけ toolbar から離す: 上の外側に操作の列を出す項目 (ユーザの発言、DR-0058
 * §3) は、その列も toolbar の下に見せる。 */
export function topBelowToolbar(container: HTMLElement, target: HTMLElement): number {
  const toolbar = container.querySelector<HTMLElement>(".tl-toolbar");
  const toolbarBottom =
    toolbar?.getBoundingClientRect().bottom ?? container.getBoundingClientRect().top;
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop);
  return (
    target.getBoundingClientRect().top -
    toolbarBottom -
    (Number.isFinite(margin) ? margin : 0) +
    container.scrollTop
  );
}

/** `target` を toolbar の下の表示領域に入れる最小の移動の scrollTop。上に
 * はみ出していれば toolbar の直下へ、下にはみ出していれば下端へ (表示領域より
 * 高ければ toolbar の直下へ)、入っていれば今のまま。 */
export function nearestBelowToolbar(container: HTMLElement, target: HTMLElement): number {
  const toolbar = container.querySelector<HTMLElement>(".tl-toolbar");
  const view = container.getBoundingClientRect();
  const viewTop = toolbar?.getBoundingClientRect().bottom ?? view.top;
  const viewBottom = view.top + container.clientTop + container.clientHeight;
  const box = target.getBoundingClientRect();
  if (box.top < viewTop || box.height > viewBottom - viewTop) {
    return topBelowToolbar(container, target);
  }
  if (box.bottom > viewBottom) return container.scrollTop + box.bottom - viewBottom;
  return container.scrollTop;
}
