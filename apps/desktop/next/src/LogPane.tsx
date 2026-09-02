"use client"

import { useCallback, useEffect, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import type { Log } from "@/log"

/** 既定の高さ（px）。3〜4 件が見えて Gantt を潰さない程度。 */
const DEFAULT_HEIGHT = 160
/** 見出しだけになってしまわない下限。 */
const MIN_HEIGHT = 72
/** キーボードで動かすときの 1 回分。 */
const STEP = 24

type Props = {
  log: Log
  /** ログだけを見るモード。Gantt は親が描かない */
  full: boolean
  onToggleFull: () => void
}

/**
 * 画面下部のログ。既定で開いておき、見落としを防ぐ。
 *
 * 高さはユーザーが決めたものを保つ。件数で伸び縮みすると、読んでいる途中に
 * Gantt の行位置が動いてしまい、ログを出す目的（何が起きたかを落ち着いて読む）と
 * 噛み合わないため。本文は固定の高さの中でスクロールさせる。
 */
export function LogPane({ log, full, onToggleFull }: Props) {
  const [open, setOpen] = useState(true)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const { entries, counts } = log

  // 上限は窓の高さから決める。窓が小さいときに Gantt を覆い尽くさないよう、
  // 常に何行かは Gantt 側に残す。
  const clamp = useCallback((value: number) => {
    const max = Math.max(MIN_HEIGHT, window.innerHeight - 200)
    return Math.min(max, Math.max(MIN_HEIGHT, Math.round(value)))
  }, [])

  // 窓を縮めたときだけ追従させる。広げたときに勝手に伸ばすと、
  // ユーザーが決めた高さを上書きしてしまう。
  useEffect(() => {
    const onResize = () => setHeight((h) => clamp(h))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [clamp])

  /**
   * 境界のドラッグで高さを変える。
   * pointer 系のイベントは window で拾う。ポインタが境界から外れても
   * 追従させたいのと、Gantt 側の要素に取られないようにするため。
   */
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (full) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const move = (ev: PointerEvent) => setHeight(clamp(startHeight + (startY - ev.clientY)))
    const end = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }

  const toggleOpen = () => setOpen((v) => !v)

  return (
    <div className={full ? "zk-log zk-log--full" : "zk-log"}>
      {/* ログだけの表示中は高さを親が決めるので、つまみは出さない。 */}
      {open && !full && (
        <div
          className="zk-log-resizer"
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="horizontal"
          aria-label="ログの高さ"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") setHeight((h) => clamp(h + STEP))
            else if (e.key === "ArrowDown") setHeight((h) => clamp(h - STEP))
            else return
            e.preventDefault()
          }}
        />
      )}

      <div
        className="zk-log-head"
        onClick={toggleOpen}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggleOpen()
        }}
      >
        <span className="zk-log-title">{open && !full ? "▾" : full ? "▣" : "▸"} Log</span>
        {counts.error > 0 && (
          <span className="zk-log-count zk-log-count--error">{counts.error} error</span>
        )}
        {counts.warn > 0 && (
          <span className="zk-log-count zk-log-count--warn">{counts.warn} warn</span>
        )}
        {counts.total === 0 && <span className="zk-log-title">問題なし</span>}
        <span className="zk-log-spacer" />
        {/* ログだけの表示に入る口はヘッダから外し、Alt+L に任せる。
            戻る口まで消すと full のまま抜けられなくなるので、その間だけ出す。 */}
        {full && (
          <button
            className="zk-button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleFull()
            }}
          >
            Gantt に戻す (Alt+L)
          </button>
        )}
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

      {(open || full) && (
        <div
          className={full ? "zk-log-body zk-log-body--full" : "zk-log-body"}
          style={full ? undefined : { height }}
        >
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
