import Link from "next/link"
import { allowedProjectIds, readToken } from "@/config"

export default function Home() {
  const projects = allowedProjectIds()
  const configured = readToken().length > 0

  return (
    <main className="zk-root">
      <div className="zk-empty">
        <h2>Zukunft — スケジュール共有</h2>
        {!configured && (
          <div className="zk-card" style={{ borderColor: "var(--warning)" }}>
            <div style={{ fontWeight: 600 }}>読み取り用トークンが未設定です</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              環境変数 <code>ZUKUNFT_GITHUB_READ_TOKEN</code> に Read 権限のみの
              トークンを設定してください。
            </div>
          </div>
        )}
        {projects.length === 0 ? (
          <p style={{ fontSize: 12 }}>
            公開する Project を <code>ZUKUNFT_PUBLIC_PROJECT_IDS</code> に
            カンマ区切りで指定してください。
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {projects.map((id) => (
              <li key={id}>
                <Link className="zk-button" href={`/project/${encodeURIComponent(id)}`}>
                  {id}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
