import type { ProjectStats } from "@zukunft/domain"

/** 下部 KPI タイル（企画書 §6.4.2）。 */
export function KpiBar({ stats }: { stats: ProjectStats }) {
  const tiles: [string, string | number][] = [
    ["Tasks", stats.taskCount],
    ["Weeks", stats.weekCount],
    ["Milestones", stats.milestoneCount],
    ["Complete", `${stats.completePercent}%`],
  ]
  return (
    <div className="zk-kpi">
      {tiles.map(([label, value]) => (
        <div className="zk-kpi-tile" key={label}>
          <span className="zk-kpi-value">{value}</span>
          <span className="zk-kpi-label">{label}</span>
        </div>
      ))}
    </div>
  )
}

/** ステータス凡例（企画書 §6.4.2 のヘッダ右）。 */
export function StatusLegend({ statuses }: { statuses: string[] }) {
  return (
    <div className="zk-legend">
      {statuses.map((name, i) => (
        <span className="zk-legend-item" key={name}>
          <span className="zk-legend-dot" style={{ background: `var(--status-${i % 4}-to)` }} />
          {name}
        </span>
      ))}
    </div>
  )
}
