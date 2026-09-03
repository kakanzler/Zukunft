import {
  type Assignee,
  type DateChange,
  type IssueState,
  type Label,
  type Milestone,
  type NewMilestoneInput,
  type NewTaskInput,
  type ParentIssue,
  type ProjectSchema,
  type ProjectSummary,
  type RepositorySummary,
  type ScheduleTask,
  type TaskContent,
  addDays,
  today,
} from "@zukunft/domain"
import { GitHubError, type GitHubScheduleRepository } from "./repository"

/**
 * GitHub に接続せずに UI を動かすための実装。
 *
 * ブラウザでの開発（Tauri の外）と、同期まわりの手動確認に使う。
 * 遅延と失敗を注入できるので、Syncing / Failed / Conflict の
 * 表示を実際に GitHub を壊さずに確認できる。
 */

export type MockOptions = {
  /** 応答を遅らせる ms。同期状態の表示確認に使う */
  latencyMs?: number
  /** 書き込みを失敗させる確率 (0-1) */
  failureRate?: number
  /** 書き込みを競合させる確率 (0-1) */
  conflictRate?: number
  /**
   * Start Date / Target Date が無い Project を再現する。
   * "once" は「最初の取得だけ欠けている」= GitHub 側で後からフィールドを
   * 追加した状況で、再読み込みがスキーマを取り直すかの確認に使う。
   */
  withoutDateFields?: boolean | "once"
  /** item が 0 件の Project を再現する */
  empty?: boolean
  /** フィールドはあるが、どの Issue にも日付が入っていない状態を再現する */
  undated?: boolean
  /**
   * ラベル・担当・フィールド値を読み切れていない Issue を混ぜる。
   *
   * 実際には Issue に 100 個を超えるラベルや担当が付いた、あるいは Project の
   * フィールドが多くて日付が後ろへ押し出された、といった状況で起きる。
   * 用意しないと、その場合に編集を閉じる導線を実機で確かめられない。
   */
  truncated?: boolean
}

const PROJECT_ID = "mock-project"

const STATUSES = ["Planning", "In Progress", "Review", "Complete"]

/** Priority の選択肢。getProjectSchema が配る id と、値を戻すときの対応表を兼ねる。 */
const PRIORITIES = ["High", "Medium", "Low"]

const SEED: [string, number, number, number, number, number | null][] = [
  // title, statusIndex, milestone, startOffset, durationDays, progress
  ["Project Kickoff", 0, 0, 0, 3, 100],
  ["Define Objectives", 0, 0, 2, 5, 100],
  ["Resource Planning", 0, 0, 5, 6, 80],
  ["Risk Assessment", 0, 0, 8, 5, 40],
  ["Wireframes", 1, 1, 10, 7, 90],
  ["UI/UX Design", 1, 1, 14, 9, 60],
  ["Design Review", 2, 1, 21, 4, 30],
  ["Frontend Development", 1, 2, 24, 14, 45],
  ["Backend Development", 1, 2, 26, 16, 35],
  ["Integration", 1, 2, 38, 8, 10],
  ["Testing", 2, 2, 44, 9, 0],
  ["User Acceptance", 2, 3, 52, 6, 0],
  ["Deployment", 3, 3, 57, 3, 0],
  ["Go Live", 3, 3, 60, 2, 0],
  ["Post Launch Review", 3, 3, 62, 5, null],
]

/** Milestone の候補。id は Issue への設定・解除に使う。 */
const MILESTONES: { id: string; title: string }[] = [
  "Kickoff",
  "Design Review",
  "Integration Complete",
  "Go Live",
].map((title, i) => ({ id: `ms-${i}`, title }))

/** 一覧用の候補。期日は 3 週間おきに置いて、並び順の確認ができるようにする。 */
function buildMilestones(origin: string): Milestone[] {
  return MILESTONES.map((m, i) => ({ ...m, dueOn: addDays(origin, 21 * (i + 1)) }))
}

/** Category 表示の確認用。1 つの Issue に複数付くこともある。 */
const LABELS: Label[] = [
  { id: "lbl-planning", name: "planning", color: "1d76db" },
  { id: "lbl-design", name: "design", color: "a855f7" },
  { id: "lbl-backend", name: "backend", color: "0e8a16" },
  { id: "lbl-frontend", name: "frontend", color: "22d3ee" },
  { id: "lbl-release", name: "release", color: "d93f0b" },
]

