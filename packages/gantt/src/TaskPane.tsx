"use client"

import { type Recurrence, isScheduled } from "@zukunft/domain"
import type { Row } from "./rows"

type Props = {
  rows: Row[]
  rowHeight: number
  /**
   * 日課の設定（task id -> 間隔と実行した日）。盤面に渡すものと同じものを受け取る。
   * 「日課かどうか」を左ペインでも同じ鍵で判定するためで、別の形で渡すと
   * 盤面が点を描いている行を左ペインが「日付未設定」と呼ぶ食い違いが起きる。
   */
  dailyTasks?: Record<string, Recurrence>
  /**
   * 盤面のマイルストーン帯の高さ（段数 × 行の高さ）。
   * 向こうが多段になったぶんだけ、こちらの見出しも高くする。
   */
  milestoneHeight: number
  visible: { start: number; end: number }
  onToggleGroup: (key: string) => void
  onTaskOpen?: (taskId: string) => void
  /** j / k で選ばれている行。クリックでも動く */
  selectedTaskId?: string | null
}

/** 既定値をその場で書くと毎回別のオブジェクトになり、行の再描画が止まらなくなる。 */
const EMPTY_DAILY_TASKS: Record<string, Recurrence> = {}

export function TaskPane({
  rows, rowHeight, milestoneHeight, visible, onToggleGroup, onTaskOpen, selectedTaskId = null,
  dailyTasks = EMPTY_DAILY_TASKS,
}: Props) {
  return (
    <>
      {/* 盤面のマイルストーン帯と対になる見出し。高さも貼り付き方も向こうと
          揃えないと、以降の行がまるごと横にずれて見える。段が増えて帯が高く
          なったときも同じで、行の高さではなく帯の高さに合わせる。
          畳めないので、グループ見出しと違ってクリックは受けない。 */}
      <div className="zk-pane-milestone" style={{ height: milestoneHeight }}>MILESTONE</div>
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>
        {rows.slice(visible.start, visible.end).map((row, i) => {
          const index = visible.start + i
          const style = {
            position: "absolute" as const,
            top: index * rowHeight,
            left: 0,
            right: 0,
            height: rowHeight,
            // 親カテゴリを使うと 2 階層になる。字下げが唯一の手掛かりなので、
            // .zk-row の左パディングに深さの分を足す。
            paddingLeft: `calc(var(--space) * 3 + ${row.depth * 14}px)`,
          }

          if (row.kind === "group") {
            const groupKey = row.groupKey
            return (
              <div
                key={row.key}
                className="zk-row zk-row--group"
                style={style}
                /* ラベルの組み合わせは名前が長くなり ellipsis で切れる。 */
                title={row.label}
                onClick={() => onToggleGroup(groupKey)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onToggleGroup(groupKey)
                }}
                aria-expanded={!row.collapsed}
              >
                <span>{row.collapsed ? "▸" : "▾"}</span>
                {row.color && (
                  <span className="zk-legend-dot" style={{ background: row.color }} />
                )}
                <span className="zk-row-title">{row.label}</span>
                <span className="zk-row-number">{row.count}</span>
              </div>
            )
          }

          const task = row.task
          const assignee = task.assignees[0]
          const classes = ["zk-row"]
          // 無期限の日課は Target Date が空なので、そのままでは「日付未設定」に
          // 見えてしまう。盤面には点が並んでいて実際には繰り返し中なので、
          // 斜体にはしない。判定は盤面と同じ dailyTasks で行う。
          if (!isScheduled(task) && !dailyTasks[task.id]) classes.push("zk-row--unscheduled")
          if (task.id === selectedTaskId) classes.push("zk-row--selected")
          return (
            <div
              key={row.key}
              className={classes.join(" ")}
              aria-selected={task.id === selectedTaskId}
              style={{ ...style, cursor: onTaskOpen ? "pointer" : undefined }}
              title={`#${task.issueNumber} ${task.title}`}
              onClick={() => onTaskOpen?.(task.id)}
              role={onTaskOpen ? "button" : undefined}
              tabIndex={onTaskOpen ? 0 : undefined}
              onKeyDown={(e) => {
                if (onTaskOpen && (e.key === "Enter" || e.key === " ")) onTaskOpen(task.id)
              }}
            >
              <span className={`zk-sync zk-sync--${task.syncState}`} aria-label={task.syncState} />
              <span className="zk-row-number">#{task.issueNumber}</span>
              <span className="zk-row-title">{task.title}</span>
              {assignee?.avatarUrl ? (
                <img className="zk-avatar" src={assignee.avatarUrl} alt={assignee.login}
                     title={assignee.login} />
              ) : (
                // アバター URL が無い場合（未アサイン、またはモックデータ）は
                // 壊れた画像アイコンを出さず、頭文字のプレースホルダにする。
                <span className="zk-avatar zk-avatar--empty" title={assignee?.login ?? "unassigned"}
                      aria-label={assignee?.login ?? "unassigned"}
                      style={{ display: "grid", placeItems: "center", fontSize: 9 }}>
                  {assignee ? assignee.login.slice(0, 1).toUpperCase() : ""}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
