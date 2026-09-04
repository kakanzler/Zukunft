"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  Assignee,
  DateChange,
  GroupMode,
  ISODate,
  IssueState,
  Label,
  Milestone,
  NewMilestoneInput,
  NewTaskInput,
  Recurrence,
  RecurrenceRule,
  TaskContent,
  ProjectSchema,
  ProjectSummary,
  RepositorySummary,
  ZoomLevel,
} from "@zukunft/domain"
import type { TaskFilter } from "@zukunft/domain"
import {
  EMPTY_FILTER,
  ZOOM_LEVELS,
  canEditDates,
  detectCycles,
  filterChoices,
  filterTasks,
  formatCycle,
  isFilterActive,
  missingRequiredFields,
  resolveField,
  toggleDone,
} from "@zukunft/domain"
import { DEFAULT_VIEWS, GanttChart, Sidebar, isTyping } from "@zukunft/gantt"
import type { GanttTheme } from "@zukunft/gantt"
import { GitHubError, describeError, statusOrder } from "@zukunft/github"
import type { GitHubScheduleRepository } from "@zukunft/github"
import { getRepository, isTauri } from "@/repository"
import { SignIn } from "@/SignIn"
import { CategorySettings } from "@/CategorySettings"
import { PendingChanges } from "@/PendingChanges"
import { FilterBar } from "@/FilterBar"
import { ManualModal } from "@/ManualModal"
import { SettingsModal } from "@/SettingsModal"
import { LogPane } from "@/LogPane"
import { MilestoneCategoryModal } from "@/MilestoneCategoryModal"
import { NewMilestoneModal } from "@/NewMilestoneModal"
import { NewTaskModal } from "@/NewTaskModal"
import { TaskModal } from "@/TaskModal"
import type { LogInput } from "@/log"
import { useLog } from "@/log"
import type { WindowSettings } from "@/settings"
import {
  DEFAULT_WINDOW_SETTINGS,
  exitFullscreen,
  loadAutoReschedule,
  loadDailyTasks,
  loadMilestoneCategories,
  loadParentLabels,
  loadTheme,
  loadWindowSettings,
  pruneDailyTasks,
  saveAutoReschedule,
  saveDailyTask,
  saveMilestoneCategory,
  saveTheme,
  saveParentLabels,
  saveWindowSettings,
} from "@/settings"
import { useSchedule } from "@/useSchedule"

/**
 * 同期状況のログはこのキーで 1 行に畳む。
 * 状態が変わるたびに積み増すと、直近の状況を探すのに古い行を読み飛ばすことになる。
 */
const SYNC_LOG_KEY = "sync"

/**
 * 再読み込み（Alt+\）に使う物理キー。
 *
 * 「\」の物理キーは配列で違う。US は Backslash、JIS は ¥ の IntlYen と
 * ろ の IntlRo が両方とも「\」の刻印を持つ。どれを押しても同じ操作になるよう、
 * 3 つとも受ける。
 */
