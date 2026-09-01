"use client"

import { isTauri } from "@/repository"

/**
 * アプリ内だけの設定（親カテゴリ）の読み書き。
 *
 * 親カテゴリは「このラベル名を最上位として扱う」という表示上の取り決めでしかなく、
 * GitHub 側のラベルには何も起きない。そのため保存先も GitHub ではなくローカルにする。
 */

/** Rust 側の `AppSettings`（apps/desktop/src-tauri/src/settings.rs）に対応する。 */
type AppSettings = {
  parentLabels?: Record<string, string[]>
}

/**
 * ブラウザ（モック）用の保存先。
 * モック UI を触って確かめるためだけのもので、永続させる意図は無い。
 * localStorage ではなく sessionStorage なのはそのため — タブを閉じれば消える。
 */
const STORAGE_PREFIX = "zukunft.parentLabels."

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  // Tauri の外では @tauri-apps/api の読み込み自体が失敗するため、動的に読む。
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

/**
 * 親カテゴリとして扱うラベル名。
 *
 * 設定が読めないことを画面の失敗にはしない。親カテゴリが無い状態（＝これまでの表示）
 * に落ちるだけで、Gantt は問題なく描けるため。
 */
export async function loadParentLabels(projectId: string): Promise<string[]> {
  if (!projectId) return []
  try {
    if (isTauri()) {
      const settings = await invokeCommand<AppSettings>("get_settings", {})
      return settings.parentLabels?.[projectId] ?? []
    }
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

/** 保存の失敗は握り潰さない。「保存した」と見えて次の起動で消えている方が困る。 */
export async function saveParentLabels(projectId: string, labels: string[]): Promise<void> {
  if (!projectId) return
  if (isTauri()) {
    await invokeCommand<AppSettings>("set_parent_labels", { projectId, labels })
    return
  }
  window.sessionStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(labels))
}
