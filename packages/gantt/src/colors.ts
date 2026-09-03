/** ステータス色の本数。定義順に巡回して割り当てる（企画書 §6.4.1）。 */
export const STATUS_COLOR_COUNT = 4

export function statusSlot(statusIndex: number): number {
  return ((statusIndex % STATUS_COLOR_COUNT) + STATUS_COLOR_COUNT) % STATUS_COLOR_COUNT
}

/** 凡例のドットなど、CSS 変数から単色が欲しい場面で使う。 */
export function statusVar(statusIndex: number): string {
  return `var(--status-${statusSlot(statusIndex)}-to)`
}

/** バーの発光色。塗りと同じ系統の色で滲ませ、Status ごとの色分けを光に埋もれさせない。 */
export function glowVar(statusIndex: number): string {
  return `var(--status-${statusSlot(statusIndex)}-glow)`
}
