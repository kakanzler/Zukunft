import { ServerScheduleRepository } from "@zukunft/github/server"

/**
 * Web 版の設定（企画書 §4.2 / §17）。
 *
 * トークンは Read 権限のみ。サーバ側でしか読まないため、
 * `NEXT_PUBLIC_` を付けず、クライアントには渡らないようにする。
 */
export function readToken(): string {
  return process.env.ZUKUNFT_GITHUB_READ_TOKEN ?? ""
}

/**
 * 公開してよい Project の許可リスト（企画書 §17）。
 * Private リポジトリの内容を公開 URL で配信することになるため、
 * 出す対象を明示的に指定させる。
 */
export function allowedProjectIds(): string[] {
  return (process.env.ZUKUNFT_PUBLIC_PROJECT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

export function isAllowed(projectId: string): boolean {
  const allowed = allowedProjectIds()
  return allowed.length > 0 && allowed.includes(projectId)
}

export function repository(): ServerScheduleRepository {
  return new ServerScheduleRepository({ token: readToken() })
}
