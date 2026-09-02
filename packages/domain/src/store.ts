import { cascade } from "./cascade"
import type { ISODate } from "./date"
import type { DateChange, ScheduleTask, SyncState } from "./schedule"

/**
 * 楽観的更新・ミューテーションキュー・Undo/Redo（企画書 §16.2 / §6.3.4）。
 *
 * すべて純粋関数として書く。React にも Tauri にも依存しないので、
 * デスクトップと（将来）Web の双方から同じ規則で使える。
 */

/**
 * ロールバック先として保持する日付の組。
 *
 * 日付が未設定の Issue にも日程を入れられる必要があるため、null を許す。
 * ここを非 null にしていたせいで、未設定のタスクへの変更が黙って捨てられていた。
 */
export type Dates = { startDate: ISODate | null; endDate: ISODate | null }

export type MutationState = "pending" | "syncing" | "failed" | "conflict"

export type Mutation = {
  id: string
  taskId: string
  change: DateChange
  /** ロールバック用に、送信前の値を保持する（企画書 §16.2 手順 2） */
  before: Dates
  after: Dates
  /** 競合検出に使う、読み取り時点の updatedAt */
  expectedUpdatedAt: string
  attempts: number
  state: MutationState
  error: string | null
  /** 競合時に GitHub 側の現在値を載せる */
  remote: ScheduleTask | null
}

/** グループの中の 1 タスク分。 */
export type UndoItem = {
  taskId: string
  before: Dates
  after: Dates
}

/**
 * Undo/Redo の 1 エントリ = 利用者の操作 1 回（企画書 §6.3.4）。
 *
 * 依存関係に合わせた自動調整（§15.2）は 1 ドラッグで複数のタスクを動かすので、
 * エントリは 1 タスクではなくグループを持つ。Ctrl+Z 1 回で操作 1 回分が戻る。
 */
export type UndoEntry = {
  /** グループの識別子。起点のミューテーション id を使う */
  id: string
  items: UndoItem[]
}

export type ScheduleState = {
  tasks: ScheduleTask[]
  queue: Mutation[]
  undo: UndoEntry[]
  redo: UndoEntry[]
}

export function initialState(tasks: ScheduleTask[] = []): ScheduleState {
  return { tasks, queue: [], undo: [], redo: [] }
}

function replaceTask(
  tasks: ScheduleTask[],
  taskId: string,
  update: (task: ScheduleTask) => ScheduleTask,
): ScheduleTask[] {
  return tasks.map((t) => (t.id === taskId ? update(t) : t))
}

export function findTask(state: ScheduleState, taskId: string): ScheduleTask | undefined {
  return state.tasks.find((t) => t.id === taskId)
}

function datesOf(task: ScheduleTask): Dates {
  return { startDate: task.startDate, endDate: task.endDate }
}

/**
 * Dates を DateChange に変換する。
 * どちらかが null なら「戻せない」ことを表す null を返す。
 * 日付の削除（clear）は未対応のため、Undo の対象から外すのに使う。
 */
function toChange(dates: Dates): DateChange | null {
  if (dates.startDate === null || dates.endDate === null) return null
  return { startDate: dates.startDate, endDate: dates.endDate }
}

function applied(before: Dates, change: DateChange): Dates {
  return {
    startDate: change.startDate ?? before.startDate,
    endDate: change.endDate ?? before.endDate,
  }
}

/**
 * ドラッグ確定時の処理（企画書 §16.2 手順 1-2）。
 * ローカルを即座に更新し、送信待ちのミューテーションを積む。
 */
