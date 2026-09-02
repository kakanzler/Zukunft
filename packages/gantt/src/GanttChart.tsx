"use client"

import { type ReactNode, useCallback, useMemo, useRef, useState } from "react"
import {
  type DateChange,
  type GroupMode,
  type ScheduleTask,
  type ZoomLevel,
  type ISODate,
  collectMilestones,
  createTimeScale,
  defaultTimelineEnd,
  isScheduled,
  maxDate,
  timelineRange,
  today,
} from "@zukunft/domain"
import { TaskPane } from "./TaskPane"
import { Timeline } from "./Timeline"
import { buildRows, visibleRange } from "./rows"

const ROW_HEIGHT = 32

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
  onTaskDatesChange: (taskId: string, change: DateChange) => void
  /** Web 版（読み取り専用）では true にする（企画書 §9） */
  readOnly?: boolean
  /** 行またはバーをクリックしたとき。詳細モーダルを開く用途 */
  onTaskOpen?: (taskId: string) => void
  /** タスクが 0 件のときに出す案内 */
  emptyMessage?: ReactNode
  toolbar?: ReactNode
}

export function GanttChart({
  tasks, statusOrder, zoom, groupBy = "status", parentLabels = EMPTY_PARENTS,
  onTaskDatesChange, readOnly = false, onTaskOpen, emptyMessage, toolbar,
}: GanttChartProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // 横軸の右端の指定。null は「既定に従う」— タスクが増えて既定が伸びたら一緒に伸びる。
  // 読み込みより先に開くので、タスクから初期値を作らず null から始める。
  const [endOverride, setEndOverride] = useState<ISODate | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const paneRef = useRef<HTMLDivElement>(null)

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
  const visible = useMemo(
    () => visibleRange(scrollTop, viewportHeight, ROW_HEIGHT, rows.length),
    [scrollTop, viewportHeight, rows.length],
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
              onTaskOpen={onTaskOpen}
            />
          </div>
        </div>

        <Timeline
          rows={rows}
          scale={scale}
          rowHeight={ROW_HEIGHT}
          visible={visible}
          milestones={milestones}
          onTaskDatesChange={onTaskDatesChange}
          readOnly={readOnly}
          onTaskOpen={onTaskOpen}
          onScroll={onTimelineScroll}
        />
      </div>
      )}
    </>
  )
}
