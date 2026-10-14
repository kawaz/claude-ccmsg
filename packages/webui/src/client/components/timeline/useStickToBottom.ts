// 末尾追従 (kawaz spec: 「ユーザが最下部付近を見ている時だけ自動スクロール追従、
// 上にスクロール中は追従しない」)。
//
// 末尾へ寄せるのは:
// - 開いた時 (mount / 別セッション) と、Timeline タブが隠れている → 見えて
//   いるに変わった時 (kawaz r76 m47: タブ往復では Timeline が unmount されず
//   scrollTop が残るので、「最新を見たい」意図に合わせて寄せ直す)
// - 初回の読み込みが届いた時 (位置を問わず必ず。kawaz r17 mid=34,37 —
//   「まだ top に居る」を「離れた」と誤認すると末尾ジャンプが死ぬ)
// - live tail の追記で、読み手が最下部付近に居た時 (遡って読んでいる最中を
//   吹っ飛ばさない)
// いずれも位置 (`/timeline/<uuid>`) を張っていない (head) 時だけ。位置への
// 着地は usePositionLanding が持つ。
//
// 寄せ方は 1 発の書き込みでなく保持 (useScrollHold): 初期 fetch の大量行は
// markdown / highlight の非同期差し替えで effect の後も伸びるので、1 度書いた
// だけでは上に取り残される。smooth アニメーションはしない — 高頻度で届く tail
// 行ごとにアニメーションが重なるとかえって読みにくい。
import { useEffect, useRef } from "preact/hooks";
import type { ScrollHold } from "../../useScrollHold.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { classifyEndChange, type EndMark } from "./transcript-end.ts";

/** 「最下部付近」のしきい値 (px)。ちょうど末端に張り付いていなくても数行分の
 * 余裕は追従対象にする、というよくあるチャット UI の慣習値。 */
const NEAR_BOTTOM_PX = 80;

export function useStickToBottom({
  sid,
  end,
  atHead,
  visible,
  content,
  scrollRef,
  scrollHold,
  onScrollMeasured,
  onUserScrollIntent,
}: {
  sid: string;
  /** 読み込み済みの transcript の終わり (`timeline.end`)。 */
  end: number;
  /** 位置を張っていない (URL の position が "head")。 */
  atHead: boolean;
  /** Timeline タブが実際に画面に出ているか。 */
  visible: boolean;
  /** 描いている内容 (group の列)。変わるたびに scroller を測り直す。 */
  content: unknown;
  scrollRef: { readonly current: HTMLElement | null };
  scrollHold: ScrollHold;
  /** scroller を測るたびに、その結果 (最下部付近か) を渡す先。この関数が
   * 変わった時 (位置が変わった時) も測り直す。 */
  onScrollMeasured: (scroller: HTMLElement, nearBottom: boolean) => void;
  /** 読み手自身のスクロール操作 (wheel / touch / キー / scrollbar) を渡す先。 */
  onUserScrollIntent: () => void;
}): {
  /** 「更新」の後: 末尾へ寄せ、続く追記にも追従する状態に戻す。 */
  resumeFollowing: () => void;
} {
  // 今、読み手は最下部付近を見ているか。scroll イベント (rAF で間引く) と
  // 測り直しでだけ更新する — DOM 位置に依存する値を state に上げると余計な
  // 再レンダーを誘発するので ref に留める。初期値 true: マウント直後 (まだ
  // 何もスクロールしていない) は最下部相当とみなし、直後に届く tail に追従する。
  const nearBottomRef = useRef(true);

  // Design rationale: 測り直し (この effect) は下の追従の effect より先に宣言
  // する。同じ commit で内容が伸びた時 (live tail の追記) は、追従の判定が
  // 伸びた後の位置で測った nearBottom を読む。effect は宣言順に走るので、この
  // 順序が判定に使う値を決めている。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      nearBottomRef.current = distance < NEAR_BOTTOM_PX;
      onScrollMeasured(scroller, nearBottomRef.current);
    };
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        measure();
        ticking = false;
      });
    };
    // 読み手自身のスクロール操作だけを拾う (programmatic scroll はこれらの
    // イベントを発火しない — useScrollHold が保持を手放す判定と同じ考え方)。
    // スクロールバーのドラッグは wheel も touch も出さないので mousedown で拾う。
    // バルーンのクリックでも発火するが、click は mousedown の後なので、
    // クリックでの位置の選択が数え直しを最後に効かせる。
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onUserScrollIntent, { passive: true });
    scroller.addEventListener("touchmove", onUserScrollIntent, { passive: true });
    scroller.addEventListener("keydown", onUserScrollIntent);
    scroller.addEventListener("mousedown", onUserScrollIntent);
    measure();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onUserScrollIntent);
      scroller.removeEventListener("touchmove", onUserScrollIntent);
      scroller.removeEventListener("keydown", onUserScrollIntent);
      scroller.removeEventListener("mousedown", onUserScrollIntent);
    };
    // content は測り直しのきっかけとしてだけ deps に入れる (中身は読まない)。
    // 読み込み中は scroller が描かれていないので、読み込みが届いて内容が
    // 変わった時にここで初めて listener が付く。
  }, [content, scrollRef, onScrollMeasured, onUserScrollIntent]);

  // 反応するのは sid と end の変化だけ。位置・最下部付近かは、変わった瞬間の
  // 値を読むだけなので Effect Event に置く。前回の印との比較で、セッションに
  // 入った (mount を含む) ことと、tail が伸びたことを 1 つの effect で見分ける。
  const markRef = useRef<EndMark | null>(null);
  const onEndChange = useEffectEvent((sidNow: string, endNow: number) => {
    const change = classifyEndChange(markRef.current, sidNow, endNow);
    markRef.current = { sid: sidNow, end: endNow };
    switch (change) {
      case "entered":
        // 前セッションの「どこまで読んだか」を引き継がない。cache がすでに
        // 埋まった状態 (前訪問済 / 再訪) で開いた時は end が伸びないので、
        // ここで末尾へ寄せる (kawaz r15 mid=7)。
        nearBottomRef.current = atHead;
        if (atHead) scrollHold.toBottom();
        return;
      case "initial-load":
        if (atHead) scrollHold.toBottom();
        return;
      case "appended":
        if (atHead && nearBottomRef.current) scrollHold.toBottom();
        return;
      case "shrank":
      case "unchanged":
        return;
    }
  });
  useEffect(() => onEndChange(sid, end), [sid, end]);

  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible || !atHead) return;
    scrollHold.toBottom();
  }, [visible, atHead, scrollHold]);

  const resumeFollowing = () => {
    nearBottomRef.current = true;
    scrollHold.toBottom();
  };
  return { resumeFollowing };
}
