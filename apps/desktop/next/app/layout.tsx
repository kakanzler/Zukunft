import type { Metadata } from "next"
import { Sawarabi_Gothic } from "next/font/google"
import "./globals.css"

/**
 * 本文フォント。next/font がビルド時に取り込んで自前で配るので、
 * 実行時に fonts.googleapis.com を見に行かない — オフラインでも、
 * CSP を 'self' に絞ったままでも同じ字面になる（企画書 §17）。
 */
const sawarabi = Sawarabi_Gothic({
  weight: "400",
  // subsets を指定しない（＝preload を切る）のは、next/font が持つ Sawarabi Gothic の
  // subset 一覧に japanese が無いため。latin だけ取ると和文が別のフォントに落ちる。
  // 指定しなければ全 subset の CSS を取り込むので、仮名・漢字も同じ字面になる。
  preload: false,
  display: "swap",
  variable: "--font-sawarabi",
})

export const metadata: Metadata = {
  title: "Zukunft",
  description: "GitHub Issue × Gantt schedule editor",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={sawarabi.variable}>
      <body>{children}</body>
    </html>
  )
}
