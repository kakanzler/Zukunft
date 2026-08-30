"use client"

import type { GroupMode } from "@zukunft/domain"

export type SidebarView = {
  mode: GroupMode
  label: string
  /** 1 行の補足。何でまとまるのかを示す */
  description: string
  icon: string
}

/** 既定のビュー。Progress は Status、Category は Issue の Label でまとめる。 */
export const DEFAULT_VIEWS: SidebarView[] = [
  {
    mode: "status",
    label: "Progress",
    description: "Status ごと",
    icon: "◷",
  },
  {
    mode: "label",
    label: "Category",
    description: "Label ごと",
    icon: "⛬",
  },
]

type Props = {
  views?: SidebarView[]
  active: GroupMode
  onSelect: (mode: GroupMode) => void
  /** 下部に置く補足（プロジェクト名など） */
  footer?: React.ReactNode
}

/**
 * 表示の切り替えサイドバー（意匠は Appearance_button.jpg に準拠）。
 *
 * アイコンとラベルを縦に積んだ枠線カードで、選択中は枠を光らせる。
 */
export function Sidebar({ views = DEFAULT_VIEWS, active, onSelect, footer }: Props) {
  return (
    <nav className="zk-sidebar" aria-label="表示の切り替え">
      <div className="zk-sidebar-brand">Zukunft</div>
      <div className="zk-sidebar-views">
        {views.map((view) => (
          <button
            key={view.mode}
            className="zk-sidebar-item"
            aria-pressed={active === view.mode}
            onClick={() => onSelect(view.mode)}
          >
            <span className="zk-sidebar-icon" aria-hidden="true">{view.icon}</span>
            <span className="zk-sidebar-label">{view.label}</span>
            <span className="zk-sidebar-desc">{view.description}</span>
          </button>
        ))}
      </div>
      {footer && <div className="zk-sidebar-foot">{footer}</div>}
    </nav>
  )
}
