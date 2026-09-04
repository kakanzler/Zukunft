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

/**
 * BlueSystem のバーの色（企画書に無い、見た目だけの規則）。
 *
 * Status の 4 色ではなく、Milestone からの距離で色を決める。Milestone が付いた
 * タスク（ゴールに最も近い）がオレンジで、依存を 1 つ遡るごとに黄 → 黄緑 → 緑 →
 * 水色 → 青 → 青紫 → 赤紫 → ピンク → 赤と移る。盤面を横に見れば、暖色ほど
 * ゴールに近く、寒色から先へ辿るほど手前の作業だと読める。
 *
 * 段は 10 色に固定し、連続に補間しない。行を足しただけで既存のバーの色が動くと、
 * 覚えた色と実際の色がずれる。距離が同じなら盤面がどう変わっても同じ色になる。
 *
 * Status 色（凡例・KPI）はここでは変えない。凡例は Status 名に対する色の対応表
 * であって、Milestone からの距離とは無関係のため、距離基準の色を割り当てる先が無い。
 */

/**
 * 実測で決めた 10 色（オレンジ 0 = Milestone に最も近い → 赤 9 = 最も遠い）。
 * HSL の式から計算すると彩度・明度の狙いがずれる（オレンジが黄色に寄って見える等）
 * ので、式ではなく指定された色そのものを段ごとに置く。
 */
const DEPTH_COLORS = [
  "#f04816", // 0 オレンジ
  "#f0d316", // 1 黄
  "#7bf016", // 2 黄緑
  "#24f016", // 3 緑
  "#16e1f0", // 4 水色
  "#163af0", // 5 青
  "#2416f0", // 6 青紫
  "#7b16f0", // 7 赤紫
  "#f016c8", // 8 ピンク
  "#f01633", // 9 赤
]

/** 段より遠いもの（10 ホップ以上）は最後の段に丸める。 */
function depthColorAt(depth: number): string {
  const clamped = Math.max(0, Math.min(DEPTH_COLORS.length - 1, Math.round(depth)))
  return DEPTH_COLORS[clamped]!
}

/** 塗りの左端（開始側）を暗くするだけの縮小。RGB を一様に縮めるので色相は動かない。 */
function darken(hex: string, factor: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`
}

export type RainbowColors = { from: string; to: string; glow: string }

/** 距離からバー 1 本ぶんの色一式を作る。塗り・輪郭・発光をすべて同じ色で揃える。 */
export function milestoneDepthColors(depth: number): RainbowColors {
  const hex = depthColorAt(depth)
  return {
    from: darken(hex, 0.6),
    to: hex,
    // bf ≒ 0xbf/0xff = 0.75。milestoneTint と同じ、16 進 2 桁を足すだけの書き方。
    glow: `${hex}bf`,
  }
}
