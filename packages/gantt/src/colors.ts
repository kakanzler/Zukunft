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
 * Status の 4 色ではなく、盤面上の行の位置で色を連続的に変える——上から下へ辿ると
 * 青 → 紫 → マゼンタ → 橙 → 黄 → 緑と巡る。目標の参考画像
 * （specifications/apeearance/appearance_ideal_completion_image.png）を実測すると、
 * 同じ Status（例: IN PROGRESS）の中でも行ごとに色が違い、Status 単位ではなく
 * 行の並び順で色が決まっていることが確認できた。
 *
 * Status 色（凡例・KPI）はここでは変えない。凡例は Status 名に対する色の対応表
 * であって、行の位置とは無関係のため、位置基準の色を割り当てる先が無い。
 */

/** 青から緑まで、紫・マゼンタ・橙・黄を経由する長い経路で回す。230° 始まり、
 *  480°（= 120° を 1 周後ろから）で終える——230→360→120 の順に進み、
 *  青とシアン側の近道（230→120 の 110°）は使わない。 */
// 実機で確かめると 230° は紫寄りに見えた（彩度・明度を上げた分、同じ色相でも
// 青の純度が下がって見える）。目標画像の最初の数本ははっきり青なので、下げる。
const RAINBOW_START = 205
const RAINBOW_END = 455

export function rainbowHue(index: number, total: number): number {
  if (total <= 1) return RAINBOW_START
  const t = Math.min(1, Math.max(0, index / (total - 1)))
  return (RAINBOW_START + (RAINBOW_END - RAINBOW_START) * t) % 360
}

export type RainbowColors = { from: string; to: string; glow: string }

/** 行の位置からバー 1 本ぶんの色一式を作る。塗り・輪郭・発光をすべて同じ色相で揃える。 */
export function rainbowColors(index: number, total: number): RainbowColors {
  const hue = rainbowHue(index, total)
  return {
    from: `hsl(${hue.toFixed(1)}, 62%, 34%)`,
    to: `hsl(${hue.toFixed(1)}, 78%, 58%)`,
    glow: `hsla(${hue.toFixed(1)}, 88%, 60%, 0.75)`,
  }
}

