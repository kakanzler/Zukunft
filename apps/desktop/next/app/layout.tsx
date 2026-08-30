import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Zukunft",
  description: "GitHub Issue × Gantt schedule editor",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
