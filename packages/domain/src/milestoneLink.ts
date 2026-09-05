import type { Dependency } from "./dependency"
import type { ScheduleTask } from "./schedule"
import { isScheduled } from "./schedule"

/** どのタスクからどのマイルストーンへ線を引くか。 */
export type MilestoneLink = {
  /** 線の出どころ。バーの上端から引くので、Projects v2 の item id で指す */
  taskId: string
  /** 線の行き先のマイルストーン。菱形と同じ id */
  milestoneId: string
}

/**
 * 同じマイルストーンを持つタスクのうち、親 Issue を持たず、かつ他のタスクに
 * 依存していない（依存の矢印を自分から出していない）ものだけを返す。
 *
 * 期日へ向かっていることは、そのマイルストーンを持つタスク全部から線を引けば
 * 確かに分かる。ただ 1 つのマイルストーンに 5 件も 10 件も付いている盤面では、
 * 線が束になって菱形の手前が塗り潰され、どのバーの話かがかえって読めなくなる。
 * 親のあるタスクは親の下でまとまっているので、最も上位の 1 本だけを引く。
 *
 * 依存元（他のタスクを blocked-by で挙げているタスク）も同じ理由で外す。
 * 依存の矢印が既にそのタスクから出ているので、そこへさらにマイルストーンへの
 * 線を重ねると、1 本のバーから 2 本の線が出て煩雑になる。依存を辿れば
 * いずれ Milestone まで届く（milestoneDepths の色でも表れる）ので、
 * 線そのものは依存の矢印に譲ってよい。
 *
 * 親は Issue ごとに 1 つで、`null`（および地図に載っていないこと）は
 * 「親が設定されていない」を意味する。「分からない」という状態は持たない。
 *
 * 取得そのものに失敗したときは、ここではなく呼び出し側が線を出さないことで
 * 塞ぐ。1 件ずつの札ではなく「引けたかどうか」の旗 1 つで足りる。
 */
export function milestoneLinkSources(
  tasks: ScheduleTask[],
  parentByIssueId: Record<string, string | null>,
  dependencies: Dependency[] = [],
): MilestoneLink[] {
  const dependsOnSomething = new Set(dependencies.map((d) => d.fromTaskId))
  const links: MilestoneLink[] = []
  for (const task of tasks) {
    // 日付が無いタスクにはバーが無い。線の出どころが盤面に存在しない。
    if (!isScheduled(task)) continue
    if (!task.milestone) continue
    // 載っていなければ親なし。null と同じ扱いにする。
    if (parentByIssueId[task.issueId] != null) continue
    if (dependsOnSomething.has(task.id)) continue
    links.push({ taskId: task.id, milestoneId: task.milestone.id })
  }
  return links
}
