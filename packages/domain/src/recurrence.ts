/**
 * 繰り返し（日課）タスクの純関数。
 *
 * GitHub Issue には「N 日ごとに繰り返す」という概念が無いので、
 * 開始日・終了日・間隔から実行日の一覧をこちら側で毎回計算する。
 */

import { type ISODate, addDays, addYears, minDate } from "./date"

/** until や fallbackEnd が壊れて渡ってきたときの安全弁。1 年 × 毎日でも最大 366 点なので、
 *  まともな入力ではまず当たらない。 */
export const MAX_OCCURRENCES = 400

/** 広がる並びの間隔（日）。開始日の次から順に空ける。 */
export const SPACED_GAPS = [1, 3, 5, 7, 11, 15]

/** 繰り返し方。間隔を自分で決めるか、決まった広がる並びを使うかの 2 つだけ。 */
export type RecurrenceRule =
  | { kind: "interval"; intervalDays: number }
  | { kind: "spaced" }

export type Recurrence = {
  rule: RecurrenceRule
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
  rule: RecurrenceRule,
  fallbackEnd: ISODate,
): { dates: ISODate[]; truncated: boolean } {
  // until を無期限のまま延ばすと、開き続けたアプリで軸が伸びるたびに点も伸びてしまう。
  // 開始日から 1 年で頭を打たせる（until が指定されていても同じ上限を超えない）。
  const oneYearCap = addYears(start, 1)
  const end = minDate(until === null ? fallbackEnd : minDate(until, fallbackEnd), oneYearCap)
  if (end < start) return { dates: [], truncated: false }

  const dates: ISODate[] = []
  let truncated = false
  // ISODate は `YYYY-MM-DD` 固定長なので文字列比較がそのまま日付順になる（date.ts の他の関数と同じ前提）。
  if (rule.kind === "interval") {
    const interval = normalizeInterval(rule.intervalDays)
    for (let d = start; d <= end; d = addDays(d, interval)) {
      if (dates.length >= MAX_OCCURRENCES) {
        truncated = true
        break
      }
      dates.push(d)
    }
  } else {
    // 開始日を 1 点目とし、そこから SPACED_GAPS を順に足していく。間隔そのものが
    // 広がっていく並びなので、等間隔の interval とは別ループにする。
    let d = start
    if (d <= end) dates.push(d)
    for (const gap of SPACED_GAPS) {
      d = addDays(d, gap)
      if (d > end) break
      if (dates.length >= MAX_OCCURRENCES) {
        truncated = true
        break
      }
      dates.push(d)
    }
  }
  return { dates, truncated }
}

/** start から until までの実行日を並べる。until が null なら fallbackEnd まで。 */
export function occurrences(
  start: ISODate,
  until: ISODate | null,
  rule: RecurrenceRule,
  fallbackEnd: ISODate,
): ISODate[] {
  return occurrencesTruncated(start, until, rule, fallbackEnd).dates
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
