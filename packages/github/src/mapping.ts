import {
  type Assignee,
  type FieldDataType,
  type FieldDefinition,
  type FieldRole,
  type ISODate,
  type IssueState,
  type Label,
  type Milestone,
  type ProjectSchema,
  type ScheduleTask,
  FIELD_ALIASES,
  REQUIRED_FIELDS,
  isISODate,
  normalizeFieldName,
  resolveField,
} from "@zukunft/domain"

/**
 * GraphQL 応答を Domain Model に変換する（企画書 §7.1）。
 * 応答を UI へ素通しせず、ここで形を固定する。
 */

type RawFieldValue = {
  __typename?: string
  date?: string | null
  name?: string | null
  number?: number | null
  text?: string | null
  field?: { name?: string | null } | null
}

/** 接続のページ情報。読み切れたかどうかの判定にだけ使う。 */
type RawPageInfo = { hasNextPage?: boolean | null; endCursor?: string | null } | null | undefined

type RawItem = {
  id: string
  fieldValues?: { nodes?: (RawFieldValue | null)[] | null; pageInfo?: RawPageInfo } | null
  content?: {
    __typename?: string
    id?: string
    number?: number
    title?: string
    body?: string
    url?: string
    state?: string
    updatedAt?: string
    assignees?: {
      nodes?: ({ id: string; login: string; avatarUrl: string } | null)[] | null
      pageInfo?: RawPageInfo
    } | null
    labels?: {
      nodes?: ({ id: string; name: string; color: string } | null)[] | null
      pageInfo?: RawPageInfo
    } | null
    repository?: { id?: string } | null
    milestone?: { id?: string; title: string; dueOn: string | null } | null
  } | null
}

const KNOWN_TYPES: FieldDataType[] = [
  "DATE", "SINGLE_SELECT", "NUMBER", "TEXT", "ITERATION",
]

/**
 * 次のページの起点。読み切っていれば null を返す。
 *
 * pageInfo が無い応答は「1 ページで終わり」として扱う。取り切れていないのに
 * 取り切ったことにするより、余計に 1 往復する方が安全ではあるが、pageInfo を
 * 選択していないクエリは元々 1 ページしか要らないもの。
 */
function nextCursor(page: RawPageInfo): string | null {
  return page?.hasNextPage ? (page.endCursor ?? null) : null
}

/** その接続を読み切れたか。pageInfo が無ければ読み切った扱い。 */
function isComplete(page: RawPageInfo): boolean {
  return !page?.hasNextPage
}

function toFieldDataType(value: unknown): FieldDataType {
  return typeof value === "string" && (KNOWN_TYPES as string[]).includes(value)
    ? (value as FieldDataType)
    : "UNKNOWN"
}

/**
 * Project のフィールド定義を 1 ページぶん読む。
 *
 * mapTasks と同じく endCursor を返す形にしてある。フィールドが多い Project で
 * Date / Status の定義を読み落とすと、既にあるフィールドを「作れ」と案内して
 * しまうため、呼び出し側は必ず最後まで辿ること。
 */
export function mapProjectSchema(
  projectId: string,
  raw: unknown,
): { schema: ProjectSchema; endCursor: string | null } {
  const node = (raw as {
    node?: { fields?: { nodes?: unknown[]; pageInfo?: RawPageInfo } }
  })?.node
  const nodes = node?.fields?.nodes ?? []
  const fields: FieldDefinition[] = []
  for (const entry of nodes) {
    const f = entry as { id?: string; name?: string; dataType?: string; options?: { id: string; name: string }[] }
    if (!f?.id || !f.name) continue
    fields.push({
      id: f.id,
      name: f.name,
      dataType: toFieldDataType(f.dataType),
      options: f.options ?? [],
    })
  }
  return { schema: { projectId, fields }, endCursor: nextCursor(node?.fields?.pageInfo) }
}

function readDate(value: string | null | undefined): ISODate | null {
  if (!value) return null
  const date = value.slice(0, 10)
  return isISODate(date) ? date : null
}

/**
 * item の fieldValues を名前で引ける形に畳む。
 * Projects v2 は「値が設定されているフィールドだけ」を返すため、
 * 未設定は単に欠落する。
 */
function indexFieldValues(item: RawItem): Map<string, RawFieldValue> {
  // 名前は正規化して入れる。GitHub 上の表記ゆれ（"Start date" など）でも
  // 同じ役割として引けるようにするため。
  const byName = new Map<string, RawFieldValue>()
  for (const value of item.fieldValues?.nodes ?? []) {
    const name = value?.field?.name
    if (value && name) byName.set(normalizeFieldName(name), value)
  }
  return byName
}

