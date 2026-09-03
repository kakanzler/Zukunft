"use client"

import { useMemo } from "react"
import type { Assignee } from "@zukunft/domain"

type Props = {
  /** 現在 Issue に付いている担当 */
  selected: Assignee[]
  /** この Issue に担当として付けられるユーザー */
  available: Assignee[]
  busy: boolean
  onChange: (assignees: Assignee[]) => void
}

/**
 * 編集モードでの担当の付け外し。
 *
 * 作りはラベル編集（LabelEditor）に合わせてあるが、新規作成の口は無い。
 * GitHub のユーザーはこちらでは作れず、候補は権限に応じて GitHub 側が決める。
 */
export function AssigneeEditor({ selected, available, busy, onChange }: Props) {
  const selectedIds = useMemo(() => new Set(selected.map((a) => a.id)), [selected])
  const unselected = available.filter((a) => !selectedIds.has(a.id))

  return (
    <div className="zk-field">
      <span className="zk-field-label">Assignees</span>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {selected.length === 0 ? (
          <span className="zk-field-value" style={{ fontSize: 11 }}>未アサイン</span>
        ) : (
          selected.map((assignee) => (
            <span className="zk-chip" key={assignee.id}>
              <Avatar assignee={assignee} />
              {assignee.login}
              <button
                type="button"
                className="zk-chip-remove"
                aria-label={`${assignee.login} を外す`}
                disabled={busy}
                onClick={() => onChange(selected.filter((a) => a.id !== assignee.id))}
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {/* 候補が届いていないときは何も出さない。空の枠だけ出すと、
          誰も割り当てられないリポジトリのように見えてしまう。 */}
      {unselected.length > 0 && (
        <div className="zk-label-picker">
          {unselected.map((assignee) => (
            <button
              type="button"
              key={assignee.id}
              className="zk-chip zk-chip--button"
              disabled={busy}
              onClick={() => onChange([...selected, assignee])}
            >
              <Avatar assignee={assignee} />
              {assignee.login}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * アバター。URL が無い場合は頭文字に落とす。
 * 壊れた画像アイコンが並ぶと、取得に失敗したように見えるため（TaskPane と同じ扱い）。
 */
function Avatar({ assignee }: { assignee: Assignee }) {
  return assignee.avatarUrl ? (
    <img className="zk-avatar" src={assignee.avatarUrl} alt="" />
  ) : (
    <span
      className="zk-avatar zk-avatar--empty"
      aria-hidden="true"
      style={{ display: "grid", placeItems: "center", fontSize: 9 }}
    >
      {assignee.login.slice(0, 1).toUpperCase()}
    </span>
  )
}
