import type {
  DateChange,
  Label,
  NewTaskInput,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"

/**
 * GitHub との通信を隠蔽する層（企画書 §8）。
 *
 * UI は常にこのインタフェースだけを見る。実装は 2 つあり、
 * デスクトップは Tauri command 経由、Web はサーバ側 fetch（読み取りのみ）。
 */
export interface GitHubScheduleRepository {
  listProjects(owner: string): Promise<ProjectSummary[]>
  getProjectSchema(projectId: string): Promise<ProjectSchema>
  getTasks(projectId: string): Promise<ScheduleTask[]>
  /**
   * 日付を更新する。
   *
   * `expectedUpdatedAt` は必須。競合検出（企画書 §16.3）を
   * 呼び出し側が省略できないようにするため、既定値を持たせない。
   */
  updateTaskDates(
    projectId: string,
    taskId: string,
    change: DateChange,
    expectedUpdatedAt: string,
  ): Promise<ScheduleTask>

  /**
   * Issue 本体（タイトル・本文）を書き換える。
   * 日付フィールドとは別のミューテーションなので、キューを通さず直接送る。
   */
  updateTaskContent(
    taskId: string,
    issueId: string,
    content: TaskContent,
  ): Promise<ScheduleTask>

  /** リポジトリに定義済みのラベル。Issue に付け外しする候補 */
  listLabels(repositoryId: string): Promise<Label[]>

  /** ラベルを新規作成する。作成しただけでは Issue には付かない */
  createLabel(repositoryId: string, name: string, color: string): Promise<Label>

  /** Issue の作成先候補。Project にリンクされたリポジトリを返す */
  listRepositories(projectId: string): Promise<RepositorySummary[]>

  /**
   * Issue を作成し、Project に追加して、指定があれば日付も設定する。
   * 読み取り専用の実装では unsupported で失敗させる。
   */
  createTask(projectId: string, input: NewTaskInput): Promise<ScheduleTask>
}

/** エラーの分類。UI はこれを見て対処を出し分ける（企画書 §18）。 */
export type GitHubErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "field-missing"
  | "rate-limited"
  | "network"
  | "conflict"
  | "unsupported"
  | "unknown"

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  /** 競合時に GitHub 側の現在値を載せる（企画書 §16.3 の提示に使う） */
  readonly remote?: ScheduleTask

  constructor(kind: GitHubErrorKind, message: string, remote?: ScheduleTask) {
    super(message)
    this.name = "GitHubError"
    this.kind = kind
    this.remote = remote
  }
}

/** リトライしてよいエラーか（企画書 §16.4）。 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof GitHubError)) return false
  return error.kind === "network" || error.kind === "rate-limited"
}

/** 分類ごとの、ユーザーに出す対処。GitHub の生の応答は出さない（企画書 §18）。 */
export function describeError(error: GitHubError): { title: string; hint: string } {
  switch (error.kind) {
    case "unauthorized":
      return { title: "サインインが必要です", hint: "設定から GitHub に再度サインインしてください。" }
    case "forbidden":
      return { title: "権限が足りません", hint: "この Project への書き込み権限があるか確認してください。" }
    case "not-found":
      return { title: "対象が見つかりません", hint: "Project または Issue が削除された可能性があります。" }
    case "field-missing":
      return { title: "フィールドがありません", hint: "Project に Start Date / Target Date / Status を作成してください。" }
    case "rate-limited":
      return { title: "レート制限に達しました", hint: "しばらく待ってから再試行してください。" }
    case "network":
      return { title: "通信できません", hint: "ネットワーク接続を確認してください。" }
    case "conflict":
      return { title: "GitHub 側が更新されています", hint: "再読み込みするか、ローカルの変更で上書きするか選んでください。" }
    case "unsupported":
      return { title: "この操作はできません", hint: "読み取り専用のビューでは変更を保存できません。" }
    case "unknown":
      return { title: "不明なエラー", hint: "再試行しても直らない場合はログを確認してください。" }
  }
}
