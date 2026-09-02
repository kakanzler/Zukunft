/**
 * 盤面の意匠（Settings の Preference）。
 *
 * 1 つに決めずに選べるようにしてある。`default` は企画書の意匠参照
 * （specifications/apeearance/appearance_gantt.jpg）に従う今までの見た目で、
 * `blue-system` は青を基調に赤を差し色にした見た目
 * （specifications/apeearance/appearnace_bar_and_others.jpg）。
 *
 * 色・線幅・発光・背景は CSS の `[data-gantt-theme]` で切り替わる。
 * 形が違うところ（バーの輪郭・左端の柱・月境界の線など）は CSS では出し入れ
 * できないので、この型を Timeline まで渡して分岐する。
 */
export const GANTT_THEMES = ["default", "blue-system"] as const

export type GanttTheme = (typeof GANTT_THEMES)[number]

export const DEFAULT_GANTT_THEME: GanttTheme = "default"

/** 保存された値が壊れていても盤面が描けなくならないよう、既定へ落とすのに使う。 */
export function isGanttTheme(value: unknown): value is GanttTheme {
  return typeof value === "string" && (GANTT_THEMES as readonly string[]).includes(value)
}