const RELOAD_CODES = new Set(["Backslash", "IntlYen", "IntlRo"])

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
  // スキーマの取得失敗。bootError と分けるのは、こちらは Project を選び直す /
  // 取り直すことで復帰できるため。
  const [schemaError, setSchemaError] = useState<GitHubError | null>(null)
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
    setSchemaError(null)
    void repository
      .getProjectSchema(projectId)
      .then((s) => {
        if (alive) setSchema(s)
      })
      .catch((error) => {
        // bootError に入れても、repository が揃ったあとは描画されない。
        // 黙って schema が null のままになり、理由の出ないまま盤面が
        // 読み取り専用になっていた（canEditDates(null) が false のため）。
        if (alive) {
          setSchemaError(
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
      {repository && schemaError ? (
        <ErrorPanel
          error={schemaError}
          onRetry={() => {
            setSchemaError(null)
            setSchemaNonce((n) => n + 1)
          }}
        />
      ) : repository ? (
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
    changeDates,
    updateContent,
    updateStatus,
    updatePriority,
    updateProgress,
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
  // Priority も同じ理由で選択肢の ID が要る。Project に無ければ空 = 変更させない。
  const priorityOptions = useMemo(
    () => (schema ? resolveField(schema, "priority", "SINGLE_SELECT")?.options ?? [] : []),
    [schema],
  )
  // Progress は選択肢を持たないので、あるかどうかだけを見る。resolveField は型が
  // 合わなくても名前一致で返すため、NUMBER であることまで確かめる。
  const canEditProgress = useMemo(
    () => schema !== null && resolveField(schema, "progress", "NUMBER")?.dataType === "NUMBER",
    [schema],
  )
  const editable = useMemo(() => canEditDates(schema), [schema])

  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  // 保留中の変更の一覧。常時出す帯にはしない — 何も待っていないときは場所を取るだけで、
  // 見るのは「未同期がある」と気づいたときだけだから、ログの行から開く。
  const [pendingOpen, setPendingOpen] = useState(false)
  // e から開いたときだけ編集モードで始める。Enter やクリックは見るだけ。
  const [openTaskEditing, setOpenTaskEditing] = useState(false)
  const openTask = schedule.tasks.find((t) => t.id === openTaskId) ?? null


  // 一覧の絞り込み。Project を切り替えたら外す — 別の Project の Status や
  // ラベルで絞ったまま「1 件も無い」を見せない。
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER)
  useEffect(() => {
    setFilter(EMPTY_FILTER)
  }, [projectId])

  const visibleTasks = useMemo(
    () => filterTasks(schedule.tasks, filter),
    [schedule.tasks, filter],
  )
  const choices = useMemo(() => filterChoices(schedule.tasks), [schedule.tasks])

  const [creatingOpen, setCreatingOpen] = useState(false)
  const [milestoneOpen, setMilestoneOpen] = useState(false)
  // マイルストーンの作成は useSchedule のキューを通さない。Projects v2 の
  // フィールドでも Issue でもないので、取り消しや競合の対象にならない。
  const [creatingMilestone, setCreatingMilestone] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  // カテゴリを割り当てるために開いているマイルストーンの node id。
  // 題名ではなく id で持つのは、GitHub 上で題名を変えても割り当てが外れないため。
  const [openMilestoneId, setOpenMilestoneId] = useState<string | null>(null)
  // マイルストーンの node id -> 割り当てたカテゴリ（ラベル名）。
  // GitHub ではなくアプリ側の設定で、盤面の菱形の色にしかならない。
  const [milestoneCategories, setMilestoneCategories] = useState<Record<string, string>>({})
  const [savingMilestoneCategory, setSavingMilestoneCategory] = useState(false)
  // task id -> 日課（間隔と実行した日）。GitHub ではなくアプリ側の設定で、
  // 変わるのは盤面の描き方だけ（バーではなく実行日の点になる）。
  // 日付そのものは Issue の Start / Target Date をそのまま読む。
  const [dailyTasks, setDailyTasks] = useState<Record<string, Recurrence>>({})
  /**
   * いまの日課の設定。state と同じ中身を同期して持つ。
   *
   * 点の入り切りは保存を待ってから state を動かすので、待っているあいだに
   * 2 つめの点を押されると、そちらが「押す前の値」から作られて先の 1 回が消える。
   * 実際、連続で 2 つ押すと片方しか残らなかった。押した時点で進む控えを別に持ち、
   * 次の押下は必ずこちらから作る。
   */
  const dailyTasksRef = useRef(dailyTasks)
  dailyTasksRef.current = dailyTasks
  // 親カテゴリとして扱うラベル名。GitHub ではなくアプリ側の設定（Project ごと）。
  const [parentLabels, setParentLabels] = useState<string[]>([])
  const [savingCategories, setSavingCategories] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  // ウィンドウの見せ方。Project に依らないアプリ全体の設定。
  const [windowSettings, setWindowSettings] = useState<WindowSettings>(DEFAULT_WINDOW_SETTINGS)
  // 依存に合わせて日程を押し出すか。これも Project に依らないアプリ全体の設定。
  // 既定は ON。読み込みが返るまでの間も、企画書 §15.2 の既定で動かす。
  const [autoReschedule, setAutoReschedule] = useState(true)
  // 盤面の意匠。Project に依らないアプリ全体の設定。
  const [ganttTheme, setGanttTheme] = useState<GanttTheme>("default")
  const [savingWindow, setSavingWindow] = useState(false)
  // ログだけを見るモード（Alt+L）。Gantt を描かないので、長い hint も折り返さず読める。
  const [logFull, setLogFull] = useState(false)
  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  // 新規 Issue の作成先。ラベルと Milestone の候補を先に取りに行くため、
  // モーダルの中ではなくここで持つ。
  const [newTaskRepositoryId, setNewTaskRepositoryId] = useState("")
  // マイルストーンの作成先。Issue の作成先とは別に持つ。片方を変えたときに
  // もう片方の作成先まで動くと、直前に選んだ先が黙って入れ替わる。
  const [newMilestoneRepositoryId, setNewMilestoneRepositoryId] = useState("")
  // ラベル候補はリポジトリ単位。開いたタスクのリポジトリの分を取りに行く。
  const [labelsByRepo, setLabelsByRepo] = useState<Record<string, Label[]>>({})
  // Milestone 候補も同じくリポジトリ単位。
  const [milestonesByRepo, setMilestonesByRepo] = useState<Record<string, Milestone[]>>({})
  // 担当候補も同じくリポジトリ単位。誰を割り当てられるかは権限で変わる。
  const [assigneesByRepo, setAssigneesByRepo] = useState<Record<string, Assignee[]>>({})
  /**
   * Issue の node id -> 親 Issue の node id（親が無ければ null）。
   *
   * 盤面からマイルストーンへ線を引くのに使う。読めなかったタスクは鍵ごと
   * 載らないので、そのぶんは線が引かれない。
   */
  const [parentByIssueId, setParentByIssueId] = useState<Record<string, string | null>>({})
  /**
   * 親を一度でも引けたか。
   *
   * 親は Issue ごとに 1 つで、地図に無い＝親が設定されていない（「分からない」という
   * 状態は持たない）。そのぶん、取得そのものに失敗した状態をこの旗で区別しないと、
   * 全タスクが「親なし」に化けて線が束になり、菱形の手前を塗り潰す。
   */
  const [parentsLoaded, setParentsLoaded] = useState(false)
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
        `　作成したら Alt+\ で読み直してください。`,
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
          actions: [{ label: "一覧を見る", run: () => setPendingOpen(true) }],
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
          // 送る前に中身を確かめる口。日付は楽観的に反映されるので、
          // ここが無いと「何が送られようとしているか」を見る場所がどこにも無い。
          actions: [{ label: "一覧を見る", run: () => setPendingOpen(true) }],
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

  /** 再読み込み（Alt+\）から呼ぶ。変化が無くても、そのときの状況をあらためて出す。 */
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

  // アプリ全体の設定は起動時に一度だけ読む。窓への反映は Rust 側が起動時に済ませて
  // いるので、ここで読むのは設定画面に今の値を出すためだけ。自動の日程調整は
  // 反映先が画面ではなく操作なので、こちらは読めた値をそのまま使う。
  useEffect(() => {
    let alive = true
    void loadWindowSettings().then((loaded) => {
      if (alive) setWindowSettings(loaded)
    })
    void loadAutoReschedule().then((enabled) => {
      if (alive) setAutoReschedule(enabled)
    })
    void loadTheme().then((loaded) => {
      if (alive) setGanttTheme(loaded)
    })
    // マイルストーンの割り当ては Project に依らない（鍵はマイルストーンの id）。
    // 親カテゴリと違い、Project を切り替えても読み直さない。
    void loadMilestoneCategories().then((loaded) => {
      if (alive) setMilestoneCategories(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 日課の設定を読む。鍵はタスクの id だが、保存は Project ごとに分かれている。
   *
   * 切り替えたらいったん空に戻してから読み直す。前の Project の設定を残したままだと、
   * 読み込みが返るまでのあいだ、覚えのないタスクがバーではなく点で描かれる。
   */
  useEffect(() => {
    setDailyTasks({})
    if (!projectId) return
    let alive = true
    void loadDailyTasks(projectId).then((loaded) => {
      if (alive) setDailyTasks(loaded)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  /**
   * 消えた Issue の日課の設定を掘り取る。
   *
   * task id は GitHub 側の都合で消える（Issue を消した、Project から外した）が、
   * 設定には残り続ける。読み込みが済んで 1 件以上あるときにだけ掘る — 失敗して
   * 0 件なのか本当に 0 件なのかをここでは区別できず、掘ると設定が丸ごと消える。
   *
   * 掘るのは Project につき 1 回。同期のたびに呼ぶと、取りこぼしのある読み込みが
   * 返るたびに設定ファイルを書き直すことになる。
   */
  const prunedProjects = useRef(new Set<string>())
  useEffect(() => {
    if (!projectId || schedule.load.phase !== "ready") return
    if (schedule.tasks.length === 0) return
    if (prunedProjects.current.has(projectId)) return
    // 結果ではなく発行時点で印を付ける。失敗したものを再描画のたびに叩き直さない。
    prunedProjects.current.add(projectId)
    void pruneDailyTasks(
      projectId,
      schedule.tasks.map((task) => task.id),
    ).catch(() => {
      // 掘れなくても盤面は描ける。消し損ねた設定が残るだけなので、画面には出さない。
    })
  }, [projectId, schedule.load.phase, schedule.tasks])

  /**
   * 盤面に並ぶ Issue の親をまとめて引く（マイルストーンへ線を引くため）。
   *
   * 一覧（getTasks）には混ぜられない。sub-issue のフィールドが使えない GitHub では
   * クエリごと失敗するので、混ぜると盤面が丸ごと出なくなる。別に引けば、失敗しても
   * 線が出ないだけで済む。
   *
   * 同期のたびには引かない。盤面に触るたびに 100 件単位の問い合わせが増える割に、
   * 親子関係はそう頻繁には変わらない。代わりに、変わりうる場面で取り直す:
   * Project を開いたとき、Alt+\ の再読み込み、アプリから親を付け替えた直後。
   */
  const refreshParents = useCallback(
    (issueIds: string[]) => {
      if (issueIds.length === 0) return
      void repository
        .listIssueParents(issueIds)
        .then((map) => {
          setParentByIssueId(map)
          setParentsLoaded(true)
        })
        .catch((error) => {
          const err =
            error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
          // 読めなかったときは 1 本も引かない。全部を「親が無い」と読み替えると、
          // 同じ期日へ向かう線が束になって菱形の手前を塗り潰す。
          setParentsLoaded(false)
          logAppend({
            level: "warn",
            message: "親 Issue を読めませんでした",
            hint: `${err.message}　マイルストーンへの線は引きません。`,
            dedupeKey: "issue-parents",
          })
        })
    },
    [repository, logAppend],
  )

  const parentsFetched = useRef(new Set<string>())
  useEffect(() => {
    if (!projectId || schedule.load.phase !== "ready") return
    if (schedule.tasks.length === 0) return
    if (parentsFetched.current.has(projectId)) return
    // 結果ではなく発行時点で印を付ける。失敗したものを再描画のたびに叩き直さない
    //（取り直しは再読み込みと親の付け替えが受け持つ）。
    parentsFetched.current.add(projectId)
    refreshParents(schedule.tasks.map((task) => task.issueId))
  }, [projectId, schedule.load.phase, schedule.tasks, refreshParents])

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
   * リポジトリのラベル・担当候補・Milestone を、まだ無ければ取っておく。
   * 詳細を開いたタスクだけでなく新規 Issue の作成先でも要るので、
   * 「どのリポジトリの分か」を引数にして両方から呼べる形にしている。
   *
   * 「取りに行ったか」は結果ではなく発行時点で記録する。取得できたかどうかで
   * 判断すると、失敗したリポジトリを再描画のたびに叩き直すことになるため。
   * 取り直したいときは Alt+\ がある。
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
        !assigneesByRepo[repositoryId] &&
        !attempted.current.has(`assignees:${repositoryId}`)
      ) {
        attempted.current.add(`assignees:${repositoryId}`)
        void repository
          .listAssignableUsers(repositoryId)
          .then((list) => setAssigneesByRepo((prev) => ({ ...prev, [repositoryId]: list })))
          .catch((error) => {
            const err =
              error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
            logAppend({
              level: "warn",
              message: "担当の候補を取得できませんでした",
              hint: `${err.message}　担当を付け替えられません。`,
              dedupeKey: `assignees:${repositoryId}`,
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
    [repository, labelsByRepo, assigneesByRepo, milestonesByRepo, logAppend],
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

  // マイルストーンの作成先の分
  useEffect(() => {
    if (!newMilestoneRepositoryId && repositories[0]) {
      setNewMilestoneRepositoryId(repositories[0].id)
    }
  }, [repositories, newMilestoneRepositoryId])

  // 作成した分は既存の一覧に足す形で持つ。開いた時点で取りに行かせておかないと、
  // 一度も候補を引いていないリポジトリでは「作ったものだけが一覧」になり、
  // 取得済みと見なされて既存のマイルストーンが二度と読まれない。
  useEffect(() => {
    if (!milestoneOpen) return
    ensureRepoMeta(newMilestoneRepositoryId)
  }, [ensureRepoMeta, milestoneOpen, newMilestoneRepositoryId])

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
  /**
   * 開いていたタスクが一覧から消えたら、閉じたことをログに残す。
   *
   * 再読み込みや削除で消えると openTask が null になり、モーダルが黙って
   * 畳まれる。書きかけがあった場合、何が起きたのか画面に何も残らない。
   */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (openTaskId !== null && openTask === null && wasOpen.current) {
      setOpenTaskId(null)
      logAppend({
        level: "warn",
        message: "開いていた Issue が一覧から消えたため、詳細を閉じました",
        hint: "再読み込みか削除で無くなった可能性があります。編集中だった内容は送られていません。",
      })
    }
    wasOpen.current = openTask !== null
  }, [openTaskId, openTask, logAppend])

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
   * 循環した依存（企画書 §15.1）。Gantt では赤い破線になるが、グループを畳んでいれば
   * 線そのものが出ない。気づける場所を Gantt の外にも置く。
   */
  /**
   * フィールド値を読み切れていないタスク（企画書 §7.3.2）。
   *
   * Projects v2 は値の入っている全フィールドを返すので、独自フィールドが多いと
   * Start Date / Target Date が後ろへ押し出される。押し出されると日付が null に
   * なってバーが盤面から消える — 「未設定だから出ない」と区別が付かないので、
   * 消えた理由を画面に出す。
   */
  const truncated = useMemo(
    () => schedule.tasks.filter((t) => !t.fieldsComplete).map((t) => t.issueNumber),
    [schedule.tasks],
  )
  const truncatedKey = truncated.join(",")
  useEffect(() => {
    // 読み切れるようになったら行を消す。残しておくと、直したのに直っていないように
    // 見える。dedupeKey は出し直したときに差し替えるだけで、消しはしない。
    if (truncated.length === 0) {
      logResolve("fields-truncated")
      return
    }
    logAppend({
      level: "warn",
      message: `${truncated.map((n) => `#${n}`).join(", ")} はフィールドを読み切れていません`,
      hint:
        "Project のフィールドが多く、日付が取得できていません。日付が空でも" +
        "「未設定」とは限りません。Project のフィールドを減らすと解消します。",
      dedupeKey: "fields-truncated",
    })
    // 中身が変わったときだけ出し直す。tasks は同期のたびに新しくなるので、
    // 配列そのものを依存にすると警告がログの中を飛び回る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truncatedKey, logAppend, logResolve])

  const cycles = useMemo(() => detectCycles(schedule.tasks).cycles, [schedule.tasks])
  // 前に出した循環の一覧。同じ内容なら出し直さない。
  //
  // dedupeKey は行を積み増さないだけで、出し直せば時刻が更新されて末尾に動く。
  // tasks は同期のたびに新しくなるので、それだけで警告がログの中を飛び回る。
  //
  // 保持するのは「前に出した循環の dedupeKey」。件数や連結文字列ではなく個々の鍵を
  // 覚えておかないと、2 つあった循環の片方だけを直したときに、残った方まで
  // 消してしまうか、直した方が残り続けるかのどちらかになる。
  const loggedCycles = useRef<string[]>([])
  useEffect(() => {
    const keys = cycles.map((c) => `cycle:${c.taskIds.join(">")}`)
    const same =
      keys.length === loggedCycles.current.length &&
      keys.every((k, i) => k === loggedCycles.current[i])
    if (same) return

    // 消えた循環の行を取り下げる。blocked-by を外して直したのに警告が残っていると、
    // 直っていないのか、ログが古いだけなのかが画面から区別できない。
    for (const old of loggedCycles.current) {
      if (!keys.includes(old)) logResolve(old)
    }
    const before = loggedCycles.current
    loggedCycles.current = keys

    // 前から出ている循環は出し直さない。出し直すと時刻が更新されてログの末尾へ
    // 動くので、直っていない古い循環が「たったいま起きた」ように見える。
    for (const cycle of cycles) {
      if (before.includes(`cycle:${cycle.taskIds.join(">")}`)) continue
      logAppend({
        level: "warn",
        message: formatCycle(cycle),
        hint:
          "依存が循環しています。自動の日程調整はこの循環を対象外にします。" +
          "どちらかの Issue の blocked-by を外してください。",
        dedupeKey: `cycle:${cycle.taskIds.join(">")}`,
      })
    }
  }, [cycles, logAppend, logResolve])

  /**
   * 親カテゴリの保存。
   *
   * この設定は以後の Gantt の並び全体を黙って変えるので、いつ誰が変えたのかを
   * 追えるようログにも残す。
   */
  /**
   * 親カテゴリの増減だけを保存する。
   *
   * saveCategories と保存先は同じだが、あちらはカテゴリ設定のモーダルを
   * 閉じるところまでやる。詳細モーダルから呼ぶと関係ないモーダルが閉じるので、
   * 保存とログだけを行う経路を分ける。
   */
  const designateParentLabels = useCallback(
    async (names: string[]) => {
      if (!projectId) return
      try {
        await saveParentLabels(projectId, names)
        setParentLabels(names)
        logAppend({
          level: "info",
          message:
            names.length > 0
              ? `親カテゴリを ${names.join(" / ")} にしました`
              : "親カテゴリを解除しました",
        })
      } catch (error) {
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({ level: "error", message: "親カテゴリを保存できませんでした", hint: detail })
      }
    },
    [projectId, logAppend],
  )

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
   * 設定画面の保存。ウィンドウは Rust 側が保存と同時に窓へ反映する。
   * 反映まで含めて成功したときだけ画面の値を進める。
   *
   * 自動の日程調整は保存先が別なので続けて書く。以後の日付操作が黙って変わる
   * 設定なので、カテゴリと同じくログにも残す。変わっていなければ書かない。
   */
  /**
   * 設定画面の保存。
   *
   * 3 つの設定は保存先が別なので、1 つ失敗しても残りは試す。ひとつの try で
   * 直列に書くと、最初の 1 件が失敗した時点で残りが実行されず、しかも画面には
   * 「設定を保存できませんでした」としか出ない — どれが保存されてどれが
   * されなかったのかが分からなかった。
   *
   * 成功したものはその場で画面に反映し、失敗したものだけを名指しで出す。
   */
  const saveWindow = useCallback(
    async (next: WindowSettings, nextAutoReschedule: boolean, nextTheme: GanttTheme) => {
      setSavingWindow(true)
      const failed: string[] = []
      const details: string[] = []

      /** 1 件ぶんの保存。失敗しても投げず、名前を控えて次へ進む。 */
      const attempt = async (name: string, save: () => Promise<void>) => {
        try {
          await save()
          return true
        } catch (error) {
          failed.push(name)
          details.push(
            `${name}: ${
              typeof error === "object" && error !== null && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error)
            }`,
          )
          return false
        }
      }

      const savedWindow = await attempt("ウィンドウ", async () => {
        await saveWindowSettings(next)
        setWindowSettings(next)
      })

      if (nextAutoReschedule !== autoReschedule) {
        const ok = await attempt("日程の自動調整", async () => {
          await saveAutoReschedule(nextAutoReschedule)
          setAutoReschedule(nextAutoReschedule)
        })
        if (ok) {
          logAppend({
            level: "info",
            message: nextAutoReschedule
              ? "依存に合わせた日程の自動調整を有効にしました"
              : "依存に合わせた日程の自動調整をやめました",
          })
        }
      }

      if (nextTheme !== ganttTheme) {
        const ok = await attempt("盤面の見た目", async () => {
          await saveTheme(nextTheme)
          setGanttTheme(nextTheme)
        })
        if (ok) {
          logAppend({ level: "info", message: `盤面の見た目を ${nextTheme} にしました` })
        }
      }

      if (savedWindow) {
        logAppend({
          level: "info",
          message:
            next.mode === "windowed"
              ? `ウィンドウを ${next.width}×${next.height} にしました`
              : next.mode === "maximized"
                ? "ウィンドウを最大化しました"
                : "フルスクリーンにしました",
        })
      }

      if (failed.length > 0) {
        logAppend({
          level: "error",
          message: `${failed.join(" / ")} を保存できませんでした`,
          hint: `${details.join(" / ")}　他の設定は保存されています。`,
        })
      } else {
        // 全部保存できたときだけ閉じる。失敗が残っているのに畳むと、
        // 何が保存されなかったのかを確かめる場所が無くなる。
        setSettingsOpen(false)
      }
      setSavingWindow(false)
    },
    [logAppend, autoReschedule, ganttTheme],
  )

  /**
   * 親 Issue（sub-issue）の読み書き。
   *
   * 一覧の取得には混ぜていないので、詳細を開いたときにここから引く。
   * sub-issue が使えない GitHub では失敗するが、その場合は欄が出ないだけ。
   */
  const loadParentIssue = useCallback(
    (issueId: string) => repository.getParentIssue(issueId),
    [repository],
  )

  const changeParentIssue = useCallback(
    async (issueId: string, parentIssueId: string | null) => {
      try {
        await repository.setParentIssue(issueId, parentIssueId)
        // 線は「親を持たないタスクからだけ」引くので、付け替えたら取り直さないと
        // 盤面の線が実際の親子関係とずれたままになる。
        refreshParents(schedule.tasks.map((task) => task.issueId))
        logAppend({
          level: "info",
          message: parentIssueId ? "親 Issue を設定しました" : "親 Issue を外しました",
        })
      } catch (error) {
        logAppend({
          level: "error",
          message: "親 Issue を変更できませんでした",
          hint: describeError(
            error instanceof GitHubError ? error : new GitHubError("unknown", String(error)),
          ).hint,
        })
        throw error
      }
    },
    [repository, logAppend, refreshParents, schedule.tasks],
  )

  /**
   * サインアウト。資格情報ストアのトークンを消す。
   *
   * 消したあとはサインイン画面へ戻す必要があるが、その状態は上位が持っている。
   * ここでは消したことをログに残し、再読み込みで判定をやり直させる。
   */
  const signOut = useCallback(async () => {
    try {
      const { auth } = await import("@zukunft/github/tauri")
      await auth.signOut()
      logAppend({ level: "info", message: "サインアウトしました" })
      window.location.reload()
    } catch (error) {
      logAppend({
        level: "error",
        message: "サインアウトできませんでした",
        hint:
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error),
      })
    }
  }, [logAppend])

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

  /**
   * マイルストーンを作る。
   *
   * リポジトリの指定だけ node id ではなく nameWithOwner を渡す。GraphQL に
   * milestone の mutation が無く、作成は REST（owner/repo で引く）でしか行えないため。
   * 作ったものは候補一覧に足す — 盤面の固定行と TaskModal の選択肢は
   * どちらもここを見ているので、取り直さなくても両方に出る。
   */
  const createMilestone = useCallback(
    async (repositoryId: string, input: NewMilestoneInput, category: string) => {
      const repo = repositories.find((r) => r.id === repositoryId)
      if (!repo) {
        logAppend({
          level: "error",
          message: "マイルストーンを作成できませんでした",
          hint: "作成先のリポジトリが分かりません。再読み込みしてください。",
        })
        return
      }
      setCreatingMilestone(true)
      try {
        const created = await repository.createMilestone(repo.nameWithOwner, input)
        setMilestonesByRepo((prev) => ({
          ...prev,
          [repositoryId]: [...(prev[repositoryId] ?? []), created],
        }))
        // カテゴリの割り当ては node id を鍵にするので、作成が返るまで書けない。
        if (category !== "") {
          try {
            await saveMilestoneCategory(created.id, category)
            setMilestoneCategories((prev) => ({ ...prev, [created.id]: category }))
          } catch {
            // 作成そのものは済んでいる。ここを作成の失敗として扱うと、
            // GitHub にはあるものが作れなかったように見える。
            logAppend({
              level: "warn",
              message: `マイルストーン「${created.title}」のカテゴリを保存できませんでした`,
              hint: "盤面の菱形に色が付きません。菱形を押すと割り当て直せます。",
            })
          }
        }
        setMilestoneOpen(false)
        logAppend({
          level: "info",
          message: `マイルストーン「${created.title}」を作成しました`,
          hint: created.dueOn
            ? undefined
            : "期日が無いため盤面には出ません。GitHub 上で期日を設定すると出ます。",
        })
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "マイルストーンを作成できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      } finally {
        setCreatingMilestone(false)
      }
    },
    [repository, repositories, logAppend],
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

  /** Priority の変更。選んだ時点で送るので、失敗はログでだけ知らせる。 */
  const changePriority = useCallback(
    async (taskId: string, optionId: string | null) => {
      try {
        const updated = await updatePriority(taskId, optionId)
        if (updated) {
          logAppend({
            level: "info",
            message: `#${updated.issueNumber} の Priority を ${updated.priority ?? "—"} にしました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Priority を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [updatePriority, logAppend],
  )

  /** Progress の変更。入力を離れた時点で送るので、失敗はログでだけ知らせる。 */
  const changeProgress = useCallback(
    async (taskId: string, value: number | null) => {
      try {
        const updated = await updateProgress(taskId, value)
        if (updated) {
          logAppend({
            level: "info",
            message: `#${updated.issueNumber} の Progress を ${
              updated.progress === null ? "—" : `${updated.progress}%`
            } にしました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        logAppend({
          level: "error",
          message: "Progress を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [updateProgress, logAppend],
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
    async (input: NewTaskInput, dailyRule: RecurrenceRule | null) => {
      try {
        const created = await sendCreateTask(input)
        setCreatingOpen(false)
        if (created) {
          logAppend({
            level: "info",
            message: `#${created.issueNumber} ${created.title} を作成しました`,
          })
          // 日課の設定はアプリ側にしか無く、鍵は作ってみるまで分からない task id。
          // ここが失敗しても Issue は既にあるので、起票そのものは成功として扱い、
          // 「日課にならなかった」ことだけを warn で残す。
          if (dailyRule !== null && projectId) {
            try {
              await saveDailyTask(projectId, created.id, dailyRule, [])
              setDailyTasks((prev) => ({
                ...prev,
                [created.id]: { rule: dailyRule, done: [] },
              }))
            } catch (error) {
              logAppend({
                level: "warn",
                message: `#${created.issueNumber} を日課にできませんでした`,
                hint: `Issue は作成されています。詳細を開いて日課を設定してください（${String(error)}）`,
              })
            }
          }
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
    [sendCreateTask, logAppend, projectId],
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
  const anyModalOpen =
    creatingOpen ||
    milestoneOpen ||
    categoryOpen ||
    openMilestoneId !== null ||
    settingsOpen ||
    manualOpen ||
    openTaskId !== null

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // 文字を打っている最中は取り消しも拡大も渡さない。本文欄で Ctrl+Z を
      // 押したときに、テキストではなく盤面の日付が戻っていた。
      if (isTyping()) return
      // モーダルを開いている間も裏の盤面を動かさない。閉じたときにどこを
      // 見ていたのか分からなくなる。
      if (anyModalOpen) return
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
  }, [undo, redo, stepZoom, anyModalOpen])

  /**
   * 再読み込み（Alt+\）。スキーマとタスクを取り直し、そのときの同期状況をログに出す。
   * スキーマも一緒に取り直すのは、GitHub 側でフィールドを足した直後に
   * タスクだけ取り直しても編集が閉じたままになるため。
   */
  const reloadAll = useCallback(() => {
    onReloadSchema()
    reload()
    // 親子関係も取り直す。GitHub 側で付け替えられていても、ここを通さないと
    // 線が古いままになる。
    refreshParents(schedule.tasks.map((task) => task.issueId))
    logSyncStanding()
  }, [onReloadSchema, reload, refreshParents, schedule.tasks, logSyncStanding])

  /**
   * 日付の変更。押し出しを伴うかどうかは設定で決まるので、ここで足してから渡す。
   *
   * 依存は設定と changeDates の 2 つだけに保つ。これも GanttChart に渡る props で、
   * 描画のたびに別物になると keydown リスナが張り直される。
   */
  const changeTaskDates = useCallback(
    (taskId: string, change: DateChange) => {
      changeDates(taskId, change, { autoReschedule })
    },
    [changeDates, autoReschedule],
  )

  /**
   * 盤面に出すマイルストーンの候補。リポジトリ単位で取ったものを 1 本に並べる。
   *
   * Issue から集めた分だけを渡すと、まだ Issue の付いていないマイルストーンが
   * 盤面に出ない。畳み込みと期日順の整理は GanttChart の中（mergeMilestones）に任せる。
   * useMemo なのは、毎レンダリング別の配列になると盤面の再計算が止まらないため。
   */
  const allMilestones = useMemo(() => {
    // リポジトリごとの一覧は、そのリポジトリを触るまで取りに行かない。
    // 一覧がまだ無くても Issue 側から盤面に出るものがあるので、タスクが持つ分も
    // ここに混ぜる。混ぜないと、そういうマイルストーンだけ色が付かない
    // （題名の重複は GanttChart の mergeMilestones が畳む）。
    const known: Milestone[] = [...Object.values(milestonesByRepo).flat()]
    for (const task of schedule.tasks) if (task.milestone) known.push(task.milestone)

    // ラベル名 -> 色。Label.color は # の付かない 6 桁 hex なので前置する。
    const colorByName = new Map(labelCandidates.map((l) => [l.name, l.color]))
    return known.map((m) => {
      const color = colorByName.get(milestoneCategories[m.id] ?? "")
      return color ? { ...m, color: `#${color}` } : m
    })
  }, [milestonesByRepo, schedule.tasks, labelCandidates, milestoneCategories])

  /** カテゴリを割り当てるために開いているマイルストーン。題名を画面に出すために引く。 */
  const openMilestone = useMemo(
    () => allMilestones.find((m) => m.id === openMilestoneId) ?? null,
    [allMilestones, openMilestoneId],
  )

  /**
   * 日課の点を押したとき。その日を「実行した／していない」で入れ替える。
   *
   * GitHub には何も送らない。先に画面を進め、保存に失敗したときだけ戻す。
   * 保存を待ってから進めると、待っているあいだに押した点が消えるため。
   */
  const toggleDailyDone = useCallback(
    async (taskId: string, date: ISODate) => {
      const current = dailyTasksRef.current[taskId]
      if (!current || !projectId) return
      const next = toggleDone(current, date)
      // 先に画面を進める。保存を待ってから進めると、待っているあいだの押下が
      // 消える。失敗したときは同じ日をもう一度切り替えて戻す（あいだに押された
      // 別の日はそのまま残る）。
      dailyTasksRef.current = { ...dailyTasksRef.current, [taskId]: next }
      setDailyTasks(dailyTasksRef.current)
      try {
        await saveDailyTask(projectId, taskId, next.rule, next.done)
      } catch (error) {
        const reverted = dailyTasksRef.current[taskId]
        if (reverted) {
          dailyTasksRef.current = {
            ...dailyTasksRef.current,
            [taskId]: toggleDone(reverted, date),
          }
          setDailyTasks(dailyTasksRef.current)
        }
        // GitHub 呼び出しではないので GitHubError には包まない。
        // Rust 側は { kind, message } を reject するため、message だけ拾う。
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({ level: "error", message: "日課の記録を保存できませんでした", hint: detail })
      }
    },
    // dailyTasks は依存に入れない。読むのは常に控え（dailyTasksRef）の方で、
    // ここに入れると点を 1 つ押すたびにハンドラが作り直され、盤面の全行が
    // 描き直される。
    [logAppend, projectId],
  )

  /**
   * 日課にする / 繰り返し方を変える / やめる（rule が null）。
   *
   * 実行した日は繰り返し方を変えても引き継ぐ。間隔の打ち間違いを直しただけで
   * これまでの記録が消えるのでは、直す気にならない。
   */
  const changeDaily = useCallback(
    async (taskId: string, rule: RecurrenceRule | null) => {
      if (!projectId) return
      const done = dailyTasks[taskId]?.done ?? []
      try {
        await saveDailyTask(projectId, taskId, rule, done)
        setDailyTasks((prev) => {
          const next = { ...prev }
          // null は「日課をやめる」。設定側も項目ごと消えるので、手元も消す。
          if (rule === null) delete next[taskId]
          else next[taskId] = { rule, done }
          return next
        })
      } catch (error) {
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({ level: "error", message: "日課の設定を保存できませんでした", hint: detail })
      }
    },
    [dailyTasks, logAppend, projectId],
  )

  /**
   * マイルストーンのカテゴリを決める（空文字で外す）。
   *
   * GitHub には何も送らない。保存できたときだけ手元の割り当てを差し替えるので、
   * 失敗したときに画面だけ色が変わって残ることはない。
   */
  const assignMilestoneCategory = useCallback(
    async (milestoneId: string, label: string) => {
      setSavingMilestoneCategory(true)
      try {
        await saveMilestoneCategory(milestoneId, label)
        setMilestoneCategories((prev) => {
          const next = { ...prev }
          if (label === "") delete next[milestoneId]
          else next[milestoneId] = label
          return next
        })
        setOpenMilestoneId(null)
      } catch (error) {
        // GitHub 呼び出しではないので GitHubError には包まない。
        // Rust 側は { kind, message } を reject するため、message だけ拾う。
        const detail =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        logAppend({
          level: "error",
          message: "マイルストーンのカテゴリを保存できませんでした",
          hint: detail,
        })
      } finally {
        setSavingMilestoneCategory(false)
      }
    },
    [logAppend],
  )

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
  // / で絞り込みの入力欄へ飛ぶ。打っている最中は拾わない。
  useEffect(() => {
    if (anyModalOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.altKey || e.ctrlKey || e.metaKey) return
      if (isTyping()) return
      const input = document.querySelector<HTMLInputElement>("[data-zk-filter-input]")
      if (!input) return
      e.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [anyModalOpen])

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
      if (isTyping()) return
      // モーダルを開いている間は、マニュアルの開閉だけ通す。起票や再読み込みを
      // 通すと、開いているモーダルの上にもう 1 枚重なる。
      if (anyModalOpen && e.code !== "KeyM") return
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
      } else if (RELOAD_CODES.has(e.code)) {
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
  }, [projectId, reloadAll, groupBy, onGroupBy, stepZoom, anyModalOpen])

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
      {/* 起票の隣に置く。どちらも「盤面に無いものを作る」操作で、
          マイルストーンだけカテゴリ設定側に置くと探すことになる。 */}
      <button
        className="zk-button"
        onClick={() => setMilestoneOpen(true)}
        disabled={!projectId}
      >
        New Milestone
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
    <div className="zk-shell" data-gantt-theme={ganttTheme}>
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
        tasks={visibleTasks}
        statusOrder={statuses}
        zoom={zoom}
        groupBy={groupBy}
        parentLabels={parentLabels}
        milestones={allMilestones}
        // 線は「親を持たないタスク」からだけ引く。読めなかった Issue は
        // ここに載らず、そのぶんは引かれない（読み取り専用ビューは渡さない）。
        parentByIssueId={parentsLoaded ? parentByIssueId : undefined}
        onMilestoneOpen={setOpenMilestoneId}
        dailyTasks={dailyTasks}
        // 点はここでは常に押せる。実行した記録の行き先はアプリの設定だけで、
        // GitHub にも Project のフィールドにも何も送らないため。
        // 押せないのは読み取り専用ビュー（apps/web）— あちらはこの props を渡さない。
        onToggleDailyDone={toggleDailyDone}
        theme={ganttTheme}
        onTaskDatesChange={changeTaskDates}
        readOnly={!editable}
        onTaskOpen={openTaskDetail}
        onTaskEdit={openTaskForEdit}
        // モーダルが開いている間は j / k で裏の一覧を動かさない。
        keyboardEnabled={!anyModalOpen}
        emptyMessage={
          schedule.load.phase === "loading"
            ? "読み込み中…"
            : isFilterActive(filter)
              ? "絞り込みに一致する Issue がありません。条件を外すと全件に戻ります。"
              : "この Project にまだ Issue がありません。GitHub で Issue を Project に追加してください。"
        }
        toolbar={toolbar}
        subHeader={
          projectId ? (
            <FilterBar
              filter={filter}
              choices={choices}
              shown={visibleTasks.length}
              total={schedule.tasks.length}
              onChange={setFilter}
            />
          ) : null
        }
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
          parentLabels={parentLabels}
          labelCatalog={labelCandidates}
          availableMilestones={milestonesByRepo[newTaskRepositoryId] ?? []}
          onCreateLabel={createLabel}
          onDeleteLabel={deleteLabel}
          onCreate={createTask}
          onClose={() => setCreatingOpen(false)}
        />
      )}
      {milestoneOpen && (
        <NewMilestoneModal
          repositories={repositories}
          repositoryId={newMilestoneRepositoryId}
          onChangeRepository={setNewMilestoneRepositoryId}
          candidates={labelCandidates}
          busy={creatingMilestone}
          onCreate={createMilestone}
          onClose={() => setMilestoneOpen(false)}
        />
      )}
      {/* 盤面の菱形から開く割り当て。候補が届く前でも開けるよう、
          マイルストーンが引けたことだけを条件にする。 */}
      {openMilestone && (
        <MilestoneCategoryModal
          title={openMilestone.title}
          candidates={labelCandidates}
          selected={milestoneCategories[openMilestone.id] ?? null}
          busy={savingMilestoneCategory}
          onSelect={(label) => void assignMilestoneCategory(openMilestone.id, label)}
          onClose={() => setOpenMilestoneId(null)}
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
      {pendingOpen && (
        <PendingChanges
          queue={schedule.queue}
          tasks={schedule.tasks}
          onRollback={rollback}
          onClose={() => setPendingOpen(false)}
        />
      )}
      {manualOpen && (
        <ManualModal statuses={statuses} onClose={() => setManualOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={windowSettings}
          autoReschedule={autoReschedule}
          theme={ganttTheme}
          busy={savingWindow}
          applies={isTauri()}
          authSource={authSource}
          onSignOut={isTauri() ? signOut : undefined}
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
          savingField={schedule.savingField}
          priorityOptions={priorityOptions}
          canEditProgress={canEditProgress}
          availableLabels={labelsByRepo[openTask.repositoryId] ?? []}
          availableAssignees={assigneesByRepo[openTask.repositoryId] ?? []}
          parentLabels={parentLabels}
          labelCatalog={labelCandidates}
          onDesignateParentLabels={designateParentLabels}
          onLoadParentIssue={loadParentIssue}
          onChangeParentIssue={changeParentIssue}
          allTasks={schedule.tasks}
          availableMilestones={milestonesByRepo[openTask.repositoryId] ?? []}
          onCreateLabel={createLabel}
          onDeleteLabel={deleteLabel}
          onChangeDates={changeTaskDates}
          onChangeStatus={changeStatus}
          onChangePriority={changePriority}
          onChangeProgress={changeProgress}
          onSaveContent={saveContent}
          onSetState={changeIssueState}
          onDelete={deleteTask}
          daily={dailyTasks[openTask.id] ?? null}
          onChangeDaily={changeDaily}
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
