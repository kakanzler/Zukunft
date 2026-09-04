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

/** オレンジ(0=Milestoneに最も近い) → 黄 → 黄緑 → 緑 → 水色 → 青 → 青紫 → 赤紫 → ピンク → 赤(9) */
const DEPTH_HUES = [30, 55, 85, 130, 190, 220, 255, 300, 335, 355]

/** 段より遠いもの（10 ホップ以上）は最後の段に丸める。 */
export function milestoneDepthHue(depth: number): number {
  const clamped = Math.max(0, Math.min(DEPTH_HUES.length - 1, Math.round(depth)))
  return DEPTH_HUES[clamped]!
}

export type RainbowColors = { from: string; to: string; glow: string }

/** 距離からバー 1 本ぶんの色一式を作る。塗り・輪郭・発光をすべて同じ色相で揃える。 */
export function milestoneDepthColors(depth: number): RainbowColors {
  const hue = milestoneDepthHue(depth)
  return {
    from: `hsl(${hue}, 62%, 34%)`,
    to: `hsl(${hue}, 78%, 58%)`,
    glow: `hsla(${hue}, 88%, 60%, 0.75)`,
  }
}
