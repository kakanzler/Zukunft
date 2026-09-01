"use client"

import { useEffect, useState } from "react"
import type { Label } from "@zukunft/domain"

type Props = {
  /** 親カテゴリに指定できるラベル。名前で重複を除いたもの */
  candidates: Label[]
  /** 現在親カテゴリに指定されているラベル名 */
  selected: string[]
  busy: boolean
  onSave: (names: string[]) => void
  onClose: () => void
}

/**
 * どのラベルを親カテゴリとして扱うかを選ぶ。
 *
 * GitHub 側から見れば普通のラベルのままで、変わるのはこのアプリでの並べ方だけ。
 * 「GitHub を書き換えるのでは」と誤解されると押せない設定なので、そこは画面に明記する。
 */
export function CategorySettings({ candidates, selected, busy, onSave, onClose }: Props) {
  const [names, setNames] = useState<string[]>(selected)

  // 候補は開いた後に届くことがある（リポジトリごとのラベル取得を待つ）。
  // 一方で選択中の名前は保存済みの値なので、候補に無くても落とさない。
  useEffect(() => {
    setNames(selected)
  }, [selected])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, busy])

  const toggle = (name: string) => {
    setNames((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="カテゴリ設定"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>カテゴリ設定</div>
          <button className="zk-button" onClick={onClose} disabled={busy} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-modal-body">
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            選んだラベルは、このアプリの中でだけ上位のまとまりとして扱われます。
            GitHub 上ではこれまでどおり普通のラベルのままで、書き換えは行いません。
            何も選ばなければ親カテゴリなし（ラベルごとの並び）になります。
          </div>

          <div className="zk-field">
            <span className="zk-field-label">親カテゴリにするラベル</span>
            {candidates.length === 0 ? (
              <span className="zk-field-value" style={{ fontSize: 11 }}>
                ラベルがありません。Issue にラベルを付けると候補に出ます。
              </span>
            ) : (
              <div style={{ display: "grid", gap: 4, maxHeight: 320, overflow: "auto" }}>
                {candidates.map((label) => (
                  <label
                    key={label.name}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={names.includes(label.name)}
                      disabled={busy}
                      onChange={() => toggle(label.name)}
                    />
                    <span className="zk-legend-dot"
                          style={{ background: label.color ? `#${label.color}` : "currentColor" }} />
                    {label.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: "var(--text-secondary)", minHeight: 16 }}>
            {names.length === 0
              ? "親カテゴリなし"
              : `親カテゴリ: ${names.join(" / ")}`}
          </div>
        </div>

        <div className="zk-modal-foot">
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="zk-button" disabled={busy} onClick={() => onSave(names)}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}
