"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  GroupMode,
  IssueState,
  Label,
  Milestone,
  NewTaskInput,
  TaskContent,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ZoomLevel,
} from "@zukunft/domain"
import { ZOOM_LEVELS, canEditDates, missingRequiredFields, resolveField } from "@zukunft/domain"
import { DEFAULT_VIEWS, GanttChart, Sidebar } from "@zukunft/gantt"
import { GitHubError, describeError, statusOrder } from "@zukunft/github"
import type { GitHubScheduleRepository } from "@zukunft/github"
import { getRepository, isTauri } from "@/repository"
import { SignIn } from "@/SignIn"
import { CategorySettings } from "@/CategorySettings"
import { ManualModal } from "@/ManualModal"
import { SettingsModal } from "@/SettingsModal"
import { LogPane } from "@/LogPane"
import { NewTaskModal } from "@/NewTaskModal"
import { TaskModal } from "@/TaskModal"
import type { LogInput } from "@/log"
import { useLog } from "@/log"
import type { WindowSettings } from "@/settings"
import {
  DEFAULT_WINDOW_SETTINGS,
  exitFullscreen,
  loadParentLabels,
  loadWindowSettings,
  saveParentLabels,
  saveWindowSettings,
} from "@/settings"
import { useSchedule } from "@/useSchedule"

/**
 * 同期状況のログはこのキーで 1 行に畳む。
 * 状態が変わるたびに積み増すと、直近の状況を探すのに古い行を読み飛ばすことになる。
 */
const SYNC_LOG_KEY = "sync"

