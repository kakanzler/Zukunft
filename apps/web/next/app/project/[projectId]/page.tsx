import { notFound } from "next/navigation"
import { missingRequiredFields } from "@zukunft/domain"
import { GitHubError, describeError, statusOrder } from "@zukunft/github"
import { isAllowed, repository } from "@/config"
import { ReadOnlyGantt } from "@/ReadOnlyGantt"

/** 5 分ごとに再生成する。共有ページなので即時性より安定性を優先する。 */
export const revalidate = 300

export default async function ProjectPage({
  params,
}: {
  params: { projectId: string }
}) {
  const projectId = decodeURIComponent(params.projectId)

  // 許可リストに無い Project は存在しないものとして扱う（企画書 §17）。
  if (!isAllowed(projectId)) notFound()

  try {
    const repo = repository()
    const [schema, tasks] = await Promise.all([
      repo.getProjectSchema(projectId),
      repo.getTasks(projectId),
    ])

    const missing = missingRequiredFields(schema)
    if (missing.length > 0) {
      return (
        <main className="zk-root">
          <div className="zk-empty">
            <h2>この Project はまだ Gantt を表示できません</h2>
            <p>{missing.map((f) => f.name).join(" / ")} が設定されていません。</p>
          </div>
        </main>
      )
    }

    return (
      <main className="zk-root">
        <ReadOnlyGantt
          tasks={tasks}
          statusOrder={statusOrder(schema)}
          title="Zukunft"
        />
      </main>
    )
  } catch (error) {
    const err = error instanceof GitHubError ? error : new GitHubError("unknown", String(error))
    const info = describeError(err)
    return (
      <main className="zk-root">
        <div className="zk-empty">
          <h2>{info.title}</h2>
          <p>{info.hint}</p>
        </div>
      </main>
    )
  }
}
