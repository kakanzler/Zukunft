"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import type {
  Assignee,
  DateChange,
  ISODate,
  IssueState,
  Label,
  Milestone,
  ParentIssue,
  Recurrence,
  ScheduleTask,
  TaskContent,
} from "@zukunft/domain"
import { DependencyEditor } from "@/DependencyEditor"
import { ParentIssuePicker } from "@/ParentIssuePicker"
import { LabelEditor } from "@/LabelEditor"
import { AssigneeEditor } from "@/AssigneeEditor"
import { ParentCategoryPicker } from "@/ParentCategoryPicker"
import { Markdown } from "@/Markdown"
import {
  inclusiveDays,
  isISODate,
  parseDependencyRefs,
  toggleTaskListItem,
  withDependencyRefs,
} from "@zukunft/domain"
import { statusVar } from "@zukunft/gantt"
import { isTauri } from "@/repository"

type StatusOption = { id: string; name: string }

type Props = {
  task: ScheduleTask
  /** Start Date / Target Date が Project に無い場合は編集できない */
  canEditDates: boolean
  savingContent: boolean
  savingStatus: boolean
  /** Priority / Progress の送信中 */
  savingField: boolean
  /** クローズ / リオープンの送信中 */
  savingState: boolean
  /** 削除の送信中 */
  deleting: boolean
  /** Project の Status フィールドの選択肢。定義順。空なら Status を変更できない */
  statusOptions: StatusOption[]
  /** Project の Priority フィールドの選択肢。定義順。空なら Priority を変更できない */
  priorityOptions?: StatusOption[]
  /** Project に Progress（NUMBER）があるか。無ければ変更できない */
  canEditProgress?: boolean
  /** リポジトリに定義済みのラベル。編集モードの候補になる */
  availableLabels: Label[]
  /** この Issue に担当として付けられるユーザー。編集モードの候補になる */
  availableAssignees: Assignee[]
  /**
   * 親カテゴリとして扱うラベル名（カテゴリ設定の値）。
   * 編集モードで、この Issue をどの親カテゴリに置くかを選ばせるのに使う。
   */
  parentLabels?: string[]
  /** 親カテゴリの集合を差し替える。渡すとこの画面から増減できる */
  onDesignateParentLabels?: (names: string[]) => Promise<void> | void
  /** 親 Issue（sub-issue）を引く。渡さなければその欄を出さない */
  onLoadParentIssue?: (issueId: string) => Promise<ParentIssue | null>
  /** 親 Issue を付け替える */
  onChangeParentIssue?: (issueId: string, parentIssueId: string | null) => Promise<void>
  /** 名前で重複を除いたラベル一覧。別リポジトリにしか無いものの色を引くのに使う */
  labelCatalog?: Label[]
  /** 同じ Project のタスク。依存先の候補になる */
  allTasks?: ScheduleTask[]
  /** リポジトリの Milestone（OPEN のみ）。編集モードの候補になる */
  availableMilestones: Milestone[]
  onCreateLabel: (repositoryId: string, name: string, color: string) => Promise<Label | null>
  onDeleteLabel: (repositoryId: string, label: Label) => Promise<boolean>
  onChangeDates: (taskId: string, change: DateChange) => void
  onChangeStatus: (taskId: string, optionId: string) => void
  /** Priority の変更。null は未設定に戻す。渡さなければ Priority を変更できない */
  onChangePriority?: (taskId: string, optionId: string | null) => void
  /** Progress の変更。null は未設定に戻す。渡さなければ Progress を変更できない */
  onChangeProgress?: (taskId: string, value: number | null) => void
  onSaveContent: (taskId: string, issueId: string, content: TaskContent) => Promise<unknown>
  onSetState: (taskId: string, issueId: string, state: IssueState) => void
  onDelete: (taskId: string, issueId: string) => void | Promise<void>
  /** この Issue の日課の設定。日課でなければ null */
  daily?: Recurrence | null
  /**
   * 日課の間隔を変える。0 は日課をやめる（実行した記録ごと消える）。
   * 渡さなければその節を出さない。
   */
  onChangeDaily?: (taskId: string, intervalDays: number) => void
  onClose: () => void
  /** 一覧で e から開いたときは編集モードで始める */
  initialEditing?: boolean
}

/** 既定値をその場で書くと毎回別の配列になり、選択肢の再計算が止まらなくなる。 */
const EMPTY_PARENT_LABELS: string[] = []
const EMPTY_LABELS: Label[] = []
const EMPTY_TASKS: ScheduleTask[] = []
const EMPTY_OPTIONS: StatusOption[] = []

