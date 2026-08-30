"use client"

import { useEffect, useState } from "react"
import type { DateChange, ISODate, Label, ScheduleTask, TaskContent } from "@zukunft/domain"
import { LabelEditor } from "@/LabelEditor"
import { inclusiveDays, isISODate } from "@zukunft/domain"
import { isTauri } from "@/repository"

type Props = {
  task: ScheduleTask
  /** Start Date / Target Date が Project に無い場合は編集できない */
  canEditDates: boolean
  savingContent: boolean
  /** リポジトリに定義済みのラベル。編集モードの候補になる */
  availableLabels: Label[]
  onCreateLabel: (repositoryId: string, name: string, color: string) => Promise<Label | null>
  onChangeDates: (taskId: string, change: DateChange) => void
  onSaveContent: (taskId: string, issueId: string, content: TaskContent) => Promise<unknown>
  onClose: () => void
}

const SYNC_LABEL: Record<ScheduleTask["syncState"], string> = {
  synced: "同期済み",
  pending: "未送信",
  syncing: "送信中",
  failed: "失敗",
  conflict: "競合",
}

/**
 * タスクの詳細。Gantt の行またはバーをクリックすると開く。
 *
 * 日付をここから直接指定できるようにしてあるのは、日付が未設定の Issue には
 * バーが描かれず、ドラッグでは編集を始められないため。
 */
