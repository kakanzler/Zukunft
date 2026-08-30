import {
  type GroupMode,
  type ScheduleTask,
  type TaskGroup,
  groupTasks,
} from "@zukunft/domain"

/** 左ペインとタイムラインで同じ行番号を共有するための行モデル。 */
export type Row =
  | {
      kind: "group"
      key: string
      groupKey: string
      label: string
      count: number
      collapsed: boolean
      color?: string
    }
  | { kind: "task"; key: string; task: ScheduleTask; statusIndex: number }

export function buildRows(
  tasks: ScheduleTask[],
  statusOrder: string[],
  collapsed: ReadonlySet<string>,
  mode: GroupMode = "status",
): Row[] {
  const groups: TaskGroup[] = groupTasks(tasks, mode, statusOrder)
  const rows: Row[] = []
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.key)
    rows.push({
      kind: "group",
      key: `g:${group.key}`,
      groupKey: group.key,
      label: group.label,
      count: group.tasks.length,
      collapsed: isCollapsed,
      color: group.color,
    })
    if (isCollapsed) continue
    for (const task of group.tasks) {
      // 色は Status の定義順に割り当てる（企画書 §6.4.1）。
      // Category 表示でもバーの色は Status のままにして、
      // どの段階のタスクかが分かるようにする。
      const statusIndex = Math.max(0, statusOrder.indexOf(task.status ?? ""))
      // 1 つの Issue が複数グループに現れるため、キーにグループを含める。
      rows.push({
        kind: "task",
        key: `t:${group.key}:${task.id}`,
        task,
        statusIndex,
      })
    }
  }
  return rows
}

/** 可視範囲の行だけを描画するための添字計算（企画書 §6.3.2 の仮想化）。 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): { start: number; end: number } {
  if (rowCount === 0 || viewportHeight <= 0) return { start: 0, end: 0 }
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  return { start, end: Math.min(rowCount, start + visible) }
}
