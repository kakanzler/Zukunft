"use client"

import { isScheduled } from "@zukunft/domain"
import type { Row } from "./rows"

type Props = {
  rows: Row[]
  rowHeight: number
  visible: { start: number; end: number }
  onToggleGroup: (key: string) => void
  onTaskOpen?: (taskId: string) => void
}

export function TaskPane({ rows, rowHeight, visible, onToggleGroup, onTaskOpen }: Props) {
  return (
    <div style={{ height: rows.length * rowHeight, position: "relative" }}>
      {rows.slice(visible.start, visible.end).map((row, i) => {
        const index = visible.start + i
        const style = {
          position: "absolute" as const,
          top: index * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
        }

        if (row.kind === "group") {
          const groupKey = row.groupKey
          return (
            <div
              key={row.key}
              className="zk-row zk-row--group"
              style={style}
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
        return (
          <div
            key={row.key}
            className={isScheduled(task) ? "zk-row" : "zk-row zk-row--unscheduled"}
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
  )
}
