"use client"

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type DateChange,
  type GroupMode,
  type ScheduleTask,
  type ZoomLevel,
  type ISODate,
  type Milestone,
  type Recurrence,
  collectMilestones,
  mergeMilestones,
  createTimeScale,
  defaultTimelineEnd,
  detectCycles,
  isScheduled,
  maxDate,
  milestoneLinkSources,
  resolveDependencies,
  timelineRange,
  today,
} from "@zukunft/domain"
import type { GanttTheme } from "./theme"
import { TaskPane } from "./TaskPane"
import { MILESTONE_FONT_SIZE, Timeline } from "./Timeline"
import { isTyping } from "./keyboard"
import { onAxisMilestones, packMilestones } from "./milestones"
import { buildRows, visibleRange } from "./rows"

const ROW_HEIGHT = 32
/** タイムラインの上に貼り付く月・週ヘッダの高さ。選択行がこの下に隠れないようにする。 */
const THEAD_HEIGHT = 48

/**
 * 盤面に出すリポジトリ側のマイルストーンと、割り当てられたカテゴリの色。
 *
 * ドメインの Milestone は色を持たない（誰の色かを知らない）ので、
 * 設定から引いた色をアプリ側がここで添える。
 */
export type ColoredMilestone = Milestone & { color?: string }

/** 既定値をその場で書くと毎回別の配列になり、行の再計算が止まらなくなる。 */
const EMPTY_PARENTS: string[] = []
const EMPTY_MILESTONES: ColoredMilestone[] = []
const EMPTY_PARENT_BY_ISSUE: Record<string, string | null> = {}
const EMPTY_DAILY_TASKS: Record<string, Recurrence> = {}

export type GanttChartProps = {
  tasks: ScheduleTask[]
  /** Status の定義順。色の割り当てとグループ順序に使う */
  statusOrder: string[]
  zoom: ZoomLevel
  /** グループ分けの基準。サイドバーの表示切り替えに対応する */
  groupBy?: GroupMode
  /**
   * 親カテゴリとして扱うラベル名（アプリの設定）。
   * 指定すると Category 表示が「親 → 残りのラベルの組み合わせ」の 2 階層になる。
   */
  parentLabels?: string[]
  /**
   * 盤面の意匠（Settings の Preference）。
   * 既定は今までの見た目。渡さない読み取り専用ビューもそのまま。
   */
  theme?: GanttTheme
  onTaskDatesChange: (taskId: string, change: DateChange) => void
  /** Web 版（読み取り専用）では true にする（企画書 §9） */
  readOnly?: boolean
  /** 行またはバーをクリックしたとき、または選択中の行で Enter。詳細モーダルを開く用途 */
  onTaskOpen?: (taskId: string) => void
  /** 選択中の行で e。詳細を編集モードで開く用途 */
  onTaskEdit?: (taskId: string) => void
  /**
   * j / k などの 1 打鍵ショートカットを受け付けるか。
   * モーダルが開いている間は false にする。裏の一覧が動くと、
   * 閉じたときにどこを見ていたのか分からなくなる。
   */
  keyboardEnabled?: boolean
  /**
   * リポジトリ側のマイルストーン一覧。Issue が 1 件も付いていないものも
   * 盤面に出すために使う。渡さない読み取り専用ビューは Issue 側だけで描く。
   * color を添えると、その色で菱形を描く。
   */
  milestones?: ColoredMilestone[]
  /**
   * Issue の node id -> 親 Issue の node id（親が無ければ null）。
   *
   * 盤面からマイルストーンへ線を引くのに使う。線は親を持たないタスクからだけ
   * 引くので、載っていないタスクは「親が分からない」として引かない。
   * 渡さない読み取り専用ビューでは 1 本も引かない。
   */
  parentByIssueId?: Record<string, string | null>
  /**
   * 盤面のマイルストーンを押したとき。カテゴリの割り当てを開く用途。
   * 渡さない読み取り専用ビューでは押せないままにする。
   */
  onMilestoneOpen?: (milestoneId: string) => void
  /**
   * 日課の設定（task id -> 間隔と実行した日）。ここにあるタスクは
   * バーではなく実行日の点で描く。日付そのものは Issue の Start / Target Date。
   */
  dailyTasks?: Record<string, Recurrence>
  /**
   * 日課の点を押したとき（その日の実行を入り切りする）。
   * 渡さない読み取り専用ビューでは押せないままにする。
   */
  onToggleDailyDone?: (taskId: string, date: ISODate) => void
  /** タスクが 0 件のときに出す案内 */
  emptyMessage?: ReactNode
  toolbar?: ReactNode
  /** ヘッダの直下に敷く帯。絞り込みなど、盤面の見え方を決めるものを置く */
  subHeader?: ReactNode
}

