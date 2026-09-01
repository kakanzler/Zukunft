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
  /** ラベル定義ごと削除する。true なら削除できた */
  onDelete: (label: Label) => Promise<boolean>
}

/** 新規作成時の初期色。参照画像のアクセントに合わせる。 */
const DEFAULT_COLOR = "#3b82f6"

/**
 * 編集モードでのラベル付け外しと新規作成、そしてラベル定義の削除。
 *
 * 作成したラベルはそのまま Issue に付ける。作っただけで付かないと、
 * 「作成したのに反映されない」と見えるため。
 *
 * 削除はこの Issue から外すのではなくリポジトリ全体から消す操作で、
 * チップの ✕（外すだけ）と取り違えると被害が大きい。そのため専用のモードに
 * 入らないと候補が出ないようにし、さらに一件ごとに確認を挟む。
 */
export function LabelEditor({ selected, available, busy, onChange, onCreate, onDelete }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [error, setError] = useState<string | null>(null)
  const [deleteMode, setDeleteMode] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Label | null>(null)
  // 送信中の二度押しを塞ぐ。2 回目は必ず「もう無い」で失敗し、
  // 消えているのに失敗だけがログに残ることになるため。
  const [deleting, setDeleting] = useState(false)

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

  const remove = async (label: Label) => {
    setError(null)
    setDeleting(true)
    let deleted: boolean
    try {
      deleted = await onDelete(label)
    } finally {
      setDeleting(false)
    }
    if (!deleted) {
      setError("削除できませんでした。ログを確認してください。")
      return
    }
    // 親の available からは消えるが、この Issue の選択は自前で持っているため、
    // ここで落とさないと存在しない id を掴んだままになる。
    onChange(selected.filter((l) => l.id !== label.id))
    setPendingDelete(null)
    setDeleteMode(false)
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

      {deleteMode ? (
        /* 削除モードでは付いているものも含めた全ラベルが対象になる。 */
        available.length > 0 && (
        <div className="zk-label-picker zk-label-picker--danger">
          {available.map((label) => (
            <button
              type="button"
              key={label.id}
              className="zk-chip zk-chip--button zk-chip--danger"
              disabled={busy}
              aria-label={`${label.name} を削除`}
              onClick={() => { setPendingDelete(label); setError(null) }}
            >
              <span className="zk-legend-dot"
                    style={{ background: label.color ? `#${label.color}` : "currentColor" }} />
              {label.name}
            </button>
          ))}
        </div>
        )
      ) : (
        unselected.length > 0 && (
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
        )
      )}

      {pendingDelete && (
        <div className="zk-label-confirm">
          <span>
            ラベル「{pendingDelete.name}」を削除します。
            付いている Issue すべてから外れ、元に戻せません。
          </span>
          <button className="zk-button zk-button--danger" disabled={busy || deleting}
                  onClick={() => void remove(pendingDelete)}>
            {deleting ? "削除中…" : "削除する"}
          </button>
          <button className="zk-button" disabled={busy || deleting}
                  onClick={() => setPendingDelete(null)}>
            やめる
          </button>
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
        <div style={{ display: "flex", gap: 6, alignSelf: "flex-start" }}>
          <button className="zk-button" disabled={busy} onClick={() => setCreating(true)}>
            ＋ 新しいラベル
          </button>
          <button
            className={deleteMode ? "zk-button zk-button--danger" : "zk-button"}
            disabled={busy}
            onClick={() => {
              setDeleteMode((v) => !v)
              setPendingDelete(null)
              setError(null)
            }}
          >
            {deleteMode ? "削除をやめる" : "ラベルを削除…"}
          </button>
        </div>
      )}

      {error && (
        <span style={{ color: "var(--danger)", fontSize: 11 }}>{error}</span>
      )}
    </div>
  )
}
