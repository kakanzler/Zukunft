import { type ISODate, addDays, diffDays } from "./date"
import type { DateChange, ScheduledTask } from "./schedule"

/** ドラッグの種類（企画書 §6.3.3）。 */
export type DragMode = "move" | "resize-start" | "resize-end"

/** バー両端の当たり判定の幅 (px)。 */
export const EDGE_HIT_PX = 8

/** バー内の相対 x 座標から、どの操作になるかを判定する。 */
export function hitTest(offsetX: number, barWidth: number): DragMode {
  // バーが細いときは両端判定を優先すると move ができなくなるため、
  // 幅が判定域の 3 倍未満なら move だけを許す。
  if (barWidth < EDGE_HIT_PX * 3) return "move"
  if (offsetX <= EDGE_HIT_PX) return "resize-start"
  if (offsetX >= barWidth - EDGE_HIT_PX) return "resize-end"
  return "move"
}

/**
 * ドラッグ量（日数）から変更後の日付を求める。
 *
 * - 常に日単位（呼び出し側が TimeScale.toDays で丸めた値を渡す）
 * - 最小幅は 1 日。リサイズで start > end になる操作は 1 日で頭打ちにする
 */
export function applyDrag(
  task: ScheduledTask,
  mode: DragMode,
  deltaDays: number,
): { startDate: ISODate; endDate: ISODate } {
  switch (mode) {
    case "move":
      return {
        startDate: addDays(task.startDate, deltaDays),
        endDate: addDays(task.endDate, deltaDays),
      }
    case "resize-start": {
      const span = diffDays(task.startDate, task.endDate)
      const clamped = Math.min(deltaDays, span)
      return { startDate: addDays(task.startDate, clamped), endDate: task.endDate }
    }
    case "resize-end": {
      const span = diffDays(task.startDate, task.endDate)
      const clamped = Math.max(deltaDays, -span)
      return { startDate: task.startDate, endDate: addDays(task.endDate, clamped) }
    }
  }
}

/**
 * 変更前後を比べ、実際に変わったフィールドだけの差分を返す。
 * 変化が無ければ null を返し、呼び出し側はミューテーションを発行しない
 * （企画書 §6.3.3 の「値が実際に変化した場合のみ」）。
 */
export function diffDates(
  before: { startDate: ISODate; endDate: ISODate },
  after: { startDate: ISODate; endDate: ISODate },
): DateChange | null {
  const change: DateChange = {}
  if (before.startDate !== after.startDate) change.startDate = after.startDate
  if (before.endDate !== after.endDate) change.endDate = after.endDate
  return Object.keys(change).length === 0 ? null : change
}
