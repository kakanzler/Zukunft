"use client"

import type { GitHubScheduleRepository } from "@zukunft/github"
import { MockScheduleRepository } from "@zukunft/github/mock"

/**
 * 実行環境に応じて実装を選ぶ（企画書 §4.3.4）。
 *
 * Tauri の WebView では `window.__TAURI_INTERNALS__` が注入される。
 * ブラウザで `next dev` を開いた場合はモックにフォールバックし、
 * GitHub に触れずに UI を確認できるようにする。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

let cached: GitHubScheduleRepository | null = null

export async function getRepository(): Promise<GitHubScheduleRepository> {
  if (cached) return cached
  if (isTauri()) {
    // Tauri の外では @tauri-apps/api の読み込み自体が失敗するため、動的に読む。
    const { TauriScheduleRepository } = await import("@zukunft/github/tauri")
    cached = new TauriScheduleRepository()
  } else {
    // ブラウザでの確認用に、失敗と競合を注入できるようにしておく。
    // 例: http://localhost:3000/?failure=1 で「失敗 → 再試行 / 取り消し」を、
    //     ?conflict=1 で「競合 → GitHub 側を採用 / ローカルで上書き」を確認できる。
    const params = new URLSearchParams(window.location.search)
    const rate = (key: string) => {
      const value = Number(params.get(key))
      return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
    }
    cached = new MockScheduleRepository({
      latencyMs: 260,
      failureRate: rate("failure"),
      conflictRate: rate("conflict"),
      // ?nodates=1 で「Start Date / Target Date が無い Project」、
      // ?empty=1 で「item が 0 件の Project」を再現する。
      withoutDateFields:
        params.get("nodates") === "once" ? "once" : params.get("nodates") === "1",
      empty: params.get("empty") === "1",
      undated: params.get("undated") === "1",
    })
  }
  return cached
}
