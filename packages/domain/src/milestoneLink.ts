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
 * 同じマイルストーンを持つタスクのうち、親 Issue を持たないものだけを返す。
 *
 * 期日へ向かっていることは、そのマイルストーンを持つタスク全部から線を引けば
 * 確かに分かる。ただ 1 つのマイルストーンに 5 件も 10 件も付いている盤面では、
 * 線が束になって菱形の手前が塗り潰され、どのバーの話かがかえって読めなくなる。
 * 親のあるタスクは親の下でまとまっているので、最も上位の 1 本だけを引く。
 *
 * `parentByIssueId` に載っていないタスクは「親が分からない」として落とす。
 * 親を引く経路は失敗しうるが、そのときに「親が無い」と読み替えると、
 * 避けたかった線だらけの盤面がそのまま出てしまう。分からないなら引かない。
 */
export function milestoneLinkSources(
  tasks: ScheduleTask[],
  parentByIssueId: Record<string, string | null>,
): MilestoneLink[] {
  const links: MilestoneLink[] = []
  for (const task of tasks) {
    // 日付が無いタスクにはバーが無い。線の出どころが盤面に存在しない。
    if (!isScheduled(task)) continue
    if (!task.milestone) continue
    // in で見るのは、値が null（親が無い）と「鍵ごと無い」（分からない）が
    // 別の意味だから。?? で畳むと後者が前者に化ける。
    if (!(task.issueId in parentByIssueId)) continue
    if (parentByIssueId[task.issueId] !== null) continue
    links.push({ taskId: task.id, milestoneId: task.milestone.id })
  }
  return links
}
