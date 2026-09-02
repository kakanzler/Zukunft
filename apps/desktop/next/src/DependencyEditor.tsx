"use client"

import { useMemo, useState } from "react"
import type { ScheduleTask } from "@zukunft/domain"

type Props = {
  /** 同じ Project に載っているタスク。候補の出所 */
  tasks: ScheduleTask[]
  /** 編集中の Issue。自分自身を候補に出さないために使う */
  taskId: string
  /** 現在の依存先の Issue 番号 */
  value: number[]
  busy: boolean
  onChange: (numbers: number[]) => void
}

/** 候補の一覧に出す最大件数。全部出すと選ぶより探す方が大変になる。 */
const MAX_CANDIDATES = 30

/**
 * 依存関係（blocked-by）の付け外し（企画書 §15.1）。
 *
 * 保存先は Issue 本文なので、本文を直接書いても同じことができる。それでも画面を
 * 用意するのは、書式を間違えたときに「線が出ない」以外の手掛かりが無いため。
 * 番号を手で打たせず一覧から選ばせれば、Project に載っていない番号を書くことも、
 * 綴りを間違えることも起きない。
 */
export function DependencyEditor({ tasks, taskId, value, busy, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const byNumber = useMemo(() => {
    const map = new Map<number, ScheduleTask>()
    for (const task of tasks) if (!map.has(task.issueNumber)) map.set(task.issueNumber, task)
    return map
  }, [tasks])

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "")
    return tasks
      .filter((t) => t.id !== taskId && !value.includes(t.issueNumber))
      .filter(
        (t) =>
          q === "" ||
          String(t.issueNumber).includes(q) ||
          t.title.toLowerCase().includes(q),
      )
      .slice(0, MAX_CANDIDATES)
  }, [tasks, taskId, value, query])

  const add = (number: number) => {
    onChange([...value, number])
    setQuery("")
  }

  return (
    <div className="zk-field">
      <span className="zk-field-label">Dependency</span>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {value.length === 0 ? (
          <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
            依存なし
          </span>
        ) : (
          value.map((number) => {
            const target = byNumber.get(number)
            return (
              <span className="zk-chip" key={number}>
                #{number}
                {/* Project に載っていない番号は線にならない。その旨をここで示す。 */}
                {target ? ` ${target.title}` : " （この Project にありません）"}
                <button
                  type="button"
                  className="zk-chip-remove"
                  aria-label={`#${number} への依存を外す`}
                  disabled={busy}
                  onClick={() => onChange(value.filter((n) => n !== number))}
                >
                  ✕
                </button>
              </span>
            )
          })
        )}
        <button
          type="button"
          className="zk-chip zk-chip--button"
          disabled={busy}
          aria-pressed={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "閉じる" : "＋ 依存を追加"}
        </button>
      </div>

      {open && (
        <>
          <input
            className="zk-input"
            value={query}
            autoFocus
            disabled={busy}
            placeholder="番号かタイトルで絞り込む"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="zk-label-picker">
            {candidates.length === 0 ? (
              <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
                該当する Issue がありません。
              </span>
            ) : (
              candidates.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className="zk-chip zk-chip--button"
                  disabled={busy}
                  onClick={() => add(task.issueNumber)}
                >
                  #{task.issueNumber} {task.title}
                </button>
              ))
            )}
          </div>
        </>
      )}

      <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
        選んだ Issue は、先に片付いている必要があるものとして本文に
        blocked-by: として書かれます。Gantt では自分から依存先へ矢印が出ます。
      </span>
    </div>
  )
}