/** 役割に対応する値を、別名の優先順で引く。 */
function valueOf(
  values: Map<string, RawFieldValue>,
  role: FieldRole,
): RawFieldValue | undefined {
  for (const alias of FIELD_ALIASES[role]) {
    const found = values.get(alias)
    if (found) return found
  }
  return undefined
}

/**
 * Issue の開閉状態。GitHub は "OPEN" / "CLOSED" を返すが、選択に入っていない
 * 応答（古いキャッシュなど）では欠けるため、開いている扱いに寄せる。
 * 閉じたものを開いていると誤るより、開いたものを閉じていると誤るほうが害が大きい。
 */
function readIssueState(value: string | null | undefined): IssueState {
  return value?.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN"
}

/** Issue を指さない item（Draft issue や PR）は Gantt の対象外なので null を返す。 */
export function mapTask(item: RawItem): ScheduleTask | null {
  const content = item.content
  if (!content || content.__typename !== "Issue") return null
  if (typeof content.number !== "number") return null

  const values = indexFieldValues(item)
  const assignees: Assignee[] = (content.assignees?.nodes ?? [])
    .filter((a): a is Assignee => Boolean(a?.login))
    .map((a) => ({ id: a.id ?? "", login: a.login, avatarUrl: a.avatarUrl ?? "" }))

  const labels: Label[] = (content.labels?.nodes ?? [])
    .filter((l): l is Label => Boolean(l?.name))
    .map((l) => ({ id: l.id ?? "", name: l.name, color: l.color ?? "" }))

  const progressRaw = valueOf(values, "progress")?.number
  const milestone = content.milestone

  return {
    id: item.id,
    issueId: content.id ?? "",
    repositoryId: content.repository?.id ?? "",
    issueNumber: content.number,
    title: content.title ?? `#${content.number}`,
    body: content.body ?? "",
    url: content.url ?? "",
    issueState: readIssueState(content.state),
    startDate: readDate(valueOf(values, "startDate")?.date),
    endDate: readDate(valueOf(values, "endDate")?.date),
    status: valueOf(values, "status")?.name ?? null,
    priority: valueOf(values, "priority")?.name ?? null,
    assignees,
    labels,
    milestone: milestone
      ? { id: milestone.id ?? "", title: milestone.title, dueOn: readDate(milestone.dueOn) }
      : null,
    progress: typeof progressRaw === "number" ? progressRaw : null,
    updatedAt: content.updatedAt ?? "",
    syncState: "synced",
    labelsComplete: isComplete(content.labels?.pageInfo),
    assigneesComplete: isComplete(content.assignees?.pageInfo),
    fieldsComplete: isComplete(item.fieldValues?.pageInfo),
  }
}

export function mapTasks(raw: unknown): { tasks: ScheduleTask[]; endCursor: string | null } {
  const items = (raw as {
    node?: { items?: { nodes?: RawItem[]; pageInfo?: RawPageInfo } }
  })?.node?.items
  const tasks: ScheduleTask[] = []
  for (const item of items?.nodes ?? []) {
    const task = mapTask(item)
    if (task) tasks.push(task)
  }
  return { tasks, endCursor: nextCursor(items?.pageInfo) }
}

/**
 * RepositoryMilestones の応答を Milestone[] に変換する。
 * id と title が無いものは Issue に設定できないので落とす。
 */
export function mapMilestones(
  raw: unknown,
): { milestones: Milestone[]; endCursor: string | null } {
  const page = (raw as {
    node?: {
      milestones?: {
        nodes?: ({ id?: string; title?: string; dueOn?: string | null } | null)[] | null
        pageInfo?: RawPageInfo
      } | null
    } | null
  })?.node?.milestones
  const milestones: Milestone[] = []
  for (const node of page?.nodes ?? []) {
    if (!node?.id || !node.title) continue
    milestones.push({ id: node.id, title: node.title, dueOn: readDate(node.dueOn) })
  }
  return { milestones, endCursor: nextCursor(page?.pageInfo) }
}

/** Status の選択肢を定義順に返す。色割り当てとグループ順序に使う（企画書 §6.4.1）。 */
export function statusOrder(schema: ProjectSchema): string[] {
  const field = resolveField(schema, "status", "SINGLE_SELECT")
  return field?.options.map((o) => o.name) ?? []
}