export function GanttChart({
  tasks, statusOrder, zoom, groupBy = "status", parentLabels = EMPTY_PARENTS,
  theme = "default", onTaskDatesChange, readOnly = false, onTaskOpen, onTaskEdit, keyboardEnabled = true,
  milestones: repositoryMilestones = EMPTY_MILESTONES, emptyMessage, toolbar, subHeader,
  onMilestoneOpen, dailyTasks = EMPTY_DAILY_TASKS, onToggleDailyDone,
  parentByIssueId = EMPTY_PARENT_BY_ISSUE,
}: GanttChartProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // 横軸の右端の指定。null は「既定に従う」— タスクが増えて既定が伸びたら一緒に伸びる。
  // 読み込みより先に開くので、タスクから初期値を作らず null から始める。
  const [endOverride, setEndOverride] = useState<ISODate | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const paneRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  // j / k で動かす選択。クリックでも同じ場所に移る。
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const rows = useMemo(
    () => buildRows(tasks, statusOrder, collapsed, groupBy, parentLabels),
    [tasks, statusOrder, collapsed, groupBy, parentLabels],
  )

  /**
   * 横軸の既定の右端。今日から 1 年先と、進行中（open）の Issue のいちばん先の日付の、
   * 遠いほう。閉じた Issue は数えないので、終わった仕事のために軸が伸び続けることはない。
   */
  const defaultEnd = useMemo(() => {
    const activeEnds = tasks
      .filter(isScheduled)
      .filter((t) => t.issueState === "OPEN")
      .map((t) => t.endDate)
    return defaultTimelineEnd(activeEnds, today())
  }, [tasks])

  const scale = useMemo(() => {
    const dates = tasks.filter(isScheduled).flatMap((t) => [t.startDate, t.endDate])
    const { origin } = timelineRange(dates, today())
    // 左端より手前を右端にはできない。幅が 0 以下になると目盛りも当たり判定も壊れる。
    const end = maxDate(endOverride ?? defaultEnd, origin)
    return createTimeScale(origin, end, zoom)
  }, [tasks, zoom, endOverride, defaultEnd])

  const milestones = useMemo(() => {
    const merged = mergeMilestones(collectMilestones(tasks), repositoryMilestones)
    // mergeMilestones は畳んだ結果を組み立て直すので、渡された色はそこで落ちる。
    // 残るのは id なので、そちらで引き直して差し直す（題名を変えても割り当てが
    // 外れないよう、鍵は題名ではなく id にしてある）。
    const colors = new Map(
      repositoryMilestones.flatMap((m) => (m.color ? [[m.id, m.color] as const] : [])),
    )
    return merged.map((m) => {
      const color = colors.get(m.id)
      return color ? { ...m, color } : m
    })
  }, [tasks, repositoryMilestones])

  /**
   * マイルストーンの段組み。重なる題名は下の段へ送る。
   *
   * 帯の高さは段数で決まり、Timeline・左ペインの見出し・revealRow の視野の
   * 3 か所がこの同じ値を見る。ずれると行が横にずれるか、選択行が帯の裏に隠れる。
   */
  const { placed: placedMilestones, laneCount } = useMemo(
    () =>
      packMilestones(
        onAxisMilestones(milestones, scale.origin, scale.end),
        scale.toX,
        scale.pxPerDay,
        MILESTONE_FONT_SIZE,
      ),
    [milestones, scale],
  )
  const milestoneHeight = laneCount * ROW_HEIGHT
  // 依存関係は Issue 本文の宣言から起こす。折り畳みやズームでは変わらない。
  const dependencies = useMemo(() => resolveDependencies(tasks), [tasks])
  // 循環した依存は成立しない日程を表している。消さずに、そうと分かる線で描く。
  const cyclicEdges = useMemo(
    () => detectCycles(tasks, dependencies).cyclicEdges,
    [tasks, dependencies],
  )
  /**
   * マイルストーンへ引く線。親を持たないタスクからだけ引く（milestoneLinkSources）。
   *
   * id を差し替えているのは、mergeMilestones が同じ題のマイルストーンを 1 つに
   * 畳み、id は先に見た方だけを残すため。畳まれた側の id のまま渡すと、菱形が
   * 見つからず、線だけが黙って消える。
   */
  const milestoneLinks = useMemo(() => {
    const keptIdByTitle = new Map(milestones.map((m) => [m.title, m.id]))
    const titleById = new Map(
      tasks.flatMap((t) => (t.milestone ? [[t.milestone.id, t.milestone.title] as const] : [])),
    )
    return milestoneLinkSources(tasks, parentByIssueId).map((link) => {
      const kept = keptIdByTitle.get(titleById.get(link.milestoneId) ?? "")
      return kept && kept !== link.milestoneId ? { ...link, milestoneId: kept } : link
    })
  }, [tasks, parentByIssueId, milestones])

  const visible = useMemo(
    () => visibleRange(scrollTop, viewportHeight, ROW_HEIGHT, rows.length),
    [scrollTop, viewportHeight, rows.length],
  )

  /**
   * 選択が動ける先。折り畳んだグループの中は行として出ていないので、対象にしない。
   * 画面に見えている並びのまま j / k で降りられるようにする。
   */
  const taskIndexes = useMemo(
    () =>
      rows.flatMap((row, index) => (row.kind === "task" ? [{ id: row.task.id, index }] : [])),
    [rows],
  )

  // 絞り込みや折り畳みで消えた行を選んだままにしない。
  useEffect(() => {
    if (selectedTaskId === null) return
    if (!taskIndexes.some((entry) => entry.id === selectedTaskId)) setSelectedTaskId(null)
  }, [taskIndexes, selectedTaskId])

  /** 選択行がヘッダの下や画面外に隠れないところまでスクロールする。 */
  const revealRow = useCallback((rowIndex: number) => {
    const el = timelineRef.current
    if (!el) return
    const top = rowIndex * ROW_HEIGHT
    // 上に居座る 2 段（月・週ヘッダとマイルストーン帯）は視野ではない。
    // 引かないと、k で上へ戻ったとき選択行が固定行の裏に入って見えなくなる。
    // マイルストーン帯は段が増えると高くなるので、固定値ではなく今の高さを引く。
    const viewHeight = el.clientHeight - THEAD_HEIGHT - milestoneHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + viewHeight) {
      el.scrollTop = top + ROW_HEIGHT - viewHeight
    }
  }, [milestoneHeight])

  const moveSelection = useCallback(
    (delta: number) => {
      if (taskIndexes.length === 0) return
      const current = taskIndexes.findIndex((entry) => entry.id === selectedTaskId)
      // 未選択から k で上に動いたときは末尾から入る。一覧の外から入る唯一の入口なので、
      // 押した向きの端に着けるのが自然。
      const next =
        current === -1
          ? delta > 0
            ? 0
            : taskIndexes.length - 1
          : Math.min(taskIndexes.length - 1, Math.max(0, current + delta))
      const target = taskIndexes[next]
      if (!target) return
      setSelectedTaskId(target.id)
      revealRow(target.index)
    },
    [taskIndexes, selectedTaskId, revealRow],
  )

  /**
   * 1 打鍵のショートカット（j / k / e / Enter）。
   *
   * 修飾キー付きは他の割り当てなので受けない。入力欄に文字を打っている間も
   * 受けない — j と打つたびに裏の選択が動いてはたまらない。
   */
  useEffect(() => {
    if (!keyboardEnabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isTyping()) return
      if (e.code === "KeyJ") {
        e.preventDefault()
        moveSelection(1)
      } else if (e.code === "KeyK") {
        e.preventDefault()
        moveSelection(-1)
      } else if (selectedTaskId === null) {
        return
      } else if (e.code === "KeyE") {
        e.preventDefault()
        onTaskEdit?.(selectedTaskId)
      } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault()
        onTaskOpen?.(selectedTaskId)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [keyboardEnabled, moveSelection, selectedTaskId, onTaskEdit, onTaskOpen])

  /** クリックで開いた行も選択に合わせる。次の j / k がそこから続く。 */
  const openTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId)
      onTaskOpen?.(taskId)
    },
    [onTaskOpen],
  )

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // タイムラインが縦スクロールの基準。左ペインは同じ量だけ内容をずらす
  // （企画書 §6.3.2：縦は連動、横はタイムラインのみ）。
  const onTimelineScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setScrollTop(el.scrollTop)
    setViewportHeight(el.clientHeight)
    if (paneRef.current) paneRef.current.scrollTop = el.scrollTop
  }, [])

  return (
    <>
      <div className="zk-header">
        {toolbar}
        <label className="zk-axis-end">
          <span className="zk-axis-end-label">表示終了日</span>
          <input
            type="date"
            className="zk-input zk-axis-end-input"
            value={scale.end}
            min={scale.origin}
            onChange={(e) => setEndOverride(e.target.value || null)}
          />
          {/* 手で決めた右端は、タスクが増えても動かない。既定に戻す口を残しておく。 */}
          <button
            className="zk-button"
            onClick={() => setEndOverride(null)}
            disabled={endOverride === null}
            title="今日から 1 年先か、進行中の Issue のいちばん先の日付まで"
          >
            自動
          </button>
        </label>
      </div>

      {subHeader}

      {tasks.length === 0 ? (
        <div className="zk-empty">{emptyMessage ?? "表示できるタスクがありません。"}</div>
      ) : (
      <div className="zk-body">
        <div className="zk-pane">
          <div className="zk-pane-head">
            <span>Task name</span>
            <span>Owner</span>
          </div>
          <div className="zk-pane-scroll" ref={paneRef}>
            <TaskPane
              rows={rows}
              rowHeight={ROW_HEIGHT}
              milestoneHeight={milestoneHeight}
              visible={visible}
              onToggleGroup={toggleGroup}
              onTaskOpen={onTaskOpen ? openTask : undefined}
              selectedTaskId={selectedTaskId}
              dailyTasks={dailyTasks}
            />
          </div>
        </div>

        <Timeline
          rows={rows}
          scale={scale}
          rowHeight={ROW_HEIGHT}
          visible={visible}
          milestones={placedMilestones}
          milestoneHeight={milestoneHeight}
          scrollTop={scrollTop}
          onMilestoneOpen={onMilestoneOpen}
          dependencies={dependencies}
          milestoneLinks={milestoneLinks}
          cyclicEdges={cyclicEdges}
          theme={theme}
          onTaskDatesChange={onTaskDatesChange}
          readOnly={readOnly}
          onTaskOpen={onTaskOpen ? openTask : undefined}
          dailyTasks={dailyTasks}
          onToggleDailyDone={onToggleDailyDone}
          onScroll={onTimelineScroll}
          selectedTaskId={selectedTaskId}
          scrollRef={timelineRef}
        />
      </div>
      )}
    </>
  )
}