export function applyLocalChange(
  state: ScheduleState,
  taskId: string,
  change: DateChange,
  mutationId: string,
  options: { recordUndo?: boolean; undoGroupId?: string } = {},
): ScheduleState {
  const task = findTask(state, taskId)
  if (!task) return state
  const before = datesOf(task)
  const after = applied(before, change)

  // 同じタスクに未送信（pending）の変更が残っていれば畳み込む。
  // 別々に送ると往復が無駄になるうえ、後発の expectedUpdatedAt が
  // 前の変更を織り込んでいない古い値になり、偽の競合を招く。
  const superseded = state.queue.find((m) => m.taskId === taskId && m.state === "pending")

  const mutation: Mutation = {
    id: mutationId,
    taskId,
    change: superseded ? diffFrom(superseded.before, after) : change,
    // ロールバック先と競合判定の基準は、最初の変更前のものを引き継ぐ
    before: superseded?.before ?? before,
    after,
    expectedUpdatedAt: superseded?.expectedUpdatedAt ?? task.updatedAt,
    attempts: 0,
    state: "pending",
    error: null,
    remote: null,
  }

  return {
    tasks: replaceTask(state.tasks, taskId, (t) => ({ ...t, ...after, syncState: "pending" })),
    queue: [...state.queue.filter((m) => m.id !== superseded?.id), mutation],
    // 変更前が未設定（null を含む）の操作は Undo に積まない。
    // 日付を消すミューテーションを持たないため、元の「未設定」へは戻せない。
    undo:
      options.recordUndo === false || toChange(before) === null
        ? state.undo
        : recordUndo(state.undo, { taskId, before, after }, options.undoGroupId ?? mutationId),
    // 新しい操作をした時点で redo は捨てる
    redo: options.recordUndo === false ? state.redo : [],
  }
}

/**
 * Undo スタックに 1 件積む。同じグループなら末尾のエントリへ追記する。
 *
 * 末尾の **id が一致するときだけ**追記するのが要点。「末尾に足す」だけにすると、
 * カスケードの起点が Undo に積まれなかったとき（日付未設定だった等）に、
 * 押し出された分が 1 つ前の無関係な操作にくっつき、Ctrl+Z 1 回で 2 操作
 * 戻ってしまう。まとめてよいのは、同じ状態遷移の中で続けて呼ばれた分だけ。
 */
function recordUndo(undo: UndoEntry[], item: UndoItem, groupId: string): UndoEntry[] {
  const tail = undo[undo.length - 1]
  if (tail && tail.id === groupId) {
    return [...undo.slice(0, -1), { ...tail, items: [...tail.items, item] }]
  }
  return [...undo, { id: groupId, items: [item] }]
}

/**
 * ドラッグ確定 1 回分（企画書 §16.2 / §15.2）。
 *
 * 動かしたタスクと、それが押し出したタスクを 1 つの Undo エントリにまとめる。
 * 押し出された側もそれぞれ独立したミューテーションになるので、送信の直列化や
 * 競合の検出は今までどおり 1 タスクずつ効く。
 *
 * id をいくつ使うか呼ぶ前には決まらないため、id そのものではなく生成関数を取る。
 */
export function applyChangeWithCascade(
  state: ScheduleState,
  taskId: string,
  change: DateChange,
  nextMutationId: () => string,
  options: { autoReschedule?: boolean } = {},
): ScheduleState {
  const groupId = nextMutationId()
  const applied = applyLocalChange(state, taskId, change, groupId, { undoGroupId: groupId })
  if (options.autoReschedule === false || applied === state) return applied

  return cascade(applied.tasks, taskId).reduce(
    (acc, edit) =>
      applyLocalChange(
        acc,
        edit.taskId,
        { startDate: edit.startDate, endDate: edit.endDate },
        nextMutationId(),
        { undoGroupId: groupId },
      ),
    applied,
  )
}

function diffFrom(before: Dates, after: Dates): DateChange {
  // after 側の null は「変更なし」として扱う。日付を消す操作は持たないため、
  // 差分に null を載せても送信先が無い。
  const change: DateChange = {}
  if (after.startDate !== null && before.startDate !== after.startDate) {
    change.startDate = after.startDate
  }
  if (after.endDate !== null && before.endDate !== after.endDate) {
    change.endDate = after.endDate
  }
  return change
}

function setMutation(
  state: ScheduleState,
  mutationId: string,
  update: (m: Mutation) => Mutation,
): Mutation | null {
  const found = state.queue.find((m) => m.id === mutationId)
  return found ? update(found) : null
}

function withMutation(state: ScheduleState, mutation: Mutation, syncState: SyncState): ScheduleState {
  return {
    ...state,
    queue: state.queue.map((m) => (m.id === mutation.id ? mutation : m)),
    tasks: replaceTask(state.tasks, mutation.taskId, (t) => ({ ...t, syncState })),
  }
}

