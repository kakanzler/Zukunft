import { type Dependency, resolveDependencies } from "./dependency"
import type { ScheduleTask } from "./schedule"

/**
 * 依存関係の循環（企画書 §15.1）。
 *
 * 循環した依存は、そもそも成立しない日程を表している。線を消してしまうと
 * 書き間違いに気づけないので、描いたうえで循環だと分かる見た目にする。
 * 自動の日程調整（cascade）は、循環したタスクを対象から外すのに使う。
 */
export type Cycle = {
  /** 循環上のタスク id。辺の向き（依存元 → 依存先）に並ぶ。先頭は繰り返さない */
  taskIds: string[]
  /** ログ用。taskIds と同じ並びの Issue 番号 */
  issueNumbers: number[]
}

export type CycleReport = {
  /** 見つかった循環。tasks の並び順で安定する */
  cycles: Cycle[]
  /** 循環上の辺。描画中に O(1) で引けるよう Set にする */
  cyclicEdges: ReadonlySet<string>
  /** 循環に属するタスク id。cascade が除外に使う */
  cyclicTaskIds: ReadonlySet<string>
}

export function edgeKey(fromTaskId: string, toTaskId: string): string {
  return `${fromTaskId}>${toTaskId}`
}

/** "循環: #101 → #102 → #101" — 戻ってきたことが読めるよう先頭を末尾に繰り返す。 */
export function formatCycle(cycle: Cycle): string {
  const path = [...cycle.issueNumbers, cycle.issueNumbers[0]!]
  return `循環: ${path.map((n) => `#${n}`).join(" → ")}`
}

/**
 * 循環を強連結成分として求める（Tarjan、再帰ではなく明示スタック）。
 *
 * DFS の後退辺だけを拾う実装にはしない。a→b→c→a に b→a が加わったとき、
 * 後退辺方式では b→a が循環に入らず実線のまま残る。循環しているのにそう見えない
 * 辺が出るのは、機能としていちばん困る間違い方なので、成分で判定する。
 *
 * 再帰にしないのは、Project が数百件になったときにスタックを溢れさせないため。
 * 描画のたびに通る経路で落ちるのは割に合わない。
 */
export function detectCycles(
  tasks: ScheduleTask[],
  dependencies: Dependency[] = resolveDependencies(tasks),
): CycleReport {
  const index = new Map<string, number>()
  tasks.forEach((task, i) => index.set(task.id, i))

  // 隣接は dependencies の順に積む。同じ入力からは常に同じ出力を返したい。
  const next = new Map<string, string[]>()
  for (const dep of dependencies) {
    next.set(dep.fromTaskId, [...(next.get(dep.fromTaskId) ?? []), dep.toTaskId])
  }

  const components = stronglyConnected(tasks, next)

  const cyclicTaskIds = new Set<string>()
  const cycles: Cycle[] = []
  for (const component of components) {
    const members = new Set(component)
    // 大きさ 1 の成分が循環なのは自分自身を指しているときだけ。
    const selfLoop =
      component.length === 1 && (next.get(component[0]!) ?? []).includes(component[0]!)
    if (component.length < 2 && !selfLoop) continue

    for (const id of component) cyclicTaskIds.add(id)
    // 代表点は tasks 順で先頭のもの。どの成分からも同じ経路が出るようにする。
    const head = [...component].sort((a, b) => index.get(a)! - index.get(b)!)[0]!
    const path = selfLoop ? [head] : shortestCycle(head, members, next)
    if (path.length === 0) continue
    cycles.push({
      taskIds: path,
      issueNumbers: path.map((id) => tasks[index.get(id)!]!.issueNumber),
    })
  }

  // 両端が同じ循環成分にある辺が、循環上の辺。
  const componentOf = new Map<string, number>()
  components.forEach((component, i) => {
    for (const id of component) componentOf.set(id, i)
  })
  const cyclicEdges = new Set<string>()
  for (const dep of dependencies) {
    if (!cyclicTaskIds.has(dep.fromTaskId) || !cyclicTaskIds.has(dep.toTaskId)) continue
    if (componentOf.get(dep.fromTaskId) !== componentOf.get(dep.toTaskId)) continue
    cyclicEdges.add(edgeKey(dep.fromTaskId, dep.toTaskId))
  }

  cycles.sort((a, b) => index.get(a.taskIds[0]!)! - index.get(b.taskIds[0]!)!)

  return { cycles, cyclicEdges, cyclicTaskIds }
}

/**
 * 成分の中で、起点へ戻る最短の経路。
 *
 * 最短にするのは読みやすさのため。9 ホップの巡回を出されても、どこを直せば
 * 循環が切れるのかが分からない。
 */
function shortestCycle(
  start: string,
  members: ReadonlySet<string>,
  next: ReadonlyMap<string, string[]>,
): string[] {
  const cameFrom = new Map<string, string>()
  const queue: string[] = []

  const push = (from: string, to: string): string[] | null => {
    if (!members.has(to)) return null
    if (to === start) {
      // start へ戻る辺を見つけた。cameFrom を辿れば経路が出る。
      const path: string[] = []
      for (let at = from; at !== start; at = cameFrom.get(at)!) path.unshift(at)
      return [start, ...path]
    }
    if (!cameFrom.has(to)) {
      cameFrom.set(to, from)
      queue.push(to)
    }
    return null
  }

  for (const to of next.get(start) ?? []) {
    const found = push(start, to)
    if (found) return found
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!
    for (const to of next.get(node) ?? []) {
      const found = push(node, to)
      if (found) return found
    }
  }
  return []
}

/**
 * 強連結成分（Tarjan）。成分は tasks の並び順で安定するように返す。
 */
function stronglyConnected(
  tasks: ScheduleTask[],
  next: ReadonlyMap<string, string[]>,
): string[][] {
  const order = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const task of tasks) {
    if (order.has(task.id)) continue

    // [ノード, 次に見る隣接の添字] の作業スタック。再帰の代わり。
    const work: { node: string; edge: number }[] = [{ node: task.id, edge: 0 }]
    order.set(task.id, counter)
    low.set(task.id, counter)
    counter++
    stack.push(task.id)
    onStack.add(task.id)

    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const neighbours = next.get(frame.node) ?? []

      if (frame.edge < neighbours.length) {
        const to = neighbours[frame.edge]!
        frame.edge++
        if (!order.has(to)) {
          order.set(to, counter)
          low.set(to, counter)
          counter++
          stack.push(to)
          onStack.add(to)
          work.push({ node: to, edge: 0 })
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, order.get(to)!))
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === order.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const id = stack.pop()!
          onStack.delete(id)
          component.push(id)
          if (id === frame.node) break
        }
        // 成分の中は発見順で持つ。呼び出し側が代表点を選ぶときに安定する。
        components.push(component.reverse())
      }
    }
  }
  return components
}
