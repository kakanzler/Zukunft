"use client"

import { type ReactNode, useCallback, useMemo, useRef, useState } from "react"
import {
  type DateChange,
  type GroupMode,
  type ScheduleTask,
  type ZoomLevel,
  collectMilestones,
  computeStats,
  createTimeScale,
  isScheduled,
  timelineRange,
  today,
} from "@zukunft/domain"
import { KpiBar, StatusLegend } from "./KpiBar"
import { TaskPane } from "./TaskPane"
import { Timeline } from "./Timeline"
import { buildRows, visibleRange } from "./rows"

const ROW_HEIGHT = 32

export type GanttChartProps = {
  tasks: ScheduleTask[]
  /** Status の定義順。色の割り当てとグループ順序に使う */
  statusOrder: string[]
  zoom: ZoomLevel
  /** グループ分けの基準。サイドバーの表示切り替えに対応する */
  groupBy?: GroupMode
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
  tasks, statusOrder, zoom, groupBy = "status", onTaskDatesChange, readOnly = false,
  onTaskOpen, emptyMessage, toolbar,
}: GanttChartProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const paneRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(
    () => buildRows(tasks, statusOrder, collapsed, groupBy),
    [tasks, statusOrder, collapsed, groupBy],
  )

  const scale = useMemo(() => {
    const dates = tasks.filter(isScheduled).flatMap((t) => [t.startDate, t.endDate])
    const { origin, end } = timelineRange(dates, today())
    return createTimeScale(origin, end, zoom)
  }, [tasks, zoom])

  const stats = useMemo(() => computeStats(tasks), [tasks])
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
        <div className="zk-header-spacer" />
        <StatusLegend statuses={statusOrder} />
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

      <KpiBar stats={stats} />
    </>
  )
}
