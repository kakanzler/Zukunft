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
 * マイルストーンが付いていて、かつ「同じマイルストーンを持つ他のタスクに
 * 自分から依存していない」タスク——言い換えると、同じマイルストーンの中で見て、
 * 自分より先に片付ける必要がある相手が（宣言されている依存の範囲で）見当たらないもの。
 * 判定は同じマイルストーン同士の辺だけで行う。別のマイルストーンのタスクに
 * 依存しているというだけでは、自分のマイルストーンに対する近さは変わらない
 * （フェーズを跨いだ依存はよくあるが、それは前のフェーズが先に終わるという意味であって、
 * 自分のフェーズの近さを損なうものではない）。
 *
 * 依存元（blocked-by で相手を挙げた側）ではなく依存先（挙げられた側）を残すのは、
 * milestoneLinkSources が依存元からはマイルストーンへの線を引かないのと同じ理由。
 * 依存元は既に依存の矢印で「その相手を経由して Milestone に向かっている」ことが
 * 読めるので、依存元自身がマイルストーンの直近だと主張する必要がない——挙げた
 * 相手（依存先）に近さを譲ってよい。逆にすると、既に距離 0 として見えているタスクへ、
 * 依存元にも同じ Milestone を後から設定しただけで色が入れ替わってしまう
 * （依存元に Milestone を設定すると色の流れが逆になる、として報告された不具合）。
 *
 * 距離 0 が決まったら、そこからの展開は同じマイルストーン縛りを外し、かつ
 * 依存している／されているの向きも問わない——依存元→依存先（自分が blocked-by
 * で挙げた、先に片付く相手）だけでなく、依存先→依存元（自分を blocked-by で
 * 挙げている、自分の後に来る相手）にも同じように伝わる。マイルストーンを
 * 持たないタスクが「距離 0 のタスクに依存させたのに色が変わらない」ということが
 * 無いようにするため（依存させる側・される側のどちらの向きでも、Milestone に
 * 一番近いタスクとの繋がりが分かれば、それだけ近い色になってよい）。
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

  // 展開用の隣接（距離 0 が決まった後、そこから広げるのに使う）。向きを問わず
  // 両方向に積む——依存元→依存先だけでなく、依存先→依存元も辿れるようにする。
  const next = new Map<string, string[]>()
  const link = (a: string, b: string) => next.set(a, [...(next.get(a) ?? []), b])
  // 起点判定用。「同じマイルストーンの相手に自分から依存している回数」。
  // 1 つでもあれば、そのマイルストーンの中では自分より先に片付く相手がいる
  // ということなので、距離 0（最も近い）を名乗らない。
  const sameMilestoneDependsOnOther = new Map<string, number>()

  for (const dep of dependencies) {
    if (cyclicEdges.has(edgeKey(dep.fromTaskId, dep.toTaskId))) continue
    link(dep.fromTaskId, dep.toTaskId)
    link(dep.toTaskId, dep.fromTaskId)

    const from = byId.get(dep.fromTaskId)
    const to = byId.get(dep.toTaskId)
    if (from?.milestone && to?.milestone && from.milestone.id === to.milestone.id) {
      sameMilestoneDependsOnOther.set(
        dep.fromTaskId,
        (sameMilestoneDependsOnOther.get(dep.fromTaskId) ?? 0) + 1,
      )
    }
  }

  const depths = new Map<string, number>()
  const queue: string[] = []
  for (const task of tasks) {
    if (task.milestone === null) continue
    if ((sameMilestoneDependsOnOther.get(task.id) ?? 0) > 0) continue
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