export function TaskModal({
  task, canEditDates, savingContent, availableLabels, onCreateLabel,
  onChangeDates, onSaveContent, onClose,
}: Props) {
  const [start, setStart] = useState(task.startDate ?? "")
  const [end, setEnd] = useState(task.endDate ?? "")

  // タイトルと本文は編集モードに入ったときだけ書き換え可能にする。
  // 詳細を見るだけのつもりで誤って書き換えるのを避けるため。
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [labels, setLabels] = useState<Label[]>(task.labels)

  // 同期が返ってきて値が変わったら入力欄も追従させる
  useEffect(() => {
    setStart(task.startDate ?? "")
    setEnd(task.endDate ?? "")
  }, [task.startDate, task.endDate])

  // 保存が返ってきたら編集欄も追従させる
  useEffect(() => {
    if (editing) return
    setTitle(task.title)
    setBody(task.body)
    setLabels(task.labels)
  }, [task.title, task.body, task.labels, editing])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // 編集中の Esc はまず編集の取り消しに使う
      if (editing) {
        cancelEdit()
        return
      }
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, editing, task.title, task.body])

  // 日付入力は 6 桁の年など ISO から外れた値も受け付けるため、
  // 「形式が不正」と「前後関係が逆」を分けて扱う。
  const bothFilled = start !== "" && end !== ""
  const wellFormed = isISODate(start) && isISODate(end)
  const ordered = wellFormed && start <= end
  const valid = ordered
  const dirty = start !== (task.startDate ?? "") || end !== (task.endDate ?? "")

  const apply = () => {
    if (!valid || !dirty) return
    const change: DateChange = {}
    if (start !== task.startDate) change.startDate = start as ISODate
    if (end !== task.endDate) change.endDate = end as ISODate
    onChangeDates(task.id, change)
    onClose()
  }

  const sameLabels =
    labels.length === task.labels.length &&
    labels.every((l) => task.labels.some((t) => t.id === l.id))
  const contentDirty = title !== task.title || body !== task.body || !sameLabels
  const contentValid = title.trim() !== ""

  const saveContent = async () => {
    if (!contentDirty || !contentValid) {
      setEditing(false)
      return
    }
    await onSaveContent(task.id, task.issueId, {
      title: title.trim(),
      body,
      labelIds: labels.map((l) => l.id),
    })
    setEditing(false)
  }

  const cancelEdit = () => {
    setTitle(task.title)
    setBody(task.body)
    setLabels(task.labels)
    setEditing(false)
  }

  const openOnGitHub = async () => {
    if (!task.url) return
    if (isTauri()) {
      const { auth } = await import("@zukunft/github/tauri")
      await auth.openExternal(task.url)
    } else {
      window.open(task.url, "_blank", "noreferrer")
    }
  }

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`#${task.issueNumber} ${task.title}`}
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
              #{task.issueNumber}　/　{SYNC_LABEL[task.syncState]}
            </div>
            {editing ? (
              <input
                className="zk-input"
                value={title}
                autoFocus
                disabled={savingContent}
                onChange={(e) => setTitle(e.target.value)}
                style={{ width: "100%", marginTop: 4, fontSize: 14, fontWeight: 600 }}
              />
            ) : (
              <div className="zk-modal-title">{task.title}</div>
            )}
          </div>
          {!editing && (
            <button className="zk-button" onClick={() => setEditing(true)}>編集</button>
          )}
          <button className="zk-button" onClick={onClose} aria-label="閉じる"
                  disabled={savingContent}>✕</button>
        </div>

        <div className="zk-modal-body">
          <div className="zk-field-row">
            <Field label="Status" value={task.status ?? "—"} />
            <Field label="Priority" value={task.priority ?? "—"} />
          </div>

          <div className="zk-field">
            <span className="zk-field-label">Assignees</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {task.assignees.length === 0 ? (
                <span className="zk-field-value">未アサイン</span>
              ) : (
                task.assignees.map((a) => (
                  <span className="zk-chip" key={a.login}>{a.login}</span>
                ))
              )}
            </div>
          </div>

          {editing ? (
            <LabelEditor
              selected={labels}
              available={availableLabels}
              busy={savingContent}
              onChange={setLabels}
              onCreate={(name, color) => onCreateLabel(task.repositoryId, name, color)}
            />
          ) : (
            <div className="zk-field">
              <span className="zk-field-label">Labels</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {task.labels.length === 0 ? (
                  <span className="zk-field-value">ラベルなし</span>
                ) : (
                  task.labels.map((label) => (
                    <span
                      className="zk-chip"
                      key={label.id || label.name}
                      style={
                        label.color
                          ? { borderColor: `#${label.color}`, color: `#${label.color}` }
                          : undefined
                      }
                    >
                      <span
                        className="zk-legend-dot"
                        style={{ background: label.color ? `#${label.color}` : "currentColor" }}
                      />
                      {label.name}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="zk-field-row">
            <Field label="Milestone" value={task.milestone?.title ?? "—"} />
            <Field
              label="Progress"
              value={task.progress === null ? "—" : `${task.progress}%`}
            />
          </div>

          <div className="zk-field">
            <span className="zk-field-label">Body</span>
            {editing ? (
              <textarea
                className="zk-input"
                rows={8}
                value={body}
                disabled={savingContent}
                placeholder="Issue の本文"
                onChange={(e) => setBody(e.target.value)}
                style={{ fontFamily: "inherit" }}
              />
            ) : task.body.trim() ? (
              <div className="zk-body-text">{task.body}</div>
            ) : (
              <div className="zk-body-text zk-body-text--empty">本文はありません。</div>
            )}
          </div>

          {!canEditDates && (
            <div className="zk-card" style={{ borderColor: "var(--warning)" }}>
              <div className="zk-notice-strong">日付フィールドがありません</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                Project に Start Date / Target Date（いずれも Date 型）を作ると、
                ここから日程を設定できるようになります。
              </div>
            </div>
          )}

          <div className="zk-field-row">
            <label className="zk-field">
              <span className="zk-field-label">Start Date</span>
              <input
                className="zk-input"
                type="date"
                value={start}
                disabled={!canEditDates}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="zk-field">
              <span className="zk-field-label">Target Date</span>
              <input
                className="zk-input"
                type="date"
                value={end}
                disabled={!canEditDates}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-secondary)", minHeight: 16 }}>
            {!canEditDates
              ? null
              : !bothFilled
                ? "両方の日付を入力すると Gantt に表示されます。"
                : !wellFormed
                  ? "日付の形式が正しくありません。"
                  : !ordered
                    ? "開始日は終了日以前にしてください。"
                    : `${inclusiveDays(start as ISODate, end as ISODate)} 日間`}
          </div>
        </div>

        <div className="zk-modal-foot">
          {editing ? (
            <>
              <button className="zk-button" onClick={cancelEdit} disabled={savingContent}>
                キャンセル
              </button>
              <button
                className="zk-button"
                aria-pressed={contentDirty && contentValid}
                disabled={savingContent || !contentValid}
                onClick={saveContent}
              >
                {savingContent ? "保存中…" : "内容を保存"}
              </button>
            </>
          ) : (
            <>
              <button className="zk-button" onClick={openOnGitHub} disabled={!task.url}>
                GitHub で開く
              </button>
              <button className="zk-button" onClick={onClose}>閉じる</button>
              <button
                className="zk-button"
                aria-pressed={dirty && valid}
                disabled={!canEditDates || !dirty || !valid}
                onClick={apply}
              >
                日程を保存
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="zk-field">
      <span className="zk-field-label">{label}</span>
      <span className="zk-field-value">{value}</span>
    </div>
  )
}
