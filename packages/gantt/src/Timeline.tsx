"use client"

import { type CSSProperties, useEffect, useId, useMemo, useState } from "react"
import {
  type DateChange,
  type Dependency,
  edgeKey,
  type ISODate,
  type MilestoneMark,
  type Recurrence,
  type ScheduleTask,
  type ScheduledTask,
  type TimeScale,
  inclusiveDays,
  isDone,
  isScheduled,
  monthTicks,
  occurrences,
  subTicks,
  today,
} from "@zukunft/domain"
import { glowVar, statusSlot, statusVar } from "./colors"
import { estimateLabelWidth } from "./milestones"
import type { GanttTheme } from "./theme"
import type { Row } from "./rows"
import { type DragState, useBarDrag } from "./useBarDrag"

const BAR_INSET = 5
/** 矢印の先端の大きさ（px）。行の高さ 32 に対して主張しすぎない程度。 */
const ARROW = 8

/**
 * マイルストーンの題名の大きさ（px）。theme.css の .zk-milestone-label と同じ値。
 *
 * 段組みを決める packMilestones は題名の幅からしか重なりを判定できないので、
 * 実際に描く大きさをここから GanttChart へ渡す。CSS と食い違うと、重なって
 * いないものが段を分けたり、重なったものが同じ段に並んだりする。
 */
export const MILESTONE_FONT_SIZE = 10
/** 菱形の中心から左右への半幅。milestones.ts の DIAMOND_HALF_WIDTH と同じ値。 */
const DIAMOND_HALF_WIDTH = 6
/** 菱形の中心から題名の開始位置まで。milestones.ts の LABEL_OFFSET と同じ値。 */
const LABEL_OFFSET = 10

/** 段の決まったマイルストーン 1 件。段は GanttChart が packMilestones で詰める。 */
export type PlacedMilestone = { mark: MilestoneMark; lane: number }

/**
 * 割り当てられたカテゴリ色を菱形に載せる。
 *
 * 輪郭をその色にし、内部は同じ色を薄くして塗る — blue-system の
 * --zk-accent-red（輪郭）と --zk-milestone-fill（不透明度 0.18 の塗り）の
 * 関係をそのまま移したもの。発光まで色に従わせたいが、光らせるかどうかは
 * 意匠ごとに違うので、filter はここで書かず、色だけを変数で渡して
 * theme.css の blue-system に読ませる。
 */
function milestoneTint(color: string): CSSProperties {
  return {
    stroke: color,
    // 0.18 ≒ 0x2e / 0xff、0.55 ≒ 0x8c / 0xff。--zk-milestone-fill と
    // blue-system の広い滲みの不透明度に合わせている。
    fill: `${color}2e`,
    "--zk-ms-color": color,
    "--zk-ms-glow": `${color}8c`,
  } as CSSProperties
}

/**
 * blue-system でバーに何を載せるかの境目（px）。
 *
 * 細いバーに輪郭と柱と終端を全部載せると、装飾が実体より太くなって
 * 「バー」ではなく「線」に見える。幅に応じて素直に減らす。
 */
/** これ未満は単色の点として描く。淡いグラデーションでは消えてしまう */
const W_MARK = 6
/** これ未満は輪郭を描かない。1px の線が幅の 1/7 を占めてしまう */
const W_OUTLINE = 14
/** 左端の柱の幅。開始日は塗りがどれだけ透けても色で立たせる */
const BAR_RISER = 2

/**
 * 日課の点の半径（px）。
 *
 * 1 日ぶんの幅に収める。month ズームは 1 日が 4px しかないので、固定値だと
 * 隣の日の点と重なって 1 本の帯に見えてしまう。行の高さにも収まる大きさで頭を打つ。
 */
const DAILY_DOT_RADIUS = 4
function dailyDotRadius(pxPerDay: number): number {
  return Math.max(1.5, Math.min(DAILY_DOT_RADIUS, pxPerDay / 2 - 0.5))
}

/**
 * 日付が変わったかを見にいく間隔。1 分でも足りるが、線が 1 分遅れて動くことに
 * 実害は無いので、起きる回数の少ない方に寄せる。
 */
const MIDNIGHT_CHECK_MS = 5 * 60 * 1000

