"use client"

import { useEffect, useState } from "react"
import type { ISODate, Label, NewMilestoneInput, RepositorySummary } from "@zukunft/domain"
import { isISODate } from "@zukunft/domain"

type Props = {
  repositories: RepositorySummary[]
  /**
   * 選択中の作成先。マイルストーンはリポジトリに属するので、
   * どこに作るかは親（作成後に候補一覧を更新する側）も知っている必要がある。
   */
  repositoryId: string
  onChangeRepository: (id: string) => void
  /** カテゴリに割り当てられるラベル。名前で重複を除いたもの */
  candidates: Label[]
  busy: boolean
  /**
   * カテゴリは GitHub には送らない（第 3 引数）。作成が返す node id に対して
   * アプリ側の設定として書くので、作る側でしか結び付けられない。
   */
  onCreate: (repositoryId: string, input: NewMilestoneInput, category: string) => void
  onClose: () => void
}

/**
 * 新しいマイルストーンを作る。
 *
 * GitHub の Web を開いて作ってから戻ってくる往復を畳むのが目的。作成だけを扱い、
 * 編集・クローズ・削除は置かない — そちらは GitHub 側で完結する操作で、
 * ここに置くと「盤面から消した」のか「GitHub から消した」のかが曖昧になる。
 */
export function NewMilestoneModal({
  repositories, repositoryId, onChangeRepository, candidates, busy, onCreate, onClose,
}: Props) {
  const [title, setTitle] = useState("")
  const [dueOn, setDueOn] = useState("")
  const [description, setDescription] = useState("")
  // 盤面の菱形の色になるだけの、アプリ内の割り当て。空文字はカテゴリなし。
  const [category, setCategory] = useState("")

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, busy])

  const dueOk = dueOn === "" || isISODate(dueOn)
  const canSubmit = repositoryId !== "" && title.trim() !== "" && dueOk && !busy

  const submit = () => {
    if (!canSubmit) return
    onCreate(
      repositoryId,
      {
        title: title.trim(),
        dueOn: dueOn === "" ? null : (dueOn as ISODate),
        description: description.trim(),
      },
      category,
    )
  }

  // 候補が 1 つしか無いのに選ばせても、選択肢のふりをした表示にしかならない。
  const onlyRepository = repositories.length === 1 ? repositories[0] : undefined

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="新しいマイルストーン"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>新しいマイルストーン</div>
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
            ) : onlyRepository ? (
              <span className="zk-field-value">{onlyRepository.nameWithOwner}</span>
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
              placeholder="v1.2 / 第 1 四半期 など"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
            />
          </label>

          <label className="zk-field">
            <span className="zk-field-label">期日</span>
            <input
              className="zk-input"
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
            />
          </label>

          {/* 割り当ては作成後に node id が返ってから設定へ書く。ここで選べないと、
              作った直後に盤面の菱形だけ色が付かず、もう一度押しに行くことになる。 */}
          <div className="zk-field">
            <span className="zk-field-label">カテゴリ</span>
            {candidates.length === 0 ? (
              <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
                ラベルがありません。Issue にラベルを付けると候補に出ます。
              </span>
            ) : (
              <div className="zk-label-picker">
                <button
                  type="button"
                  className="zk-chip zk-chip--button"
                  aria-pressed={category === ""}
                  disabled={busy}
                  onClick={() => setCategory("")}
                >
                  カテゴリなし
                </button>
                {candidates.map((label) => (
                  <button
                    type="button"
                    key={label.name}
                    className="zk-chip zk-chip--button"
                    aria-pressed={category === label.name}
                    disabled={busy}
                    onClick={() => setCategory(label.name)}
                    style={
                      category === label.name
                        ? { borderColor: `#${label.color}`, color: `#${label.color}` }
                        : undefined
                    }
                  >
                    <span
                      className="zk-legend-dot"
                      style={{ background: label.color ? `#${label.color}` : "currentColor" }}
                    />
                    {label.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <label className="zk-field">
            <span className="zk-field-label">説明</span>
            <textarea
              className="zk-input"
              rows={4}
              value={description}
              placeholder="任意。このマイルストーンで何を終わらせるか"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div style={{ fontSize: 11, color: "var(--text-secondary)", minHeight: 16 }}>
            {/* 期日が無くても作れる。GitHub 側では期日なしのマイルストーンは正当なもので、
                盤面に出ないことを理由に作らせないと、GitHub の Web を開く往復が戻ってくる。 */}
            {!dueOk
              ? "日付の形式が正しくありません。"
              : dueOn === ""
                ? "期日は任意です。期日が無いと盤面には出ません（GitHub 上には作成されます）。"
                : "この日を目印として盤面に出します。"}
          </div>
        </div>

        <div className="zk-modal-foot">
          {/* 作っただけでは何にも紐づかない。Issue 側で選ぶ手順が残ることを先に言う。 */}
          <span className="zk-new-task-note">
            作成しただけでは Issue には付きません（各 Issue の Milestone で選びます）
          </span>
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="zk-button" aria-pressed={canSubmit} disabled={!canSubmit} onClick={submit}>
            {busy ? "作成中…" : "作成"}
          </button>
        </div>
      </div>
    </div>
  )
}
