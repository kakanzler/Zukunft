"use client"

import { useEffect, useState } from "react"
import type {
  ISODate,
  Label,
  Milestone,
  NewTaskInput,
  RecurrenceRule,
  RepositorySummary,
} from "@zukunft/domain"
import { LabelEditor } from "@/LabelEditor"
import { ParentCategoryPicker } from "@/ParentCategoryPicker"
import {
  SPACED_SCHEDULE_TEXT,
  dailyLimit,
  isBeyondDailyLimit,
  spacedSummary,
} from "@/daily"
import { inclusiveDays, isISODate } from "@zukunft/domain"

type StatusOption = { id: string; name: string }

type Props = {
  repositories: RepositorySummary[]
  /**
   * 選択中の作成先。ラベルと Milestone の候補はリポジトリ単位で取るため、
   * どこに作ろうとしているかは親も知っている必要がある。
   */
  repositoryId: string
  onChangeRepository: (id: string) => void
  /** Start Date / Target Date が Project に無い場合、日付は指定できない */
  canEditDates: boolean
  busy: boolean
  /** Project の Status フィールドの選択肢。定義順。空なら Status を指定できない */
  statusOptions: StatusOption[]
  /** 選択中リポジトリに定義済みのラベル */
  availableLabels: Label[]
  /**
   * 親カテゴリとして扱うラベル名（カテゴリ設定の値）。
   * 起票の時点で置き場所を決められないと、作った直後に詳細を開き直すことになる。
   */
  parentLabels?: string[]
  /** 名前で重複を除いたラベル一覧。別リポジトリにしか無いものの色を引くのに使う */
  labelCatalog?: Label[]
  /** 選択中リポジトリの Milestone（OPEN のみ） */
  availableMilestones: Milestone[]
  onCreateLabel: (repositoryId: string, name: string, color: string) => Promise<Label | null>
  onDeleteLabel: (repositoryId: string, label: Label) => Promise<boolean>
  /**
   * 起票する。dailyRule は日課にする場合の繰り返し方で、日課にしないなら null。
   * 日課の設定は GitHub ではなくアプリ側に持つので、
   * Issue を作った後に返る id で書きに行くのは呼び出し側の仕事になる。
   */
  onCreate: (input: NewTaskInput, dailyRule: RecurrenceRule | null) => void
  onClose: () => void
}

/**
 * Body の下敷き。
 *
 * 起票の時点で「何を目指すのか」「何をするのか」「どうなったら終わりか」を
 * 書き分けさせるための見出しだけを置く。空欄から書き始めると、
 * だいたい「やること」だけが残って完了条件が抜ける。
 *
 * 見出しの下は空行にしておく。カーソルを置けばそのまま書ける方が、
 * 例文を消してから書くより速い。
 */
const BODY_TEMPLATE = `## Aiming

## What to do

## Acceptance Criteria
`

/** 既定値をその場で書くと毎回別の配列になり、選択肢の再計算が止まらなくなる。 */
const EMPTY_PARENT_LABELS: string[] = []
const EMPTY_LABELS: Label[] = []

/**
 * 新しい Issue を起票して Project に追加する。
 *
 * 日付は任意。GitHub で Issue を作ってから Project に追加して日付を入れる、
 * という往復を 1 画面に畳むのが目的。ラベル・Milestone・Status も同じ理由で
 * ここに置く。作ってから詳細を開いて付け直すのでは往復が残ってしまう。
 */
