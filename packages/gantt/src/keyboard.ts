/**
 * キーボードショートカットの共通判定。
 *
 * 同じ「いま文字を打っているか」の判定を各所で書き直していると、片方だけ直して
 * 食い違う。実際、盤面の 1 打鍵（j / k / e）は入力欄を避けていたのに、
 * Ctrl+Z と Ctrl+± は避けておらず、本文を書いている最中の取り消しが
 * テキストではなく盤面の日付に効いていた。
 */

/** いま文字を入力しているか。入力欄・選択・contenteditable のどれか。 */
export function isTyping(target: EventTarget | null = document.activeElement): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  )
}
