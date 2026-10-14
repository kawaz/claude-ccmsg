// TL の位置 (`/s/<sid>/timeline/<uuid>`) の選択と着地 (kawaz r76 m71)。
//
// 位置の意味は **`#id` 付き URL を開いたときと同じ**: その位置へ着地 (スクロール)
// するのは「外からその位置へ来た」時 (直リンク / 戻る・進む) だけで、以降は
// 選択の装飾を出すだけ。画面内のバルーンをクリックした選択ではスクロール
// しない (kawaz r115 m4: 「クリックした瞬間に勝手に一番上へ寄せられると、
// ダブルクリックの単語選択ができないし、2 クリック目が別の場所に当たって事故
// る」)。判断は timeline-position.ts、ここは store / URL / DOM への配線。
//
// 位置 (`/timeline/<uuid>`) は親セッションの TL しか指せない — locator の
// grammar 上、agent TL (`/timeline/agent/...`) の position は常に "head" で、
// agent ref と uuid を同時に表す形が無い (locator.ts)。agent TL で位置を書き
// 込むと agent ref が落ち、項目をクリックしただけで親 TL へ弾き出される。
// 表せない選択なので agent TL では行わない。
import { useCallback, useEffect, useState } from "preact/hooks";
import { timelineHref } from "../../locator.ts";
import { rememberTimelinePosition, replaceNavigation } from "../../navigation.ts";
import type { TimelineState } from "../../store.ts";
import type { ParsedLine } from "../../transcript-model.ts";
import type { ScrollHold } from "../../useScrollHold.ts";
import {
  positionLandingKey,
  shouldLandOnPosition,
  shouldReturnToHead,
  togglePosition,
} from "../timeline-position.ts";
import { topBelowToolbar } from "./toolbar-offset.ts";

/** 位置の選択・着地・解除が共有する、render をまたいで覚えておく 2 つの事実。
 * どちらも描画には出ない (変わっても描き直さない) ので state でなくここに
 * 持つ。usePositionPin が作り、usePositionLanding と末尾の検知が読み書きする。 */
export class PinTracker {
  /** 直近に着地した (またはクリックで着地済みとした) 位置のキー。 */
  private landedKey: string | null = null;
  /** 位置を張ってから読み手自身がスクロールしたか (wheel / touch / キー /
   * scrollbar のドラッグ)。最下部に来た時に位置を外してよいかの判定に使う。 */
  private userScrolledSincePin = false;

  /** クリックで `next` を選んだ: その場で着地済みとし (着地のスクロールを
   * 空振りさせる)、スクロールしたかを数え直す。 */
  selected(sid: string, next: string): void {
    this.landedKey = next === "head" ? null : positionLandingKey(sid, next);
    this.userScrolledSincePin = false;
  }

  /** 読み手自身のスクロール操作があった。 */
  userScrolled(): void {
    this.userScrolledSincePin = true;
  }

  /** 最下部に来た時、位置 `position` を外して head に戻してよいか。 */
  mayReturnToHead(position: string): boolean {
    return shouldReturnToHead(position, this.userScrolledSincePin);
  }

  /** head に戻った: 同じ位置を選び直したら、それは新しい遷移として着地させる。 */
  forgetLanding(): void {
    this.landedKey = null;
  }

  /** `key` へまだ着地していなければ着地したことにして true。着地のスクロールは
   * 読み手の操作ではないので、ここからスクロールしたかを数え直す。 */
  claimLanding(key: string): boolean {
    if (!shouldLandOnPosition(this.landedKey, key)) return false;
    this.landedKey = key;
    this.userScrolledSincePin = false;
    return true;
  }
}

