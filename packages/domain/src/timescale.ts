import {
  type ISODate,
  addDays,
  diffDays,
  startOfMonth,
  startOfNextMonth,
  startOfWeek,
  toUTCDate,
} from "./date"

/** ズーム段階（企画書 §6.3.1）。 */
export type ZoomLevel = "day" | "week" | "month"

export const PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 32,
  week: 12,
  month: 4,
}

export const ZOOM_LEVELS: ZoomLevel[] = ["day", "week", "month"]

/**
 * 日付と x 座標を相互変換する（企画書 §6.3.1）。
 *
 * `toDate` は常に日単位に丸めるため、どのズーム段階でも
 * ドラッグが日をまたがない移動を生むことはない。
 */
export type TimeScale = {
  origin: ISODate
  end: ISODate
  pxPerDay: number
  zoom: ZoomLevel
  /** タイムライン全体の幅 (px) */
  width: number
  toX(date: ISODate): number
  toDate(x: number): ISODate
  /** px 差を日数に変換する（ドラッグ量の換算用） */
  toDays(dx: number): number
}

export function createTimeScale(
  origin: ISODate,
  end: ISODate,
  zoom: ZoomLevel,
): TimeScale {
  const pxPerDay = PX_PER_DAY[zoom]
  const totalDays = diffDays(origin, end) + 1
  return {
    origin,
    end,
    zoom,
    pxPerDay,
    width: totalDays * pxPerDay,
    toX: (date) => diffDays(origin, date) * pxPerDay,
    toDate: (x) => addDays(origin, Math.round(x / pxPerDay)),
    toDays: (dx) => Math.round(dx / pxPerDay),
  }
}

/**
 * タスク群を収める表示期間を決める。
 * 前後に余白を足し、週境界に揃えて目盛りが半端にならないようにする。
 */
export function timelineRange(
  dates: ISODate[],
  fallback: ISODate,
  paddingDays = 7,
): { origin: ISODate; end: ISODate } {
  if (dates.length === 0) {
    return { origin: startOfWeek(addDays(fallback, -paddingDays)), end: addDays(fallback, 30) }
  }
  const sorted = [...dates].sort()
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  return {
    origin: startOfWeek(addDays(first, -paddingDays)),
    end: addDays(last, paddingDays),
  }
}

export type Tick = {
  date: ISODate
  x: number
  label: string
}

const MONTH_LABELS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
]

/** 月ヘッダの目盛り（企画書 §6.4.2 の上段）。 */
export function monthTicks(scale: TimeScale): (Tick & { width: number })[] {
  const ticks: (Tick & { width: number })[] = []
  let cursor = startOfMonth(scale.origin)
  while (cursor <= scale.end) {
    const next = startOfNextMonth(cursor)
    const d = toUTCDate(cursor)
    const startX = Math.max(scale.toX(cursor), 0)
    const endX = Math.min(scale.toX(next), scale.width)
    ticks.push({
      date: cursor,
      x: startX,
      width: endX - startX,
      label: `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    })
    cursor = next
  }
  return ticks
}

/**
 * 下段ヘッダの目盛り。ズームに応じて粒度を変える。
 * month ズームでは週目盛りが密集して読めないため月頭のみにする。
 */
export function subTicks(scale: TimeScale): (Tick & { width: number })[] {
  if (scale.zoom === "month") {
    return monthTicks(scale).map((t, i) => ({ ...t, label: `M${i + 1}` }))
  }
  const step = scale.zoom === "day" ? 1 : 7
  const ticks: (Tick & { width: number })[] = []
  let cursor = scale.zoom === "day" ? scale.origin : startOfWeek(scale.origin)
  let index = 1
  while (cursor <= scale.end) {
    const next = addDays(cursor, step)
    const startX = scale.toX(cursor)
    ticks.push({
      date: cursor,
      x: startX,
      width: step * scale.pxPerDay,
      label: scale.zoom === "day" ? cursor.slice(8) : `WEEK ${index}`,
    })
    cursor = next
    index += 1
  }
  return ticks
}
