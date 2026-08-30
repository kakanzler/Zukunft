"use client"

import { useMemo, useState } from "react"
import type { Label } from "@zukunft/domain"

type Props = {
  /** 現在 Issue に付いているラベル */
  selected: Label[]
  /** リポジトリに定義済みのラベル */
  available: Label[]
  busy: boolean
  onChange: (labels: Label[]) => void
  onCreate: (name: string, color: string) => Promise<Label | null>
}

/** 新規作成時の初期色。参照画像のアクセントに合わせる。 */
const DEFAULT_COLOR = "#3b82f6"

/**
 * 編集モードでのラベル付け外しと新規作成。
 *
 * 作成したラベルはそのまま Issue に付ける。作っただけで付かないと、
 * 「作成したのに反映されない」と見えるため。
 */
export function LabelEditor({ selected, available, busy, onChange, onCreate }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [error, setError] = useState<string | null>(null)

  const selectedIds = useMemo(() => new Set(selected.map((l) => l.id)), [selected])
  const unselected = available.filter((l) => !selectedIds.has(l.id))

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    const created = await onCreate(trimmed, color.replace(/^#/, ""))
    if (!created) {
      setError("作成できませんでした。ログを確認してください。")
      return
    }
    onChange([...selected, created])
    setName("")
    setColor(DEFAULT_COLOR)
    setCreating(false)
  }

  return (
    <div className="zk-field">
      <span className="zk-field-label">Labels</span>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {selected.length === 0 ? (
          <span className="zk-field-value" style={{ fontSize: 11 }}>ラベルなし</span>
        ) : (
          selected.map((label) => (
            <span className="zk-chip" key={label.id}
                  style={label.color ? { borderColor: `#${label.color}`, color: `#${label.color}` } : undefined}>
              <span className="zk-legend-dot"
                    style={{ background: label.color ? `#${label.color}` : "currentColor" }} />
              {label.name}
              <button
                type="button"
                className="zk-chip-remove"
                aria-label={`${label.name} を外す`}
                disabled={busy}
                onClick={() => onChange(selected.filter((l) => l.id !== label.id))}
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {unselected.length > 0 && (
        <div className="zk-label-picker">
          {unselected.map((label) => (
            <button
              type="button"
              key={label.id}
              className="zk-chip zk-chip--button"
              disabled={busy}
              style={label.color ? { borderColor: `#${label.color}66`, color: `#${label.color}` } : undefined}
              onClick={() => onChange([...selected, label])}
            >
              <span className="zk-legend-dot"
                    style={{ background: label.color ? `#${label.color}` : "currentColor" }} />
              {label.name}
            </button>
          ))}
        </div>
      )}

      {creating ? (
        <div className="zk-label-new">
          <input
            className="zk-input"
            value={name}
            autoFocus
            placeholder="新しいラベル名"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create()
            }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <input type="color" value={color} disabled={busy}
                 onChange={(e) => setColor(e.target.value)} aria-label="ラベルの色" />
          <button className="zk-button" disabled={busy || name.trim() === ""} onClick={create}>
            作成して付ける
          </button>
          <button className="zk-button" disabled={busy}
                  onClick={() => { setCreating(false); setName(""); setError(null) }}>
            やめる
          </button>
        </div>
      ) : (
        <button className="zk-button" disabled={busy} onClick={() => setCreating(true)}
                style={{ alignSelf: "flex-start" }}>
          ＋ 新しいラベル
        </button>
      )}

      {error && (
        <span style={{ color: "var(--danger)", fontSize: 11 }}>{error}</span>
      )}
    </div>
  )
}
