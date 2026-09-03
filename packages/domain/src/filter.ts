import type { ScheduleTask } from "./schedule"

/**
 * 一覧の絞り込み。
 *
 * Issue が 100 を超えると、目的の行に辿り着く手段が j / k とスクロールしか無い。
 * グループ分け（groupTasks）の前に掛けるので、絞った結果がそのまま同じ並びで出る。
 *
 * 軸をまたぐ条件は AND、同じ軸の中の複数値は OR。「design と backend の両方が
 * 付いた Issue」より「どちらかが付いた Issue」を探すことの方が多いため。
 */
export type TaskFilter = {
  /** 番号（"#12" も "12" も）とタイトルの部分一致。空なら素通し */
  text: string
  /** 空なら絞らない。以下同じ */
  statuses: string[]
  labels: string[]
  assignees: string[]
  milestones: string[]
  /**
   * 閉じた Issue を含めるか。
   * 既定は true — これまでの表示を変えないため。
   */
  includeClosed: boolean
}

export const EMPTY_FILTER: TaskFilter = {
  text: "",
  statuses: [],
  labels: [],
  assignees: [],
  milestones: [],
  includeClosed: true,
}

/** 何か絞られているか。件数表示を出すかどうかの判定に使う。 */
export function isFilterActive(filter: TaskFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.statuses.length > 0 ||
    filter.labels.length > 0 ||
    filter.assignees.length > 0 ||
    filter.milestones.length > 0 ||
    !filter.includeClosed
  )
}

/** 空の選択は「絞らない」。全部外した状態を「全部消す」と読ませない。 */
function matchesAny(selected: string[], values: string[]): boolean {
  return selected.length === 0 || values.some((value) => selected.includes(value))
}

/**
 * 文字での絞り込み。
 *
 * 先頭の # は落とす。番号を貼り付けるときに付いてくるが、これを厳密に見ると
 * 「#12」と打った人だけ何も出ない、という理不尽な差になる。
 */
function matchesText(task: ScheduleTask, query: string): boolean {
  const text = query.trim().toLowerCase()
  if (text === "") return true
  const number = text.replace(/^#/, "")
  return (
    task.title.toLowerCase().includes(text) ||
    (number !== "" && String(task.issueNumber).includes(number))
  )
}

export function filterTasks(tasks: ScheduleTask[], filter: TaskFilter): ScheduleTask[] {
  if (!isFilterActive(filter)) return tasks
  return tasks.filter((task) => {
    if (!filter.includeClosed && task.issueState === "CLOSED") return false
    if (!matchesText(task, filter.text)) return false
    if (!matchesAny(filter.statuses, task.status === null ? [] : [task.status])) return false
    if (!matchesAny(filter.labels, task.labels.map((l) => l.name))) return false
    if (!matchesAny(filter.assignees, task.assignees.map((a) => a.login))) return false
    if (!matchesAny(filter.milestones, task.milestone ? [task.milestone.title] : [])) return false
    return true
  })
}

/** 絞り込みの候補。いま一覧にある値だけを出す（選べない値を並べない）。 */
export type FilterChoices = {
  statuses: string[]
  labels: string[]
  assignees: string[]
  milestones: string[]
}

export function filterChoices(tasks: ScheduleTask[]): FilterChoices {
  const statuses = new Set<string>()
  const labels = new Set<string>()
  const assignees = new Set<string>()
  const milestones = new Set<string>()
  for (const task of tasks) {
    if (task.status) statuses.add(task.status)
    for (const label of task.labels) labels.add(label.name)
    for (const assignee of task.assignees) assignees.add(assignee.login)
    if (task.milestone) milestones.add(task.milestone.title)
  }
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b))
  return {
    // Status だけは並べ替えない。Project の定義順が意味を持つため、
    // 呼び出し側が statusOrder で並べ直せるよう出現順で返す。
    statuses: [...statuses],
    labels: sorted(labels),
    assignees: sorted(assignees),
    milestones: sorted(milestones),
  }
}