export function markSyncing(state: ScheduleState, mutationId: string): ScheduleState {
  const mutation = setMutation(state, mutationId, (m) => ({
    ...m,
    state: "syncing",
    attempts: m.attempts + 1,
    error: null,
  }))
  return mutation ? withMutation(state, mutation, "syncing") : state
}

/** 送信成功（企画書 §16.2 手順 3）。GitHub が返した値でローカルを上書きする。 */
export function markSynced(
  state: ScheduleState,
  mutationId: string,
  remote: ScheduleTask,
): ScheduleState {
  const mutation = state.queue.find((m) => m.id === mutationId)
  if (!mutation) return state
  return {
    ...state,
    queue: state.queue.filter((m) => m.id !== mutationId),
    tasks: replaceTask(state.tasks, mutation.taskId, () => ({ ...remote, syncState: "synced" })),
  }
}

export function markFailed(state: ScheduleState, mutationId: string, error: string): ScheduleState {
  const mutation = setMutation(state, mutationId, (m) => ({ ...m, state: "failed", error }))
  return mutation ? withMutation(state, mutation, "failed") : state
}

export function markConflict(
  state: ScheduleState,
  mutationId: string,
  remote: ScheduleTask,
  error: string,
): ScheduleState {
  const mutation = setMutation(state, mutationId, (m) => ({
    ...m,
    state: "conflict",
    error,
    remote,
  }))
  return mutation ? withMutation(state, mutation, "conflict") : state
}

/**
 * ロールバック（企画書 §16.2 手順 4）。
 * 保存しておいた変更前の値へ戻し、キューからも取り除く。
 * Undo スタックからも消す — 失敗した操作を Undo で復活させないため（§6.3.4）。
 *
 * 失敗したタスクを含むエントリは、**グループごと**捨てる。一部だけ残すと、
 * 押し出された側だけが元に戻り、依存先より前に始まる日程 — 利用者が一度も
 * 見ていない状態 — を Undo で作れてしまう。
 */
export function rollback(state: ScheduleState, mutationId: string): ScheduleState {
  const mutation = state.queue.find((m) => m.id === mutationId)
  if (!mutation) return state
  return {
    ...state,
    queue: state.queue.filter((m) => m.id !== mutationId),
    tasks: replaceTask(state.tasks, mutation.taskId, (t) => ({
      ...t,
      ...mutation.before,
      syncState: "synced",
    })),
    undo: dropUndoGroup(state.undo, mutation.taskId, mutation.after),
  }
}

/**
 * 失敗した変更を含むエントリを 1 つだけ落とす。
 *
 * 末尾から探すのは、失敗が届くまでに別の編集が入りうるうえ、同じ
 * (taskId, after) の組を持つエントリが正当に 2 つ存在しうるため。
 * 直近のものが、その失敗したミューテーションの属するエントリ。
 */
function dropUndoGroup(undo: UndoEntry[], taskId: string, after: Dates): UndoEntry[] {
  for (let i = undo.length - 1; i >= 0; i--) {
    const hit = undo[i]!.items.some(
      (item) => item.taskId === taskId && sameDates(item.after, after),
    )
    if (hit) return [...undo.slice(0, i), ...undo.slice(i + 1)]
  }
  return undo
}

/** 競合を「GitHub 側を採用」で解決する（企画書 §16.3）。 */
export function resolveWithRemote(state: ScheduleState, mutationId: string): ScheduleState {
  const mutation = state.queue.find((m) => m.id === mutationId)
  if (!mutation) return state
  const remote = mutation.remote
  return {
    ...state,
    queue: state.queue.filter((m) => m.id !== mutationId),
    tasks: remote
      ? replaceTask(state.tasks, mutation.taskId, () => ({ ...remote, syncState: "synced" }))
      : replaceTask(state.tasks, mutation.taskId, (t) => ({
          ...t,
          ...mutation.before,
          syncState: "synced",
        })),
  }
}

/**
 * 競合を「ローカルで上書き」で解決する。
 * GitHub の現在値を新しい基準にして、同じ変更をもう一度キューへ積む。
 */
