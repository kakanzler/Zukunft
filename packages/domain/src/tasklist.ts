/**
 * Issue 本文のタスクリスト（`- [ ]`）の開閉。
 *
 * GitHub の本文は正本がテキストなので、チェックの状態もテキストとして持つ。
 * 描画したチェックボックスから本文へ戻すために、「上から数えて N 個目」で位置を
 * 決める。react-markdown 側も同じ順で描くため、この数え方で一致する。
 */

/**
 * タスクリストの印。行頭の箇条書き（- * +）と番号付き（1. 1)）の両方を受ける。
 * 入れ子のぶんの字下げも許す。
 */
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm

/** 本文に含まれるタスクリストの数。 */
export function countTaskListItems(body: string): number {
  return [...body.matchAll(TASK_MARKER)].length
}

/**
 * 上から数えて index 番目（0 始まり）のチェックを反転した本文を返す。
 *
 * 範囲外なら本文をそのまま返す。描画と本文がずれていたときに、
 * 別の行を勝手に書き換えるより何もしない方が安全。
 */
export function toggleTaskListItem(body: string, index: number): string {
  if (index < 0) return body
  let seen = -1
  return body.replace(TASK_MARKER, (whole, head: string, mark: string, tail: string) => {
    seen += 1
    if (seen !== index) return whole
    return `${head}${mark === " " ? "x" : " "}${tail}`
  })
}

/** 上から数えて index 番目のチェックが入っているか。 */
export function isTaskListItemChecked(body: string, index: number): boolean {
  const match = [...body.matchAll(TASK_MARKER)][index]
  return match ? match[2] !== " " : false
}