export default function Page() {
  const [repository, setRepository] = useState<GitHubScheduleRepository | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [schema, setSchema] = useState<ProjectSchema | null>(null)
  // GitHub 側でフィールドを足したあと取り直すためのトリガ。
  // タスクだけ再取得してもスキーマは古いままで、編集が閉じたままになる。
  const [schemaNonce, setSchemaNonce] = useState(0)
  const [zoom, setZoom] = useState<ZoomLevel>("week")
  const [groupBy, setGroupBy] = useState<GroupMode>("status")
  const [bootError, setBootError] = useState<GitHubError | null>(null)
  // null = 判定前。ブラウザ（モック）ではサインインを要求しない。
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [authSource, setAuthSource] = useState<string>("none")
  // 認証判定のやり直し用トリガ。レート制限などで判定できなかったとき、
  // アプリを起動し直さずに再試行できるようにする。
  const [authNonce, setAuthNonce] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) setSignedIn(true)
        return
      }
      try {
        const { auth } = await import("@zukunft/github/tauri")
        const status = await auth.status()
        if (alive) {
          setSignedIn(status.signedIn)
          setAuthSource(status.source)
        }
      } catch (error) {
        if (!alive) return
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        // サインイン画面へ送るのは、GitHub がトークンを受け付けなかったときだけ。
        // レート制限や通信断まで未サインインとして扱うと、有効なトークンを持ったまま
        // サインアウトさせてしまうので、それ以外は起動時のエラーとして見せる。
        if (err.kind === "unauthorized") {
          setSignedIn(false)
        } else {
          setBootError(err)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [authNonce])

  useEffect(() => {
    if (signedIn !== true) return
    let alive = true
    void (async () => {
      try {
        const repo = await getRepository()
        if (!alive) return
        setRepository(repo)
        const list = await repo.listProjects("")
        if (!alive) return
        setProjects(list)
        setProjectId(list[0]?.id ?? null)
      } catch (error) {
        if (alive) {
          setBootError(
            error instanceof GitHubError ? error : new GitHubError("unknown", String(error)),
          )
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [signedIn])

  useEffect(() => {
    if (!repository || !projectId) return
    let alive = true
    void repository
      .getProjectSchema(projectId)
      .then((s) => {
        if (alive) setSchema(s)
      })
      .catch((error) => {
        if (alive) {
          setBootError(
            error instanceof GitHubError ? error : new GitHubError("unknown", String(error)),
          )
        }
      })
    return () => {
      alive = false
    }
  }, [repository, projectId, schemaNonce])

  if (signedIn === false) {
    return (
      <main className="zk-root">
        <SignIn
          onSignedIn={(status) => {
            setSignedIn(status.signedIn)
            setAuthSource(status.source)
          }}
        />
      </main>
    )
  }

  return (
    <main className="zk-root">
      {repository ? (
        <Workspace
          repository={repository}
          projects={projects}
          projectId={projectId}
          onSelectProject={setProjectId}
          schema={schema}
          zoom={zoom}
          onZoom={setZoom}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          authSource={authSource}
          onReloadSchema={() => setSchemaNonce((n) => n + 1)}
        />
      ) : bootError ? (
        <ErrorPanel
          error={bootError}
          onRetry={() => {
            setBootError(null)
            setAuthNonce((n) => n + 1)
          }}
        />
      ) : (
        <div className="zk-empty">読み込み中…</div>
      )}
    </main>
  )
}

function Workspace({
  repository, projects, projectId, onSelectProject, schema, zoom, onZoom,
  groupBy, onGroupBy, authSource, onReloadSchema,
}: {
  repository: GitHubScheduleRepository
  projects: ProjectSummary[]
  projectId: string | null
  onSelectProject: (id: string) => void
  schema: ProjectSchema | null
  zoom: ZoomLevel
  onZoom: (z: ZoomLevel) => void
  groupBy: GroupMode
  onGroupBy: (mode: GroupMode) => void
  authSource: string
  onReloadSchema: () => void
}) {
  const schedule = useSchedule(repository, projectId)
  /**
   * useSchedule が返す操作は個別に useCallback 済みで identity が安定している。
   * ここで取り出しておくのは、依存配列に `schedule` 全体を書かずに済ませるため。
   * 全体を入れるとタスクが 1 件変わるだけで全部が作り直される。
   */
  const {
    reload,
    undo,
    redo,
    keepRemote,
    keepLocal,
    retry,
    rollback,
    updateContent,
    updateStatus,
    setTaskState,
    deleteTask: sendDeleteTask,
    createTask: sendCreateTask,
  } = schedule
  const missing = useMemo(() => (schema ? missingRequiredFields(schema) : []), [schema])
  const statuses = useMemo(() => (schema ? statusOrder(schema) : []), [schema])
  // Status の変更には選択肢の ID が要る。名前だけの statuses とは別に持つ。
  const statusOptions = useMemo(
    () => (schema ? resolveField(schema, "status", "SINGLE_SELECT")?.options ?? [] : []),
    [schema],
  )
  const editable = useMemo(() => canEditDates(schema), [schema])

  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  // e から開いたときだけ編集モードで始める。Enter やクリックは見るだけ。
  const [openTaskEditing, setOpenTaskEditing] = useState(false)
  const openTask = schedule.tasks.find((t) => t.id === openTaskId) ?? null

  const [creatingOpen, setCreatingOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  // 親カテゴリとして扱うラベル名。GitHub ではなくアプリ側の設定（Project ごと）。
  const [parentLabels, setParentLabels] = useState<string[]>([])
  const [savingCategories, setSavingCategories] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  // ウィンドウの見せ方。Project に依らないアプリ全体の設定。
  const [windowSettings, setWindowSettings] = useState<WindowSettings>(DEFAULT_WINDOW_SETTINGS)
  const [savingWindow, setSavingWindow] = useState(false)
  // ログだけを見るモード（Alt+L）。Gantt を描かないので、長い hint も折り返さず読める。
  const [logFull, setLogFull] = useState(false)
  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  // 新規 Issue の作成先。ラベルと Milestone の候補を先に取りに行くため、
  // モーダルの中ではなくここで持つ。
  const [newTaskRepositoryId, setNewTaskRepositoryId] = useState("")
  // ラベル候補はリポジトリ単位。開いたタスクのリポジトリの分を取りに行く。
  const [labelsByRepo, setLabelsByRepo] = useState<Record<string, Label[]>>({})
  // Milestone 候補も同じくリポジトリ単位。
  const [milestonesByRepo, setMilestonesByRepo] = useState<Record<string, Milestone[]>>({})
  const log = useLog()
  // 依存配列に入れてよいのはこちら。log そのものは entries が変わるたびに
  // identity が変わるので、通信する effect の依存に入れると回り続ける。
  const { append: logAppend, resolve: logResolve } = log
  const logged = useRef<Set<string>>(new Set())
  // 取りに行ったリポジトリのメタ情報。失敗しても再描画のたびに叩き直さないため。
  const attempted = useRef<Set<string>>(new Set())

  /**
   * 読み込み失敗をログへ。
   *
   * ガードを持たないのは意図。schedule.load は setLoad でしか変わらない state なので、
   * 「読み込みの状態が本当に変わったときだけ 1 回」という正しい引き金になっている。
   * 兄弟の effect がガードを要るのは、missing や queue が毎レンダリング作り直される
   * 派生値だから。ここで依存に log そのものを入れると毎レンダリング流れ続ける。
   */
  useEffect(() => {
    // 再試行が通ったら古い失敗行は取り下げる（企画書 §18）。
    if (schedule.load.phase === "ready") {
      logResolve("load")
      return
    }
    if (schedule.load.phase !== "error") return
    const info = describeError(schedule.load.error)
    logAppend({
      level: "error",
      message: info.title,
      hint: `${schedule.load.error.message}　${info.hint}`,
      dedupeKey: "load",
      actions: [{ label: "再試行", run: reload }],
    })
  }, [schedule.load, reload, logAppend, logResolve])

  // Project の設定不足を一度だけ警告する
  useEffect(() => {
    if (!schema || missing.length === 0) return
    const key = `setup:${schema.projectId}`
    if (logged.current.has(key)) return
    logged.current.add(key)
    // 実在するフィールド名も出す。名前が少しでも違うと一致しないため、
    // 「作ったのに認識されない」場合の切り分けに要る。
    const present = schema.fields.map((f) => `${f.name} (${f.dataType})`).join(", ")
    logAppend({
      level: "warn",
      message: "Project の設定が足りません",
      hint:
        `${missing.map((f) => `${f.name} (${f.expectedType})`).join(" / ")} が必要です。` +
        `　現在のフィールド: ${present || "なし"}` +
        `　大文字小文字と空白は無視するので Start date / End date / Due date なども可。` +
        `　作成したら Alt+R で読み直してください。`,
      dedupeKey: key,
    })
  }, [schema, missing, logAppend])

  /**
   * いまの同期状況。ヘッダの常時表示をやめた代わりに、これをログへ流す（企画書 §19）。
   * 未解決の競合・失敗があるうちは「同期されています」とは言わない。
   */
  const standing = useMemo((): { kind: "synced" | "pending" | "problem"; entry: LogInput } => {
    const problems = schedule.queue.filter(
      (m) => m.state === "failed" || m.state === "conflict",
    ).length
    if (problems > 0) {
      return {
        kind: "problem",
        entry: {
          level: "warn",
          message: `要対応 ${problems} 件`,
          hint: "送信に失敗した、または競合した変更があります。下のログの各エントリから対処してください。",
          dedupeKey: SYNC_LOG_KEY,
        },
      }
    }
    if (schedule.pending > 0) {
      return {
        kind: "pending",
        entry: {
          level: "warn",
          message: `未同期 ${schedule.pending} 件`,
          hint: "GitHub へ送信していない変更があります。送信は自動で進みます。",
          dedupeKey: SYNC_LOG_KEY,
        },
      }
    }
    return {
      kind: "synced",
      entry: { level: "info", message: "同期されています。", dedupeKey: SYNC_LOG_KEY },
    }
  }, [schedule.queue, schedule.pending])

  /**
   * 同期状況の変化だけをログに出す。
   *
   * 未同期のまま件数が増えても行を増やさない（「発覚時に 1 度だけ」）。
   * 最初の読み込みが終わるまで黙っているのは、まだ何も取れていない時点の
   * 「同期されています」が状況を語っていないため。
   */
  const lastStanding = useRef<string | null>(null)
  useEffect(() => {
    if (schedule.load.phase !== "ready" && lastStanding.current === null) return
    if (lastStanding.current === standing.kind) return
    lastStanding.current = standing.kind
    logAppend(standing.entry)
  }, [standing, schedule.load.phase, logAppend])

  /** 再読み込み（Alt+R）から呼ぶ。変化が無くても、そのときの状況をあらためて出す。 */
  const logSyncStanding = useCallback(() => {
    lastStanding.current = standing.kind
    logAppend(standing.entry)
  }, [standing, logAppend])

  // 同期の失敗と競合をログへ。解決したエントリは取り下げる（企画書 §18）。
  useEffect(() => {
    const active = new Set<string>()
    for (const mutation of schedule.queue) {
      if (mutation.state !== "failed" && mutation.state !== "conflict") continue
      const key = `mut:${mutation.id}:${mutation.state}`
      active.add(key)
      if (logged.current.has(key)) continue
      logged.current.add(key)

      const range = `${mutation.after.startDate} → ${mutation.after.endDate}`
      if (mutation.state === "conflict") {
        const remote = mutation.remote
        logAppend({
          level: "warn",
          message: "GitHub 側が更新されています",
          hint: remote
            ? `ローカル: ${range}　/　GitHub: ${remote.startDate} → ${remote.endDate}`
            : range,
          dedupeKey: key,
          actions: [
            { label: "GitHub 側を採用", run: () => keepRemote(mutation.id) },
            { label: "ローカルで上書き", run: () => keepLocal(mutation.id) },
          ],
        })
      } else {
        logAppend({
          level: "error",
          message: "GitHub に反映できませんでした",
          hint: `${range}　${mutation.error ?? ""}`,
          dedupeKey: key,
          actions: [
            { label: "再試行", run: () => retry(mutation.id) },
            { label: "取り消す", run: () => rollback(mutation.id), danger: true },
          ],
        })
      }
    }
    for (const key of [...logged.current]) {
      if (key.startsWith("mut:") && !active.has(key)) {
        logged.current.delete(key)
        logResolve(key)
      }
    }
  }, [
    schedule.queue,
    keepRemote,
    keepLocal,
    retry,
    rollback,
    logAppend,
    logResolve,
  ])

  // Issue の作成先候補を取っておく
  useEffect(() => {
    if (!projectId) return
    let alive = true
    void repository
      .listRepositories(projectId)
      .then((list) => {
        if (alive) setRepositories(list)
      })
      .catch((error) => {
        if (!alive) return
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        logAppend({
          level: "warn",
          message: "リポジトリ一覧を取得できませんでした",
          hint: `${err.message}　新規 Issue の作成先を選べません。`,
          dedupeKey: "repos",
        })
      })
    return () => {
      alive = false
    }
  }, [repository, projectId, logAppend])

  // ウィンドウの設定は起動時に一度だけ読む。窓への反映は Rust 側が起動時に済ませて
  // いるので、ここで読むのは設定画面に今の値を出すためだけ。
  useEffect(() => {
    let alive = true
    void loadWindowSettings().then((loaded) => {
      if (alive) setWindowSettings(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  // 親カテゴリの設定を読む。ラベル名の意味は Project ごとに違うので、
  // 切り替えたらいったん空に戻してから読み直す。前の Project の指定で
  // Gantt を組み替えたままにしないため。
  useEffect(() => {
    setParentLabels([])
    if (!projectId) return
    let alive = true
    // 読み込みが返るまでの間、前の Project の親カテゴリで並べてしまわないように落とす。
    setParentLabels([])
    void loadParentLabels(projectId).then((names) => {
      if (alive) setParentLabels(names)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  /**
   * リポジトリのラベルと Milestone を、まだ無ければ取っておく。
   * 詳細を開いたタスクだけでなく新規 Issue の作成先でも要るので、
   * 「どのリポジトリの分か」を引数にして両方から呼べる形にしている。
   *
   * 「取りに行ったか」は結果ではなく発行時点で記録する。取得できたかどうかで
   * 判断すると、失敗したリポジトリを再描画のたびに叩き直すことになるため。
   * 取り直したいときは Alt+R がある。
   */
  const ensureRepoMeta = useCallback(
    (repositoryId: string) => {
      if (!repositoryId) return
      if (!labelsByRepo[repositoryId] && !attempted.current.has(`labels:${repositoryId}`)) {
        attempted.current.add(`labels:${repositoryId}`)
        void repository
          .listLabels(repositoryId)
          .then((list) => setLabelsByRepo((prev) => ({ ...prev, [repositoryId]: list })))
          .catch((error) => {
            const err =
              error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
            logAppend({
              level: "warn",
              message: "ラベル一覧を取得できませんでした",
              hint: `${err.message}　既存ラベルを選べません。`,
              dedupeKey: `labels:${repositoryId}`,
            })
          })
      }
      if (
        !milestonesByRepo[repositoryId] &&
        !attempted.current.has(`milestones:${repositoryId}`)
      ) {
        attempted.current.add(`milestones:${repositoryId}`)
        void repository
          .listMilestones(repositoryId)
          .then((list) => setMilestonesByRepo((prev) => ({ ...prev, [repositoryId]: list })))
          .catch((error) => {
            const err =
              error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
            logAppend({
              level: "warn",
              message: "Milestone 一覧を取得できませんでした",
              hint: `${err.message}　Milestone を付け替えられません。`,
              dedupeKey: `milestones:${repositoryId}`,
            })
          })
      }
    },
    [repository, labelsByRepo, milestonesByRepo, logAppend],
  )

  // 詳細を開いたタスクのリポジトリの分
  const openRepositoryId = openTask?.repositoryId ?? ""
  useEffect(() => {
    ensureRepoMeta(openRepositoryId)
  }, [ensureRepoMeta, openRepositoryId])

  // 新規 Issue の作成先の分。既定は先頭のリポジトリ（一覧は後から届く）。
  useEffect(() => {
    if (!newTaskRepositoryId && repositories[0]) setNewTaskRepositoryId(repositories[0].id)
  }, [repositories, newTaskRepositoryId])

  useEffect(() => {
    if (!creatingOpen) return
    ensureRepoMeta(newTaskRepositoryId)
  }, [ensureRepoMeta, creatingOpen, newTaskRepositoryId])

  // カテゴリ設定の候補は Project 全体のラベル。開いたときに揃っていない分を取りに行く。
  useEffect(() => {
    if (!categoryOpen) return
    for (const repo of repositories) ensureRepoMeta(repo.id)
  }, [ensureRepoMeta, categoryOpen, repositories])

  /**
   * 親カテゴリに指定できるラベル。名前で重複を除く。
   *
   * ラベルは node id がリポジトリごとに別物なので、複数リポジトリに同名のラベルが
   * あっても 1 件として扱う。指定は名前で行うため、それで困らない。
   * 一覧の取得が届く前でも選べるよう、いま表示しているタスクが持つラベルも混ぜる。
   */
  const labelCandidates = useMemo(() => {
    const byName = new Map<string, Label>()
    for (const list of Object.values(labelsByRepo)) {
      for (const label of list) if (!byName.has(label.name)) byName.set(label.name, label)
    }
    for (const task of schedule.tasks) {
      for (const label of task.labels) if (!byName.has(label.name)) byName.set(label.name, label)
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [labelsByRepo, schedule.tasks])

  /**
   * 親カテゴリの保存。
   *
   * この設定は以後の Gantt の並び全体を黙って変えるので、いつ誰が変えたのかを
   * 追えるようログにも残す。
   */
  const saveCategories = useCallback(
    async (names: string[]) => {
      if (!projectId) return
      setSavingCategories(true)
      try {
        await saveParentLabels(projectId, names)
        setParentLabels(names)
        setCategoryOpen(false)
        logAppend({
          level: "info",
          message:
            names.length > 0
              ? `親カテゴリを ${names.join(" / ")} にしました`
              : "親カテゴリを解除しました",
        })
      } catch (error) {
        // GitHub 呼び出しではないので GitHubError には包まない。
        // Rust 側は { kind, message } を reject するため、message だけ拾う。
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({
          level: "error",
          message: "カテゴリ設定を保存できませんでした",
          hint: detail,
        })
      } finally {
        setSavingCategories(false)
      }
    },
    [projectId, logAppend],
  )

  /**
   * ウィンドウ設定の保存。Rust 側が保存と同時に窓へ反映する。
   * 反映まで含めて成功したときだけ画面の値を進める。
   */
  const saveWindow = useCallback(
    async (next: WindowSettings) => {
      setSavingWindow(true)
      try {
        await saveWindowSettings(next)
        setWindowSettings(next)
        setSettingsOpen(false)
        logAppend({
          level: "info",
          message:
            next.mode === "windowed"
              ? `ウィンドウを ${next.width}×${next.height} にしました`
              : next.mode === "maximized"
                ? "ウィンドウを最大化しました"
                : "フルスクリーンにしました",
        })
      } catch (error) {
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({
          level: "error",
          message: "ウィンドウの設定を保存できませんでした",
          hint: detail,
        })
      } finally {
        setSavingWindow(false)
      }
    },
    [logAppend],
  )

  const createLabel = useCallback(
    async (repositoryId: string, name: string, color: string): Promise<Label | null> => {
      try {
        const created = await repository.createLabel(repositoryId, name, color)
        setLabelsByRepo((prev) => ({
          ...prev,
          [repositoryId]: [...(prev[repositoryId] ?? []), created],
        }))
        logAppend({ level: "info", message: `ラベル「${created.name}」を作成しました` })
        return created
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "ラベルを作成できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return null
      }
    },
    [repository, logAppend],
  )

  const deleteLabel = useCallback(
    async (repositoryId: string, label: Label): Promise<boolean> => {
      try {
        await repository.deleteLabel(label.id)
        setLabelsByRepo((prev) => ({
          ...prev,
          [repositoryId]: (prev[repositoryId] ?? []).filter((l) => l.id !== label.id),
        }))
        logAppend({ level: "info", message: `ラベル「${label.name}」を削除しました` })
        // 消えたラベルは付いていた Issue すべてから外れる。手元のタスクは
        // そのラベルを持ったままなので、取り直さないと Gantt や Category
        // グループが存在しないラベルを表示し続ける。
        reload()
        return true
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "ラベルを削除できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return false
      }
    },
    [repository, reload, logAppend],
  )

  const saveContent = useCallback(
    async (taskId: string, issueId: string, content: TaskContent) => {
      try {
        const updated = await updateContent(taskId, issueId, content)
        logAppend({
          level: "info",
          message: `#${updated.issueNumber} の内容を保存しました`,
        })
        return updated
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Issue の内容を保存できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return null
      }
    },
    [updateContent, logAppend],
  )

  /** Status の変更。選んだ時点で送るので、失敗はログでだけ知らせる。 */
  const changeStatus = useCallback(
    async (taskId: string, optionId: string) => {
      try {
        const updated = await updateStatus(taskId, optionId)
        if (updated) {
          logAppend({
            level: "info",
            message: `#${updated.issueNumber} の Status を ${updated.status ?? "—"} にしました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Status を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [updateStatus, logAppend],
  )

  /** クローズ / リオープン。押した時点で送るので、失敗はログでだけ知らせる。 */
  const changeIssueState = useCallback(
    async (taskId: string, issueId: string, state: IssueState) => {
      try {
        const updated = await setTaskState(taskId, issueId, state)
        logAppend({
          level: "info",
          message: `#${updated.issueNumber} を${state === "CLOSED" ? "クローズ" : "リオープン"}しました`,
        })
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Issue の状態を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [setTaskState, logAppend],
  )

  /** Issue の削除。消えた行を開いたままにできないので、成功したら詳細を閉じる。 */
  const deleteTask = useCallback(
    async (taskId: string, issueId: string) => {
      try {
        const removed = await sendDeleteTask(taskId, issueId)
        setOpenTaskId(null)
        logAppend({
          level: "info",
          message: removed ? `#${removed.issueNumber} を削除しました` : "Issue を削除しました",
        })
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Issue を削除できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [sendDeleteTask, logAppend],
  )

  const createTask = useCallback(
    async (input: NewTaskInput) => {
      try {
        const created = await sendCreateTask(input)
        setCreatingOpen(false)
        if (created) {
          logAppend({
            level: "info",
            message: `#${created.issueNumber} ${created.title} を作成しました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Issue を作成できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [sendCreateTask, logAppend],
  )

  /**
   * ズームを 1 段動かす。delta が正で粗く（day → week → month）、負で細かく。
   * 端では折り返さない — 押し続けて一周してしまう方が分かりにくい。
   */
  const stepZoom = useCallback(
    (delta: number) => {
      const current = ZOOM_LEVELS.indexOf(zoom)
      const moved = current + delta
      const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, moved))]
      if (next && next !== zoom) onZoom(next)
    },
    [zoom, onZoom],
  )

  // Undo / Redo のキーボードショートカット（企画書 §6.3.4）。
  // 判定は e.code（物理キー）で行う。Shift を押した e.key は "Z" になるため、
  // "z" と比べていた間は Ctrl+Shift+Z が一度も一致していなかった。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((e.code === "KeyZ" && e.shiftKey) || e.code === "KeyY") {
        e.preventDefault()
        redo()
      } else if (e.code === "Equal" || e.code === "NumpadAdd") {
        // 拡大は粒度を細かくする向き（month → week → day）。
        // preventDefault は必須で、外すと WebView 自身の画面拡大に取られる。
        e.preventDefault()
        stepZoom(-1)
      } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault()
        stepZoom(1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [undo, redo, stepZoom])

  /**
   * 再読み込み（Alt+R）。スキーマとタスクを取り直し、そのときの同期状況をログに出す。
   * スキーマも一緒に取り直すのは、GitHub 側でフィールドを足した直後に
   * タスクだけ取り直しても編集が閉じたままになるため。
   */
  const reloadAll = useCallback(() => {
    onReloadSchema()
    reload()
    logSyncStanding()
  }, [onReloadSchema, reload, logSyncStanding])

  // GanttChart の keydown リスナが毎レンダリング張り直されないよう、関数の identity を保つ。
  const openTaskDetail = useCallback((taskId: string) => {
    setOpenTaskEditing(false)
    setOpenTaskId(taskId)
  }, [])
  const openTaskForEdit = useCallback((taskId: string) => {
    setOpenTaskEditing(true)
    setOpenTaskId(taskId)
  }, [])

  /**
   * Esc でフルスクリーンを抜ける。
   *
   * モーダルが開いているときは何もしない。Esc はまずモーダルを閉じるキーで、
   * 各モーダルが自前で拾っている。ここでも反応すると、閉じると同時に窓まで
   * 縮んでしまい、どちらを取り消したのか分からなくなる。
   *
   * 設定は書き換えないので、次の起動は保存済みの見せ方に戻る。
   */
  const anyModalOpen =
    creatingOpen || categoryOpen || settingsOpen || manualOpen || openTaskId !== null
  useEffect(() => {
    if (anyModalOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      void exitFullscreen()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [anyModalOpen])

  // 画面の切り替えと起票の Alt ショートカット。
  // 文字入力を奪わないよう Alt 単独の組み合わせに限り、Ctrl / Meta との併用は見送る。
  // キー判定は e.code（物理キー）で行う。Alt を押した状態の e.key は配列によって
  // 別の文字になることがあり、それを見ると効いたり効かなかったりするため。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.code === "KeyL") {
        e.preventDefault()
        setLogFull((v) => !v)
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // Alt+Shift+←/→ でズームの粒度を移す。サイドバーの移動（Shift なし）と
        // 押し分けられるよう、Shift が無いときは何もしない。
        if (!e.shiftKey) return
        e.preventDefault()
        stepZoom(e.code === "ArrowRight" ? 1 : -1)
      } else if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        if (e.shiftKey) return
        // サイドバーの項目を上下に移動する。端では折り返さない。
        // 一覧の端に着いたことが分かる方が、押し続けて行き過ぎるより迷わない。
        e.preventDefault()
        const modes = DEFAULT_VIEWS.map((view) => view.mode)
        const current = modes.indexOf(groupBy)
        const moved = current + (e.code === "ArrowDown" ? 1 : -1)
        const next = modes[Math.min(modes.length - 1, Math.max(0, moved))]
        if (next && next !== groupBy) onGroupBy(next)
      } else if (e.code === "KeyR") {
        if (!projectId) return
        e.preventDefault()
        reloadAll()
      } else if (e.code === "KeyM") {
        e.preventDefault()
        setManualOpen((v) => !v)
      } else if (e.code === "KeyA") {
        // 作成先の Project が決まっていないと起票できない。
        if (!projectId) return
        e.preventDefault()
        setCreatingOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [projectId, reloadAll, groupBy, onGroupBy, stepZoom])

  const toolbar = (
    <>
      <select
        className="zk-button"
        value={projectId ?? ""}
        onChange={(e) => onSelectProject(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.title}</option>
        ))}
      </select>
      <div className="zk-segmented" role="group" aria-label="ズーム">
        {ZOOM_LEVELS.map((level) => (
          <button
            key={level}
            className="zk-segmented-item"
            aria-pressed={zoom === level}
            onClick={() => onZoom(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <button
        className="zk-button"
        onClick={() => setCreatingOpen(true)}
        disabled={!projectId}
      >
        New Issue
      </button>
      {/* ここから右端側。起票までが日常の操作で、カテゴリ設定はたまにしか触らない。 */}
      <button
        className="zk-button zk-header-push"
        onClick={() => setCategoryOpen(true)}
        disabled={!projectId}
      >
        カテゴリ設定
      </button>
    </>
  )

  return (
    <div className="zk-shell">
      <Sidebar
        active={groupBy}
        onSelect={onGroupBy}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="zk-main">
      {/* ログだけを見るモードでは Gantt を描かない。畳んで隅に寄せるのではなく
          消してしまう方が、狭い窓でもログが実際に読める高さになる。 */}
      {!logFull && (
      <GanttChart
        tasks={schedule.tasks}
        statusOrder={statuses}
        zoom={zoom}
        groupBy={groupBy}
        parentLabels={parentLabels}
        onTaskDatesChange={schedule.changeDates}
        readOnly={!editable}
        onTaskOpen={openTaskDetail}
        onTaskEdit={openTaskForEdit}
        // モーダルが開いている間は j / k で裏の一覧を動かさない。
        keyboardEnabled={!anyModalOpen}
        emptyMessage={
          schedule.load.phase === "loading"
            ? "読み込み中…"
            : "この Project にまだ Issue がありません。GitHub で Issue を Project に追加してください。"
        }
        toolbar={toolbar}
      />
      )}
      <LogPane log={log} full={logFull} onToggleFull={() => setLogFull((v) => !v)} />
      </div>
      {creatingOpen && (
        <NewTaskModal
          repositories={repositories}
          repositoryId={newTaskRepositoryId}
          onChangeRepository={setNewTaskRepositoryId}
          canEditDates={editable}
          busy={schedule.creating}
          statusOptions={statusOptions}
          availableLabels={labelsByRepo[newTaskRepositoryId] ?? []}
          availableMilestones={milestonesByRepo[newTaskRepositoryId] ?? []}
          onCreateLabel={createLabel}
          onDeleteLabel={deleteLabel}
          onCreate={createTask}
          onClose={() => setCreatingOpen(false)}
        />
      )}
      {categoryOpen && (
        <CategorySettings
          candidates={labelCandidates}
          selected={parentLabels}
          busy={savingCategories}
          onSave={saveCategories}
          onClose={() => setCategoryOpen(false)}
        />
      )}
      {manualOpen && (
        <ManualModal statuses={statuses} onClose={() => setManualOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={windowSettings}
          busy={savingWindow}
          applies={isTauri()}
          onSave={saveWindow}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {openTask && (
        <TaskModal
          task={openTask}
          canEditDates={editable}
          savingContent={schedule.savingContent}
          savingStatus={schedule.savingStatus}
          savingState={schedule.savingState}
          deleting={schedule.deleting}
          statusOptions={statusOptions}
          availableLabels={labelsByRepo[openTask.repositoryId] ?? []}
          availableMilestones={milestonesByRepo[openTask.repositoryId] ?? []}
          onCreateLabel={createLabel}
          onDeleteLabel={deleteLabel}
          onChangeDates={schedule.changeDates}
          onChangeStatus={changeStatus}
          onSaveContent={saveContent}
          onSetState={changeIssueState}
          onDelete={deleteTask}
          initialEditing={openTaskEditing}
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  )
}

function ErrorPanel({ error, onRetry }: { error: GitHubError; onRetry?: () => void }) {
  const info = describeError(error)
  return (
    <div className="zk-empty">
      <h2>{info.title}</h2>
      <p>{info.hint}</p>
      {onRetry && <button className="zk-button" onClick={onRetry}>再試行</button>}
    </div>
  )
}