/**
 * 選択肢に無い Priority を現在値として見せるための印。
 * 実在する選択肢の id と衝突しないよう、GitHub が使わない形にしてある。
 */
const UNKNOWN_PRIORITY = "__zk-unknown-priority__"

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
  task, canEditDates, savingContent, savingStatus, savingField,
  savingState, deleting, statusOptions,
  priorityOptions = EMPTY_OPTIONS, canEditProgress = false,
  availableLabels, availableAssignees,
  parentLabels = EMPTY_PARENT_LABELS, labelCatalog = EMPTY_LABELS,
  allTasks = EMPTY_TASKS, availableMilestones, onCreateLabel, onDeleteLabel,
  onDesignateParentLabels, onLoadParentIssue, onChangeParentIssue,
  onChangeDates, onChangeStatus, onChangePriority, onChangeProgress,
  onSaveContent, onSetState, onDelete, onClose,
  daily = null, onChangeDaily,
  initialEditing = false,
}: Props) {
  const [start, setStart] = useState(task.startDate ?? "")
  const [end, setEnd] = useState(task.endDate ?? "")

  // 一覧で e を押して開いた場合は、最初から編集に入る。
  const [editing, setEditing] = useState(initialEditing)
  /**
   * 編集を始めた時点の updatedAt。競合の判定に使う（企画書 §16.3）。
   *
   * 送るときの task.updatedAt ではなく、編集に入った時点の値を掴む。
   * 編集中に再読み込みが走ると task は新しくなるが、こちらの下書きは古い内容を
   * 元にしているので、新しい値で照合すると素通ししてしまう。
   */
  const [editingBase, setEditingBase] = useState(task.updatedAt)
  // 削除は取り消せないので、ボタン列を確認に差し替える 2 段階にする。
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [labels, setLabels] = useState<Label[]>(task.labels)
  const [assignees, setAssignees] = useState<Assignee[]>(task.assignees)
  const [milestoneId, setMilestoneId] = useState(task.milestone?.id ?? "")
  // 依存関係は本文に書いてある。編集中は本文とは別に持ち、保存のときに書き戻す。
  const [dependsOn, setDependsOn] = useState<number[]>(() => parseDependencyRefs(task.body))
  /**
   * Progress は文字列で持つ。数値にすると「空欄」と 0 が同じ状態になり、
   * 未設定に戻す操作が表現できない。送るときに null / 数値へ直す。
   */
  const [progress, setProgress] = useState(task.progress === null ? "" : String(task.progress))

  // 同期が返ってきて値が変わったら入力欄も追従させる。
  //
  // ただし日付を打っている最中は上書きしない。同じタスクのドラッグ分の送信が
  // 返ってくると、入力中の日付がカーソルの下で書き戻されていた。
  // 本文側（下の effect）と揃えて、編集中は触らない。
  const editingDates = start !== (task.startDate ?? "") || end !== (task.endDate ?? "")
  useEffect(() => {
    if (editingDates) return
    setStart(task.startDate ?? "")
    setEnd(task.endDate ?? "")
    // editingDates を依存に入れると、打ち始めた瞬間に false → true で
    // 走り直して入力を消してしまう。日付が変わったときだけ見る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.startDate, task.endDate])

  /**
   * 日課の間隔。Progress と同じく文字列で持つ。数値にすると打ち消した瞬間に
   * 0（＝日課をやめる）になり、「消して打ち直す」だけで日課が消えてしまう。
   */
  // UI が扱う日課はまだ interval モードだけ（spaced の画面対応は後続作業）。
  const dailyInterval = daily?.rule.kind === "interval" ? daily.rule.intervalDays : null
  const [intervalText, setIntervalText] = useState(
    dailyInterval === null ? "1" : String(dailyInterval),
  )
  /**
   * 保存が返ったら、または別のタスクを開いたら、その日課の値に戻す。
   *
   * 依存は設定そのもの（daily）ではなく間隔の数値。盤面で点を 1 つ押すたびに
   * daily は別のオブジェクトになるので、そのまま依存にすると打ちかけの間隔が
   * 実行の記録のたびに消える。
   */
  useEffect(() => {
    setIntervalText(dailyInterval === null ? "1" : String(dailyInterval))
  }, [task.id, dailyInterval])

  const progressText = task.progress === null ? "" : String(task.progress)
  const progressDirty = progress !== progressText
  // 別のタスクを開いても同じモーダルが使い回されるので、打ちかけの数字が
  // 残る。前の行の値をそのまま送ってしまうため、タスクが変わったら必ず戻す。
  // 同じタスクを見ている間だけは、日付と同じく入力中の値を守る。
  const shownTaskId = useRef(task.id)
  useEffect(() => {
    const switched = shownTaskId.current !== task.id
    shownTaskId.current = task.id
    if (!switched && progressDirty) return
    setProgress(task.progress === null ? "" : String(task.progress))
    // progressDirty を依存に入れると、打ち始めた瞬間に走り直して入力を消す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.progress])

  // 保存が返ってきたら編集欄も追従させる
  useEffect(() => {
    if (editing) return
    setTitle(task.title)
    setBody(task.body)
    setLabels(task.labels)
    setAssignees(task.assignees)
    setMilestoneId(task.milestone?.id ?? "")
    setDependsOn(parseDependencyRefs(task.body))
  }, [task.title, task.body, task.labels, task.assignees, task.milestone, editing])

  // 別のタスクを開いたら削除の確認は持ち越さない。
  // 前の行で出した確認をそのまま押すと、意図しない Issue を消してしまう。
  useEffect(() => {
    setConfirmingDelete(false)
  }, [task.id])

  /** 編集をやめて、開いたときの値に戻す。Esc とキャンセルボタンの両方から使う。 */
  const cancelEdit = useCallback(() => {
    setTitle(task.title)
    setBody(task.body)
    setLabels(task.labels)
    setAssignees(task.assignees)
    setMilestoneId(task.milestone?.id ?? "")
    setDependsOn(parseDependencyRefs(task.body))
    setEditing(false)
    setConfirmingDelete(false)
  }, [task.title, task.body, task.labels, task.assignees, task.milestone])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 詳細を見ているところから e で編集に入る。文字を打っている最中は拾わない。
      if (e.code === "KeyE" && !editing && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const active = document.activeElement
        const typing =
          active instanceof HTMLElement &&
          (active.isContentEditable ||
            active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT")
        if (!typing) {
          e.preventDefault()
          setEditingBase(task.updatedAt)
          setEditing(true)
        }
        return
      }
      if (e.key !== "Escape") return
      // 削除の確認が出ているなら、まずそれを取り下げる
      if (confirmingDelete) {
        setConfirmingDelete(false)
        return
      }
      // 編集中の Esc はまず編集の取り消しに使う
      if (editing) {
        cancelEdit()
        return
      }
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, editing, confirmingDelete, cancelEdit, task.updatedAt])

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
    !task.labelsComplete ||
    (labels.length === task.labels.length &&
      labels.every((l) => task.labels.some((t) => t.id === l.id)))
  // 読み切れていない担当は送らないので、触れていても「変更なし」として扱う。
  const sameAssignees =
    !task.assigneesComplete ||
    (assignees.length === task.assignees.length &&
      assignees.every((a) => task.assignees.some((t) => t.id === a.id)))
  const savedDeps = parseDependencyRefs(task.body)
  const sameDeps =
    dependsOn.length === savedDeps.length && dependsOn.every((n) => savedDeps.includes(n))
  const contentDirty =
    title !== task.title ||
    body !== task.body ||
    !sameLabels ||
    !sameAssignees ||
    !sameDeps ||
    milestoneId !== (task.milestone?.id ?? "")
  const contentValid = title.trim() !== ""

  const saveContent = async () => {
    if (!contentDirty || !contentValid) {
      setEditing(false)
      return
    }
    await onSaveContent(task.id, task.issueId, {
      title: title.trim(),
      // 依存関係は本文の中の宣言なので、本文と一緒に 1 回で送る。
      body: withDependencyRefs(body, dependsOn),
      expectedUpdatedAt: editingBase,
      // ラベルを読み切れていない Issue では触らない。置き換え集合として送ると、
      // 読めなかった分が Issue から永久に外れる。
      labelIds: task.labelsComplete ? labels.map((l) => l.id) : null,
      // 担当も同じ置き換え集合。読み切れていない Issue では触らない。
      assigneeIds: task.assigneesComplete ? assignees.map((a) => a.id) : null,
      milestoneId: milestoneId === "" ? null : milestoneId,
    })
    setEditing(false)
  }

  /**
   * 本文のチェックボックスの開け閉め。
   *
   * 編集モードに入らずその場で送る。読んでいる最中に 1 つ消すだけの操作なので、
   * 「編集 → 保存」を挟ませると手数が釣り合わない。送るのは本文だけで、
   * タイトルと Milestone は今の値をそのまま載せる（updateIssue は置き換えのため）。
   */
  const toggleTask = async (index: number) => {
    if (savingContent) return
    await onSaveContent(task.id, task.issueId, {
      title: task.title,
      body: toggleTaskListItem(task.body, index),
      labelIds: task.labelsComplete ? task.labels.map((l) => l.id) : null,
      assigneeIds: task.assigneesComplete ? task.assignees.map((a) => a.id) : null,
      milestoneId: task.milestone?.id ?? null,
      // いま見えているものへの即時操作なので、基準は今の値でよい。
      expectedUpdatedAt: task.updatedAt,
    })
  }

  // 「update」は今そこにある変更をまとめて送る。編集モードなら本文なども、
  // そうでなければ日付だけ。どちらも無ければ押せない。
  const busy = savingContent || savingStatus || savingField || savingState || deleting
  const canUpdate =
    !busy &&
    ((datesDirty && datesValid) || (editing && contentDirty && contentValid))

  const update = async () => {
    if (editing) await saveContent()
    if (datesDirty && datesValid) applyDates()
  }

  const closed = task.issueState === "CLOSED"
  const toggleState = () => onSetState(task.id, task.issueId, closed ? "OPEN" : "CLOSED")

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

  // Project に Priority / Progress が無ければ編集させない。Status の選択肢が
  // 空のときと同じ扱いで、送っても field-missing で失敗するだけのため。
  const canChangePriority = Boolean(onChangePriority) && priorityOptions.length > 0
  const canChangeProgress = Boolean(onChangeProgress) && canEditProgress
  /**
   * いま選ばれている Priority。
   *
   * Milestone と違い、タスクが持っているのは選択肢の名前だけで id は持っていない。
   * 選択肢が Project から消されると id が引けず、値が入っているのに「—」が
   * 選ばれて見える — 何も設定されていないと誤解させる。そこで、引けないときだけ
   * 名前を載せた仮の選択肢を足して現在値を見せる。送り先の id が無いので、
   * この選択肢は選び直せない（選ぶのは実在する選択肢か「—」）。
   */
  const knownPriorityId = priorityOptions.find((o) => o.name === task.priority)?.id
  const priorityMissing = task.priority !== null && knownPriorityId === undefined
  const currentPriorityId = knownPriorityId ?? (priorityMissing ? UNKNOWN_PRIORITY : "")

  /**
   * Progress の確定。入力のたびには送らない。1 文字ごとに GitHub を叩くことになり、
   * 「10」を打つ途中の 1 が残り得る。フォーカスを外したときと Enter でだけ送る。
   */
  const commitProgress = () => {
    if (!onChangeProgress || !canChangeProgress || busy) return
    const text = progress.trim()
    if (text === "") {
      // 未設定に戻す。0 と同じにはしない。
      if (task.progress !== null) onChangeProgress(task.id, null)
      return
    }
    const value = Number(text)
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      // 送っても弾かれるので、ここで諦めて元の値に戻す。
      setProgress(progressText)
      return
    }
    if (value === task.progress) return
    onChangeProgress(task.id, value)
  }

  /**
   * 日課の間隔の確定。Progress と同じく、打っている途中では送らない。
   *
   * 送り先はアプリの設定だけで GitHub には何も起きないが、1 文字ごとに保存すると
   * 「10」を打つ途中の 1 日ごとが一瞬盤面に出て、点が数百個描き直される。
   */
  /** 打ってある間隔。読めなければ既定の 1 日ごと。 */
  const typedInterval = () => {
    const value = Number(intervalText.trim())
    return Number.isInteger(value) && value >= 1 ? value : 1
  }

  const commitDaily = () => {
    if (!onChangeDaily || busy) return
    const value = Number(intervalText.trim())
    if (!Number.isInteger(value) || value < 1) {
      // 0 や空欄は「やめる」ではなく打ち間違い。やめるのはチェックを外す操作なので、
      // ここでは送らずに元の値へ戻す。
      setIntervalText(dailyInterval === null ? "1" : String(dailyInterval))
      return
    }
    if (value === dailyInterval) return
    onChangeDaily(task.id, value)
  }

  // 現在の Milestone が候補に無い（閉じている等）場合も選択肢に残す。
  const milestoneChoices = task.milestone &&
    !availableMilestones.some((m) => m.id === task.milestone!.id)
    ? [task.milestone, ...availableMilestones]
    : availableMilestones

  /**
   * 親カテゴリの選択肢。
   *
   * 親カテゴリは GitHub 側ではただのラベルなので、選ぶ / 外すはそのラベルの
   * 付け外しそのものになる。付けるには node id が要るが、カテゴリ設定が持って
   * いるのは名前だけなので、ここで実体を引き直す。他のリポジトリにしか無い
   * ラベルは引けない — その場合は選べないことを理由ごと出す。
   */
  const parentChoices = parentLabels.map((name) => ({
    name,
    label:
      task.labels.find((l) => l.name === name) ??
      availableLabels.find((l) => l.name === name) ??
      null,
  }))
  const selectedParents = new Set(
    labels.filter((l) => parentLabels.includes(l.name)).map((l) => l.name),
  )

  /** 親カテゴリの付け外し。下の Labels の集合と同じ状態を触るので表示は連動する。 */
  const toggleParent = (name: string, label: Label | null) => {
    if (selectedParents.has(name)) {
      setLabels(labels.filter((l) => l.name !== name))
      return
    }
    if (!label) return
    setLabels([...labels, label])
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
            {/* クローズ済みかどうかは一覧では分からない。開いた時にここで気づけるようにする。 */}
            <span className="zk-field-label">
              title　#{task.issueNumber}　/　{SYNC_LABEL[task.syncState]}
              {closed && "　/　クローズ済み"}
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

        {/* 日課。起票の画面と同じ形で、日付欄の直後に置く。ここで決めるのは
            日付の読み方（Start Date が最初の実行日、Target Date が最後の実行日）で、
            間違えた間隔を後から直せる唯一の場所でもある。 */}
        {onChangeDaily && (
          <div className="zk-field zk-daily-edit">
            <span className="zk-field-label">日課</span>
            <label className="zk-daily-check">
              <input
                type="checkbox"
                checked={daily !== null}
                disabled={busy}
                onChange={(e) => {
                  // やめるときは間隔 0 を送る。設定側は項目ごと消えるので、
                  // 実行した記録もそこで一緒に消える。
                  onChangeDaily(task.id, e.target.checked ? typedInterval() : 0)
                }}
              />
              決まった間隔で繰り返す
            </label>
            {daily !== null && (
              <div className="zk-daily-row">
                <input
                  className="zk-input zk-daily-interval"
                  type="number"
                  aria-label="間隔（日）"
                  min={1}
                  step={1}
                  value={intervalText}
                  disabled={busy}
                  onChange={(e) => setIntervalText(e.target.value)}
                  onBlur={commitDaily}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitDaily()
                    }
                  }}
                />
                日ごと
              </div>
            )}
            <div className="zk-daily-note">
              GitHub 上は普通の Issue のままです。start date が最初の実行日、
              target date が最後の実行日になります（空なら無期限）。
            </div>
          </div>
        )}

        {editing && (
          <div className="zk-task-labels-edit">
            {/* 親カテゴリはラベルの一種なので、ラベル編集と同じカードに置く。
                別の枠にすると「ラベルとは別の何か」に見えてしまう。 */}
            {!task.labelsComplete && (
              <div className="zk-label-confirm">
                この Issue のラベルを全部読めていないため、ラベルの変更はできません。
                保存しても、いま付いているラベルはそのまま残ります。
              </div>
            )}
            {/* 親カテゴリが未設定でも欄は出す。設定できないのか、設定する場所が
                別にあるのかが読めないため。 */}
            {task.labelsComplete && (
              <ParentCategoryPicker
                parentLabels={parentLabels}
                labelCatalog={labelCatalog}
                available={availableLabels}
                selected={labels}
                busy={savingContent}
                onChange={setLabels}
                onCreate={(name, color) => onCreateLabel(task.repositoryId, name, color)}
                onDesignate={onDesignateParentLabels}
              />
            )}
            {task.labelsComplete && (
            <LabelEditor
              selected={labels}
              available={availableLabels}
              busy={savingContent}
              onChange={setLabels}
              onCreate={(name, color) => onCreateLabel(task.repositoryId, name, color)}
              onDelete={(label) => onDeleteLabel(task.repositoryId, label)}
            />
            )}
            {!task.assigneesComplete && (
              <div className="zk-label-confirm">
                この Issue の担当を全部読めていないため、担当の変更はできません。
                保存しても、いま付いている担当はそのまま残ります。
              </div>
            )}
            {task.assigneesComplete && (
              <AssigneeEditor
                selected={assignees}
                available={availableAssignees}
                busy={savingContent}
                onChange={setAssignees}
              />
            )}
            <DependencyEditor
              tasks={allTasks}
              taskId={task.id}
              value={dependsOn}
              busy={savingContent}
              onChange={setDependsOn}
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
            <Markdown text={task.body} onToggleTask={toggleTask} busy={savingContent} />
          ) : (
            <div className="zk-body-text zk-body-text--fill zk-body-text--empty">
              本文はありません。
            </div>
          )}
        </div>

        <div className="zk-task-notice">
          {/* モックには枠が無いが、担当・Priority・Progress は落とさずここに畳んでおく。 */}
          <span className="zk-task-meta-inline">
            依存: {savedDeps.length === 0 ? "—" : savedDeps.map((n) => `#${n}`).join(", ")}
            {/* 編集モードでは担当は AssigneeEditor が持つ。ここにも出すと、
                どちらを直せば効くのかが読めなくなる。 */}
            {!editing && (
              <>
                {"　/　"}
                {task.assignees.length === 0
                  ? "未アサイン"
                  : task.assignees.map((a) => a.login).join(", ")}
              </>
            )}
            {"　/　"}
            {/* Priority と Progress は Status と同じくその場で変更できる。
                Project にフィールドが無いときは、変えられないものを操作させても
                失敗するだけなので、今までどおり表示だけにする。 */}
            <span className="zk-task-meta-field">
              Priority:{" "}
              {canChangePriority ? (
                <select
                  className="zk-meta-select"
                  aria-label="Priority"
                  value={currentPriorityId}
                  disabled={busy}
                  onChange={(e) =>
                    onChangePriority?.(task.id, e.target.value === "" ? null : e.target.value)
                  }
                >
                  {/* 未設定に戻せるよう、値が入っていても空の選択肢は残す。 */}
                  <option value="">—</option>
                  {priorityMissing && (
                    <option value={UNKNOWN_PRIORITY} disabled>
                      {task.priority}（この Project の選択肢にありません）
                    </option>
                  )}
                  {priorityOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              ) : (
                (task.priority ?? "—")
              )}
            </span>
            {"　/　"}
            <span className="zk-task-meta-field">
              Progress:{" "}
              {canChangeProgress ? (
                <>
                  <input
                    className="zk-meta-number"
                    type="number"
                    aria-label="Progress"
                    min={0}
                    max={100}
                    step={1}
                    value={progress}
                    placeholder="—"
                    disabled={busy}
                    onChange={(e) => setProgress(e.target.value)}
                    onBlur={commitProgress}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        commitProgress()
                      }
                    }}
                  />
                  %
                </>
              ) : task.progress === null ? (
                "—"
              ) : (
                `${task.progress}%`
              )}
            </span>
          </span>
          {!task.fieldsComplete && !bothFilled
            ? "この Issue はフィールドが多く、日付を読み切れていません。未設定とは限りません。"
            : !canEditDates
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
          {confirmingDelete ? (
            <>
              <span className="zk-task-meta-inline" style={{ flex: 1, color: "var(--danger)" }}>
                この Issue を削除します。取り消せません
              </span>
              <button
                className="zk-button zk-button--danger"
                disabled={busy}
                onClick={async () => {
                  // 確認は送信が終わるまで出したままにする。押した直後に元の列へ戻ると
                  // 何が起きているのか分からず、成功したのかも読めない。
                  await onDelete(task.id, task.issueId)
                  setConfirmingDelete(false)
                }}
              >
                {deleting ? "削除中…" : "削除する"}
              </button>
              <button
                className="zk-button"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                やめる
              </button>
            </>
          ) : (
            <>
              {onLoadParentIssue && onChangeParentIssue ? (
                <ParentIssuePicker
                  task={task}
                  tasks={allTasks}
                  onLoad={onLoadParentIssue}
                  onChange={onChangeParentIssue}
                />
              ) : null}
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
                <button
                  className="zk-button"
                  disabled={busy}
                  onClick={() => {
                    setEditingBase(task.updatedAt)
                    setEditing(true)
                  }}
                >
                  edit
                </button>
              )}
              <button className="zk-button" onClick={toggleState} disabled={busy}>
                {savingState ? "変更中…" : closed ? "reopen" : "close"}
              </button>
              <button
                className="zk-button zk-button--danger"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
              >
                delete
              </button>
            </>
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
