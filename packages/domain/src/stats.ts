import { type ISODate, diffDays, inclusiveDays } from "./date"
import { type Milestone, type MilestoneMark, type ScheduleTask, isScheduled } from "./schedule"

/** 下部 KPI タイルの値（企画書 §6.4.2）。 */
export type ProjectStats = {
  taskCount: number
  weekCount: number
  milestoneCount: number
  completePercent: number
}

/**
 * Status がこの名前（大文字小文字を無視）なら完了とみなす。
 * Project ごとに選択肢名は異なり得るため、判定は緩めに取る。
 */
const DONE_STATUS = ["complete", "completed", "done", "closed"]

export function isComplete(task: ScheduleTask): boolean {
  const status = task.status?.toLowerCase().trim()
  return status !== undefined && DONE_STATUS.includes(status)
}

export function computeStats(tasks: ScheduleTask[]): ProjectStats {
  const scheduled = tasks.filter(isScheduled)
  const dates: ISODate[] = scheduled.flatMap((t) => [t.startDate, t.endDate])
  const sorted = [...dates].sort()

  const weekCount =
    sorted.length === 0
      ? 0
      : Math.max(1, Math.ceil(inclusiveDays(sorted[0]!, sorted[sorted.length - 1]!) / 7))

  const milestones = new Set(
    tasks.map((t) => t.milestone?.title).filter((title): title is string => Boolean(title)),
  )

  // Progress があればそれを、無ければ Status の完了判定を 0/100 として平均する。
  const progressValues = tasks.map((t) => t.progress ?? (isComplete(t) ? 100 : 0))
  const completePercent =
    progressValues.length === 0
      ? 0
      : Math.round(progressValues.reduce((a, b) => a + b, 0) / progressValues.length)

  return {
    taskCount: tasks.length,
    weekCount,
    milestoneCount: milestones.size,
    completePercent,
  }
}

export type TaskGroup = {
  key: string
  label: string
  /** このグループに属するタスク。入れ子がある場合は配下すべて（件数表示に使う） */
  tasks: ScheduleTask[]
  /** グループを表す色（ラベル色など）。無ければ既定の配色を使う */
  color?: string
  /** 入れ子のグループ。undefined なら tasks をそのまま並べる */
  groups?: TaskGroup[]
}

/** グループ分けの基準。サイドバーの表示切り替えに対応する。 */
export type GroupMode = "status" | "label"

/** ラベルが 1 つも付いていないタスクをまとめる先。 */
const NO_LABEL = "\u0000no-label"
/** 親カテゴリのラベルを 1 つも持たないタスクをまとめる先。 */
const NO_PARENT = "\u0000no-parent"

/**
 * Status でグループ化する（企画書 §6.4.2）。
 * 表示順は statusOrder（Project のフィールド定義順）に従い、
 * そこに無い Status と未設定は末尾にまとめる。
 */
export function groupByStatus(tasks: ScheduleTask[], statusOrder: string[]): TaskGroup[] {
  const buckets = new Map<string, ScheduleTask[]>()
  for (const name of statusOrder) buckets.set(name, [])

  const NO_STATUS = "\u0000no-status"
  for (const task of tasks) {
    const key = task.status ?? NO_STATUS
    const bucket = buckets.get(key)
    if (bucket) bucket.push(task)
    else buckets.set(key, [task])
  }

  return [...buckets.entries()]
    .filter(([, group]) => group.length > 0)
    .map(([key, group]) => ({
      key,
      label: key === NO_STATUS ? "NO STATUS" : key.toUpperCase(),
      tasks: [...group].sort(sortByStart),
    }))
}

/**
 * ラベルの組み合わせでグループ化する（Category 表示）。
 *
 * 1 つの Issue は 1 つのグループにしか入らない。ラベルごとにグループを作ると、
 * 複数のラベルを持つ Issue が持っている数だけ行に現れ、一覧として読めなくなるため
 * （実運用では 3 つ付いた Issue が 3 行になっていた）。
 * ラベルの無い Issue は末尾にまとめる。
 */
export function groupByLabel(
  tasks: ScheduleTask[],
  /** キーに含めないラベル名。親カテゴリを子の組み合わせ名から外すのに使う */
  ignore?: ReadonlySet<string>,
): TaskGroup[] {
  const buckets = new Map<string, { label: string; color: string; tasks: ScheduleTask[] }>()

  for (const task of tasks) {
    const labels = ignore ? task.labels.filter((l) => !ignore.has(l.name)) : task.labels
    if (labels.length === 0) {
      const bucket = buckets.get(NO_LABEL) ?? { label: "NO LABEL", color: "", tasks: [] }
      bucket.tasks.push(task)
      buckets.set(NO_LABEL, bucket)
      continue
    }
    // 名前順に揃えてからキーにする。GitHub が返すラベルの並びは Issue ごとに
    // 違いうるので、揃えないと同じ組み合わせが別のグループに割れる。
    const sorted = [...labels].sort((a, b) => a.name.localeCompare(b.name))
    const key = sorted.map((l) => l.name).join("\u0000")
    const bucket = buckets.get(key) ?? {
      label: sorted.map((l) => l.name).join(" + ").toUpperCase(),
      // 点は 1 つしか置けないので先頭の色を代表にする。
      // どのラベルの組み合わせかはグループ名がすべて並べている。
      color: sorted[0]!.color,
      tasks: [],
    }
    bucket.tasks.push(task)
    buckets.set(key, bucket)
  }

  const named = [...buckets.entries()]
    .filter(([key]) => key !== NO_LABEL)
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
  const unlabeled = buckets.get(NO_LABEL)

  const groups: TaskGroup[] = named.map(([key, bucket]) => ({
    key,
    label: bucket.label,
    tasks: [...bucket.tasks].sort(sortByStart),
    color: bucket.color ? `#${bucket.color}` : undefined,
  }))

  if (unlabeled) {
    groups.push({
      key: NO_LABEL,
      label: "NO LABEL",
      tasks: [...unlabeled.tasks].sort(sortByStart),
    })
  }
  return groups
}

