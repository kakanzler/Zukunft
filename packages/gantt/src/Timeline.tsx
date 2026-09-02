"use client"

import { type CSSProperties, useMemo } from "react"
import {
  type DateChange,
  type ISODate,
  type ScheduledTask,
  type TimeScale,
  inclusiveDays,
  isScheduled,
  monthTicks,
  subTicks,
  today,
} from "@zukunft/domain"
import { glowVar, gradientId } from "./colors"
import type { Row } from "./rows"
import { useBarDrag } from "./useBarDrag"

const BAR_INSET = 5

type Props = {
  rows: Row[]
  scale: TimeScale
  rowHeight: number
  visible: { start: number; end: number }
  milestones: { title: string; dueOn: ISODate }[]
  onTaskDatesChange: (taskId: string, change: DateChange) => void
  readOnly?: boolean
  onTaskOpen?: (taskId: string) => void
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void
  /** j / k で選ばれている行。帯を敷いて示す */
  selectedTaskId?: string | null
  /** 選択を追って縦スクロールさせるために、親が掴んでおくスクローラ */
  scrollRef?: React.RefObject<HTMLDivElement>
}

export function Timeline({
  rows, scale, rowHeight, visible, milestones, onTaskDatesChange, readOnly = false,
  onTaskOpen, onScroll, selectedTaskId = null, scrollRef,
}: Props) {
  const { drag, begin, move, end } = useBarDrag({
    scale,
    onCommit: onTaskDatesChange,
    onClick: onTaskOpen,
  })
  const months = useMemo(() => monthTicks(scale), [scale])
  const subs = useMemo(() => subTicks(scale), [scale])
  const todayX = useMemo(() => {
    const t = today()
    return t >= scale.origin && t <= scale.end ? scale.toX(t) : null
  }, [scale])

  const bodyHeight = rows.length * rowHeight

  return (
    <div className="zk-timeline" onScroll={onScroll} ref={scrollRef}>
      <div className="zk-thead" style={{ width: scale.width }}>
        {months.map((t) => (
          <div key={`m-${t.date}`} className="zk-thead-month" style={{ left: t.x, width: t.width }}>
            {t.label}
          </div>
        ))}
        {subs.map((t) => (
          <div key={`s-${t.date}`} className="zk-thead-sub" style={{ left: t.x, width: t.width }}>
            {t.label}
          </div>
        ))}
      </div>

      <svg width={scale.width} height={bodyHeight} style={{ display: "block" }}>
        <defs>
          {[0, 1, 2, 3].map((i) => (
            <linearGradient key={i} id={`zk-grad-${i}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={`var(--status-${i}-from)`} />
              <stop offset="100%" stopColor={`var(--status-${i}-to)`} />
            </linearGradient>
          ))}
        </defs>

        {subs.map((t) => (
          <line
            key={`grid-${t.date}`}
            className={scale.zoom === "month" ? "zk-grid-line zk-grid-line--month" : "zk-grid-line"}
            x1={t.x} y1={0} x2={t.x} y2={bodyHeight}
          />
        ))}

        {/* 選択行の帯。バーの無い（日付未設定の）タスクも選べるので、
            バーではなく行そのものを示す。 */}
        {rows.slice(visible.start, visible.end).map((row, i) => {
          const index = visible.start + i
          if (row.kind !== "task" || row.task.id !== selectedTaskId) return null
          return (
            <rect
              key={`sel-${row.key}`}
              className="zk-row-selected-band"
              x={0} y={index * rowHeight} width={scale.width} height={rowHeight}
            />
          )
        })}

        {todayX !== null && (
          <line className="zk-today-line" x1={todayX} y1={0} x2={todayX} y2={bodyHeight} />
        )}

        {rows.slice(visible.start, visible.end).map((row, i) => {
          const index = visible.start + i
          const y = index * rowHeight
          if (row.kind === "group") return null
          const task = row.task
          if (!isScheduled(task)) return null

          const dragging = drag?.taskId === task.id
          const shown: ScheduledTask = dragging
            ? { ...task, ...drag.preview }
            : task

          return (
            <g key={row.key}>
              {dragging && <Bar task={task} y={y} scale={scale} rowHeight={rowHeight}
                                statusIndex={row.statusIndex} ghost />}
              <g
                className={dragging ? "zk-bar zk-bar--dragging" : "zk-bar"}
                {...(readOnly
                  ? // 読み取り専用ではドラッグを始めない。書き込み経路を残さないため、
                    // ハンドラごと外し、詳細を開くクリックだけを受ける（企画書 §9）。
                    { onClick: () => onTaskOpen?.(task.id) }
                  : {
                      onPointerDown: (e: React.PointerEvent<SVGGElement>) =>
                        begin(e, task, scale.toX(task.startDate), barWidth(task, scale)),
                      onPointerMove: move,
                      onPointerUp: end,
                    })}
                style={{ cursor: readOnly ? "pointer" : undefined }}
              >
                <Bar task={shown} y={y} scale={scale} rowHeight={rowHeight}
                     statusIndex={row.statusIndex} />
              </g>
            </g>
          )
        })}

        {milestones.map((m) => {
          if (m.dueOn < scale.origin || m.dueOn > scale.end) return null
          const x = scale.toX(m.dueOn) + scale.pxPerDay / 2
          return (
            <g key={m.title}>
              <path className="zk-milestone" d={`M ${x} 4 L ${x + 6} 10 L ${x} 16 L ${x - 6} 10 Z`} />
              <text className="zk-milestone-label" x={x + 10} y={10}>{m.title}</text>
            </g>
          )
        })}
      </svg>

      {drag && (
        <div className="zk-tooltip" style={{ left: drag.pointer.x + 14, top: drag.pointer.y + 14 }}>
          {drag.preview.startDate} → {drag.preview.endDate}
          {"  "}({inclusiveDays(drag.preview.startDate, drag.preview.endDate)}d)
        </div>
      )}
    </div>
  )
}

function barWidth(task: ScheduledTask, scale: TimeScale): number {
  return Math.max(inclusiveDays(task.startDate, task.endDate) * scale.pxPerDay, 2)
}

function Bar({
  task, y, scale, rowHeight, statusIndex, ghost = false,
}: {
  task: ScheduledTask
  y: number
  scale: TimeScale
  rowHeight: number
  statusIndex: number
  ghost?: boolean
}) {
  const x = scale.toX(task.startDate)
  const width = barWidth(task, scale)
  const height = rowHeight - BAR_INSET * 2
  const progress = task.progress
  return (
    <g className={ghost ? "zk-bar-ghost" : undefined}>
      <rect
        x={x} y={y + BAR_INSET} width={width} height={height} rx={height / 2}
        fill={`url(#${gradientId(statusIndex)})`}
        className={ghost ? undefined : "zk-bar-glow"}
        // 発光色は Status ごと。塗りと同じ色で滲ませないと、色分けが光に埋もれる。
        style={ghost ? undefined : ({ "--bar-glow": glowVar(statusIndex) } as CSSProperties)}
      />
      {progress !== null && progress > 0 && (
        <rect
          x={x} y={y + BAR_INSET} width={(width * Math.min(progress, 100)) / 100} height={height}
          rx={height / 2} fill="rgba(255,255,255,0.28)"
        />
      )}
      {width > 60 && (
        <text className="zk-bar-label" x={x + 10} y={y + rowHeight / 2}>
          #{task.issueNumber}
        </text>
      )}
    </g>
  )
}