/** 担当の候補。実物と同じく、アプリからは作れず GitHub 側が決めたものを選ぶだけ。 */
const ASSIGNEES: Assignee[] = [
  { id: "usr-dev1", login: "dev1", avatarUrl: "" },
  { id: "usr-dev2", login: "dev2", avatarUrl: "" },
  { id: "usr-dev3", login: "dev3", avatarUrl: "" },
  { id: "usr-reviewer", login: "reviewer", avatarUrl: "" },
]

/**
 * モックでの「自分」。実物では viewer を引くところ。
 * 起票した Issue の担当になるので、候補の 1 人と同じ id にしておく。
 */
const VIEWER: Assignee = ASSIGNEES[0]!

/** モックで依存関係を持たせる Issue の添字（直前の Issue に依存する）。 */
const DEPENDS_ON = new Set([1, 4, 6, 7, 9, 10, 12, 13])
/**
 * 循環を 1 組だけ作る（#111 ⇄ #112）。値は依存先の添字。
 * 危険色の破線とログの警告を、実機で確かめられるようにしておく。
 */
const CYCLE_BACK = new Map<number, number>([[10, 11], [11, 10]])

function buildTasks(origin: string): ScheduleTask[] {
  return SEED.map(([title, statusIndex, milestoneIndex, offset, duration, progress], i) => ({
    id: `mock-item-${i + 1}`,
    issueId: `mock-issue-${i + 1}`,
    repositoryId: "mock-repo-1",
    issueNumber: 101 + i,
    title,
    // 依存関係の矢印を確かめられるよう、一部の Issue に宣言を入れておく。
    // 直前の Issue に依存させると、どこかで必ず段違いの行を跨ぐ形になる。
    body: `${title} の作業内容をここに書く。
${CYCLE_BACK.has(i) ? `
blocked-by: #${101 + CYCLE_BACK.get(i)!}
` : ""}${DEPENDS_ON.has(i) ? `
blocked-by: #${100 + i}
` : ""}
- [ ] 実装
- [ ] 動作確認`,
    url: `https://github.com/example/zukunft/issues/${101 + i}`,
    issueState: "OPEN" as const,
    startDate: addDays(origin, offset),
    endDate: addDays(origin, offset + duration - 1),
    status: STATUSES[statusIndex] ?? null,
    priority: i % 3 === 0 ? "High" : "Medium",
    assignees: i % 4 === 3 ? [] : [ASSIGNEES[i % 3]!],
    // 一部はラベル無し、一部は複数ラベルにして Category 表示を試せるようにする
    labels:
      i % 5 === 4
        ? []
        : i % 3 === 0
          ? [LABELS[i % LABELS.length]!, LABELS[(i + 2) % LABELS.length]!]
          : [LABELS[i % LABELS.length]!],
    milestone: {
      id: MILESTONES[milestoneIndex]?.id ?? "ms-0",
      title: MILESTONES[milestoneIndex]?.title ?? "v1",
      dueOn: addDays(origin, offset + duration + 2),
    },
    progress,
    updatedAt: new Date().toISOString(),
    syncState: "synced" as const,
    labelsComplete: true,
    assigneesComplete: true,
    fieldsComplete: true,
  }))
}

/**
 * 読み切れていない Issue を混ぜる。
 * #103 はラベルが、#105 は担当が、#106 はフィールド値が読み切れていない想定。
 * 担当は「既に 1 人見えているが、それが全部とは限らない」状態が要るので、
 * 未アサインの Issue ではなく担当が付いているものを選ぶ。
 */
function withTruncation(tasks: ScheduleTask[]): ScheduleTask[] {
  return tasks.map((task) =>
    task.issueNumber === 103
      ? { ...task, labelsComplete: false }
      : task.issueNumber === 105
        ? { ...task, assigneesComplete: false }
        : task.issueNumber === 106
          ? { ...task, fieldsComplete: false, startDate: null, endDate: null }
          : task,
  )
}

export class MockScheduleRepository implements GitHubScheduleRepository {
  #tasks: ScheduleTask[]
  #labels: Label[] = [...LABELS]
  #milestones: Milestone[]
  #schemaFetches = 0
  readonly #options: Required<MockOptions>

