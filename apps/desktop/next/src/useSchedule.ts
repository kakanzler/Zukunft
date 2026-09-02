"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type DateChange,
  type ScheduleState,
  type ScheduleTask,
  applyChangeWithCascade,
  canRedo,
  canUndo,
  initialState,
  markConflict,
  markFailed,
  markSynced,
  markSyncing,
  mergeRefresh,
  nextPending,
  pendingCount,
  redo as redoAction,
  resolveWithLocal,
  resolveWithRemote,
  rollback as rollbackAction,
  undo as undoAction,
} from "@zukunft/domain"
import type { IssueState, NewTaskInput, TaskContent } from "@zukunft/domain"
import { GitHubError, type GitHubScheduleRepository } from "@zukunft/github"

/** リトライ間隔（企画書 §16.4）。 */
const BACKOFF_MS = [1_000, 4_000, 16_000]
const MAX_ATTEMPTS = BACKOFF_MS.length

let mutationSeq = 0
const nextMutationId = () => `m${++mutationSeq}`

export type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "error"; error: GitHubError }

/**
 * Gantt の状態と GitHub 同期をまとめる（企画書 §7.2 / §16）。
 *
 * ドラッグ確定 → 楽観的更新 → キュー → 送信 の流れをここで駆動する。
 * UI コンポーネントは repository を直接触らない。
 */
