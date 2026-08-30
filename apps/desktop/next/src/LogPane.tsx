"use client"

import { useState } from "react"
import type { Log } from "@/log"

/** 画面下部のログ。既定で開いておき、見落としを防ぐ。 */
export function LogPane({ log }: { log: Log }) {
  const [open, setOpen] = useState(true)
  const { entries, counts } = log

  return (
    <div className="zk-log">
      <div
        className="zk-log-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((v) => !v)
        }}
      >
        <span className="zk-log-title">{open ? "▾" : "▸"} Log</span>
        {counts.error > 0 && (
          <span className="zk-log-count zk-log-count--error">{counts.error} error</span>
        )}
        {counts.warn > 0 && (
          <span className="zk-log-count zk-log-count--warn">{counts.warn} warn</span>
        )}
        {counts.total === 0 && <span className="zk-log-title">問題なし</span>}
        <span className="zk-log-spacer" />
        <button
          className="zk-button"
          disabled={counts.total === 0}
          onClick={(e) => {
            e.stopPropagation()
            log.clear()
          }}
        >
          消去
        </button>
      </div>

      {open && (
        <div className="zk-log-body">
          {entries.length === 0 ? (
            <div className="zk-log-empty">まだ何も記録されていません。</div>
          ) : (
            // 新しいものを上に出す。古いログを追いかけてスクロールしなくて済む。
            [...entries].reverse().map((entry) => (
              <div className="zk-log-entry" key={entry.id}>
                <span className="zk-log-time">{formatTime(entry.at)}</span>
                <span className={`zk-log-level zk-log-level--${entry.level}`}>
                  {entry.level}
                </span>
                <span className="zk-log-message">
                  {entry.message}
                  {entry.hint && <span className="zk-log-hint">　{entry.hint}</span>}
                </span>
                {entry.actions && entry.actions.length > 0 && (
                  <span className="zk-log-actions">
                    {entry.actions.map((action) => (
                      <button
                        key={action.label}
                        className={action.danger ? "zk-button zk-button--danger" : "zk-button"}
                        onClick={action.run}
                      >
                        {action.label}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(at: Date): string {
  return at.toTimeString().slice(0, 8)
}