  constructor(options: MockOptions = {}) {
    this.#options = {
      latencyMs: options.latencyMs ?? 220,
      failureRate: options.failureRate ?? 0,
      conflictRate: options.conflictRate ?? 0,
      withoutDateFields: options.withoutDateFields ?? false,
      empty: options.empty ?? false,
      undated: options.undated ?? false,
      truncated: options.truncated ?? false,
    }
    const origin = addDays(today(), -14)
    this.#milestones = buildMilestones(origin)
    const seeded = buildTasks(origin)
    const dated = (options.undated ?? false)
      ? seeded.map((t) => ({ ...t, startDate: null, endDate: null }))
      : seeded
    this.#tasks = (options.truncated ?? false) ? withTruncation(dated) : dated
  }

  async #delay(): Promise<void> {
    if (this.#options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.latencyMs))
    }
  }

  async listProjects(owner: string): Promise<ProjectSummary[]> {
    await this.#delay()
    return [
      {
        id: PROJECT_ID,
        number: 1,
        title: "Zukunft Roadmap (mock)",
        url: "https://github.com/orgs/example/projects/1",
        ownerType: "organization",
        ownerLogin: owner || "example",
      },
    ]
  }

  #dateFieldsMissing(): boolean {
    const mode = this.#options.withoutDateFields
    if (mode === "once") return this.#schemaFetches <= 1
    return mode === true
  }

  async getProjectSchema(projectId: string): Promise<ProjectSchema> {
    await this.#delay()
    this.#schemaFetches += 1
    if (this.#dateFieldsMissing()) {
      return {
        projectId,
        fields: [
          { id: "f-status", name: "Status", dataType: "SINGLE_SELECT",
            options: STATUSES.map((name, i) => ({ id: `o${i}`, name })) },
        ],
      }
    }
    return {
      projectId,
      fields: [
        { id: "f-status", name: "Status", dataType: "SINGLE_SELECT",
          options: STATUSES.map((name, i) => ({ id: `o${i}`, name })) },
        { id: "f-start", name: "Start Date", dataType: "DATE", options: [] },
        { id: "f-end", name: "Target Date", dataType: "DATE", options: [] },
        { id: "f-priority", name: "Priority", dataType: "SINGLE_SELECT",
          options: PRIORITIES.map((name, i) => ({ id: `p${i}`, name })) },
        { id: "f-progress", name: "Progress", dataType: "NUMBER", options: [] },
      ],
    }
  }

  async getTasks(_projectId: string): Promise<ScheduleTask[]> {
    await this.#delay()
    if (this.#options.empty) return []
    if (this.#dateFieldsMissing()) {
      // 日付フィールドが無い Project では、どの item にも日付が付かない。
      return this.#tasks.map((t) => ({ ...t, startDate: null, endDate: null }))
    }
    return this.#tasks.map((t) => ({ ...t }))
  }

  async listLabels(_repositoryId: string): Promise<Label[]> {
    await this.#delay()
    return this.#labels.map((l) => ({ ...l }))
  }

  async listAssignableUsers(_repositoryId: string): Promise<Assignee[]> {
    await this.#delay()
    return ASSIGNEES.map((a) => ({ ...a }))
  }

  async listMilestones(_repositoryId: string): Promise<Milestone[]> {
    await this.#delay()
    return this.#milestones.map((m) => ({ ...m }))
  }

  /**
   * マイルストーンを作る。作ったものは自分の一覧に加えるので、
   * 以後の listMilestones にも出る（実物と同じく、作成しただけでは Issue には付かない）。
   */
  async createMilestone(
    _nameWithOwner: string,
    input: NewMilestoneInput,
  ): Promise<Milestone> {
    await this.#delay()
    const title = input.title.trim()
    // 実物の REST は同じ題を 422 で弾く。ここで通してしまうと、
    // モックでだけ通って実機で失敗する経路ができる。
    if (this.#milestones.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
      throw new GitHubError("unknown", `「${title}」という題のマイルストーンは既にあります`)
    }
    const created: Milestone = {
      id: `ms-${title}-${Date.now()}`,
      title,
      dueOn: input.dueOn,
    }
    this.#milestones = [...this.#milestones, created]
    return { ...created }
  }

  async createLabel(_repositoryId: string, name: string, color: string): Promise<Label> {
    await this.#delay()
    const trimmed = name.trim()
    if (this.#labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new GitHubError("unknown", `ラベル「${trimmed}」は既に存在します`)
    }
    const created: Label = { id: `lbl-${trimmed}-${Date.now()}`, name: trimmed, color }
    this.#labels = [...this.#labels, created]
    return { ...created }
  }

  /** ラベル定義ごと消す。実物と同じく、付いていた Issue すべてから外れる。 */
  async deleteLabel(labelId: string): Promise<void> {
    await this.#delay()
    if (!this.#labels.some((l) => l.id === labelId)) {
      throw new GitHubError("not-found", "ラベルが見つかりません")
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }
    this.#labels = this.#labels.filter((l) => l.id !== labelId)
    this.#tasks = this.#tasks.map((t) =>
      t.labels.some((l) => l.id === labelId)
        ? { ...t, labels: t.labels.filter((l) => l.id !== labelId) }
        : t,
    )
  }

  async updateTaskContent(
    taskId: string,
    _issueId: string,
    content: TaskContent,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }
    // 日付と同じく、送る前に読み取り時点から変わっていないかを見る。
    if (content.expectedUpdatedAt !== "" && content.expectedUpdatedAt !== current.updatedAt) {
      throw new GitHubError("conflict", "GitHub 側でこの Issue が更新されています", current)
    }
    const updated: ScheduleTask = {
      ...current,
      title: content.title,
      body: content.body,
      // null は「ラベルには触らない」。読み切れていない Issue で置き換えを
      // 送らせないための経路なので、モックでも現状維持にする。
      labels:
        content.labelIds === null
          ? current.labels
          : content.labelIds
              .map((id) => this.#labels.find((l) => l.id === id))
              .filter((l): l is Label => Boolean(l)),
      // 担当もラベルと同じ置き換え集合。null は「担当には触らない」。
      assignees:
        content.assigneeIds === null
          ? current.assignees
          : content.assigneeIds
              .map((id) => ASSIGNEES.find((a) => a.id === id))
              .filter((a): a is Assignee => Boolean(a)),
      // null は「外す」。知らない id は現状維持にして、
      // 候補の取得に失敗しただけでマイルストーンを黙って消さないようにする。
      milestone:
        content.milestoneId === null
          ? null
          : (this.#milestones.find((m) => m.id === content.milestoneId) ?? current.milestone),
      updatedAt: new Date().toISOString(),
    }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }

  async listRepositories(_projectId: string): Promise<RepositorySummary[]> {
    await this.#delay()
    return [{ id: "mock-repo-1", nameWithOwner: "example/zukunft" }]
  }

  /** 親子関係。モックでは覚えるだけで、GitHub 側の制約（循環など）は見ない。 */
  #parents = new Map<string, string>()

  async getParentIssue(issueId: string): Promise<ParentIssue | null> {
    await this.#delay()
    const parentIssueId = this.#parents.get(issueId)
    const parent = this.#tasks.find((t) => t.issueId === parentIssueId)
    return parent
      ? { issueId: parent.issueId, number: parent.issueNumber, title: parent.title, url: parent.url }
      : null
  }

  async setParentIssue(issueId: string, parentIssueId: string | null): Promise<void> {
    await this.#delay()
    if (parentIssueId === null) this.#parents.delete(issueId)
    else this.#parents.set(issueId, parentIssueId)
  }

  async createTask(_projectId: string, input: NewTaskInput): Promise<ScheduleTask> {
    await this.#delay()
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }
    const issueNumber =
      this.#tasks.reduce((max, t) => Math.max(max, t.issueNumber), 100) + 1
    const created: ScheduleTask = {
      id: `mock-item-${issueNumber}`,
      issueId: `mock-issue-${issueNumber}`,
      repositoryId: "mock-repo-1",
      issueNumber,
      title: input.title,
      body: input.body ?? "",
      url: `https://github.com/example/zukunft/issues/${issueNumber}`,
      issueState: "OPEN",
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      // 知らない選択肢 id は既定のままにする。実物でも作成自体は成功し、
      // Status だけが Project の既定値で残るため。
      status: STATUSES.find((_, i) => `o${i}` === input.statusOptionId) ?? STATUSES[0] ?? null,
      priority: null,
      // 起票した Issue は自分に割り当てる（実物では viewer を引く）。
      assignees: [VIEWER],
      labels: (input.labelIds ?? [])
        .map((id) => this.#labels.find((l) => l.id === id))
        .filter((l): l is Label => Boolean(l)),
      milestone: this.#milestones.find((m) => m.id === input.milestoneId) ?? null,
      progress: null,
      updatedAt: new Date().toISOString(),
      syncState: "synced",
      // 作ったばかりの Issue は、こちらが送った内容がそのまま全部。
      labelsComplete: true,
      assigneesComplete: true,
      fieldsComplete: true,
    }
    this.#tasks = [...this.#tasks, created]
    return { ...created }
  }

  /**
   * Status の変更。
   *
   * updatedAt は動かさない。Status は Projects v2 のフィールド値であって
   * Issue 本体ではないため、実物でも Issue の updatedAt は変わらない。
   * ここで進めてしまうと、直後の日付更新が偽の競合になる。
   */
  async updateTaskStatus(
    _projectId: string,
    taskId: string,
    optionId: string,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")

    // getProjectSchema が配る `o${i}` と同じ対応表で選択肢の名前に戻す。
    const name = STATUSES.find((_, i) => `o${i}` === optionId)
    if (name === undefined) {
      throw new GitHubError("not-found", `Status の選択肢「${optionId}」が見つかりません`)
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }

    const updated: ScheduleTask = { ...current, status: name }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }

  /**
   * Priority の変更。optionId が null なら未設定に戻す。
   *
   * Status と同じく updatedAt は動かさない。Projects v2 のフィールド値であって
   * Issue 本体ではないため、実物でも Issue の updatedAt は変わらない。
   * ここで進めてしまうと、直後の日付更新が偽の競合になる。
   */
  async updateTaskPriority(
    _projectId: string,
    taskId: string,
    optionId: string | null,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")

    // getProjectSchema が配る `p${i}` と同じ対応表で選択肢の名前に戻す。
    let name: string | null = null
    if (optionId !== null) {
      name = PRIORITIES.find((_, i) => `p${i}` === optionId) ?? null
      if (name === null) {
        throw new GitHubError("not-found", `Priority の選択肢「${optionId}」が見つかりません`)
      }
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }

    const updated: ScheduleTask = { ...current, priority: name }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }

  /**
   * Progress の変更。value が null なら未設定に戻す。0 とは別の状態として扱う。
   *
   * Status と同じく updatedAt は動かさない。Projects v2 のフィールド値であって
   * Issue 本体ではないため、実物でも Issue の updatedAt は変わらない。
   * ここで進めてしまうと、直後の日付更新が偽の競合になる。
   */
  async updateTaskProgress(
    _projectId: string,
    taskId: string,
    value: number | null,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")

    // 範囲外は実物（Rust 側のコマンド）でも弾かれる。モックだけ通ると、
    // モックで動いたものが実物で落ちることになる。
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
      throw new GitHubError("unknown", "Progress は 0〜100 で指定してください")
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }

    const updated: ScheduleTask = { ...current, progress: value }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }

  /**
   * Issue の開閉。Status と違い Issue 本体の状態なので、
   * 実物では updatedAt が動く。競合検出の確認ができるよう、ここでも進める。
   */
  async setTaskState(
    taskId: string,
    _issueId: string,
    state: IssueState,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }

    const updated: ScheduleTask = {
      ...current,
      issueState: state,
      updatedAt: new Date().toISOString(),
    }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }

  /** Issue ごと消す。実物と同じく、消えた後は取り戻せない。 */
  async deleteTask(issueId: string): Promise<void> {
    await this.#delay()
    if (!this.#tasks.some((t) => t.issueId === issueId)) {
      throw new GitHubError("not-found", "タスクが見つかりません")
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }
    this.#tasks = this.#tasks.filter((t) => t.issueId !== issueId)
  }

  async updateTaskDates(
    _projectId: string,
    taskId: string,
    change: DateChange,
    expectedUpdatedAt: string,
  ): Promise<ScheduleTask> {
    await this.#delay()
    const current = this.#tasks.find((t) => t.id === taskId)
    if (!current) throw new GitHubError("not-found", "タスクが見つかりません")

    if (Math.random() < this.#options.conflictRate) {
      const remote = { ...current, updatedAt: new Date().toISOString() }
      throw new GitHubError("conflict", "GitHub 側が更新されています", remote)
    }
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new GitHubError("conflict", "GitHub 側が更新されています", { ...current })
    }
    if (Math.random() < this.#options.failureRate) {
      throw new GitHubError("network", "GitHub に接続できませんでした")
    }

    const updated: ScheduleTask = {
      ...current,
      startDate: change.startDate ?? current.startDate,
      endDate: change.endDate ?? current.endDate,
      updatedAt: new Date().toISOString(),
      syncState: "synced",
    }
    this.#tasks = this.#tasks.map((t) => (t.id === taskId ? updated : t))
    return { ...updated }
  }
}
