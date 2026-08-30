"use client"

import { useState } from "react"
import type { GroupMode, ScheduleTask, ZoomLevel } from "@zukunft/domain"
import { ZOOM_LEVELS } from "@zukunft/domain"
import { GanttChart, Sidebar } from "@zukunft/gantt"

/**
 * 読み取り専用の Gantt（企画書 §9）。
 *
 * `packages/gantt` をデスクトップと共有し、`readOnly` を立てて
 * ドラッグを無効にする。Web からの書き込み経路は存在しない。
 */
export function ReadOnlyGantt({
  tasks, statusOrder, title,
}: {
  tasks: ScheduleTask[]
  statusOrder: string[]
  title: string
}) {
  const [zoom, setZoom] = useState<ZoomLevel>("week")
  const [groupBy, setGroupBy] = useState<GroupMode>("status")

  const toolbar = (
    <>
      {ZOOM_LEVELS.map((level) => (
        <button key={level} className="zk-button" aria-pressed={zoom === level}
                onClick={() => setZoom(level)}>
          {level}
        </button>
      ))}
      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>読み取り専用</span>
    </>
  )

  return (
    <div className="zk-shell">
      <Sidebar active={groupBy} onSelect={setGroupBy} footer={title} />
      <div className="zk-main">
        <GanttChart
          tasks={tasks}
          statusOrder={statusOrder}
          zoom={zoom}
          groupBy={groupBy}
          onTaskDatesChange={() => {}}
          readOnly
          emptyMessage="この Project に表示できる Issue がありません。"
          toolbar={toolbar}
        />
      </div>
    </div>
  )
}