export function NewTaskModal({
  repositories, repositoryId, onChangeRepository, canEditDates, busy,
  statusOptions, availableLabels, availableMilestones, onCreateLabel, onDeleteLabel,
  parentLabels = EMPTY_PARENT_LABELS, labelCatalog = EMPTY_LABELS,
  onCreate, onClose,
}: Props) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState(BODY_TEMPLATE)
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [statusOptionId, setStatusOptionId] = useState("")
  const [labels, setLabels] = useState<Label[]>([])
  const [milestoneId, setMilestoneId] = useState("")
  // 日課にするか。日付は Start / Target Date を流用するので、ここで持つのは
  // 「繰り返すかどうか」と「繰り返し方」だけ。
  const [daily, setDaily] = useState(false)
  // 繰り返し方。既定は今までと同じ「N 日ごと」。
  const [dailyMode, setDailyMode] = useState<RecurrenceRule["kind"]>("interval")
  /**
   * 間隔は文字列で持つ。数値にすると打ち消した瞬間に 0 や NaN になり、
   * 「消して打ち直す」という当たり前の操作ができなくなる。送るときに数値へ直す。
   */
  const [intervalText, setIntervalText] = useState("1")
  // 終わりの指定。Target Date を空のままにすると、開始日から 1 年で止まる。
  const [endless, setEndless] = useState(true)

  // ラベルと Milestone の id はリポジトリごとに別物。作成先を変えても残すと
  // 別リポジトリの id を送ることになるので捨てる。
  useEffect(() => {
    setLabels([])
    setMilestoneId("")
  }, [repositoryId])

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
  // 期日を決めない日課だけは Start Date だけで成り立つ。最後の実行日が無いという
  // 指定そのものが Target Date の空欄なので、片側だけを認める唯一の場合。
  const startOnly = daily && endless && isISODate(start) && end === ""
  const datesOk = startOnly || noneFilled || (bothFilled && wellFormed && start <= end)
  const interval = Number(intervalText)
  const intervalOk = Number.isInteger(interval) && interval >= 1
  // 「広がる並び」は間隔が決まっているので、間隔の入力そのものを見ない。
  const ruleOk = dailyMode === "spaced" || intervalOk
  // 1 年より先の Target Date は指定しても点が並ばない（企画書の日課は開始日から
  // 1 年で止まる）。黙って詰めると指定した期日と盤面が食い違うので、作らせない。
  const endTooFar = daily && !endless && isBeyondDailyLimit(start, end)
  // 日課は Start Date が最初の実行日。起点が無いと点を置く場所が決まらないので、
  // 「日課だが開始日が無い」状態では作らせない。
  const dailyOk = !daily || (isISODate(start) && ruleOk && !endTooFar)
  const canSubmit = repositoryId !== "" && title.trim() !== "" && datesOk && dailyOk && !busy

  const submit = () => {
    if (!canSubmit) return
    const input: NewTaskInput = { repositoryId, title: title.trim() }
    if (body.trim()) input.body = body.trim()
    if (labels.length > 0) input.labelIds = labels.map((l) => l.id)
    if (milestoneId !== "") input.milestoneId = milestoneId
    if (statusOptionId !== "") input.statusOptionId = statusOptionId
    if (bothFilled && wellFormed) {
      input.startDate = start as ISODate
      input.endDate = end as ISODate
    } else if (startOnly) {
      // 期日を決めない日課。Target Date は入れない — 空であること自体がその指定。
      input.startDate = start as ISODate
    }
    const rule: RecurrenceRule =
      dailyMode === "spaced" ? { kind: "spaced" } : { kind: "interval", intervalDays: interval }
    onCreate(input, daily ? rule : null)
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
                onChange={(e) => onChangeRepository(e.target.value)}
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

          {/* Status・ラベル・Milestone は詳細（TaskModal）と同じ並びにしておく。
              作成直後に詳細を開いても位置が変わらない方が迷わない。 */}
          <label className="zk-field">
            <span className="zk-field-label">Status</span>
            <select
              className="zk-input"
              value={statusOptionId}
              disabled={statusOptions.length === 0}
              onChange={(e) => setStatusOptionId(e.target.value)}
            >
              <option value="">—（未設定）</option>
              {statusOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>

          {/* 親カテゴリはラベルの一種なので、ラベル編集と続けて置く。
              どちらも同じ labels を編集するので、片方で付けた分はもう片方にも出る。 */}
          {parentLabels.length > 0 && (
            <ParentCategoryPicker
              parentLabels={parentLabels}
              labelCatalog={labelCatalog}
              available={availableLabels}
              selected={labels}
              busy={busy}
              onChange={setLabels}
              onCreate={(name, color) => onCreateLabel(repositoryId, name, color)}
            />
          )}

          <LabelEditor
            selected={labels}
            available={availableLabels}
            busy={busy}
            onChange={setLabels}
            onCreate={(name, color) => onCreateLabel(repositoryId, name, color)}
            onDelete={(label) => onDeleteLabel(repositoryId, label)}
          />

          <label className="zk-field">
            <span className="zk-field-label">Milestone</span>
            <select
              className="zk-input"
              value={milestoneId}
              onChange={(e) => setMilestoneId(e.target.value)}
            >
              <option value="">なし</option>
              {availableMilestones.map((m) => (
                <option key={m.id} value={m.id}>{m.title}</option>
              ))}
            </select>
          </label>

          <label className="zk-field">
            <span className="zk-field-label">Body</span>
            <textarea
              className="zk-input"
              // 3 つの見出しと、その下に書く余地が一度に見える高さ。
              rows={10}
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
              <input className="zk-input" type="date" value={end}
                     /* 期日を決めない日課では最後の実行日が無い。空であること自体が
                        その指定なので、打てないようにして空に保つ。 */
                     disabled={!canEditDates || (daily && endless)}
                     onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>

          {/* 日課。日付欄の直後に置くのは、ここで決めるのが「日付の読み方」だから。
              Start Date が最初の実行日、Target Date が最後の実行日になる。 */}
          <div className="zk-field zk-daily-edit">
            <span className="zk-field-label">日課</span>
            <label className="zk-daily-check">
              <input
                type="checkbox"
                checked={daily}
                disabled={!canEditDates}
                onChange={(e) => {
                  setDaily(e.target.checked)
                  // 日課に切り替えた時点では終わりを決めていない。既定（期日なし）に
                  // 合わせて Target Date を空に戻す。
                  if (e.target.checked && endless) setEnd("")
                }}
              />
              決まった間隔で繰り返す
            </label>
            {daily && (
              <>
                {/* 繰り返し方。間隔を自分で決めるか、決まった広がる並びを使うか。 */}
                <div className="zk-daily-row">
                  <label className="zk-daily-choice">
                    <input
                      type="radio"
                      name="zk-new-task-daily-mode"
                      checked={dailyMode === "interval"}
                      disabled={!canEditDates}
                      onChange={() => setDailyMode("interval")}
                    />
                    N 日ごと
                  </label>
                  <label className="zk-daily-choice">
                    <input
                      type="radio"
                      name="zk-new-task-daily-mode"
                      checked={dailyMode === "spaced"}
                      disabled={!canEditDates}
                      onChange={() => setDailyMode("spaced")}
                    />
                    1, 3, 5, 7, 11, 15 日で広がる
                  </label>
                </div>
                {dailyMode === "interval" ? (
                  <div className="zk-daily-row">
                    <input
                      className="zk-input zk-daily-interval"
                      type="number"
                      aria-label="間隔（日）"
                      min={1}
                      step={1}
                      value={intervalText}
                      disabled={!canEditDates}
                      onChange={(e) => setIntervalText(e.target.value)}
                    />
                    日ごと
                  </div>
                ) : (
                  /* 間隔は決まっているので入力は出さない。代わりに、実際にいつ
                     実行するのかを書く — 間隔の数字だけでは何日後に来るのかが読めない。 */
                  <div className="zk-daily-note">実行するのは {SPACED_SCHEDULE_TEXT} です。</div>
                )}
                <div className="zk-daily-row">
                  <label className="zk-daily-choice">
                    <input
                      type="radio"
                      name="zk-new-task-daily-end"
                      checked={endless}
                      disabled={!canEditDates}
                      onChange={() => {
                        setEndless(true)
                        setEnd("")
                      }}
                    />
                    開始日から 1 年
                  </label>
                  <label className="zk-daily-choice">
                    <input
                      type="radio"
                      name="zk-new-task-daily-end"
                      checked={!endless}
                      disabled={!canEditDates}
                      onChange={() => setEndless(false)}
                    />
                    期日まで（Target Date）
                  </label>
                </div>
              </>
            )}
            <div className="zk-daily-note">
              GitHub 上は普通の Issue のままです。Start Date が最初の実行日、
              Target Date が最後の実行日になります（空なら開始日から 1 年）。
            </div>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-secondary)", minHeight: 16 }}>
            {!canEditDates
              ? "Project に Start Date / Target Date が無いため、日程は後から設定します。"
              : daily && !isISODate(start)
                ? "日課は Start Date が最初の実行日です。開始日を入れてください。"
                : daily && !ruleOk
                  ? "間隔は 1 以上の整数で指定してください。"
                  : daily && endless
                    ? dailyMode === "spaced"
                      ? spacedSummary(start)
                      : `${start} から ${interval} 日ごとに繰り返します（開始日から 1 年）`
                    : daily && (!bothFilled || !wellFormed)
                      ? "期日までにする場合は Target Date を指定してください。"
                      : daily && start > end
                        ? "開始日は終了日以前にしてください。"
                        : endTooFar
                          ? `日課は開始日から 1 年で止まります。Target Date は ${dailyLimit(start)} 以前にしてください。`
                          : daily
                            ? dailyMode === "spaced"
                              ? `${spacedSummary(start)}（${end} まで）`
                              : `${start} から ${end} まで ${interval} 日ごとに繰り返します`
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
          {/* 黙って担当を付けると、後から外したいときに何が付けたのか分からない。 */}
          <span className="zk-new-task-note">担当は自分になります（作成後に変更できます）</span>
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="zk-button" aria-pressed={canSubmit} disabled={!canSubmit} onClick={submit}>
            {busy ? "作成中…" : "作成"}
          </button>
        </div>
      </div>
    </div>
  )
}
