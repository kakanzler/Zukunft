"use client"

import { useEffect, useState } from "react"
import type { ISODate, NewTaskInput, RepositorySummary } from "@zukunft/domain"
import { inclusiveDays, isISODate } from "@zukunft/domain"

type Props = {
  repositories: RepositorySummary[]
  /** Start Date / Target Date が Project に無い場合、日付は指定できない */
  canEditDates: boolean
  busy: boolean
  onCreate: (input: NewTaskInput) => void
  onClose: () => void
}

/**
 * 新しい Issue を起票して Project に追加する。
 *
 * 日付は任意。GitHub で Issue を作ってから Project に追加して日付を入れる、
 * という往復を 1 画面に畳むのが目的。
 */
export function NewTaskModal({ repositories, canEditDates, busy, onCreate, onClose }: Props) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")

  useEffect(() => {
    if (!repositoryId && repositories[0]) setRepositoryId(repositories[0].id)
  }, [repositories, repositoryId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, busy])

  const bothFilled = start !== "" && end !== ""
  const noneFilled = start === "" && end === ""
  const wellFormed = isISODate(start) && isISODate(end)
  const datesOk = noneFilled || (bothFilled && wellFormed && start <= end)
  const canSubmit = repositoryId !== "" && title.trim() !== "" && datesOk && !busy

  const submit = () => {
    if (!canSubmit) return
    const input: NewTaskInput = { repositoryId, title: title.trim() }
    if (body.trim()) input.body = body.trim()
    if (bothFilled && wellFormed) {
      input.startDate = start as ISODate
      input.endDate = end as ISODate
    }
    onCreate(input)
  }

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="新しい Issue"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>新しい Issue</div>
          <button className="zk-button" onClick={onClose} disabled={busy} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-modal-body">
          <label className="zk-field">
            <span className="zk-field-label">Repository</span>
            {repositories.length === 0 ? (
              <span className="zk-field-value" style={{ color: "var(--warning)" }}>
                この Project にリンクされたリポジトリがありません。
                GitHub の Project 設定でリポジトリをリンクしてください。
              </span>
            ) : (
              <select
                className="zk-input"
                value={repositoryId}
                onChange={(e) => setRepositoryId(e.target.value)}
              >
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>{repo.nameWithOwner}</option>
                ))}
              </select>
            )}
          </label>

          <label className="zk-field">
            <span className="zk-field-label">Title</span>
            <input
              className="zk-input"
              value={title}
              autoFocus
              placeholder="実装するタスクの名前"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
            />
          </label>

          <label className="zk-field">
            <span className="zk-field-label">Body</span>
            <textarea
              className="zk-input"
              rows={4}
              value={body}
              placeholder="任意。Issue の本文"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          <div className="zk-field-row">
            <label className="zk-field">
              <span className="zk-field-label">Start Date</span>
              <input className="zk-input" type="date" value={start} disabled={!canEditDates}
                     onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="zk-field">
              <span className="zk-field-label">Target Date</span>
              <input className="zk-input" type="date" value={end} disabled={!canEditDates}
                     onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-secondary)", minHeight: 16 }}>
            {!canEditDates
              ? "Project に Start Date / Target Date が無いため、日程は後から設定します。"
              : noneFilled
                ? "日程は任意です。未入力なら日付なしの Issue として作成します。"
                : !bothFilled
                  ? "日程を入れる場合は両方を指定してください。"
                  : !wellFormed
                    ? "日付の形式が正しくありません。"
                    : start > end
                      ? "開始日は終了日以前にしてください。"
                      : `${inclusiveDays(start as ISODate, end as ISODate)} 日間`}
          </div>
        </div>

        <div className="zk-modal-foot">
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="zk-button" aria-pressed={canSubmit} disabled={!canSubmit} onClick={submit}>
            {busy ? "作成中…" : "作成"}
          </button>
        </div>
      </div>
    </div>
  )
}
