import type {
  DateChange,
  Label,
  Milestone,
  NewTaskInput,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"
import { mapMilestones, mapProjectSchema, mapTasks } from "./mapping"
import {
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
    const data = await this.#graphql<{
      repositoryOwner?: {
        __typename?: string
        projectsV2?: { nodes?: Node[] }
      } | null
    }>(LIST_PROJECTS, { login: owner })

    const node = data.repositoryOwner
    if (!node) throw new GitHubError("not-found", `GitHub に「${owner}」が見つかりません`)

    const ownerType = node.__typename === "Organization" ? "organization" : "user"
    return (node.projectsV2?.nodes ?? []).map((n) => toSummary(n, ownerType, owner))
  }

  async getProjectSchema(projectId: string): Promise<ProjectSchema> {
    const data = await this.#graphql<unknown>(PROJECT_SCHEMA, { projectId })
    return mapProjectSchema(projectId, data)
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
    const data = await this.#graphql<{
      node?: { repositories?: { nodes?: RepositorySummary[] } } | null
    }>(PROJECT_REPOSITORIES, { projectId })
    return data.node?.repositories?.nodes ?? []
  }

  async listLabels(repositoryId: string): Promise<Label[]> {
    const data = await this.#graphql<{ node?: { labels?: { nodes?: Label[] } } | null }>(
      REPOSITORY_LABELS,
      { repositoryId },
    )
    return data.node?.labels?.nodes ?? []
  }

  async listMilestones(repositoryId: string): Promise<Milestone[]> {
    const data = await this.#graphql<unknown>(REPOSITORY_MILESTONES, { repositoryId })
    return mapMilestones(data)
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

  createLabel(_repositoryId: string, _name: string, _color: string): Promise<Label> {
    return Promise.reject(
      new GitHubError("unsupported", "Web 版は読み取り専用です。ラベルの作成はデスクトップアプリから行ってください"),
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
