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
import { GanttChart, Sidebar } from "@zukunft/gantt"
import { GitHubError, describeError, statusOrder } from "@zukunft/github"
import type { GitHubScheduleRepository } from "@zukunft/github"
import { getRepository, isTauri } from "@/repository"
import { SignIn } from "@/SignIn"
import { CategorySettings } from "@/CategorySettings"
import { LogPane } from "@/LogPane"
import { NewTaskModal } from "@/NewTaskModal"
import { TaskModal } from "@/TaskModal"
import { useLog } from "@/log"
import { loadParentLabels, saveParentLabels } from "@/settings"
import { useSchedule } from "@/useSchedule"

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
      } catch {
        if (alive) setSignedIn(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

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
        <ErrorPanel error={bootError} />
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
  const missing = useMemo(() => (schema ? missingRequiredFields(schema) : []), [schema])
  const statuses = useMemo(() => (schema ? statusOrder(schema) : []), [schema])
  // Status の変更には選択肢の ID が要る。名前だけの statuses とは別に持つ。
  const statusOptions = useMemo(
    () => (schema ? resolveField(schema, "status", "SINGLE_SELECT")?.options ?? [] : []),
    [schema],
  )
  const editable = useMemo(() => canEditDates(schema), [schema])

  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const openTask = schedule.tasks.find((t) => t.id === openTaskId) ?? null

  const [creatingOpen, setCreatingOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  // 親カテゴリとして扱うラベル名。GitHub ではなくアプリ側の設定（Project ごと）。
  const [parentLabels, setParentLabels] = useState<string[]>([])
  const [savingCategories, setSavingCategories] = useState(false)
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
  const logged = useRef<Set<string>>(new Set())

  // 読み込み失敗をログへ
  useEffect(() => {
    if (schedule.load.phase !== "error") return
    const info = describeError(schedule.load.error)
    log.append({
      level: "error",
      message: info.title,
      hint: `${schedule.load.error.message}　${info.hint}`,
      dedupeKey: "load",
      actions: [{ label: "再試行", run: schedule.reload }],
    })
  }, [schedule.load, schedule.reload, log])

  // Project の設定不足を一度だけ警告する
  useEffect(() => {
    if (!schema || missing.length === 0) return
    const key = `setup:${schema.projectId}`
    if (logged.current.has(key)) return
    logged.current.add(key)
    // 実在するフィールド名も出す。名前が少しでも違うと一致しないため、
    // 「作ったのに認識されない」場合の切り分けに要る。
    const present = schema.fields.map((f) => `${f.name} (${f.dataType})`).join(", ")
    log.append({
      level: "warn",
      message: "Project の設定が足りません",
      hint:
        `${missing.map((f) => `${f.name} (${f.expectedType})`).join(" / ")} が必要です。` +
        `　現在のフィールド: ${present || "なし"}` +
        `　大文字小文字と空白は無視するので Start date / End date / Due date なども可。` +
        `　作成したら「再読み込み」を押してください。`,
      dedupeKey: key,
    })
  }, [schema, missing, log])

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
        log.append({
          level: "warn",
          message: "GitHub 側が更新されています",
          hint: remote
            ? `ローカル: ${range}　/　GitHub: ${remote.startDate} → ${remote.endDate}`
            : range,
          dedupeKey: key,
          actions: [
            { label: "GitHub 側を採用", run: () => schedule.keepRemote(mutation.id) },
            { label: "ローカルで上書き", run: () => schedule.keepLocal(mutation.id) },
          ],
        })
      } else {
        log.append({
          level: "error",
          message: "GitHub に反映できませんでした",
          hint: `${range}　${mutation.error ?? ""}`,
          dedupeKey: key,
          actions: [
            { label: "再試行", run: () => schedule.retry(mutation.id) },
            { label: "取り消す", run: () => schedule.rollback(mutation.id), danger: true },
          ],
        })
      }
    }
    for (const key of [...logged.current]) {
      if (key.startsWith("mut:") && !active.has(key)) {
        logged.current.delete(key)
        log.resolve(key)
      }
    }
  }, [schedule.queue, schedule.keepRemote, schedule.keepLocal, schedule.retry, schedule.rollback, log])

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
        log.append({
          level: "warn",
          message: "リポジトリ一覧を取得できませんでした",
          hint: `${err.message}　新規 Issue の作成先を選べません。`,
          dedupeKey: "repos",
        })
      })
    return () => {
      alive = false
    }
  }, [repository, projectId, log])

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
   */
  const ensureRepoMeta = useCallback(
    (repositoryId: string) => {
      if (!repositoryId) return
      if (!labelsByRepo[repositoryId]) {
        void repository
          .listLabels(repositoryId)
          .then((list) => setLabelsByRepo((prev) => ({ ...prev, [repositoryId]: list })))
          .catch((error) => {
            const err =
              error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
            log.append({
              level: "warn",
              message: "ラベル一覧を取得できませんでした",
              hint: `${err.message}　既存ラベルを選べません。`,
              dedupeKey: `labels:${repositoryId}`,
            })
          })
      }
      if (!milestonesByRepo[repositoryId]) {
        void repository
          .listMilestones(repositoryId)
          .then((list) => setMilestonesByRepo((prev) => ({ ...prev, [repositoryId]: list })))
          .catch((error) => {
            const err =
              error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
            log.append({
              level: "warn",
              message: "Milestone 一覧を取得できませんでした",
              hint: `${err.message}　Milestone を付け替えられません。`,
              dedupeKey: `milestones:${repositoryId}`,
            })
          })
      }
    },
    [repository, labelsByRepo, milestonesByRepo, log],
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
        log.append({
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
        log.append({
          level: "error",
          message: "カテゴリ設定を保存できませんでした",
          hint: detail,
        })
      } finally {
        setSavingCategories(false)
      }
    },
    [projectId, log],
  )

  const createLabel = useCallback(
    async (repositoryId: string, name: string, color: string): Promise<Label | null> => {
      try {
        const created = await repository.createLabel(repositoryId, name, color)
        setLabelsByRepo((prev) => ({
          ...prev,
          [repositoryId]: [...(prev[repositoryId] ?? []), created],
        }))
        log.append({ level: "info", message: `ラベル「${created.name}」を作成しました` })
        return created
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "ラベルを作成できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return null
      }
    },
    [repository, log],
  )

  const deleteLabel = useCallback(
    async (repositoryId: string, label: Label): Promise<boolean> => {
      try {
        await repository.deleteLabel(label.id)
        setLabelsByRepo((prev) => ({
          ...prev,
          [repositoryId]: (prev[repositoryId] ?? []).filter((l) => l.id !== label.id),
        }))
        log.append({ level: "info", message: `ラベル「${label.name}」を削除しました` })
        // 消えたラベルは付いていた Issue すべてから外れる。手元のタスクは
        // そのラベルを持ったままなので、取り直さないと Gantt や Category
        // グループが存在しないラベルを表示し続ける。
        schedule.reload()
        return true
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "ラベルを削除できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return false
      }
    },
    [repository, schedule, log],
  )

  const saveContent = useCallback(
    async (taskId: string, issueId: string, content: TaskContent) => {
      try {
        const updated = await schedule.updateContent(taskId, issueId, content)
        log.append({
          level: "info",
          message: `#${updated.issueNumber} の内容を保存しました`,
        })
        return updated
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "Issue の内容を保存できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
        return null
      }
    },
    [schedule, log],
  )

  /** Status の変更。選んだ時点で送るので、失敗はログでだけ知らせる。 */
  const changeStatus = useCallback(
    async (taskId: string, optionId: string) => {
      try {
        const updated = await schedule.updateStatus(taskId, optionId)
        if (updated) {
          log.append({
            level: "info",
            message: `#${updated.issueNumber} の Status を ${updated.status ?? "—"} にしました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "Status を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [schedule, log],
  )

  /** クローズ / リオープン。押した時点で送るので、失敗はログでだけ知らせる。 */
  const changeIssueState = useCallback(
    async (taskId: string, issueId: string, state: IssueState) => {
      try {
        const updated = await schedule.setTaskState(taskId, issueId, state)
        log.append({
          level: "info",
          message: `#${updated.issueNumber} を${state === "CLOSED" ? "クローズ" : "リオープン"}しました`,
        })
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "Issue の状態を変更できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [schedule, log],
  )

  /** Issue の削除。消えた行を開いたままにできないので、成功したら詳細を閉じる。 */
  const deleteTask = useCallback(
    async (taskId: string, issueId: string) => {
      try {
        const removed = await schedule.deleteTask(taskId, issueId)
        setOpenTaskId(null)
        log.append({
          level: "info",
          message: removed ? `#${removed.issueNumber} を削除しました` : "Issue を削除しました",
        })
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "Issue を削除できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [schedule, log],
  )

  const createTask = useCallback(
    async (input: NewTaskInput) => {
      try {
        const created = await schedule.createTask(input)
        setCreatingOpen(false)
        if (created) {
          log.append({
            level: "info",
            message: `#${created.issueNumber} ${created.title} を作成しました`,
          })
        }
      } catch (error) {
        const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
        const info = describeError(err)
        log.append({
          level: "error",
          message: "Issue を作成できませんでした",
          hint: `${err.message}　${info.hint}`,
        })
      }
    },
    [schedule, log],
  )

  // Undo / Redo のキーボードショートカット（企画書 §6.3.4）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault()
        schedule.undo()
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault()
        schedule.redo()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [schedule])

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
      } else if (e.code === "KeyA") {
        // 作成先の Project が決まっていないと起票できない。
        if (!projectId) return
        e.preventDefault()
        setCreatingOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [projectId])

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
      {ZOOM_LEVELS.map((level) => (
        <button
          key={level}
          className="zk-button"
          aria-pressed={zoom === level}
          onClick={() => onZoom(level)}
        >
          {level}
        </button>
      ))}
      <button className="zk-button" disabled={!schedule.canUndo} onClick={schedule.undo}>Undo</button>
      <button className="zk-button" disabled={!schedule.canRedo} onClick={schedule.redo}>Redo</button>
      <button
        className="zk-button"
        onClick={() => {
          onReloadSchema()
          schedule.reload()
        }}
      >
        再読み込み
      </button>
      <button
        className="zk-button"
        onClick={() => setCreatingOpen(true)}
        disabled={!projectId}
      >
        ＋ 新規 Issue (Alt+A)
      </button>
      <button
        className="zk-button"
        onClick={() => setCategoryOpen(true)}
        disabled={!projectId}
      >
        カテゴリ設定
      </button>
      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
        {/* 未解決の競合・失敗を「同期済み」と表示しない（企画書 §19）。 */}
        {summarize(schedule.pending, schedule.queue)}
        {!isTauri() && "　/　モックデータ"}
        {authSource === "env" && "　/　環境変数のトークン"}
      </span>
    </>
  )

  const project = projects.find((p) => p.id === projectId)

  return (
    <div className="zk-shell">
      <Sidebar
        active={groupBy}
        onSelect={onGroupBy}
        footer={project ? project.title : undefined}
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
        onTaskOpen={setOpenTaskId}
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
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  )
}

/** ヘッダの同期サマリ。解決待ちがあるうちは「同期済み」と言わない。 */
function summarize(pending: number, queue: { state: string }[]): string {
  const problems = queue.filter((m) => m.state === "failed" || m.state === "conflict").length
  if (problems > 0) return `要対応 ${problems} 件`
  if (pending > 0) return `未同期 ${pending} 件`
  return "同期済み"
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
