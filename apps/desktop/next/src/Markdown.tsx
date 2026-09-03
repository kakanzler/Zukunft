"use client"

import type { ChangeEvent, MouseEvent } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { isTauri } from "@/repository"

/**
 * Issue 本文の Markdown を描画する。
 *
 * 生の HTML は意図的に解釈しない（react-markdown の既定）。本文は GitHub から
 * 来る外部入力なので、WebView に任意のマークアップを流し込む口を開けない。
 *
 * 画像も描画しない。Tauri の CSP（tauri.conf.json）が `img-src` を自分自身と
 * アバターのホストに限っているため、外部画像はどのみち読めず、壊れた画像枠が
 * 出るだけになる。代わりに代替テキストを見せる。
 */
export function Markdown({
  text,
  onToggleTask,
  busy = false,
}: {
  text: string
  /**
   * 本文のタスクリストを押したとき。上から数えて何番目かを渡す。
   * 渡さなければチェックボックスは押せないまま（読むだけの場面）。
   */
  onToggleTask?: (index: number) => void
  busy?: boolean
}) {
  // どの行を押したかは、描画時に数えるのではなく押された時点の DOM の並びで決める。
  // 描画のたびに数え直す作りにすると、React が input だけを描き直したときに
  // 番号がずれる（実際に 1 つ隣が反転していた）。DOM の並びは本文の並びと必ず一致する。
  const onToggle = (event: ChangeEvent<HTMLInputElement>) => {
    const box = event.currentTarget
    const boxes = box.closest(".zk-body-md")?.querySelectorAll("input.zk-md-task")
    if (!boxes) return
    onToggleTask?.([...boxes].indexOf(box))
  }

  return (
    <div className="zk-body-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
          img: ({ alt, src }) => (
            <span className="zk-md-image" title={typeof src === "string" ? src : undefined}>
              🖼 {alt || "画像"}
            </span>
          ),
          input: ({ type, checked }) =>
            type === "checkbox" ? (
              <input
                type="checkbox"
                className="zk-md-task"
                checked={Boolean(checked)}
                disabled={!onToggleTask || busy}
                aria-label="この項目のチェック"
                onChange={onToggle}
              />
            ) : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** Rust の `open_external` が受け付けるホスト。これ以外は開けない。 */
const GITHUB_URL = /^https:\/\/(www\.)?github\.com\//i

function ExternalLink({ href, children }: { href?: string; children: React.ReactNode }) {
  const absolute = typeof href === "string" && /^https?:\/\//i.test(href)
  // デスクトップでは Rust 側が GitHub のホストしか開かないので、
  // それ以外は押せないことが見て分かるようにしておく（URL は title で読める）。
  const openable = absolute && (!isTauri() || GITHUB_URL.test(href))

  const onClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (!openable || !href) return
    if (isTauri()) {
      const { auth } = await import("@zukunft/github/tauri")
      await auth.openExternal(href)
    } else {
      window.open(href, "_blank", "noreferrer")
    }
  }

  return (
    <a
      className={openable ? "zk-md-link" : "zk-md-link zk-md-link--inert"}
      href={href}
      title={href}
      onClick={onClick}
    >
      {children}
    </a>
  )
}
