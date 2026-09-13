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

/**
 * マイルストーンのアイコン（内側）に使える色。
 *
 * DEPTH_COLORS とは無関係な別の表。あちらは「バーを Milestone からの距離で
 * 塗る」ための段で、こちらは asset/milestone/milestone_intside_<name>.svg として
 * 実在する絵の一覧。鍵はファイル名の一部そのもので、値はその絵の fill を
 * 実測したもの。ここを勝手な色に書き換えると、画面の色と読み込むファイルが
 * 食い違う（あるいは 404 で内側が消える）。
 *
 * 外側（milestone_outside.svg）は固定のオレンジ 1 枚しかないので、表には無い。
 */
export const MILESTONE_INSIDE_COLORS: Record<string, string> = {
  blue: "#1243F9",
  green: "#2BF912",
  lime: "#9FF912",
  orange: "#FF4000",
  paleblue: "#12F9D4",
  pink: "#F912C1",
  purple: "#3912F9",
  red: "#F91212",
  redpurple: "#AE12F9",
  yellow: "#F9ED12",
}

/** 既定の内側の色。外側と同じオレンジなので、色の割り当てが無くても浮かない。 */
const DEFAULT_INSIDE_COLOR = "orange"

/** "#rrggbb" を 3 つの数に割る。読めない形なら null（呼び出し側が既定へ逃げる）。 */
function hexRgb(hex: string): [number, number, number] | null {
  if (hex.length !== 7 || hex[0] !== "#") return null
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return [r, g, b]
}

/**
 * 任意の色を、実在する 10 枚の絵のどれかに寄せる。
 *
 * カテゴリに割り当てられるのは GitHub のラベル色（何色でもありうる）なのに、
 * 内側の絵は 10 枚しか無い。補間はできない（絵なので）ので、いちばん近いものを
 * 選ぶ。距離は RGB の二乗ユークリッド距離 — 知覚的な近さとは厳密には違うが、
 * 10 色が色相環にほぼ均等に散っているので、これで「赤いラベルなら赤い菱形」に
 * はなる。平方根は取らない（大小の比較にしか使わないので順序が変わらない）。
 *
 * 同じ距離のものが複数あれば、この表に書いた順で先のものを採る。同じ色に対して
 * 常に同じ絵を返さないと、描き直すたびに菱形の色が入れ替わる。
 */
export function nearestMilestoneColor(hex: string): string {
  const target = hexRgb(hex)
  if (!target) return DEFAULT_INSIDE_COLOR
  let best = DEFAULT_INSIDE_COLOR
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [name, value] of Object.entries(MILESTONE_INSIDE_COLORS)) {
    const rgb = hexRgb(value)
    if (!rgb) continue
    const distance =
      (target[0] - rgb[0]) ** 2 + (target[1] - rgb[1]) ** 2 + (target[2] - rgb[2]) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

export type DependenceIssueBarColors = { from: string; to: string; glow: string }

/** 距離からバー 1 本ぶんの色一式を作る。塗り・輪郭・発光をすべて同じ色で揃える。 */
export function milestoneDepthColors(depth: number): DependenceIssueBarColors {
  const hex = depthColorAt(depth)
  return {
    from: darken(hex, 0.6),
    to: hex,
    // bf ≒ 0xbf/0xff = 0.75。milestoneTint と同じ、16 進 2 桁を足すだけの書き方。
    glow: `${hex}bf`,
  }
}
