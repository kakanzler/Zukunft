import { edgeKey } from "./cycle"
import type { Dependency } from "./dependency"
import type { ScheduleTask } from "./schedule"

/**
 * マイルストーンからの距離（依存を何ホップ遡ればマイルストーンに届くか）。
 *
 * 「マイルストーンが付いていること」自体は距離 0 の条件にならない——GitHub の
 * Milestone は releas/phase の大まかな括りとして、ほぼ全部の Issue に付くことが
 * 普通にある（企画のモックデータでも 15 件全部に付いている）。それを距離 0 の
 * 条件にすると、全タスクが同時に距離 0 の起点になってしまい、依存を辿っても
 * 色が一切変わらない。
 *
 * 距離 0（「そのマイルストーンに最も近い」）は、代わりに次で決める:
 * マイルストーンが付いていて、かつ「同じマイルストーンを持つ他のタスクから
 * 待たれていない」タスク——言い換えると、同じマイルストーンの中で見て、
 * 自分より後に来るタスクが（宣言されている依存の範囲で）見当たらないもの。
 * 判定は同じマイルストーン同士の辺だけで行う。別のマイルストーンのタスクに
 * 待たれているというだけでは、自分のマイルストーンに対する近さは変わらない
 * （フェーズを跨いだ依存はよくあるが、それは前のフェーズの終盤という意味であって、
 * 自分のフェーズの終盤でなくなるわけではない）。
 *
 * 距離 0 が決まったら、そこからの遡り（BFS の展開）は同じマイルストーン縛りを
 * 外し、すべての依存を辿る——マイルストーンを持たないタスクや、別のマイルストーンの
 * タスクが前段の準備として挟まることは普通にあるため（既存のテストが確かめている
 * とおり、マイルストーンを持たないタスクにも距離が伝播する）。
 *
 * 循環した辺（detectCycles の cyclicEdges）は隣接からも起点判定からも外す。
 * 成立しない日程を根拠にしても意味が無いし、外さないと同じ節点を延々と回ることになる。
 *
 * どのマイルストーンにも届かないタスクは、返す Map に載せない。何色にするかは
 * 距離の問題ではなく見た目の決めごとなので、呼び出し側で決める。
 */
export function milestoneDepths(
  tasks: ScheduleTask[],
  dependencies: Dependency[],
  cyclicEdges: ReadonlySet<string>,
): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))

  // 展開用の隣接（距離 0 が決まった後、そこから遡るのに使う）。全部の依存を辿る。
  const next = new Map<string, string[]>()
  // 起点判定用。「同じマイルストーンの他のタスクから待たれている回数」。
  // 1 つでもあれば、そのマイルストーンの中では最後ではない。
  const sameMilestoneWaitedOn = new Map<string, number>()

  for (const dep of dependencies) {
    if (cyclicEdges.has(edgeKey(dep.fromTaskId, dep.toTaskId))) continue
    next.set(dep.fromTaskId, [...(next.get(dep.fromTaskId) ?? []), dep.toTaskId])

    const from = byId.get(dep.fromTaskId)
    const to = byId.get(dep.toTaskId)
    if (from?.milestone && to?.milestone && from.milestone.id === to.milestone.id) {
      sameMilestoneWaitedOn.set(dep.toTaskId, (sameMilestoneWaitedOn.get(dep.toTaskId) ?? 0) + 1)
    }
  }

  const depths = new Map<string, number>()
  const queue: string[] = []
  for (const task of tasks) {
    if (task.milestone === null) continue
    if ((sameMilestoneWaitedOn.get(task.id) ?? 0) > 0) continue
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
