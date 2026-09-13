"use client"

import { useEffect, useState } from "react"
import type { Label } from "@zukunft/domain"

type Props = {
  /** 割り当て先のマイルストーンの node id。削除の宛先に要る */
  milestoneId: string
  /** 割り当て先のマイルストーンの題名。どれを触っているのかを画面に残す */
  title: string
  /** 割り当てられるラベル。名前で重複を除いたもの */
  candidates: Label[]
  /** いま割り当てられているラベル名。未割り当ては null */
  selected: string | null
  busy: boolean
  /** 割り当てを決める。空文字は「カテゴリなし」に戻す */
  onSelect: (label: string) => void
  /**
   * マイルストーンそのものを GitHub から消す。盤面から隠すだけの操作ではない。
   * 送信の完了まで待てるよう Promise を返させる（TaskModal の削除と同じ）。
   */
  onDelete: (milestoneId: string) => Promise<void>
  /** 削除の送信中。ボタンの文言を変えるためだけに分けて持つ */
  deleting: boolean
  onClose: () => void
}

/**
 * マイルストーンにカテゴリ（ラベル）を割り当てる。削除もここから行う。
 *
 * 割り当ての方は盤面の菱形の色にしかならず、GitHub 側のマイルストーンにも
 * ラベルにも何も起きない。誤解されると押せない設定なので、そこは画面に明記する。
 * 一方で削除は GitHub 上のマイルストーンを実際に消す（REST の DELETE）。
 * 同じモーダルに性質の違う 2 つが並ぶので、「何も書き込まない」という断りは
 * カテゴリの説明の側に閉じ、削除の側には別に警告を置く。
 *
 * 割り当ては選ぶと即座に保存して閉じる。ここで決めることは 1 つしかないので、
 * 「選ぶ」と「保存」を分けても押す回数が増えるだけになる。削除だけは
 * TaskModal と同じ二段階（押す → 確認が出る → もう一度押す）にする。
 */
export function MilestoneCategoryModal({
  milestoneId, title, candidates, selected, busy, onSelect, onDelete, deleting, onClose,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // 送信中は閉じさせない。カテゴリの保存と削除はどちらも「返るまで待つ」もので、
  // 途中で閉じられると何が済んだのか画面から読めなくなる。
  const working = busy || deleting

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, working])

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !working) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="マイルストーンのカテゴリ"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>マイルストーンのカテゴリ</div>
          <button className="zk-button zk-modal-close" onClick={onClose} disabled={working} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-modal-body">
          <div className="zk-field">
            <span className="zk-field-label">マイルストーン</span>
            <span className="zk-field-value">{title}</span>
          </div>

          <div className="zk-field">
            <span className="zk-field-label">カテゴリ</span>
            {candidates.length === 0 ? (
              <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
                ラベルがありません。Issue にラベルを付けると候補に出ます。
              </span>
            ) : (
              <div className="zk-label-picker">
                {/* 外す口を候補と同じ並びに置く。別の場所に置くと、
                    「解除できるのか」を探すことになる。 */}
                <button
                  type="button"
                  className="zk-chip zk-chip--button"
                  aria-pressed={selected === null}
                  disabled={working}
                  onClick={() => onSelect("")}
                >
                  カテゴリなし
                </button>
                {candidates.map((label) => (
                  <button
                    type="button"
                    key={label.name}
                    className="zk-chip zk-chip--button"
                    aria-pressed={selected === label.name}
                    disabled={working}
                    onClick={() => onSelect(label.name)}
                    style={
                      selected === label.name
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

          {/* 「何も書き込まない」はカテゴリの割り当てについてだけの話。
              下の削除は GitHub を書き換えるので、断りをこの段落の中に閉じる。 */}
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            選んだラベルの色で、盤面の菱形を描きます。カテゴリの割り当ては
            アプリの中だけの設定で、GitHub 側のマイルストーンやラベルには
            何も書き込みません。
          </div>
        </div>

        <div className="zk-modal-foot">
          {confirmingDelete ? (
            <>
              <span
                className="zk-field-value"
                style={{ flex: 1, fontSize: 11, lineHeight: 1.6, color: "var(--danger)" }}
              >
                GitHub 上のマイルストーン「{title}」を削除します。付いていた
                Issue すべてから外れ、取り消せません
              </span>
              <button
                className="zk-button zk-button--danger"
                disabled={working}
                onClick={async () => {
                  // 確認は送信が終わるまで出したままにする。押した直後に元の列へ
                  // 戻ると何が起きているのか分からず、成功したのかも読めない
                  // （TaskModal の削除と同じ）。
                  await onDelete(milestoneId)
                  setConfirmingDelete(false)
                }}
              >
                {deleting ? "削除中…" : "削除する"}
              </button>
              <button
                className="zk-button"
                disabled={working}
                onClick={() => setConfirmingDelete(false)}
              >
                やめる
              </button>
            </>
          ) : (
            <>
              {/* 危険な操作なので、閉じるボタンから離して左端に置く。
                  1 回目の押下では消えず、警告と一緒に確認が出るだけ。 */}
              <button
                className="zk-button zk-button--danger"
                style={{ marginRight: "auto" }}
                disabled={working}
                onClick={() => setConfirmingDelete(true)}
              >
                マイルストーンを削除
              </button>
              <button className="zk-button" onClick={onClose} disabled={working}>閉じる</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
