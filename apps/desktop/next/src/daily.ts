"use client"

/**
 * 日課の節（起票と詳細の両方に出る）で使う言い回しと判定。
 *
 * 2 つのモーダルに同じ文言を書くと、片方だけ直したときに「同じ設定なのに
 * 説明が違う」状態になる。実行日の並びも 1 年の上限も、判断は packages/domain の
 * occurrences が持っているので、そこから導ける形でここに 1 つだけ置く。
 */

import { type ISODate, SPACED_GAPS, addYears, isISODate } from "@zukunft/domain"

/**
 * 「広がる並び」で実際に実行する日（開始日からの日数）。
 *
 * 間隔（1, 3, 5, …）ではなく累積で持つ。間隔の数字だけでは、何日後に来るのかが
 * 読み手に分からない。SPACED_GAPS から導くのは、並びが変わったときに
 * 画面の説明だけが古いまま残らないようにするため。
 */
export const SPACED_OFFSETS: number[] = SPACED_GAPS.reduce<number[]>(
  (offsets, gap) => [...offsets, (offsets[offsets.length - 1] ?? 0) + gap],
  [0],
)

/** 実行する日を 1 行で書いたもの。「開始日 / 1 日後 / …」 */
export const SPACED_SCHEDULE_TEXT = `${["開始日", ...SPACED_OFFSETS.slice(1).map((days) => `${days} 日後`)].join(" / ")} の ${SPACED_OFFSETS.length} 回`

/** 「広がる並び」を選んだときの、その開始日での説明。 */
export function spacedSummary(start: string): string {
  const last = SPACED_OFFSETS[SPACED_OFFSETS.length - 1] ?? 0
  return `${start} を 1 点目に、${last} 日後までの ${SPACED_OFFSETS.length} 回に広げて繰り返します`
}

/**
 * 日課の最後の実行日の上限。開始日が読めなければ null。
 *
 * occurrences（packages/domain）が開始日から 1 年で頭を打つので、それより先の
 * Target Date は指定しても点が並ばない。同じ 1 年をここでも使う。
 */
export function dailyLimit(start: string): ISODate | null {
  return isISODate(start) ? addYears(start as ISODate, 1) : null
}

/** Target Date が上限より先か。上限が決まらない（開始日が空など）ときは false。 */
export function isBeyondDailyLimit(start: string, end: string): boolean {
  const limit = dailyLimit(start)
  return limit !== null && isISODate(end) && end > limit
}
