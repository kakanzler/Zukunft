"use client"

import { type CSSProperties, useMemo } from "react"
import {
  type DateChange,
  type Dependency,
  type ISODate,
  edgeKey,
  type ScheduledTask,
  type TimeScale,
  inclusiveDays,
  isScheduled,
  monthTicks,
  subTicks,
  today,
} from "@zukunft/domain"
import { glowVar, gradientId, statusVar } from "./colors"
import type { Row } from "./rows"
import { type DragState, useBarDrag } from "./useBarDrag"

const BAR_INSET = 5
/** 矢印の先端の大きさ（px）。行の高さ 32 に対して主張しすぎない程度。 */
const ARROW = 8

type Props = {
  rows: Row[]
  scale: TimeScale
  rowHeight: number
  visible: { start: number; end: number }
  milestones: { title: string; dueOn: ISODate }[]
  /** Issue 間の依存関係。両端が描かれている行のときだけ矢印にする */
  dependencies?: Dependency[]
  /** 循環している辺（cycle.ts の edgeKey）。危険色の破線で描く */
  cyclicEdges?: ReadonlySet<string>
  onTaskDatesChange: (taskId: string, change: DateChange) => void
  readOnly?: boolean
  onTaskOpen?: (taskId: string) => void
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void
  /** j / k で選ばれている行。帯を敷いて示す */
  selectedTaskId?: string | null
  /** 選択を追って縦スクロールさせるために、親が掴んでおくスクローラ */
  scrollRef?: React.RefObject<HTMLDivElement>
}

/** 既定値をその場で書くと毎回別の配列になり、矢印の再計算が止まらなくなる。 */
const EMPTY_DEPENDENCIES: Dependency[] = []
const EMPTY_EDGES: ReadonlySet<string> = new Set()

export function Timeline({
  rows, scale, rowHeight, visible, milestones, dependencies = EMPTY_DEPENDENCIES,
  cyclicEdges = EMPTY_EDGES, onTaskDatesChange, readOnly = false,
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

  /** 矢印を引くのに要る、タスクごとの行番号・色・バーの位置。 */
  const placed = useMemo(() => {
    const map = new Map<string, { index: number; statusIndex: number; task: ScheduledTask }>()
    rows.forEach((row, index) => {
      if (row.kind === "task" && isScheduled(row.task)) {
        map.set(row.task.id, { index, statusIndex: row.statusIndex, task: row.task })
      }
    })
    return map
  }, [rows])

  // drag を placed の依存に入れると、ポインタが動くたびに全行の Map を作り直すことに
  // なる。辺の数はたかが知れているので、buildLinks の中で 1 本ずつ差し替える。
  const links = useMemo(
    () => buildLinks(dependencies, placed, scale, rowHeight, visible, cyclicEdges, drag),
    [dependencies, placed, scale, rowHeight, visible, cyclicEdges, drag],
  )

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
          {/* 矢印は自分の色から依存先の色へ。線の実座標で刻むので、
              行が離れていても向きと色の対応が崩れない。 */}
          {links.filter((link) => !link.cyclic).map((link) => (
            <linearGradient
              key={link.id}
              id={link.id}
              gradientUnits="userSpaceOnUse"
              x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2}
            >
              <stop offset="0%" stopColor={link.fromColor} />
              <stop offset="100%" stopColor={link.toColor} />
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

        {/* バーより後に描く。関係が線で追えることを、バーの見やすさより優先する。 */}
        {links.map((link) => (
          <g key={link.id} className="zk-dep">
            {/* 循環した辺はグラデーションを当てない。当てると危険色が消える。 */}
            <path
              className={link.cyclic ? "zk-dep-line zk-dep-line--cyclic" : "zk-dep-line"}
              d={link.path}
              stroke={link.cyclic ? "var(--danger)" : `url(#${link.id})`}
            />
            {/* 先端はグラデーションの終端色で塗る。線が着いた先の色と揃える。 */}
            <path
              className="zk-dep-head"
              d={link.head}
              fill={link.cyclic ? "var(--danger)" : link.toColor}
            />
          </g>
        ))}

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


type Placement = { index: number; statusIndex: number; task: ScheduledTask }

type Link = {
  id: string
  cyclic: boolean
  path: string
  head: string
  x1: number
  y1: number
  x2: number
  y2: number
  fromColor: string
  toColor: string
}

/**
 * 依存関係を矢印の座標に変換する。
 *
 * 依存元のバーから出て依存先のバーに刺さる。依存先は普通あとに来ないので
 * 線は左へ戻ることが多く、そのぶん「どちらが先か」を向きで読ませたい。
 * そこで端点は常に近い側の端に取り、外向きの制御点で膨らませて、
 * バーの上を横切らずに回り込ませる。
 */
function buildLinks(
  dependencies: Dependency[],
  placed: Map<string, Placement>,
  scale: TimeScale,
  rowHeight: number,
  visible: { start: number; end: number },
  cyclicEdges: ReadonlySet<string>,
  drag: DragState | null,
): Link[] {
  // ドラッグ中のタスクは仮の日付で描く。確定するまで線が元の位置に残ると、
  // 依存先を見ながら日程を動かすことができない。
  const at = (placement: Placement | undefined): Placement | undefined =>
    placement && drag?.taskId === placement.task.id
      ? { ...placement, task: { ...placement.task, ...drag.preview } }
      : placement

  const links: Link[] = []
  dependencies.forEach((dep, i) => {
    const from = at(placed.get(dep.fromTaskId))
    const to = at(placed.get(dep.toTaskId))
    // 折り畳んだグループの中や、日付が未設定で描かれていない行には引けない。
    if (!from || !to) return
    // 両端とも可視範囲の同じ側の外なら、線も画面に掛からない。
    if (from.index >= visible.end && to.index >= visible.end) return
    if (from.index < visible.start && to.index < visible.start) return

    const fx = scale.toX(from.task.startDate)
    const fw = barWidth(from.task, scale)
    const tx = scale.toX(to.task.startDate)
    const tw = barWidth(to.task, scale)
    const y1 = from.index * rowHeight + rowHeight / 2
    const y2 = to.index * rowHeight + rowHeight / 2

    // 依存先が手前にあるか。あるなら左端から出て、依存先の右端に刺す。
    const backwards = tx + tw <= fx + fw
    const x1 = backwards ? fx : fx + fw
    const x2 = backwards ? tx + tw : tx
    const out1 = backwards ? -1 : 1
    const out2 = backwards ? 1 : -1
    const bend = Math.max(18, Math.min(64, Math.abs(x2 - x1) / 2))

    links.push({
      id: `zk-dep-${i}`,
      cyclic: cyclicEdges.has(edgeKey(dep.fromTaskId, dep.toTaskId)),
      path: `M ${x1} ${y1} C ${x1 + out1 * bend} ${y1}, ${x2 + out2 * bend} ${y2}, ${x2} ${y2}`,
      head: `M ${x2} ${y2} L ${x2 + out2 * ARROW} ${y2 - ARROW / 2} L ${x2 + out2 * ARROW} ${y2 + ARROW / 2} Z`,
      x1, y1, x2, y2,
      fromColor: statusVar(from.statusIndex),
      toColor: statusVar(to.statusIndex),
    })
  })
  return links
}
