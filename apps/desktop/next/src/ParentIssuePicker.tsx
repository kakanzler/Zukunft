"use client"

import { useEffect, useMemo, useState } from "react"
import type { ParentIssue, ScheduleTask } from "@zukunft/domain"

type Props = {
  /** 編集中の Issue。自分自身を親に選べないようにするのに使う */
  task: ScheduleTask
  /** 同じ Project のタスク。親の候補になる */
  tasks: ScheduleTask[]
  /** 親を引く。使えない GitHub では失敗するので、その場合は欄ごと畳む */
  onLoad: (issueId: string) => Promise<ParentIssue | null>
  /** 親を付け替える。null なら外す */
  onChange: (issueId: string, parentIssueId: string | null) => Promise<void>
}

/** 候補の一覧に出す最大件数。全部出すと選ぶより探す方が大変になる。 */
const MAX_CANDIDATES = 30

/**
 * 親 Issue（GitHub の sub-issue 関係）。
 *
 * 一覧の取得には混ぜず、詳細を開いたときだけ引く。sub-issue のフィールドが
 * 使えない GitHub ではクエリごと失敗するので、混ぜると盤面が丸ごと出なくなる。
 * ここで単独に引けば、失敗しても「この欄が出ない」だけで済む。
 */
export function ParentIssuePicker({ task, tasks, onLoad, onChange }: Props) {
  const [parent, setParent] = useState<ParentIssue | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "unsupported">("loading")
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  useEffect(() => {
    let alive = true
    setState("loading")
    setOpen(false)
    void onLoad(task.issueId)
      .then((found) => {
        if (!alive) return
        setParent(found)
        setState("ready")
      })
      .catch(() => {
        // 使えない GitHub もある。欄ごと出さないことで、押しても何も
        // 起きない枠を残さない。
        if (alive) setState("unsupported")
      })
    return () => {
      alive = false
    }
  }, [task.issueId, onLoad])

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "")
    return tasks
      .filter((t) => t.issueId !== task.issueId && t.issueId !== "")
      .filter(
        (t) =>
          q === "" || String(t.issueNumber).includes(q) || t.title.toLowerCase().includes(q),
      )
      .slice(0, MAX_CANDIDATES)
  }, [tasks, task.issueId, query])

  const apply = async (parentIssueId: string | null) => {
    setBusy(true)
    try {
      await onChange(task.issueId, parentIssueId)
      const found = parentIssueId
        ? (tasks.find((t) => t.issueId === parentIssueId) ?? null)
        : null
      setParent(
        found
          ? { issueId: found.issueId, number: found.issueNumber, title: found.title, url: found.url }
          : null,
      )
      setOpen(false)
      setQuery("")
    } finally {
      setBusy(false)
    }
  }

  if (state === "unsupported") return null

  return (
    <div className="zk-field zk-task-parent">
      <span className="zk-field-label">Parent Issue</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {state === "loading" ? (
          <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
            読み込み中…
          </span>
        ) : parent ? (
          <span className="zk-chip">
            #{parent.number} {parent.title}
            <button
              type="button"
              className="zk-chip-remove"
              aria-label="親 Issue を外す"
              disabled={busy}
              onClick={() => apply(null)}
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
            親なし
          </span>
        )}
        {state === "ready" && (
          <button
            type="button"
            className="zk-chip zk-chip--button"
            aria-pressed={open}
            disabled={busy}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "閉じる" : parent ? "付け替える" : "＋ 親を選ぶ"}
          </button>
        )}
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
              candidates.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="zk-chip zk-chip--button"
                  disabled={busy}
                  onClick={() => apply(t.issueId)}
                >
                  #{t.issueNumber} {t.title}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
