"use client"

import { useCallback, useMemo, useRef, useState } from "react"

/**
 * アプリ下部のログペイン。
 *
 * 企画書 §18 は「原因ごとに対処を添えて表示する」としか決めていないが、
 * カードを画面に積むと解決するまで場所を取り続けるため、時系列のログに流す。
 * 対処が必要なものだけ、エントリに操作ボタンを持たせる。
 */

export type LogLevel = "info" | "warn" | "error"

export type LogAction = {
  label: string
  run: () => void
  danger?: boolean
}

export type LogEntry = {
  id: number
  at: Date
  level: LogLevel
  message: string
  /** 原因に対する具体的な対処（企画書 §18） */
  hint?: string
  actions?: LogAction[]
  /** 同じ事象を積み増ししないための識別子 */
  dedupeKey?: string
}

/** 保持する上限。長時間動かしても増え続けないようにする。 */
const MAX_ENTRIES = 200

export type LogInput = Omit<LogEntry, "id" | "at">

export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const seq = useRef(0)

  const append = useCallback((input: LogInput) => {
    setEntries((prev) => {
      // 同じ dedupeKey の古いエントリは差し替える。
      // 再試行のたびに同じ失敗が積み上がるのを避けるため。
      const kept = input.dedupeKey
        ? prev.filter((e) => e.dedupeKey !== input.dedupeKey)
        : prev
      const next = [...kept, { ...input, id: ++seq.current, at: new Date() }]
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }, [])

  /** 解決済みの事象をログから取り下げる（競合を解決した、など）。 */
  const resolve = useCallback((dedupeKey: string) => {
    setEntries((prev) => prev.filter((e) => e.dedupeKey !== dedupeKey))
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  const counts = useMemo(() => {
    let warn = 0
    let error = 0
    for (const entry of entries) {
      if (entry.level === "warn") warn += 1
      else if (entry.level === "error") error += 1
    }
    return { warn, error, total: entries.length }
  }, [entries])

  /**
   * 返り値の identity を安定させる。LogPane に毎回新しい props を渡さないため。
   *
   * ただしこれは保険でしかない。`entries` が変われば identity も変わるので、
   * effect の依存配列には**このオブジェクトではなく `append` / `resolve` を入れる**こと。
   * ここをメモ化しただけで直った気になるのが一番危ない — ログを 1 行足すたびに
   * 依存が変わり、その effect が通信をしていれば「ログを出す → 再実行 → また
   * ログを出す」で回り続ける。実際にそれで GitHub を叩き続けていた。
   */
  return useMemo(
    () => ({ entries, counts, append, resolve, clear }),
    [entries, counts, append, resolve, clear],
  )
}

export type Log = ReturnType<typeof useLog>
