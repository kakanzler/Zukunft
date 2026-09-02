import { addDays, type ISODate, inclusiveDays } from "./date"
import { type CycleReport, detectCycles } from "./cycle"
import { type Dependency, resolveDependencies } from "./dependency"
import { type ScheduleTask, isScheduled } from "./schedule"

/** カスケードが決めた、1 タスク分の新しい日程。 */
export type ScheduleEdit = {
  taskId: string
  startDate: ISODate
  endDate: ISODate
}

/**
 * 依存関係に合わせて日程を後ろへずらす（企画書 §15.2）。
 *
 * 押すだけで、前倒しはしない。意図して空けた余裕まで詰めてしまうと、
 * 「勝手に動いた」としか見えなくなる。制約を破っているタスクだけを直す。
 *
 * 制約は「依存タスクは依存先の終了日より後に始まる」。破っていれば
 * 依存先の翌日開始にずらし、期間はそのまま保つ。
 *
 * `tasks` には changedTaskId の変更を適用済みのものを渡すこと。ここで
 * DateChange を解釈しないのは、その意味づけ（未指定は据え置き）を
 * store.ts の側に一本化しておきたいため。
 */
export function cascade(
  tasks: ScheduleTask[],
  changedTaskId: string,
  options: { dependencies?: Dependency[]; cycles?: CycleReport } = {},
): ScheduleEdit[] {
  const dependencies = options.dependencies ?? resolveDependencies(tasks)
  // 循環したタスクはグラフから外す。ガードで止めるのではなく、
  // 辿る対象から消すことで構造として終わるようにする。
  const excluded = (options.cycles ?? detectCycles(tasks, dependencies)).cyclicTaskIds

  const byId = new Map<string, ScheduleTask>()
  const order = new Map<string, number>()
  tasks.forEach((task, i) => {
    byId.set(task.id, task)
    order.set(task.id, i)
  })
  if (!byId.has(changedTaskId) || excluded.has(changedTaskId)) return []

  /** 依存先 → それに依存している側。押し出しはこの向きに伝わる。 */
  const dependents = new Map<string, string[]>()
  /** 依存している側 → その依存先。守るべき制約を集めるのに使う。 */
  const blockers = new Map<string, string[]>()
  for (const dep of dependencies) {
    if (excluded.has(dep.fromTaskId) || excluded.has(dep.toTaskId)) continue
    dependents.set(dep.toTaskId, [...(dependents.get(dep.toTaskId) ?? []), dep.fromTaskId])
    blockers.set(dep.fromTaskId, [...(blockers.get(dep.fromTaskId) ?? []), dep.toTaskId])
  }

  // 変更したタスクから下流に届く範囲だけを対象にする。
  const cone = new Set<string>([changedTaskId])
  const frontier = [changedTaskId]
  for (let head = 0; head < frontier.length; head++) {
    for (const to of dependents.get(frontier[head]!) ?? []) {
      if (cone.has(to)) continue
      cone.add(to)
      frontier.push(to)
    }
  }

  // 範囲の中だけで入次数を数え、依存先が確定してから依存元を見る（Kahn）。
  // 素朴な BFS だと、依存先を 2 つ持つタスクが片方だけ確定した時点で評価され、
  // 同じタスクに 2 つの編集＝ 2 回の GitHub 書き込みが出てしまう。
  const indegree = new Map<string, number>()
  for (const id of cone) indegree.set(id, 0)
  for (const id of cone) {
    for (const to of dependents.get(id) ?? []) {
      if (cone.has(to)) indegree.set(to, indegree.get(to)! + 1)
    }
  }

  const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!
  const ready = [...cone].filter((id) => indegree.get(id) === 0).sort(byOrder)
  const edits: ScheduleEdit[] = []
  const moved = new Map<string, ISODate>()

  /** その時点で有効な終了日。この実行で動かしたならそちらを使う。 */
  const endOf = (id: string): ISODate | null => {
    const settled = moved.get(id)
    if (settled) return settled
    const task = byId.get(id)
    return task && isScheduled(task) ? task.endDate : null
  }

  for (let head = 0; head < ready.length; head++) {
    const id = ready[head]!

    if (id !== changedTaskId) {
      const task = byId.get(id)
      // 日付未設定のタスクは飛ばす。守る制約も、保つ期間も無い。
      if (task && isScheduled(task)) {
        const ends = (blockers.get(id) ?? [])
          .map(endOf)
          .filter((end): end is ISODate => end !== null)
        const latest = ends.sort()[ends.length - 1]
        if (latest !== undefined && task.startDate <= latest) {
          const startDate = addDays(latest, 1)
          const endDate = addDays(startDate, inclusiveDays(task.startDate, task.endDate) - 1)
          edits.push({ taskId: id, startDate, endDate })
          moved.set(id, endDate)
        }
      }
    }

    // 入次数を落として、次に見られるようになったものを順序を保って足す。
    const unlocked: string[] = []
    for (const to of dependents.get(id) ?? []) {
      if (!cone.has(to)) continue
      indegree.set(to, indegree.get(to)! - 1)
      if (indegree.get(to) === 0) unlocked.push(to)
    }
    ready.push(...unlocked.sort(byOrder))
  }

  return edits
}
