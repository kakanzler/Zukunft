import type { ISODate } from "./date"

/**
 * タスクとローカル状態 / GitHub の一致状況（企画書 §16.1）。
 *
 * - synced   : GitHub と一致している
 * - pending  : ローカルには反映済み。まだ送信していない
 * - syncing  : 送信中
 * - failed   : 送信に失敗した。リトライまたはロールバック待ち
 * - conflict : 送信前に GitHub 側の値が変わっていた
 */
export type SyncState = "synced" | "pending" | "syncing" | "failed" | "conflict"

export type Assignee = {
  login: string
  avatarUrl: string
}

/** Issue のラベル。Category 表示のグループになる。 */
export type Label = {
  /** ラベルの node id。Issue への付け外しに使う */
  id: string
  name: string
  /** GitHub が返す 6 桁の 16 進。先頭に # は付かない */
  color: string
}

export type Milestone = {
  title: string
  dueOn: ISODate | null
}

/**
 * Gantt の 1 行に対応するタスク（企画書 §7.1）。
 * Projects v2 の item と、それが指す Issue を統合したもの。
 */
export type ScheduleTask = {
  /** Projects v2 の item id。日付フィールドの書き込み先を指す */
  id: string
  /** Issue 本体の node id。タイトル・本文の書き換え先 */
  issueId: string
  /** Issue が属するリポジトリの node id。ラベルの一覧・作成に使う */
  repositoryId: string
  issueNumber: number
  title: string
  /** Issue の本文。空文字は「本文なし」を表す */
  body: string
  url: string
  startDate: ISODate | null
  endDate: ISODate | null
  status: string | null
  priority: string | null
  assignees: Assignee[]
  labels: Label[]
  milestone: Milestone | null
  /** 0-100。未設定なら null */
  progress: number | null
  /** 競合検出に使う Issue の updatedAt（ISO 8601 日時） */
  updatedAt: string
  syncState: SyncState
}

/** Gantt に描画できる（開始日と終了日が揃っている）タスク。 */
export type ScheduledTask = ScheduleTask & {
  startDate: ISODate
  endDate: ISODate
}

export function isScheduled(task: ScheduleTask): task is ScheduledTask {
  return task.startDate !== null && task.endDate !== null
}

/** 日付の変更内容。両方 undefined の変更は発行しない。 */
export type DateChange = {
  startDate?: ISODate
  endDate?: ISODate
}

/** Issue の作成先候補（Project にリンクされたリポジトリ）。 */
export type RepositorySummary = {
  id: string
  nameWithOwner: string
}

/** Issue 本体（タイトル・本文）の編集内容。 */
export type TaskContent = {
  title: string
  body: string
  /** 付け替え後のラベル。指定した集合で置き換える */
  labelIds: string[]
}

/** アプリから新しい Issue を起票するときの入力。 */
export type NewTaskInput = {
  repositoryId: string
  title: string
  body?: string
  startDate?: ISODate
  endDate?: ISODate
}

export type ProjectSummary = {
  id: string
  number: number
  title: string
  url: string
  /** "organization" | "user" — 再取得時のクエリ切り替えに使う */
  ownerType: "organization" | "user"
  ownerLogin: string
}

export type FieldDataType =
  | "DATE"
  | "SINGLE_SELECT"
  | "NUMBER"
  | "TEXT"
  | "ITERATION"
  | "UNKNOWN"

export type FieldDefinition = {
  id: string
  name: string
  dataType: FieldDataType
  /** SINGLE_SELECT のときのみ。並び順は GitHub 上の定義順 */
  options: { id: string; name: string }[]
}

/**
 * Project のフィールド定義表（企画書 §7.3.2）。
 * ミューテーションには fieldId が必要だが、アプリが知っているのは名前なので、
 * Project を開いた時点で名前 → 定義の対応表を作りキャッシュする。
 */
export type ProjectSchema = {
  projectId: string
  fields: FieldDefinition[]
}

/** 企画書 §5.2 が必須とするフィールド名。 */
export const REQUIRED_FIELDS = {
  status: "Status",
  startDate: "Start Date",
  endDate: "Target Date",
} as const

export const OPTIONAL_FIELDS = {
  priority: "Priority",
  progress: "Progress",
} as const

/**
 * フィールド名の正規化。大文字小文字・空白・記号の違いを吸収する。
 *
 * GitHub 上では "Start date" のように書かれることが多く、完全一致で照合すると
 * 「作ったのに認識されない」が起きる。Rust 側（github.rs）にも同じ規則がある。
 */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** 役割ごとに受け付けるフィールド名。先頭が推奨名。 */
export const FIELD_ALIASES = {
  status: ["status", "state"],
  startDate: ["startdate", "start", "begin", "startson"],
  endDate: ["targetdate", "enddate", "duedate", "target", "end", "due", "endson"],
  priority: ["priority"],
  progress: ["progress", "percentcomplete", "percent"],
} as const

export type FieldRole = keyof typeof FIELD_ALIASES

/** 完全一致での検索。表記ゆれを許すなら resolveField を使う。 */
export function findField(schema: ProjectSchema, name: string): FieldDefinition | undefined {
  return schema.fields.find((f) => f.name === name)
}

/**
 * 役割からフィールドを引く。表記ゆれを許し、型が合うものを優先する。
 * 別名が複数該当した場合は、別名リストの順序（推奨名が先）で決める。
 */
export function resolveField(
  schema: ProjectSchema,
  role: FieldRole,
  expectedType?: FieldDataType,
): FieldDefinition | undefined {
  const aliases = FIELD_ALIASES[role] as readonly string[]
  const candidates = schema.fields
    .map((field) => ({ field, rank: aliases.indexOf(normalizeFieldName(field.name)) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank)

  if (expectedType) {
    const typed = candidates.find((c) => c.field.dataType === expectedType)
    if (typed) return typed.field
    // 型が合うものが無ければ、名前だけ一致したものを返す。
    // 「あるが型が違う」ことを呼び出し側が診断できるようにするため。
  }
  return candidates[0]?.field
}

export type MissingField = {
  name: string
  expectedType: FieldDataType
}

/**
 * 必須フィールドの不足を返す（企画書 §7.3.4）。
 * 空でない場合、Gantt を描画せずセットアップ画面を表示する。
 */
export function missingRequiredFields(schema: ProjectSchema): MissingField[] {
  const expected: (MissingField & { role: FieldRole })[] = [
    { role: "status", name: REQUIRED_FIELDS.status, expectedType: "SINGLE_SELECT" },
    { role: "startDate", name: REQUIRED_FIELDS.startDate, expectedType: "DATE" },
    { role: "endDate", name: REQUIRED_FIELDS.endDate, expectedType: "DATE" },
  ]
  return expected
    .filter((want) => resolveField(schema, want.role, want.expectedType)?.dataType !== want.expectedType)
    .map(({ name, expectedType }) => ({ name, expectedType }))
}

/**
 * 日付を書き込めるかどうか。
 *
 * Start Date / Target Date が無い Project では、ドラッグしても書き込む先が無い。
 * 表示はできるので Gantt 自体は出し、編集だけを閉じるために使う。
 */
export function canEditDates(schema: ProjectSchema | null): boolean {
  if (!schema) return false
  const hasDate = (role: FieldRole) => resolveField(schema, role, "DATE")?.dataType === "DATE"
  return hasDate("startDate") && hasDate("endDate")
}

/** 未設定でも表示は続けられる（任意）フィールドかどうか。 */
export function isBlockingField(name: string): boolean {
  return name === REQUIRED_FIELDS.startDate || name === REQUIRED_FIELDS.endDate
}
