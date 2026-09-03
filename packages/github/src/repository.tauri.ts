import { invoke } from "@tauri-apps/api/core"
import type {
  Assignee,
  ParentIssue,
  DateChange,
  IssueState,
  Label,
  Milestone,
  NewTaskInput,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"
import {
  GitHubError,
  type GitHubErrorKind,
  type GitHubScheduleRepository,
} from "./repository"

/**
 * デスクトップ実装（企画書 §4.3.3）。
 *
 * GitHub API を直接叩かず、すべて Tauri command に委譲する。
 * これにより WebView 側に Token が渡らず、CORS の制約も受けない。
 */

/** Rust 側が返すエラーの形。`AppError` の serde 表現に対応する。 */
type RustError = { kind?: string; message?: string; remote?: ScheduleTask }

const ERROR_KINDS: GitHubErrorKind[] = [
  "unauthorized", "forbidden", "not-found", "field-missing",
  "rate-limited", "network", "conflict", "unsupported", "unknown",
]

function toGitHubError(error: unknown): GitHubError {
  if (error instanceof GitHubError) return error
  const raw = (typeof error === "object" && error !== null ? error : {}) as RustError
  const kind = ERROR_KINDS.includes(raw.kind as GitHubErrorKind)
    ? (raw.kind as GitHubErrorKind)
    : "unknown"
  const message = raw.message ?? (typeof error === "string" ? error : "GitHub 呼び出しに失敗しました")
  return new GitHubError(kind, message, raw.remote)
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toGitHubError(error)
  }
}

export class TauriScheduleRepository implements GitHubScheduleRepository {
  listProjects(owner: string): Promise<ProjectSummary[]> {
    return call<ProjectSummary[]>("list_projects", { login: owner })
  }

  getProjectSchema(projectId: string): Promise<ProjectSchema> {
    return call<ProjectSchema>("get_project_schema", { projectId })
  }

  getTasks(projectId: string): Promise<ScheduleTask[]> {
    return call<ScheduleTask[]>("get_tasks", { projectId })
  }

  updateTaskDates(
    projectId: string,
    taskId: string,
    change: DateChange,
    expectedUpdatedAt: string,
  ): Promise<ScheduleTask> {
    return call<ScheduleTask>("update_task_dates", {
      projectId,
      taskId,
      change,
      expectedUpdatedAt,
    })
  }

  getParentIssue(issueId: string): Promise<ParentIssue | null> {
    return call<ParentIssue | null>("get_parent_issue", { issueId })
  }

  setParentIssue(issueId: string, parentIssueId: string | null): Promise<void> {
    return call<void>("set_parent_issue", { issueId, parentIssueId })
  }

  updateTaskContent(
    taskId: string,
    issueId: string,
    content: TaskContent,
  ): Promise<ScheduleTask> {
    return call<ScheduleTask>("update_task_content", { taskId, issueId, content })
  }

  updateTaskStatus(projectId: string, taskId: string, optionId: string): Promise<ScheduleTask> {
    return call<ScheduleTask>("update_task_status", { projectId, taskId, optionId })
  }

  updateTaskPriority(
    projectId: string,
    taskId: string,
    optionId: string | null,
  ): Promise<ScheduleTask> {
    return call<ScheduleTask>("update_task_priority", { projectId, taskId, optionId })
  }

  updateTaskProgress(
    projectId: string,
    taskId: string,
    value: number | null,
  ): Promise<ScheduleTask> {
    return call<ScheduleTask>("update_task_progress", { projectId, taskId, value })
  }

  setTaskState(taskId: string, issueId: string, state: IssueState): Promise<ScheduleTask> {
    return call<ScheduleTask>("set_task_state", { taskId, issueId, issueState: state })
  }

  deleteTask(issueId: string): Promise<void> {
    return call<void>("delete_task", { issueId })
  }

  listLabels(repositoryId: string): Promise<Label[]> {
    return call<Label[]>("list_labels", { repositoryId })
  }

  listAssignableUsers(repositoryId: string): Promise<Assignee[]> {
    return call<Assignee[]>("list_assignable_users", { repositoryId })
  }

  listMilestones(repositoryId: string): Promise<Milestone[]> {
    return call<Milestone[]>("list_milestones", { repositoryId })
  }

  createLabel(repositoryId: string, name: string, color: string): Promise<Label> {
    return call<Label>("create_label", { repositoryId, name, color })
  }

  deleteLabel(labelId: string): Promise<void> {
    return call<void>("delete_label", { labelId })
  }

  listRepositories(projectId: string): Promise<RepositorySummary[]> {
    return call<RepositorySummary[]>("list_repositories", { projectId })
  }

  createTask(projectId: string, input: NewTaskInput): Promise<ScheduleTask> {
    return call<ScheduleTask>("create_task", { projectId, input })
  }
}

/* ---- 認証（企画書 §11：OAuth Device Flow） ---- */

export type AuthStatus = {
  signedIn: boolean
  login: string | null
  /** トークンの入手元。"env" は環境変数、"stored" は OS の資格情報ストア。 */
  source: "env" | "stored" | "none"
}

export type DeviceCode = {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  expiresIn: number
}

export const auth = {
  status: () => call<AuthStatus>("auth_status", {}),
  /** Device Flow を開始し、ユーザーに見せるコードと URL を得る。 */
  startDeviceFlow: () => call<DeviceCode>("auth_start_device_flow", {}),
  /**
   * 認可待ちをポーリングする。まだ承認されていない間は
   * kind: "unauthorized" のエラーを投げるので、interval 秒ごとに呼び直す。
   */
  pollDeviceFlow: (deviceCode: string) =>
    call<AuthStatus>("auth_poll_device_flow", { deviceCode }),
  /** プロトタイプ用の PAT 直接入力（企画書 §11）。 */
  signInWithToken: (token: string) => call<AuthStatus>("auth_sign_in_with_token", { token }),
  signOut: () => call<void>("auth_sign_out", {}),
  /**
   * 承認 URL を OS の既定ブラウザで開く。
   * WebView 内のリンクでは外部ブラウザが開かないため、Rust 側に委譲する。
   */
  openExternal: (url: string) => call<void>("open_external", { url }),
}

/** 未送信の変更をローカルに保持しているかの確認（企画書 §16 / §25）。 */
export const cache = {
  clear: (projectId: string) => call<void>("cache_clear", { projectId }),
  pendingCount: () => call<number>("cache_pending_count", {}),
}
