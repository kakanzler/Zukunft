"use client"

import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import type {
  DateChange,
  ISODate,
  Label,
  Milestone,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"
import { LabelEditor } from "@/LabelEditor"
import { inclusiveDays, isISODate } from "@zukunft/domain"
import { statusVar } from "@zukunft/gantt"
import { isTauri } from "@/repository"

type StatusOption = { id: string; name: string }

type Props = {
  task: ScheduleTask
  /** Start Date / Target Date が Project に無い場合は編集できない */
  canEditDates: boolean
  savingContent: boolean
  savingStatus: boolean
  /** Project の Status フィールドの選択肢。定義順。空なら Status を変更できない */
  statusOptions: StatusOption[]
  /** リポジトリに定義済みのラベル。編集モードの候補になる */
  availableLabels: Label[]
  /** リポジトリの Milestone（OPEN のみ）。編集モードの候補になる */
  availableMilestones: Milestone[]
  onCreateLabel: (repositoryId: string, name: string, color: string) => Promise<Label | null>
  onChangeDates: (taskId: string, change: DateChange) => void
  onChangeStatus: (taskId: string, optionId: string) => void
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
 * タスクの詳細（意匠は specifications/apeearance/appearnace_modal.png に準拠）。
 * Gantt の行またはバーをクリックすると開く。
 *
 * 編集の粒度は 2 段階。
 * - Status と日付は「編集」に入らずその場で変更できる。どちらも選択肢と日付入力
 *   なので誤操作になりにくく、日付が未設定の Issue はバーが描かれずドラッグでも
 *   直せないため、ここが唯一の入口になる。
 * - タイトル・ラベル・Milestone・本文は「編集」に入ってから。詳細を見るだけの
 *   つもりで書き換えてしまうのを避けるため。
 */
export function TaskModal({
  task, canEditDates, savingContent, savingStatus, statusOptions,
  availableLabels, availableMilestones, onCreateLabel,
  onChangeDates, onChangeStatus, onSaveContent, onClose,
}: Props) {
  const [start, setStart] = useState(task.startDate ?? "")
  const [end, setEnd] = useState(task.endDate ?? "")

  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [labels, setLabels] = useState<Label[]>(task.labels)
  const [milestoneId, setMilestoneId] = useState(task.milestone?.id ?? "")

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
    setMilestoneId(task.milestone?.id ?? "")
  }, [task.title, task.body, task.labels, task.milestone, editing])

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
  }, [onClose, editing, task.title, task.body, task.milestone])

  // 日付入力は 6 桁の年など ISO から外れた値も受け付けるため、
  // 「形式が不正」と「前後関係が逆」を分けて扱う。
  const bothFilled = start !== "" && end !== ""
  const wellFormed = isISODate(start) && isISODate(end)
  const ordered = wellFormed && start <= end
  const datesValid = ordered
  const datesDirty = start !== (task.startDate ?? "") || end !== (task.endDate ?? "")

  const applyDates = () => {
    if (!datesValid || !datesDirty) return
    const change: DateChange = {}
    if (start !== task.startDate) change.startDate = start as ISODate
    if (end !== task.endDate) change.endDate = end as ISODate
    onChangeDates(task.id, change)
  }

  const sameLabels =
    labels.length === task.labels.length &&
    labels.every((l) => task.labels.some((t) => t.id === l.id))
  const contentDirty =
    title !== task.title ||
    body !== task.body ||
    !sameLabels ||
    milestoneId !== (task.milestone?.id ?? "")
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
      milestoneId: milestoneId === "" ? null : milestoneId,
    })
    setEditing(false)
  }

  const cancelEdit = () => {
    setTitle(task.title)
    setBody(task.body)
    setLabels(task.labels)
    setMilestoneId(task.milestone?.id ?? "")
    setEditing(false)
  }

  // 「update」は今そこにある変更をまとめて送る。編集モードなら本文なども、
  // そうでなければ日付だけ。どちらも無ければ押せない。
  const busy = savingContent || savingStatus
  const canUpdate =
    !busy &&
    ((datesDirty && datesValid) || (editing && contentDirty && contentValid))

  const update = async () => {
    if (editing) await saveContent()
    if (datesDirty && datesValid) applyDates()
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

  // Status の色は Gantt のバーと同じ規則（定義順に 4 色を巡回）で割り当てる。
  const statusIndex = statusOptions.findIndex((o) => o.name === task.status)
  const statusColor = statusIndex >= 0 ? statusVar(statusIndex) : "var(--border-subtle)"
  const currentStatusId = statusOptions.find((o) => o.name === task.status)?.id ?? ""

  // 現在の Milestone が候補に無い（閉じている等）場合も選択肢に残す。
  const milestoneChoices = task.milestone &&
    !availableMilestones.some((m) => m.id === task.milestone!.id)
    ? [task.milestone, ...availableMilestones]
    : availableMilestones

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
      <div className="zk-modal zk-modal--task">
        <div className="zk-task-head">
          <div className="zk-field zk-task-status">
            <span className="zk-field-label">status</span>
            <div className="zk-status-picker" title={task.status ?? "未設定"}>
              <span className="zk-status-dot" style={{ background: statusColor }} />
              <select
                className="zk-status-select"
                aria-label="Status"
                value={currentStatusId}
                disabled={busy || statusOptions.length === 0}
                onChange={(e) => onChangeStatus(task.id, e.target.value)}
              >
                {currentStatusId === "" && <option value="">—</option>}
                {statusOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="zk-field zk-task-title">
            <span className="zk-field-label">
              title　#{task.issueNumber}　/　{SYNC_LABEL[task.syncState]}
            </span>
            {editing ? (
              <input
                className="zk-input zk-title-input"
                value={title}
                autoFocus
                disabled={savingContent}
                onChange={(e) => setTitle(e.target.value)}
              />
            ) : (
              <div className="zk-input zk-title-input zk-title-input--static">{task.title}</div>
            )}
          </div>

          <div className="zk-field zk-task-labels">
            <span className="zk-field-label">label</span>
            {/* 編集中は編集後の集合を映す。下の LabelEditor の結果がここに出る。 */}
            <div className="zk-label-row">
              {labels.length === 0 ? (
                <span className="zk-field-value zk-muted">ラベルなし</span>
              ) : (
                labels.map((label) => (
                  <span
                    className="zk-chip zk-chip--label"
                    key={label.id || label.name}
                    style={chipStyle(label.color)}
                  >
                    {label.name}
                  </span>
                ))
              )}
            </div>
          </div>

          <button
            className="zk-button zk-task-close"
            onClick={onClose}
            aria-label="閉じる"
            disabled={savingContent}
          >
            ✕
          </button>
        </div>

        <div className="zk-task-meta">
          <label className="zk-field">
            <span className="zk-field-label">start date</span>
            <input
              className="zk-input"
              type="date"
              value={start}
              disabled={!canEditDates || busy}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="zk-field">
            <span className="zk-field-label">target date</span>
            <input
              className="zk-input"
              type="date"
              value={end}
              disabled={!canEditDates || busy}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label className="zk-field">
            <span className="zk-field-label">Milestone</span>
            {editing ? (
              <select
                className="zk-input"
                value={milestoneId}
                disabled={savingContent}
                onChange={(e) => setMilestoneId(e.target.value)}
              >
                <option value="">なし</option>
                {milestoneChoices.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            ) : (
              <div className="zk-input zk-input--static">
                {task.milestone?.title ?? "—"}
              </div>
            )}
          </label>
        </div>

        {editing && (
          <div className="zk-task-labels-edit">
            <LabelEditor
              selected={labels}
              available={availableLabels}
              busy={savingContent}
              onChange={setLabels}
              onCreate={(name, color) => onCreateLabel(task.repositoryId, name, color)}
            />
          </div>
        )}

        <div className="zk-field zk-task-body">
          <span className="zk-field-label">body</span>
          {editing ? (
            <textarea
              className="zk-input zk-body-input"
              value={body}
              disabled={savingContent}
              placeholder="Issue の本文（Markdown）"
              onChange={(e) => setBody(e.target.value)}
            />
          ) : task.body.trim() ? (
            <div className="zk-body-text zk-body-text--fill">{task.body}</div>
          ) : (
            <div className="zk-body-text zk-body-text--fill zk-body-text--empty">
              本文はありません。
            </div>
          )}
        </div>

        <div className="zk-task-notice">
          {/* モックには枠が無いが、担当・Priority・Progress は落とさずここに畳んでおく。 */}
          <span className="zk-task-meta-inline">
            {task.assignees.length === 0
              ? "未アサイン"
              : task.assignees.map((a) => a.login).join(", ")}
            　/　Priority: {task.priority ?? "—"}
            　/　Progress: {task.progress === null ? "—" : `${task.progress}%`}
          </span>
          {!canEditDates
            ? "Project に Start Date / Target Date（Date 型）を作ると日程を設定できます。"
            : !bothFilled
              ? "両方の日付を入力すると Gantt に表示されます。"
              : !wellFormed
                ? "日付の形式が正しくありません。"
                : !ordered
                  ? "開始日は終了日以前にしてください。"
                  : `${inclusiveDays(start as ISODate, end as ISODate)} 日間`}
        </div>

        <div className="zk-task-foot">
          <div className="zk-field zk-task-parent">
            <span className="zk-field-label">Parent Issue</span>
            {/* 親子関係（sub-issue）は未対応。枠だけ用意しておく（企画書 Q-8） */}
            <div className="zk-input zk-input--static zk-muted">—</div>
          </div>
          <button className="zk-button" onClick={openOnGitHub} disabled={!task.url}>
            to GitHub
          </button>
          <button
            className="zk-button"
            aria-pressed={canUpdate}
            disabled={!canUpdate}
            onClick={update}
          >
            {savingContent ? "保存中…" : "update"}
          </button>
          {editing ? (
            <button className="zk-button" onClick={cancelEdit} disabled={savingContent}>
              cancel
            </button>
          ) : (
            <button className="zk-button" onClick={() => setEditing(true)} disabled={busy}>
              edit
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** ラベルの色で塗ったチップ。地の明度に応じて文字色を白黒で切り替える。 */
function chipStyle(color: string): CSSProperties | undefined {
  if (!color) return undefined
  return {
    background: `#${color}`,
    borderColor: `#${color}`,
    color: isLight(color) ? "#0b1020" : "#ffffff",
  }
}

function isLight(hex: string): boolean {
  if (hex.length !== 6) return false
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if ([r, g, b].some((v) => Number.isNaN(v))) return false
  // ITU-R BT.601 の輝度。GitHub のラベル表示と同じ考え方。
  return (r! * 299 + g! * 587 + b! * 114) / 1000 > 150
}
