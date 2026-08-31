"use client"

import type { MouseEvent } from "react"
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
export function Markdown({ text }: { text: string }) {
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