export function usePositionPin({
  sid,
  currentPosition,
  agentActive,
}: {
  sid: string;
  /** URL が指す位置 (無選択なら "head")。 */
  currentPosition: string;
  agentActive: boolean;
}): {
  tracker: PinTracker;
  /** 項目のクリック: その位置を選ぶ。選択中の項目なら外して head に戻す
   * (kawaz r76 m71: 「今だと msgid を外す方法が無い」)。head に戻しても
   * その場ではスクロールしない。 */
  selectPosition: (uuid: string) => void;
  /** scroller を測った結果 (最下部付近か) を位置に反映する: 最下部なら head
   * (位置を張っていれば、読み手が自分でスクロールして来た時だけ外す)、そう
   * でなければ表示領域の先頭の項目を、セッションへ戻った時の位置として覚える。 */
  onScrollMeasured: (scroller: HTMLElement, nearBottom: boolean) => void;
  /** 読み手自身のスクロール操作 (wheel / touch / キー / scrollbar)。 */
  onUserScrollIntent: () => void;
} {
  const [tracker] = useState(() => new PinTracker());
  const selectPosition = useCallback(
    (uuid: string) => {
      if (agentActive) return;
      const next = togglePosition(currentPosition, uuid);
      tracker.selected(sid, next);
      rememberTimelinePosition(sid, next);
      replaceNavigation(timelineHref(sid, next));
    },
    [sid, currentPosition, agentActive, tracker],
  );
  const onScrollMeasured = useCallback(
    (scroller: HTMLElement, nearBottom: boolean) => {
      if (nearBottom) {
        // 位置を張った直後 (= 画面内クリックでの選択) にここで外すと、選択した
        // 瞬間に URL と装飾が剥がされて **最下部が見えている間はメッセージを
        // 選べない** (kawaz r115 m4)。測り直しは位置の変化でも走るので、scroll
        // イベントが 1 度も来ていなくてもここへ来る。
        if (currentPosition !== "head") {
          if (!tracker.mayReturnToHead(currentPosition)) return;
          rememberTimelinePosition(sid, "head");
          replaceNavigation(timelineHref(sid));
          return;
        }
        rememberTimelinePosition(sid, "head");
        return;
      }
      const viewportTop = scroller.getBoundingClientRect().top;
      const visible = [...scroller.querySelectorAll<HTMLElement>("[data-timeline-uuid]")].find(
        (item) => item.getBoundingClientRect().bottom > viewportTop,
      );
      const uuid = visible?.dataset.timelineUuid;
      if (uuid) rememberTimelinePosition(sid, uuid);
    },
    [currentPosition, sid, tracker],
  );
  const onUserScrollIntent = useCallback(() => tracker.userScrolled(), [tracker]);
  return { tracker, selectPosition, onScrollMeasured, onUserScrollIntent };
}

/** 位置への着地。**その位置を開いた / その位置へ遷移した最初の 1 回だけ**
 * スクロールし、以降は選択装飾を出すだけ。この effect は tail 追記や markdown /
 * highlight 差し替えによる `parsed` の変化でも走るので、着地済みのキーを
 * tracker に覚えて再スクロールを止める — さもないと位置を張ったまま上を読んで
 * いる最中に TL が更新されるたび引き戻される。読み込み済みの窓に無い位置は
 * head に戻す。 */
export function usePositionLanding({
  sid,
  currentPosition,
  timelineStatus,
  parsed,
  scrollRef,
  scrollHold,
  tracker,
}: {
  sid: string;
  currentPosition: string;
  timelineStatus: TimelineState["status"];
  /** 描かれる行。変わるたびに対象を探し直す (着地済みなら何もしない)。 */
  parsed: readonly ParsedLine[];
  scrollRef: { readonly current: HTMLElement | null };
  scrollHold: ScrollHold;
  tracker: PinTracker;
}): void {
  useEffect(() => {
    if (currentPosition === "head") tracker.forgetLanding();
    if (timelineStatus !== "loaded" || currentPosition === "head") return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-timeline-uuid="${CSS.escape(currentPosition)}"]`,
    );
    if (!target) {
      // Still means "outside the loaded window" and nothing else: `uuid` is
      // only ever passed to the boundary bubbles, never to the fold side, so a
      // pin target is always mounted regardless of any fold.
      rememberTimelinePosition(sid, "head");
      replaceNavigation(timelineHref(sid));
      return;
    }
    rememberTimelinePosition(sid, currentPosition);
    if (!tracker.claimLanding(positionLandingKey(sid, currentPosition))) return;
    // 着地は「対象が TL 表示領域の一番上 (toolbar 直下)」(kawaz r76 m47) —
    // 画面中央ではなく先頭に置く。保持 (useScrollHold) なので、着地の後に上の
    // 項目が伸びても対象は toolbar 直下に留まる。この effect の再実行
    // (parsed の変化) は着地済みとして上で抜けるので、保持を取り消さない。
    scrollHold.toElement(target, (container, el) =>
      container.scrollTo({ top: topBelowToolbar(container, el) }),
    );
  }, [sid, currentPosition, timelineStatus, parsed, scrollRef, scrollHold, tracker]);
}