/**
 * 親カテゴリでまとめ、その中を残りのラベルの組み合わせで分ける（2 階層）。
 *
 * 親カテゴリは GitHub 上ではただのラベルで、上下関係は持っていない。
 * それを「この Issue は資格の勉強」「これは学校の課題」といった括りとして
 * 使いたいので、どのラベルを親と見なすかだけをアプリ側で決める。
 *
 * 親ラベルを複数持つ Issue は、子と同じく組み合わせを 1 つの親グループにする。
 * 親に順位を付ければどちらか一方に寄せられるが、順位という設定を増やすより、
 * 「両方に属する」と読める組み合わせ名で出す方が説明が要らない。
 */
export function groupByParentLabel(
  tasks: ScheduleTask[],
  parentLabels: string[],
): TaskGroup[] {
  const parents = new Set(parentLabels)
  const buckets = new Map<string, { label: string; color: string; tasks: ScheduleTask[] }>()

  for (const task of tasks) {
    const own = task.labels.filter((l) => parents.has(l.name))
    if (own.length === 0) {
      const bucket = buckets.get(NO_PARENT) ?? { label: "その他", color: "", tasks: [] }
      bucket.tasks.push(task)
      buckets.set(NO_PARENT, bucket)
      continue
    }
    const sorted = [...own].sort((a, b) => a.name.localeCompare(b.name))
    const key = sorted.map((l) => l.name).join(" ")
    const bucket = buckets.get(key) ?? {
      label: sorted.map((l) => l.name).join(" + ").toUpperCase(),
      color: sorted[0]!.color,
      tasks: [],
    }
    bucket.tasks.push(task)
    buckets.set(key, bucket)
  }

  const toGroup = (key: string, bucket: { label: string; color: string; tasks: ScheduleTask[] }) => ({
    key,
    label: bucket.label,
    // 件数は配下の合計。折り畳んだままでも規模が分かる。
    tasks: [...bucket.tasks].sort(sortByStart),
    color: bucket.color ? `#${bucket.color}` : undefined,
    // 子の組み合わせ名から親は外す。親グループの見出しで既に分かっているため。
    groups: groupByLabel(bucket.tasks, parents),
  })

  const groups: TaskGroup[] = [...buckets.entries()]
    .filter(([key]) => key !== NO_PARENT)
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([key, bucket]) => toGroup(key, bucket))

  const orphans = buckets.get(NO_PARENT)
  if (orphans) groups.push(toGroup(NO_PARENT, orphans))
  return groups
}

export function groupTasks(
  tasks: ScheduleTask[],
  mode: GroupMode,
  statusOrder: string[],
  /** 親カテゴリとして扱うラベル名。空なら Category はフラットなまま */
  parentLabels: string[] = [],
): TaskGroup[] {
  if (mode !== "label") return groupByStatus(tasks, statusOrder)
  return parentLabels.length > 0
    ? groupByParentLabel(tasks, parentLabels)
    : groupByLabel(tasks)
}

function sortByStart(a: ScheduleTask, b: ScheduleTask): number {
  if (a.startDate === null) return 1
  if (b.startDate === null) return -1
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
  return a.issueNumber - b.issueNumber
}

/** タスク群のマイルストーンを期日順に返す（重複は畳む）。 */
export function collectMilestones(tasks: ScheduleTask[]): MilestoneMark[] {
  // 同名は 1 つに畳むが、色やカテゴリを後から割り当てるには id が要る。
  // 先に見た方の id を採るのは、期日と同じく「出所で結果が揺れない」ため。
  const seen = new Map<string, { id: string; dueOn: ISODate }>()
  for (const task of tasks) {
    const m = task.milestone
    if (m?.dueOn && !seen.has(m.title)) seen.set(m.title, { id: m.id, dueOn: m.dueOn })
  }
  return [...seen.entries()]
    .map(([title, { id, dueOn }]) => ({ id, title, dueOn }))
    .sort((a, b) => diffDays(b.dueOn, a.dueOn))
}

/**
 * 盤面に出すマイルストーンを 1 本にまとめる。
 *
 * Issue から集めた分だけでは、まだ Issue が 1 件も紐づいていないマイルストーンが
 * 盤面に出ない。作った直後に何も起きなかったように見えるので、リポジトリ側の
 * 一覧も混ぜる。期日の無いものは横軸のどこにも置けないため落とす。
 *
 * 同じ題は 1 つに畳む。先に見た方（Issue 側）の期日を残すのは、
 * どちらも同じマイルストーンを指す以上、出所で結果が揺れない方が読みやすいため。
 */
export function mergeMilestones(
  fromTasks: MilestoneMark[],
  fromRepositories: Milestone[],
): MilestoneMark[] {
  // 同名は 1 つに畳む。id も先に見た方（Issue 側）を残すのは、
  // 期日と同じく出所で結果が揺れない方が読みやすいため。
  const seen = new Map<string, { id: string; dueOn: ISODate }>()
  for (const m of fromTasks) if (!seen.has(m.title)) seen.set(m.title, { id: m.id, dueOn: m.dueOn })
  for (const m of fromRepositories) {
    if (m.dueOn && !seen.has(m.title)) seen.set(m.title, { id: m.id, dueOn: m.dueOn })
  }
  return [...seen.entries()]
    .map(([title, { id, dueOn }]) => ({ id, title, dueOn }))
    .sort((a, b) => diffDays(b.dueOn, a.dueOn))
}
