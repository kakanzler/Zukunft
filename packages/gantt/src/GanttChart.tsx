"use client"

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type DateChange,
  type GroupMode,
  type ScheduleTask,
  type ZoomLevel,
  type ISODate,
  collectMilestones,
  createTimeScale,
  defaultTimelineEnd,
  detectCycles,
  isScheduled,
  maxDate,
  resolveDependencies,
  timelineRange,
  today,
} from "@zukunft/domain"
import type { GanttTheme } from "./theme"
import { TaskPane } from "./TaskPane"
import { Timeline } from "./Timeline"
import { isTyping } from "./keyboard"
import { buildRows, visibleRange } from "./rows"

const ROW_HEIGHT = 32
/** タイムラインの上に貼り付く月・週ヘッダの高さ。選択行がこの下に隠れないようにする。 */
const THEAD_HEIGHT = 48

/** 既定値をその場で書くと毎回別の配列になり、行の再計算が止まらなくなる。 */
const EMPTY_PARENTS: string[] = []

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
  /** タスクが 0 件のときに出す案内 */
  emptyMessage?: ReactNode
  toolbar?: ReactNode
}

export function GanttChart({
  tasks, statusOrder, zoom, groupBy = "status", parentLabels = EMPTY_PARENTS,
  theme = "default", onTaskDatesChange, readOnly = false, onTaskOpen, onTaskEdit, keyboardEnabled = true,
  emptyMessage, toolbar,
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

  const milestones = useMemo(() => collectMilestones(tasks), [tasks])
  // 依存関係は Issue 本文の宣言から起こす。折り畳みやズームでは変わらない。
  const dependencies = useMemo(() => resolveDependencies(tasks), [tasks])
  // 循環した依存は成立しない日程を表している。消さずに、そうと分かる線で描く。
  const cyclicEdges = useMemo(
    () => detectCycles(tasks, dependencies).cyclicEdges,
    [tasks, dependencies],
  )
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
    const viewHeight = el.clientHeight - THEAD_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + viewHeight) {
      el.scrollTop = top + ROW_HEIGHT - viewHeight
    }
  }, [])

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
              visible={visible}
              onToggleGroup={toggleGroup}
              onTaskOpen={onTaskOpen ? openTask : undefined}
              selectedTaskId={selectedTaskId}
            />
          </div>
        </div>

        <Timeline
          rows={rows}
          scale={scale}
          rowHeight={ROW_HEIGHT}
          visible={visible}
          milestones={milestones}
          dependencies={dependencies}
          cyclicEdges={cyclicEdges}
          theme={theme}
          onTaskDatesChange={onTaskDatesChange}
          readOnly={readOnly}
          onTaskOpen={onTaskOpen ? openTask : undefined}
          onScroll={onTimelineScroll}
          selectedTaskId={selectedTaskId}
          scrollRef={timelineRef}
        />
      </div>
      )}
    </>
  )
}