export function useSchedule(
  repository: GitHubScheduleRepository,
  projectId: string | null,
) {
  const [state, setState] = useState<ScheduleState>(() => initialState())
  const [load, setLoad] = useState<LoadState>({ phase: "idle" })

  // 送信ループが state を追いかけ直さずに済むよう、最新の state を ref に持つ。
  const stateRef = useRef(state)
  stateRef.current = state
  const sending = useRef(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoad({ phase: "loading" })
    try {
      const tasks = await repository.getTasks(projectId)
      setState((prev) =>
        prev.queue.length === 0 ? { ...prev, tasks } : mergeRefresh(prev, tasks),
      )
      setLoad({ phase: "ready" })
    } catch (error) {
      setLoad({
        phase: "error",
        error: error instanceof GitHubError ? error : new GitHubError("unknown", String(error)),
      })
    }
  }, [repository, projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 送信ループ。pending を 1 件ずつ処理する。
   *
   * state を依存に持つエフェクトから起動すると、markSyncing による state 更新で
   * 自分自身の cleanup が走り、送信中のリクエストを取り消してしまう。
   * そのためループ本体は ref に置き、キューの変化をきっかけに呼び出すだけにする。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const pump = useRef<() => void>(() => {})
  pump.current = () => {
    if (!projectId || sending.current) return
    const mutation = nextPending(stateRef.current)
    if (!mutation) return

    sending.current = true
    setState((prev) => markSyncing(prev, mutation.id))

    void (async () => {
      try {
        const updated = await repository.updateTaskDates(
          projectId,
          mutation.taskId,
          mutation.change,
          mutation.expectedUpdatedAt,
        )
        if (alive.current) setState((prev) => markSynced(prev, mutation.id, updated))
      } catch (error) {
        if (!alive.current) return
        const err =
          error instanceof GitHubError ? error : new GitHubError("unknown", String(error))

        if (err.kind === "conflict") {
          const remote = err.remote ?? findRemoteFallback(stateRef.current, mutation.taskId)
          setState((prev) => markConflict(prev, mutation.id, remote, err.message))
          return
        }

        const attempts = mutation.attempts + 1
        const retryable = err.kind === "network" || err.kind === "rate-limited"
        if (retryable && attempts < MAX_ATTEMPTS) {
          // 間隔をあけて pending へ戻す。syncing のまま待たせない（企画書 §16.4）。
          const wait = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[MAX_ATTEMPTS - 1]!
          setTimeout(() => {
            if (!alive.current) return
            setState((prev) => ({
              ...prev,
              queue: prev.queue.map((m) =>
                m.id === mutation.id ? { ...m, state: "pending", error: err.message } : m,
              ),
            }))
          }, wait)
          return
        }
        setState((prev) => markFailed(prev, mutation.id, err.message))
      } finally {
        sending.current = false
        // 直列に次の 1 件へ進む。
        if (alive.current) pump.current()
      }
    })()
  }

  useEffect(() => {
    pump.current()
  }, [state.queue, projectId, repository])

  /**
   * 日付の変更。依存関係に合わせて、押し出されたタスクも一緒に動かす（企画書 §15.2）。
   * 自動調整は設定で切れる。切っているときは今までどおり 1 件だけ動く。
   */
  const changeDates = useCallback(
    (taskId: string, change: DateChange, options: { autoReschedule?: boolean } = {}) => {
      setState((prev) =>
        applyChangeWithCascade(prev, taskId, change, nextMutationId, options),
      )
    },
    [],
  )

  const [creating, setCreating] = useState(false)

  /**
   * Issue を作成して一覧に加える。
   *
   * 日付の編集と違い楽観的更新はしない。作成は GitHub 側で採番されて初めて
   * item id と Issue 番号が決まるため、返ってきた実物を足す方が確実。
   */
  const createTask = useCallback(
    async (input: NewTaskInput) => {
      if (!projectId) return null
      setCreating(true)
      try {
        const created = await repository.createTask(projectId, input)
        setState((prev) => ({ ...prev, tasks: [...prev.tasks, created] }))
        return created
      } finally {
        setCreating(false)
      }
    },
    [repository, projectId],
  )

  const actions = useMemo(
    () => ({
      // カスケードは 1 操作で複数タスクを動かすので、id をいくつ使うかは
      // 呼ぶ前に決まらない。id そのものではなく生成関数を渡す。
      undo: () => setState((prev) => undoAction(prev, nextMutationId)),
      redo: () => setState((prev) => redoAction(prev, nextMutationId)),
      rollback: (mutationId: string) => setState((prev) => rollbackAction(prev, mutationId)),
      keepRemote: (mutationId: string) => setState((prev) => resolveWithRemote(prev, mutationId)),
      keepLocal: (mutationId: string) =>
        setState((prev) => resolveWithLocal(prev, mutationId, nextMutationId())),
      retry: (mutationId: string) =>
        setState((prev) => ({
          ...prev,
          queue: prev.queue.map((m) =>
            m.id === mutationId ? { ...m, state: "pending", attempts: 0, error: null } : m,
          ),
        })),
      reload,
    }),
    [reload],
  )

  const [savingContent, setSavingContent] = useState(false)

  /**
   * Issue 本体の編集。日付と違い楽観的更新はせず、
   * GitHub が返した内容で置き換える（本文は整形されて返ることがあるため）。
   */
  const updateContent = useCallback(
    async (taskId: string, issueId: string, content: TaskContent) => {
      setSavingContent(true)
      try {
        const updated = await repository.updateTaskContent(taskId, issueId, content)
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)),
        }))
        return updated
      } finally {
        setSavingContent(false)
      }
    },
    [repository],
  )

  const [savingStatus, setSavingStatus] = useState(false)

  /**
   * Status の変更。編集モードに入らず、その場で GitHub に送る。
   * ここも楽観的更新はせず GitHub が返した値で置き換える
   * （選択肢名は Project の定義が正本で、送った id と 1 対 1 とは限らないため）。
   */
  const updateStatus = useCallback(
    async (taskId: string, optionId: string) => {
      if (!projectId) return null
      setSavingStatus(true)
      try {
        const updated = await repository.updateTaskStatus(projectId, taskId, optionId)
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)),
        }))
        return updated
      } finally {
        setSavingStatus(false)
      }
    },
    [repository, projectId],
  )

  const [savingState, setSavingState] = useState(false)

  /**
   * Issue のクローズ / リオープン。
   * ここも GitHub が返した Issue で置き換える。状態と一緒に updatedAt も進むため、
   * ローカルで真似ると次の日付更新が競合と見なされてしまう。
   */
  const setTaskState = useCallback(
    async (taskId: string, issueId: string, issueState: IssueState) => {
      setSavingState(true)
      try {
        const updated = await repository.setTaskState(taskId, issueId, issueState)
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)),
        }))
        return updated
      } finally {
        setSavingState(false)
      }
    },
    [repository],
  )

  /**
   * Issue の削除。GitHub から消えたものは戻せないので楽観的更新はしない。
   * 未送信の日付変更も一緒に捨てる。宛先の Issue が無い以上、送っても必ず失敗し、
   * 「要対応」として残り続けてしまうため。
   */
  const [deleting, setDeleting] = useState(false)

  const deleteTask = useCallback(async (taskId: string, issueId: string) => {
    const removed = stateRef.current.tasks.find((t) => t.id === taskId) ?? null
    // 送信中は UI 側でボタンを塞ぐ。二度押しの 2 回目は必ず「もう無い」で失敗し、
    // 消えているのに失敗ログだけが残ることになるため。
    setDeleting(true)
    try {
      await repository.deleteTask(issueId)
    } finally {
      setDeleting(false)
    }
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== taskId),
      queue: prev.queue.filter((m) => m.taskId !== taskId),
    }))
    return removed
  }, [repository])

  return {
    tasks: state.tasks,
    queue: state.queue,
    load,
    creating,
    createTask,
    savingContent,
    updateContent,
    savingStatus,
    updateStatus,
    savingState,
    setTaskState,
    deleting,
    deleteTask,
    pending: pendingCount(state),
    canUndo: canUndo(state),
    canRedo: canRedo(state),
    changeDates,
    ...actions,
  }
}

/** 競合時に GitHub 側の値が取れなかった場合の保険。 */
function findRemoteFallback(state: ScheduleState, taskId: string): ScheduleTask {
  const task = state.tasks.find((t) => t.id === taskId)
  if (task) return task
  throw new GitHubError("not-found", "競合したタスクが見つかりません")
}
