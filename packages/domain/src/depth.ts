import { edgeKey } from "./cycle"
import type { Dependency } from "./dependency"
import type { ScheduleTask } from "./schedule"

/**
 * マイルストーンからの距離（依存を何ホップ遡ればマイルストーンに届くか）。
 *
 * マイルストーンが付いたタスクが「ゴールに最も近い」タスクで、距離 0。
 * Dependency は fromTaskId が toTaskId を待つ向きなので、fromTaskId → toTaskId と
 * 辿ることが「先に片付いている必要がある側へ遡る」ことになる。距離 0 のタスクを
 * 全部起点にした多始点 BFS で、各タスクの最短の距離を求める。
 *
 * 循環した辺（detectCycles の cyclicEdges）は隣接から外す。成立しない日程を
 * 距離の根拠にしても意味が無いし、外さないと同じ節点を延々と回ることになる。
 *
 * どのマイルストーンにも届かないタスクは、返す Map に載せない。何色にするかは
 * 距離の問題ではなく見た目の決めごとなので、呼び出し側で決める。
 */
export function milestoneDepths(
  tasks: ScheduleTask[],
  dependencies: Dependency[],
  cyclicEdges: ReadonlySet<string>,
): Map<string, number> {
  // 隣接は dependencies の順に積む。同じ入力からは常に同じ出力を返したい。
  const next = new Map<string, string[]>()
  for (const dep of dependencies) {
    if (cyclicEdges.has(edgeKey(dep.fromTaskId, dep.toTaskId))) continue
    next.set(dep.fromTaskId, [...(next.get(dep.fromTaskId) ?? []), dep.toTaskId])
  }

  const depths = new Map<string, number>()
  const queue: string[] = []
  for (const task of tasks) {
    if (task.milestone === null) continue
    if (depths.has(task.id)) continue
    depths.set(task.id, 0)
    queue.push(task.id)
  }

  // 先に入れた節点ほど距離が短い（多始点 BFS）ので、初めて見たときの距離が最短。
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!
    const depth = depths.get(node)!
    for (const to of next.get(node) ?? []) {
      if (depths.has(to)) continue
      depths.set(to, depth + 1)
      queue.push(to)
    }
  }

  return depths
}
