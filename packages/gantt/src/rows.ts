import {
  type GroupMode,
  type ScheduleTask,
  type TaskGroup,
  groupTasks,
} from "@zukunft/domain"

/**
 * 左ペインとタイムラインで同じ行番号を共有するための行モデル。
 * `depth` は入れ子の深さ（0 が最上位）。親カテゴリを使うと 2 階層になる。
 */
export type Row =
  | {
      kind: "group"
      key: string
      groupKey: string
      label: string
      count: number
      collapsed: boolean
      depth: number
      color?: string
    }
  | { kind: "task"; key: string; task: ScheduleTask; statusIndex: number; depth: number }

export function buildRows(
  tasks: ScheduleTask[],
  statusOrder: string[],
  collapsed: ReadonlySet<string>,
  mode: GroupMode = "status",
  parentLabels: string[] = [],
): Row[] {
  const groups: TaskGroup[] = groupTasks(tasks, mode, statusOrder, parentLabels)
  const rows: Row[] = []
  for (const group of groups) emitGroup(group, group.key, 0, rows, statusOrder, collapsed)
  return rows
}

/**
 * グループ 1 つ分の行を並べる。入れ子があれば子グループを、無ければタスクを出す。
 *
 * キーには親のキーを前置する。子グループの名前は親をまたいで重複しうるため
 * （どの親の下にも NO LABEL が出る）、そのままでは折り畳みが連動してしまう。
 */
function emitGroup(
  group: TaskGroup,
  key: string,
  depth: number,
  rows: Row[],
  statusOrder: string[],
  collapsed: ReadonlySet<string>,
): void {
  const isCollapsed = collapsed.has(key)
  rows.push({
    kind: "group",
    key: `g:${key}`,
    groupKey: key,
    label: group.label,
    count: group.tasks.length,
    collapsed: isCollapsed,
    depth,
    color: group.color,
  })
  if (isCollapsed) return

  if (group.groups) {
    for (const child of group.groups) {
      emitGroup(child, `${key}\u0000${child.key}`, depth + 1, rows, statusOrder, collapsed)
    }
    return
  }

  for (const task of group.tasks) {
    // 色は Status の定義順に割り当てる（企画書 §6.4.1）。
    // Category 表示でもバーの色は Status のままにして、
    // どの段階のタスクかが分かるようにする。
    const statusIndex = Math.max(0, statusOrder.indexOf(task.status ?? ""))
    rows.push({
      kind: "task",
      key: `t:${task.id}`,
      task,
      statusIndex,
      depth: depth + 1,
    })
  }
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