export function resolveWithLocal(
  state: ScheduleState,
  mutationId: string,
  newMutationId: string,
): ScheduleState {
  const mutation = state.queue.find((m) => m.id === mutationId)
  if (!mutation) return state
  const retried: Mutation = {
    ...mutation,
    id: newMutationId,
    attempts: 0,
    state: "pending",
    error: null,
    expectedUpdatedAt: mutation.remote?.updatedAt ?? mutation.expectedUpdatedAt,
    remote: null,
  }
  return {
    ...state,
    queue: [...state.queue.filter((m) => m.id !== mutationId), retried],
    tasks: replaceTask(state.tasks, mutation.taskId, (t) => ({
      ...t,
      ...mutation.after,
      syncState: "pending",
    })),
  }
}

function sameDates(a: Dates, b: Dates): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate
}

/** 次に送信すべきミューテーション。1 タスクにつき 1 件ずつ直列に送る。 */
export function nextPending(state: ScheduleState): Mutation | null {
  const busy = new Set(
    state.queue.filter((m) => m.state === "syncing").map((m) => m.taskId),
  )
  return state.queue.find((m) => m.state === "pending" && !busy.has(m.taskId)) ?? null
}

export function pendingCount(state: ScheduleState): number {
  return state.queue.filter((m) => m.state !== "conflict").length
}

export function canUndo(state: ScheduleState): boolean {
  return state.undo.length > 0
}

export function canRedo(state: ScheduleState): boolean {
  return state.redo.length > 0
}

/**
 * Undo（企画書 §6.3.4）。
 * 逆向きの変更を新しいミューテーションとして発行するため、GitHub 側の履歴も前進する。
 *
 * エントリはグループなので、含まれるタスクの数だけミューテーションを出す。
 * いくつ要るかは呼ぶ前に決まらないため、id ではなく生成関数を取る。
 */
export function undo(state: ScheduleState, nextMutationId: () => string): ScheduleState {
  const entry = state.undo[state.undo.length - 1]
  if (!entry) return state
  // 積んだ順の逆に戻す。日付は絶対値なので結果は変わらないが、キューとログに
  // 出る並びが行きと鏡になり、何が起きたのかを追いやすい。
  const applied = applyItems(
    { ...state, undo: state.undo.slice(0, -1) },
    [...entry.items].reverse(),
    (item) => item.before,
    nextMutationId,
  )
  if (!applied) return state
  return { ...applied, redo: [...state.redo, entry] }
}

export function redo(state: ScheduleState, nextMutationId: () => string): ScheduleState {
  const entry = state.redo[state.redo.length - 1]
  if (!entry) return state
  const applied = applyItems(
    { ...state, redo: state.redo.slice(0, -1) },
    entry.items,
    (item) => item.after,
    nextMutationId,
  )
  if (!applied) return state
  return { ...applied, undo: [...state.undo, entry] }
}

/**
 * グループの各要素を、指定した側の日付へ戻す。
 *
 * 戻せない要素（日付が未設定だった側）は飛ばす。1 件も戻せなければ null を返し、
 * 呼び出し側はスタックを消費せずに何もしなかったことにする。
 */
function applyItems(
  state: ScheduleState,
  items: UndoItem[],
  pick: (item: UndoItem) => Dates,
  nextMutationId: () => string,
): ScheduleState | null {
  let applied = false
  const next = items.reduce((acc, item) => {
    const change = toChange(pick(item))
    if (!change) return acc
    applied = true
    return applyLocalChange(acc, item.taskId, change, nextMutationId(), { recordUndo: false })
  }, state)
  return applied ? next : null
}

/** GitHub から取り直したタスク一覧を反映する。未送信の変更は保持する。 */
export function mergeRefresh(state: ScheduleState, fresh: ScheduleTask[]): ScheduleState {
  const dirty = new Map<string, ScheduleTask>()
  for (const mutation of state.queue) {
    const local = findTask(state, mutation.taskId)
    if (local) dirty.set(mutation.taskId, local)
  }
  return {
    ...state,
    tasks: fresh.map((task) => dirty.get(task.id) ?? task),
  }
}
