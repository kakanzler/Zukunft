"use client"

import type { GroupMode } from "@zukunft/domain"

export type SidebarView = {
  mode: GroupMode
  label: string
  icon: string
}

/** 既定のビュー。Progress は Status、Category は Issue の Label でまとめる。 */
export const DEFAULT_VIEWS: SidebarView[] = [
  { mode: "status", label: "Progress", icon: "◷" },
  { mode: "label", label: "Category", icon: "⛬" },
]

type Props = {
  views?: SidebarView[]
  active: GroupMode
  onSelect: (mode: GroupMode) => void
  /** 押すと設定を開く。渡されなければ設定ボタンごと出さない（Web の読み取り専用ビュー） */
  onOpenSettings?: () => void
  /** 下部に置く補足（プロジェクト名など） */
  footer?: React.ReactNode
}

/**
 * 表示の切り替えサイドバー。
 *
 * 1 行につきアイコンと名前だけ。枠線のカードにすると、たかだか数項目の
 * 切り替えが画面の主役のように見えてしまう。選択中は色で示す。
 */
export function Sidebar({ views = DEFAULT_VIEWS, active, onSelect, onOpenSettings, footer }: Props) {
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
          </button>
        ))}
      </div>
      {/* 設定は表示の切り替えではないので、ビューの並びから離して最下部に置く。 */}
      {onOpenSettings && (
        <div className="zk-sidebar-bottom">
          <button className="zk-sidebar-item" onClick={onOpenSettings}>
            <span className="zk-sidebar-icon" aria-hidden="true">⚙</span>
            <span className="zk-sidebar-label">Settings</span>
          </button>
        </div>
      )}
      {footer && <div className="zk-sidebar-foot">{footer}</div>}
    </nav>
  )
}
