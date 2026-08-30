/**
 * 日付ユーティリティ。
 *
 * アプリ内では日付を常に `YYYY-MM-DD` 形式の文字列（ISODate）で扱い、
 * 計算が必要なときだけ UTC の Date に変換する。
 * ローカルタイムゾーンを経由すると、GitHub が返す日付が
 * 環境によって前後の日にずれるため。
 */

/** `YYYY-MM-DD` 形式の日付文字列。 */
export type ISODate = string

const MS_PER_DAY = 86_400_000
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isISODate(value: string): value is ISODate {
  return ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

/** ISODate を UTC 深夜の Date に変換する。 */
export function toUTCDate(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`)
}

/** Date を ISODate に変換する（UTC 基準）。 */
export function toISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10)
}

/** 今日を ISODate で返す。 */
export function today(now: Date = new Date()): ISODate {
  return toISODate(now)
}

/** 日数を加算した ISODate を返す。 */
export function addDays(date: ISODate, days: number): ISODate {
  return toISODate(new Date(toUTCDate(date).getTime() + days * MS_PER_DAY))
}

/** `to - from` を日数で返す。 */
export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((toUTCDate(to).getTime() - toUTCDate(from).getTime()) / MS_PER_DAY)
}

/** 両端を含む日数。開始日と終了日が同じなら 1。 */
export function inclusiveDays(start: ISODate, end: ISODate): number {
  return diffDays(start, end) + 1
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b
}

/** その日を含む週の月曜日を返す。 */
export function startOfWeek(date: ISODate): ISODate {
  const day = toUTCDate(date).getUTCDay() // 0 = Sunday
  const offset = day === 0 ? -6 : 1 - day
  return addDays(date, offset)
}

/** その月の 1 日を返す。 */
export function startOfMonth(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`
}

/** 翌月の 1 日を返す。 */
export function startOfNextMonth(date: ISODate): ISODate {
  const d = toUTCDate(startOfMonth(date))
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
}