type Props = {
  rows: Row[]
  scale: TimeScale
  rowHeight: number
  visible: { start: number; end: number }
  /** 段まで決まったマイルストーン。どの段に置くかは GanttChart が決める */
  milestones: PlacedMilestone[]
  /**
   * マイルストーン帯の高さ（段数 × 行の高さ）。
   * 左ペインの .zk-pane-milestone と 1px でも違うと、以降の行が横にずれる。
   */
  milestoneHeight: number
  /**
   * 菱形と題名を押したとき。渡さない読み取り専用ビューでは押せないままにする
   * （当たり判定もカーソルも足さない）。
   */
  onMilestoneOpen?: (milestoneId: string) => void
  /** Issue 間の依存関係。両端が描かれている行のときだけ矢印にする */
  dependencies?: Dependency[]
  /** 循環している辺（cycle.ts の edgeKey）。危険色の破線で描く */
  cyclicEdges?: ReadonlySet<string>
  /** 盤面の意匠。形が違うところをここで分ける */
  theme?: GanttTheme
  /**
   * 日課の設定（task id -> 間隔と実行した日）。ここにあるタスクは期間ではなく
   * 実行日の列なので、バーではなく点で描く。
   */
  dailyTasks?: Record<string, Recurrence>
  /**
   * 点を押したとき（その日の実行を入り切りする）。
   * 渡さない読み取り専用ビューでは押せないままにする。
   */
  onToggleDailyDone?: (taskId: string, date: ISODate) => void
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
const EMPTY_DAILY_TASKS: Record<string, Recurrence> = {}

export function Timeline({
  rows, scale, rowHeight, visible, milestones, milestoneHeight,
  dependencies = EMPTY_DEPENDENCIES,
  cyclicEdges = EMPTY_EDGES, theme = "default", onTaskDatesChange, readOnly = false,
  onTaskOpen, onScroll, selectedTaskId = null, scrollRef, onMilestoneOpen,
  dailyTasks = EMPTY_DAILY_TASKS, onToggleDailyDone,
}: Props) {
  const { drag, begin, move, end, cancel } = useBarDrag({
    scale,
    onCommit: onTaskDatesChange,
    onClick: onTaskOpen,
  })
  const months = useMemo(() => monthTicks(scale), [scale])
  const subs = useMemo(() => subTicks(scale), [scale])
  // 日付が変わったら今日線を引き直す。開いたままにされるアプリなので、
  // scale だけを依存にしていると、日をまたいでも前日に線が残る。
  const [currentDay, setCurrentDay] = useState(today)
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentDay(today()), MIDNIGHT_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [])
  const todayX = useMemo(
    () =>
      currentDay >= scale.origin && currentDay <= scale.end ? scale.toX(currentDay) : null,
    [scale, currentDay],
  )

  const bodyHeight = rows.length * rowHeight
  const blue = theme === "blue-system"

  /**
   * この Timeline だけの id の接頭辞。
   *
   * SVG の id は文書全体で一意でないといけない。固定文字列だと、盤面が 2 つ
   * 載った時点で url(#…) の参照が混線して、片方のバーが別の色で塗られる。
   * useId のコロンは url(#…) や querySelector と相性が悪いので落とす。
   */
  const uid = useId().replace(/:/g, "")
  const gradId = (slot: number) => `${uid}-grad-${slot}`
  const edgeId = (slot: number) => `${uid}-edge-${slot}`

  /**
   * 矢印を引くのに要る、タスクごとの行番号・色・バーの位置。
   *
   * 日課（dailyTasks にあるもの）はここから除く。日課はバーではなく点で描くので、
   * バーの端を前提にした矢印を引くと空間に向かって着いてしまう。
   */
  const placed = useMemo(() => {
    const map = new Map<string, { index: number; statusIndex: number; task: ScheduledTask }>()
    rows.forEach((row, index) => {
      if (row.kind === "task" && isScheduled(row.task) && !dailyTasks[row.task.id]) {
        map.set(row.task.id, { index, statusIndex: row.statusIndex, task: row.task })
      }
    })
    return map
  }, [rows, dailyTasks])

  // drag を placed の依存に入れると、ポインタが動くたびに全行の Map を作り直すことに
  // なる。辺の数はたかが知れているので、buildLinks の中で 1 本ずつ差し替える。
  const links = useMemo(
    () => buildLinks(dependencies, placed, scale, rowHeight, visible, cyclicEdges, drag, uid),
    [dependencies, placed, scale, rowHeight, visible, cyclicEdges, drag, uid],
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

      {/* マイルストーンは盤面と一緒には流さない。本体の SVG に描くと、
          行を下へ辿った先で期日がどこにも見えなくなる。月・週ヘッダと同じ作りの
          帯にして、縦には貼り付かせ、横だけ盤面と一緒に流す。

          高さは段数ぶん（milestoneHeight）。重なった題名を下の段へ送っても、
          帯が 1 行のままだと、送った先が帯の外にはみ出して行に重なる。 */}
      <div className="zk-milestone-row" style={{ width: scale.width, height: milestoneHeight }}>
        <svg width={scale.width} height={milestoneHeight} style={{ display: "block" }}>
          {/* 軸の外は段を数える前（GanttChart）で落としてある。ここで落とすと、
              帯の高さは落とす前の段数のままになり、空の段が残る。 */}
          {milestones.map(({ mark, lane }) => {
            const x = scale.toX(mark.dueOn) + scale.pxPerDay / 2
            const top = lane * rowHeight
            // 段の中では今までどおり中央。段が増えても菱形と題名の関係は変えない。
            const cy = top + rowHeight / 2
            // 色が無ければテーマ既定のまま（Default は紫、blue-system は橙）。
            // 割り当てがあるときだけ、その色で輪郭と薄い塗りを作る。
            const tint = mark.color
            const open = onMilestoneOpen
            return (
              <g
                key={mark.id}
                onClick={open ? () => open(mark.id) : undefined}
                onKeyDown={
                  open
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") open(mark.id)
                      }
                    : undefined
                }
                role={open ? "button" : undefined}
                tabIndex={open ? 0 : undefined}
                style={open ? { cursor: "pointer" } : undefined}
              >
                {/* 菱形は 12px 角しかなく、狙って押させるには小さすぎる。
                    題名まで含めた矩形を透明で敷いて当たり判定を広げる。
                    押せないビューには敷かない — 押せない場所に反応する見た目
                    （カーソルの変化）だけが残ってしまう。 */}
                {open && (
                  <rect
                    className="zk-milestone-hit"
                    x={x - DIAMOND_HALF_WIDTH - 2}
                    y={top + 2}
                    width={
                      DIAMOND_HALF_WIDTH + 2 + LABEL_OFFSET +
                      estimateLabelWidth(mark.title, MILESTONE_FONT_SIZE)
                    }
                    height={rowHeight - 4}
                  />
                )}
                <path
                  className={tint ? "zk-milestone zk-milestone--tinted" : "zk-milestone"}
                  style={tint ? milestoneTint(tint) : undefined}
                  d={
                    `M ${x} ${cy - DIAMOND_HALF_WIDTH} L ${x + DIAMOND_HALF_WIDTH} ${cy}` +
                    ` L ${x} ${cy + DIAMOND_HALF_WIDTH} L ${x - DIAMOND_HALF_WIDTH} ${cy} Z`
                  }
                />
                <text className="zk-milestone-label" x={x + LABEL_OFFSET} y={cy}>
                  {mark.title}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* overflow: visible は blue-system のとき。x=0 のバーの発光と輪郭が
          SVG の箱で切られるのを防ぐ。実際の視野は .zk-timeline の overflow が切る。 */}
      <svg
        width={scale.width}
        height={bodyHeight}
        style={{ display: "block", overflow: blue ? "visible" : undefined }}
      >
        <defs>
          {/* blue-system では左からゆっくり現れる。0 ではなく 0.06 で止めるのは、
              真の 0 にすると左端＝開始日が完全に消えるため。 */}
          {[0, 1, 2, 3].map((i) =>
            blue ? (
              <linearGradient key={i} id={gradId(i)} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={`var(--status-${i}-from)`} stopOpacity="0.06" />
                <stop offset="22%" stopColor={`var(--status-${i}-from)`} stopOpacity="0.26" />
                <stop offset="60%" stopColor={`var(--status-${i}-to)`} stopOpacity="0.66" />
                <stop offset="100%" stopColor={`var(--status-${i}-to)`} stopOpacity="1" />
              </linearGradient>
            ) : (
              <linearGradient key={i} id={gradId(i)} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={`var(--status-${i}-from)`} />
                <stop offset="100%" stopColor={`var(--status-${i}-to)`} />
              </linearGradient>
            ),
          )}
          {/* 輪郭。塗りが手放した左端をここで取り返すので、左をいちばん明るくする。 */}
          {blue &&
            [0, 1, 2, 3].map((i) => (
              <linearGradient key={`e${i}`} id={edgeId(i)} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={`var(--status-${i}-to)`} stopOpacity="0.32" />
                <stop offset="45%" stopColor={`var(--status-${i}-to)`} stopOpacity="0.14" />
                <stop offset="100%" stopColor={`var(--status-${i}-to)`} stopOpacity="0.6" />
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

        {/* 選択行の帯。バーの無い（日付未設定の）タスクも選べるので、
            バーではなく行そのものを示す。

            blue-system では不透明にするため、グリッドより先に描く。あとに描くと
            選択行の中だけ目盛りが消える。 */}
        {rows.slice(visible.start, visible.end).map((row, i) => {
          const index = visible.start + i
          if (row.kind !== "task" || row.task.id !== selectedTaskId) return null
          return (
            <rect
              key={`sel-${row.key}`}
              className="zk-row-selected-band"
              x={0} y={index * rowHeight}
              width={scale.width} height={rowHeight}
            />
          )
        })}

        {subs.map((t) => (
          <line
            key={`grid-${t.date}`}
            className={scale.zoom === "month" ? "zk-grid-line zk-grid-line--month" : "zk-grid-line"}
            x1={blue ? t.x + 0.5 : t.x} y1={0}
            x2={blue ? t.x + 0.5 : t.x} y2={bodyHeight}
          />
        ))}

        {/* 実際の月の境目。1px の線に 2px の帯を添えて、線を太らせずに重さを出す。
            monthTicks は先頭を Math.max(x, 0) で潰すので、x <= 0 は境界ではなく
            軸の左端。線を引くと「そこで月が変わった」という嘘になる。 */}
        {blue &&
          months.map((t) =>
            t.x <= 0 ? null : (
              <g key={`mb-${t.date}`}>
                <rect className="zk-grid-month-wash" x={t.x} y={0} width={2} height={bodyHeight} />
                <line
                  className="zk-grid-month-line"
                  x1={t.x + 0.5} y1={0} x2={t.x + 0.5} y2={bodyHeight}
                />
              </g>
            ),
          )}

        {todayX !== null && (
          <g>
            {/* 暈は blue-system だけ。盤面でいちばん強い 1 本にする。 */}
            {blue && (
              <rect className="zk-today-halo" x={todayX - 4} y={0} width={8} height={bodyHeight} />
            )}
            <line className="zk-today-line" x1={todayX} y1={0} x2={todayX} y2={bodyHeight} />
          </g>
        )}

        {rows.slice(visible.start, visible.end).map((row, i) => {
          const index = visible.start + i
          const y = index * rowHeight
          if (row.kind === "group") return null
          const task = row.task

          // 日課はバーより先に見る。無期限の日課は Target Date が空で
          // isScheduled が false になり、バーの分岐に入ると何も描かれずに消える。
          const recurrence = dailyTasks[task.id]
          if (recurrence) {
            return (
              <DailyDots
                key={row.key}
                task={task}
                recurrence={recurrence}
                y={y}
                scale={scale}
                rowHeight={rowHeight}
                statusIndex={row.statusIndex}
                onToggle={onToggleDailyDone}
              />
            )
          }

          if (!isScheduled(task)) return null

          const dragging = drag?.taskId === task.id
          const shown: ScheduledTask = dragging
            ? { ...task, ...drag.preview }
            : task

          return (
            <g key={row.key}>
              {dragging && <Bar task={task} y={y} scale={scale} rowHeight={rowHeight}
                                statusIndex={row.statusIndex} index={index} blue={blue}
                                uid={uid} ghost />}
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
                      // 捕捉が外れたら操作ごと捨てる。掴んだままの状態が残ると、
                      // ボタンを離しているのにバーが指について回り、次に触った
                      // ところで身に覚えのない日付が確定する。
                      onPointerCancel: cancel,
                      onLostPointerCapture: cancel,
                    })}
                style={{ cursor: readOnly ? "pointer" : undefined }}
              >
                <Bar task={shown} y={y} scale={scale} rowHeight={rowHeight}
                     statusIndex={row.statusIndex} index={index} blue={blue} uid={uid} />
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

/**
 * バーの幅（px）。1 日のタスクでも 2px は残す — 0 幅だと盤面から消えてしまう。
 *
 * この関数と barPath / buildLinks を export しているのは、盤面の座標計算が
 * 壊れたことに描画を目で見るまで気づけないため。DOM 無しで確かめられる形に
 * 出しておき、test/smoke.ts から座標そのものを見る。呼び出しは Timeline 内だけ。
 */
export function barWidth(task: ScheduledTask, scale: TimeScale): number {
  return Math.max(inclusiveDays(task.startDate, task.endDate) * scale.pxPerDay, 2)
}

/**
 * 左は角、右は丸のバー。
 *
 * 角丸のピルのまま左を透明にすると、開始日の位置が輪郭の弧だけになって消える。
 * 左を角にすると、開始日が硬い縦の辺になり、そこから光が現れる形になる。
 * rect の rx を使わないのは、横と縦が別々に丸められるため — 幅 2px のバーが
 * 高さ 22px の楕円（レンズ）になってしまう。
 */
export function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(h / 2, w / 2)
  // 左はごく小さく丸める。完全な角にすると光る塊ではなく「箱」に見える。
  const l = Math.min(2, r)
  return (
    `M ${x + l} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r}` +
    ` V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + l}` +
    ` A ${l} ${l} 0 0 1 ${x} ${y + h - l} V ${y + l} A ${l} ${l} 0 0 1 ${x + l} ${y} Z`
  )
}

type BarProps = {
  task: ScheduledTask
  y: number
  scale: TimeScale
  rowHeight: number
  statusIndex: number
  /** 行番号。バーごとに要るグラデーションの id に使う */
  index: number
  /** この Timeline だけの id 接頭辞 */
  uid: string
  blue: boolean
  ghost?: boolean
}

function Bar(props: BarProps) {
  return props.blue && !props.ghost ? <BlueBar {...props} /> : <PlainBar {...props} />
}

/** 今までの見た目（default）。ドラッグ中のゴーストも常にこちらで描く。 */
function PlainBar({ task, y, scale, rowHeight, statusIndex, uid, ghost = false }: BarProps) {
  const x = scale.toX(task.startDate)
  const width = barWidth(task, scale)
  const height = rowHeight - BAR_INSET * 2
  const progress = task.progress
  return (
    <g className={ghost ? "zk-bar-ghost" : undefined}>
      <rect
        x={x} y={y + BAR_INSET} width={width} height={height} rx={height / 2}
        fill={`url(#${uid}-grad-${statusSlot(statusIndex)})`}
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

/**
 * blue-system の見た目。左から現れる塗りに、輪郭・柱・終端の光を重ねる。
 *
 * 発光（.zk-bar-glow）は塗りではなく全体を包む <g> に掛ける。塗りだけを光らせると、
 * くっきりした柱が光る塊の上に貼り付いて見える。
 */
function BlueBar({ task, y, scale, rowHeight, statusIndex, index, uid }: BarProps) {
  const x = scale.toX(task.startDate)
  const width = barWidth(task, scale)
  const height = rowHeight - BAR_INSET * 2
  const top = y + BAR_INSET
  const slot = statusSlot(statusIndex)
  const solid = statusVar(statusIndex)
  const glow = { "--bar-glow": glowVar(statusIndex) } as CSSProperties

  // 細すぎるバーに淡いグラデーションを載せると消える。点として単色で描く。
  if (width < W_MARK) {
    const w = Math.max(width, 3)
    return (
      <g className="zk-bar-glow" style={glow}>
        <rect x={x} y={top} width={w} height={height} rx={Math.min(1.5, w / 2)}
              fill={solid} fillOpacity={0.92} />
      </g>
    )
  }

  const progress = task.progress
  const filled =
    progress !== null && progress > 0 ? (width * Math.min(progress, 100)) / 100 : 0

  return (
    <g className="zk-bar-glow" style={glow}>
      {/* 進捗の座標系は「塗る幅」ではなく「バー全体」。既定の objectBoundingBox だと
          進捗 20% のときバーの 2 割の位置で白が最大になり、結局板に戻ってしまう。 */}
      {filled >= 3 && (
        <linearGradient
          id={`${uid}-prog-${index}`}
          gradientUnits="userSpaceOnUse"
          x1={x} y1="0" x2={x + width} y2="0"
        >
          <stop offset="0%" stopColor="#dceaff" stopOpacity="0.03" />
          <stop offset="30%" stopColor="#dceaff" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#eaf2ff" stopOpacity="0.26" />
        </linearGradient>
      )}

      <path d={barPath(x, top, width, height)} fill={`url(#${uid}-grad-${slot})`} />

      {filled >= 3 && (
        <>
          <path d={barPath(x, top, filled, height)} fill={`url(#${uid}-prog-${index})`} />
          {/* 滲みだけでは割合が読めないので、境目に細い線を立てる。
              右端に寄りすぎると丸い縁とぶつかるので、そこでは出さない。 */}
          {width - filled >= 4 && (
            <rect className="zk-bar-progress-edge"
                  x={x + filled - 1} y={top + 3} width={1} height={height - 6} />
          )}
        </>
      )}

      {/* 輪郭は 0.5px 内側に描く。線はパスの上に半分ずつ載るので、x=0 のバーは
          外半分が SVG の外に出て欠ける。内側に寄せると欠けが消え、同時に
          整数 + 0.5 に載って 1px がぼやけない。 */}
      {width >= W_OUTLINE && (
        <path className="zk-bar-outline"
              d={barPath(x + 0.5, top + 0.5, width - 1, height - 1)}
              fill="none" stroke={`url(#${uid}-edge-${slot})`} />
      )}

      {/* 開始日の柱。塗りがどれだけ透けても、ここだけは色で立たせる。 */}
      <rect className="zk-bar-riser" x={x} y={top} width={BAR_RISER} height={height} rx={1}
            fill={solid} />

      {width > 60 && (
        <text className="zk-bar-label" x={x + 10} y={y + rowHeight / 2}>
          #{task.issueNumber}
        </text>
      )}
    </g>
  )
}

type DailyDotsProps = {
  task: ScheduleTask
  recurrence: Recurrence
  y: number
  scale: TimeScale
  rowHeight: number
  statusIndex: number
  onToggle?: (taskId: string, date: ISODate) => void
}

/**
 * 日課の実行日を点で並べる。
 *
 * 日課は「いつからいつまで」ではなく「その日にやったかどうか」の列なので、
 * バーを引かずに点を置く。Start Date が最初の実行日、Target Date が最後の実行日
 * （空なら無期限＝横軸の右端まで）。日付は Issue 側のものをそのまま読むので、
 * 依存関係も絞り込みも日課でこれまでどおり効く。
 *
 * 点はドラッグの対象にしない。幅が数 px しかなく、バーの左右端を掴み分ける
 * hitTest が意味を持たないため、読み取り専用の分岐と同じく onClick だけを受ける。
 */
function DailyDots({
  task, recurrence, y, scale, rowHeight, statusIndex, onToggle,
}: DailyDotsProps) {
  // 起点が無ければ点を置けない。日課の指定だけが残っている Issue でも落とさない。
  if (task.startDate === null) return null
  const cy = y + rowHeight / 2
  const r = dailyDotRadius(scale.pxPerDay)
  const color = statusVar(statusIndex)
  const glow = { "--bar-glow": glowVar(statusIndex) } as CSSProperties
  // occurrences が見るのは右端（fallbackEnd）だけなので、左端より手前はここで落とす。
  // 軸の外に点を置くと、負の x で盤面の左に貼り付いた列ができる。
  const dates = occurrences(
    task.startDate,
    task.endDate,
    recurrence.rule,
    scale.end,
  ).filter((date) => date >= scale.origin)

  return (
    <g className="zk-daily" style={onToggle ? { cursor: "pointer" } : undefined}>
      {dates.map((date) => {
        const done = isDone(recurrence, date)
        return (
          <circle
            key={date}
            className={done ? "zk-daily-dot zk-daily-dot--done" : "zk-daily-dot zk-daily-dot--todo"}
            /* 日の中央。マイルストーンの菱形と同じ置き方にして、同じ日のものを縦に揃える。 */
            cx={scale.toX(date) + scale.pxPerDay / 2}
            cy={cy}
            r={r}
            fill={color}
            /* 発光色は Status ごと。バーと同じで、塗りと同じ系統の色で滲ませないと
               Status の色分けが光に埋もれる。未実行には載せない（光らせないため）。 */
            style={done ? glow : undefined}
            onClick={onToggle ? () => onToggle(task.id, date) : undefined}
          />
        )
      })}
    </g>
  )
}

export type Placement = { index: number; statusIndex: number; task: ScheduledTask }

export type Link = {
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
export function buildLinks(
  dependencies: Dependency[],
  placed: Map<string, Placement>,
  scale: TimeScale,
  rowHeight: number,
  visible: { start: number; end: number },
  cyclicEdges: ReadonlySet<string>,
  drag: DragState | null,
  uid: string,
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
      id: `${uid}-dep-${i}`,
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
