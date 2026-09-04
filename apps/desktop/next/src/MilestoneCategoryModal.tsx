"use client"

import { useEffect } from "react"
import type { Label } from "@zukunft/domain"

type Props = {
  /** 割り当て先のマイルストーンの題名。どれを触っているのかを画面に残す */
  title: string
  /** 割り当てられるラベル。名前で重複を除いたもの */
  candidates: Label[]
  /** いま割り当てられているラベル名。未割り当ては null */
  selected: string | null
  busy: boolean
  /** 割り当てを決める。空文字は「カテゴリなし」に戻す */
  onSelect: (label: string) => void
  onClose: () => void
}

/**
 * マイルストーンにカテゴリ（ラベル）を割り当てる。
 *
 * 割り当ては盤面の菱形の色にしかならず、GitHub 側のマイルストーンにも
 * ラベルにも何も起きない。誤解されると押せない設定なので、そこは画面に明記する。
 *
 * 選ぶと即座に保存して閉じる。ここで決めることは 1 つしかないので、
 * 「選ぶ」と「保存」を分けても押す回数が増えるだけになる。
 */
export function MilestoneCategoryModal({
  title, candidates, selected, busy, onSelect, onClose,
}: Props) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, busy])

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="マイルストーンのカテゴリ"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>マイルストーンのカテゴリ</div>
          <button className="zk-button" onClick={onClose} disabled={busy} aria-label="閉じる">✕</button>
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
                  disabled={busy}
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
                    disabled={busy}
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

          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            選んだラベルの色で、盤面の菱形を描きます。GitHub 側のマイルストーンや
            ラベルには何も書き込みません。
          </div>
        </div>

        <div className="zk-modal-foot">
          <button className="zk-button" onClick={onClose} disabled={busy}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
