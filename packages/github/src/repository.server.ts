import type {
  Assignee,
  DateChange,
  IssueState,
  Label,
  Milestone,
  NewMilestoneInput,
  NewTaskInput,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"
import { mapMilestones, mapProjectSchema, mapTasks } from "./mapping"
import {
  ASSIGNABLE_USERS,
  LIST_PROJECTS,
  PROJECT_ITEMS,
  PROJECT_REPOSITORIES,
  PROJECT_SCHEMA,
  REPOSITORY_LABELS,
  REPOSITORY_MILESTONES,
} from "./queries"
import { GitHubError, type GitHubScheduleRepository } from "./repository"

/**
 * Web 実装（企画書 §4.2 / §9）。**読み取り専用**。
 *
 * Vercel の Server Component から呼ばれることを想定する。
 * Read 権限のみのトークンをサーバ側の環境変数から受け取り、
 * ブラウザには決して渡さない。
 */

const ENDPOINT = "https://api.github.com/graphql"

export type ServerRepositoryOptions = {
  /** Read 権限のみの fine-grained PAT。サーバ側の環境変数から渡す */
  token: string
  /** Next.js の fetch キャッシュ制御（秒）。既定 5 分 */
  revalidateSeconds?: number
}

export class ServerScheduleRepository implements GitHubScheduleRepository {
  readonly #token: string
  readonly #revalidate: number

  constructor({ token, revalidateSeconds = 300 }: ServerRepositoryOptions) {
    if (!token) {
      throw new GitHubError("unauthorized", "読み取り用の GitHub トークンが設定されていません")
    }
    this.#token = token
    this.#revalidate = revalidateSeconds
  }

  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "User-Agent": "zukunft-web",
        },
        body: JSON.stringify({ query, variables }),
        next: { revalidate: this.#revalidate },
      } as RequestInit)
    } catch (cause) {
      throw new GitHubError("network", "GitHub に接続できませんでした", undefined)
    }

    if (response.status === 401) throw new GitHubError("unauthorized", "トークンが無効です")
    if (response.status === 403) throw new GitHubError("forbidden", "この Project を読む権限がありません")
    if (response.status === 404) throw new GitHubError("not-found", "Project が見つかりません")
    if (!response.ok) throw new GitHubError("unknown", `GitHub が ${response.status} を返しました`)

    const payload = (await response.json()) as { data?: T; errors?: { message: string; type?: string }[] }
    const first = payload.errors?.[0]
    if (first) {
      // GraphQL は HTTP 200 でエラーを返すため、ここでも分類し直す。
      const kind = first.type === "RATE_LIMITED" ? "rate-limited" : "unknown"
      throw new GitHubError(kind, first.message)
    }
    if (!payload.data) throw new GitHubError("unknown", "GitHub の応答が空でした")
    return payload.data
  }

  async listProjects(owner: string): Promise<ProjectSummary[]> {
    type Node = { id: string; number: number; title: string; url: string }
    type Page = { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
    const projects: ProjectSummary[] = []
    let after: string | null = null
    let ownerType: "organization" | "user" = "user"

    // 一覧はどの接続も最後まで辿る。途中で切ると、古い Project が
    // 「存在しない」ように見えて選べなくなる。
    do {
      const data: {
        repositoryOwner?: { __typename?: string; projectsV2?: Page } | null
      } = await this.#graphql(LIST_PROJECTS, { login: owner, after })

      const node = data.repositoryOwner
      if (!node) throw new GitHubError("not-found", `GitHub に「${owner}」が見つかりません`)

      ownerType = node.__typename === "Organization" ? "organization" : "user"
      const page = node.projectsV2
      projects.push(...(page?.nodes ?? []).map((n) => toSummary(n, ownerType, owner)))
      after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null
    } while (after !== null)

    return projects
  }

  async getProjectSchema(projectId: string): Promise<ProjectSchema> {
    const fields: ProjectSchema["fields"] = []
    let after: string | null = null
    // フィールドを読み落とすと、既にある Date / Status を「作れ」と案内してしまう。
    do {
      const data: unknown = await this.#graphql<unknown>(PROJECT_SCHEMA, { projectId, after })
      const page = mapProjectSchema(projectId, data)
      fields.push(...page.schema.fields)
      after = page.endCursor
    } while (after !== null)
    return { projectId, fields }
  }

  async getTasks(projectId: string): Promise<ScheduleTask[]> {
    const tasks: ScheduleTask[] = []
    let after: string | null = null
    // items は 100 件ずつ endCursor で辿る（企画書 §7.3.2）。
    do {
      const data: unknown = await this.#graphql<unknown>(PROJECT_ITEMS, { projectId, after })
      const page = mapTasks(data)
      tasks.push(...page.tasks)
      after = page.endCursor
    } while (after !== null)
    return tasks
  }

  async listRepositories(projectId: string): Promise<RepositorySummary[]> {
    type Page = {
      nodes?: RepositorySummary[]
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    }
    const repositories: RepositorySummary[] = []
    let after: string | null = null
    // 読み落としたリポジトリの Issue は「ラベル候補ゼロ」になり、保存すると
    // ラベルが全部外れる。ここは特に切ってはいけない。
    do {
      const data: { node?: { repositories?: Page } | null } = await this.#graphql(
        PROJECT_REPOSITORIES,
        { projectId, after },
      )
      const page = data.node?.repositories
      repositories.push(...(page?.nodes ?? []))
      after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null
    } while (after !== null)
    return repositories
  }

  async listLabels(repositoryId: string): Promise<Label[]> {
    type Page = { nodes?: Label[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
    const labels: Label[] = []
    let after: string | null = null
    // 読み落とすと、既にある名前での作成が失敗して理由が読めなくなる。
    do {
      const data: { node?: { labels?: Page } | null } = await this.#graphql(REPOSITORY_LABELS, {
        repositoryId,
        after,
      })
      const page = data.node?.labels
      labels.push(...(page?.nodes ?? []))
      after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null
    } while (after !== null)
    return labels
  }

  async listAssignableUsers(repositoryId: string): Promise<Assignee[]> {
    type Page = {
      nodes?: Assignee[]
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    }
    const users: Assignee[] = []
    let after: string | null = null
    // 読み落とすと、実際には割り当てられる人が候補に出ない。
    do {
      const data: { node?: { assignableUsers?: Page } | null } = await this.#graphql(
        ASSIGNABLE_USERS,
        { repositoryId, after },
      )
      const page = data.node?.assignableUsers
      users.push(...(page?.nodes ?? []))
      after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null
    } while (after !== null)
    return users
  }

  async listMilestones(repositoryId: string): Promise<Milestone[]> {
    const milestones: Milestone[] = []
    let after: string | null = null
    do {
      const data: unknown = await this.#graphql<unknown>(REPOSITORY_MILESTONES, {
        repositoryId,
        after,
      })
      const page = mapMilestones(data)
      milestones.push(...page.milestones)
      after = page.endCursor
    } while (after !== null)
    return milestones
  }

  /** 読み取り専用ビューは親子関係を出さない。無いものとして扱う。 */
  getParentIssue(): Promise<null> {
    return Promise.resolve(null)
  }

  setParentIssue(): Promise<never> {
    return Promise.reject(
      new GitHubError("unsupported", "読み取り専用ビューでは変更できません"),
    )
  }

  updateTaskStatus(
    _projectId: string,
    _taskId: string,
    _optionId: string,
  ): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Status の変更はデスクトップアプリから行ってください"),
    )
  }

  updateTaskPriority(
    _projectId: string,
    _taskId: string,
    _optionId: string | null,
  ): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Priority の変更はデスクトップアプリから行ってください"),
    )
  }

  updateTaskProgress(
    _projectId: string,
    _taskId: string,
    _value: number | null,
  ): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Progress の変更はデスクトップアプリから行ってください"),
    )
  }

  createMilestone(_nameWithOwner: string, _input: NewMilestoneInput): Promise<Milestone> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。マイルストーンの作成はデスクトップアプリから行ってください"),
    )
  }

  createLabel(_repositoryId: string, _name: string, _color: string): Promise<Label> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。ラベルの作成はデスクトップアプリから行ってください"),
    )
  }

  deleteLabel(_labelId: string): Promise<void> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。ラベルの削除はデスクトップアプリから行ってください"),
    )
  }

  updateTaskContent(
    _taskId: string,
    _issueId: string,
    _content: TaskContent,
  ): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Issue の編集はデスクトップアプリから行ってください"),
    )
  }

  setTaskState(
    _taskId: string,
    _issueId: string,
    _state: IssueState,
  ): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Issue の開閉はデスクトップアプリから行ってください"),
    )
  }

  deleteTask(_issueId: string): Promise<void> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Issue の削除はデスクトップアプリから行ってください"),
    )
  }

  createTask(_projectId: string, _input: NewTaskInput): Promise<ScheduleTask> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。Issue の作成はデスクトップアプリから行ってください"),
    )
  }

  updateTaskDates(
    _projectId: string,
    _taskId: string,
    _change: DateChange,
    _expectedUpdatedAt: string,
  ): Promise<ScheduleTask> {
    // 企画書 §4.2 の原則：Web 側に書き込み権限を持たせない。
    // 呼ばれた時点で設計違反なので、黙って無視せず明示的に失敗させる。
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。変更はデスクトップアプリから行ってください"),
    )
  }
}

function toSummary(
  node: { id: string; number: number; title: string; url: string },
  ownerType: "organization" | "user",
  ownerLogin: string,
): ProjectSummary {
  return { ...node, ownerType, ownerLogin }
}
