/**
 * 繰り返し（日課）タスクの純関数。
 *
 * GitHub Issue には「N 日ごとに繰り返す」という概念が無いので、
 * 開始日・終了日・間隔から実行日の一覧をこちら側で毎回計算する。
 */

import { type ISODate, addDays, minDate } from "./date"

/** 一度に描く実行日の上限。無期限 × 長い横軸で点が数千個になり、
 *  盤面が重くなるだけで読めなくなるのを防ぐ。 */
export const MAX_OCCURRENCES = 1000

export type Recurrence = {
  /** 何日ごとに繰り返すか。1 なら毎日 */
  intervalDays: number
  /** 実行した日。順序は問わない */
  done: ISODate[]
}

/**
 * 呼び出し側の入力ミス（0 や負数、小数）で無限ループや無限に近い刻みになるのを防ぐ。
 * 1 未満・非整数は素直に 1（毎日）に丸める。
 */
function normalizeInterval(intervalDays: number): number {
  const floored = Math.floor(intervalDays)
  return floored < 1 ? 1 : floored
}

/**
 * `occurrences` の内部実装。上限で打ち切ったかどうかを黙って捨てずに返す。
 * 呼び出し側が打ち切りを気にしないときは `occurrences` を使えばよい。
 */
export function occurrencesTruncated(
  start: ISODate,
  until: ISODate | null,
  intervalDays: number,
  fallbackEnd: ISODate,
): { dates: ISODate[]; truncated: boolean } {
  const interval = normalizeInterval(intervalDays)
  // until が横軸の外（fallbackEnd より後ろ）まで指定されていても、描けない分は計算しない。
  const end = until === null ? fallbackEnd : minDate(until, fallbackEnd)
  if (end < start) return { dates: [], truncated: false }

  const dates: ISODate[] = []
  let truncated = false
  // ISODate は `YYYY-MM-DD` 固定長なので文字列比較がそのまま日付順になる（date.ts の他の関数と同じ前提）。
  for (let d = start; d <= end; d = addDays(d, interval)) {
    if (dates.length >= MAX_OCCURRENCES) {
      truncated = true
      break
    }
    dates.push(d)
  }
  return { dates, truncated }
}

/** start から until までの実行日を並べる。until が null なら fallbackEnd まで。 */
export function occurrences(
  start: ISODate,
  until: ISODate | null,
  intervalDays: number,
  fallbackEnd: ISODate,
): ISODate[] {
  return occurrencesTruncated(start, until, intervalDays, fallbackEnd).dates
}

export function isDone(recurrence: Recurrence, date: ISODate): boolean {
  return recurrence.done.includes(date)
}

/** 元の Recurrence は変更しない。Undo やストアの差分検出が破壊的変更を前提にしていないため。 */
export function toggleDone(recurrence: Recurrence, date: ISODate): Recurrence {
  return isDone(recurrence, date)
    ? { ...recurrence, done: recurrence.done.filter((d) => d !== date) }
    : { ...recurrence, done: [...recurrence.done, date] }
}
