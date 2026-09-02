"use client"

import { isTauri } from "@/repository"

/**
 * アプリ内だけの設定（親カテゴリ・ウィンドウの見せ方）の読み書き。
 *
 * 親カテゴリは「このラベル名を最上位として扱う」という表示上の取り決めでしかなく、
 * GitHub 側のラベルには何も起きない。そのため保存先も GitHub ではなくローカルにする。
 */

/**
 * ウィンドウの見せ方。ディスプレイの解像度そのものではなく、このアプリの窓の話。
 * `windowed` のときだけ width / height が効く。
 */
export type WindowMode = "windowed" | "maximized" | "fullscreen"

export type WindowSettings = {
  mode: WindowMode
  width: number
  height: number
}

/** tauri.conf.json の windows[0] に合わせる。Rust 側の既定値と同じ値を持つ。 */
export const DEFAULT_WINDOW_SETTINGS: WindowSettings = {
  mode: "fullscreen",
  width: 1440,
  height: 900,
}

/** tauri.conf.json の minWidth / minHeight。画面の入力もここで止める。 */
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 600

/** Rust 側の `AppSettings`（apps/desktop/src-tauri/src/settings.rs）に対応する。 */
type AppSettings = {
  parentLabels?: Record<string, string[]>
  window?: Partial<WindowSettings>
  autoReschedule?: boolean
}

/**
 * ブラウザ（モック）用の保存先。
 * モック UI を触って確かめるためだけのもので、永続させる意図は無い。
 * localStorage ではなく sessionStorage なのはそのため — タブを閉じれば消える。
 */
const STORAGE_PREFIX = "zukunft.parentLabels."
const WINDOW_STORAGE_KEY = "zukunft.window"
const AUTO_RESCHEDULE_STORAGE_KEY = "zukunft.autoReschedule"

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

/**
 * 依存関係に合わせて日程を自動で後ろへずらすか（企画書 §15.2）。
 *
 * 既定は有効。依存関係を書いた時点で「守りたい」という意思表示なので、
 * 既定で守る側に倒す。読めなければ既定に落ちる — この設定のために
 * Gantt が開けなくなる方が困る。
 */
export async function loadAutoReschedule(): Promise<boolean> {
  try {
    if (isTauri()) {
      const settings = await invokeCommand<AppSettings>("get_settings", {})
      return settings.autoReschedule ?? true
    }
    return window.sessionStorage.getItem(AUTO_RESCHEDULE_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export async function saveAutoReschedule(enabled: boolean): Promise<void> {
  if (isTauri()) {
    await invokeCommand<AppSettings>("set_auto_reschedule", { enabled })
    return
  }
  window.sessionStorage.setItem(AUTO_RESCHEDULE_STORAGE_KEY, String(enabled))
}

/** 壊れた値でウィンドウ設定の画面が開けなくなるのを避ける。 */
function normalizeWindowSettings(value: Partial<WindowSettings> | undefined): WindowSettings {
  const mode: WindowMode =
    value?.mode === "windowed" || value?.mode === "maximized"
      ? value.mode
      : DEFAULT_WINDOW_SETTINGS.mode
  const size = (raw: unknown, min: number, fallback: number) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min ? Math.round(raw) : fallback
  return {
    mode,
    width: size(value?.width, MIN_WINDOW_WIDTH, DEFAULT_WINDOW_SETTINGS.width),
    height: size(value?.height, MIN_WINDOW_HEIGHT, DEFAULT_WINDOW_SETTINGS.height),
  }
}

/**
 * ウィンドウの見せ方。
 *
 * 親カテゴリと同じく、読めないことを画面の失敗にはしない。既定（1440×900 の窓）に
 * 落ちるだけで、アプリは問題なく使える。
 */
export async function loadWindowSettings(): Promise<WindowSettings> {
  try {
    if (isTauri()) {
      const settings = await invokeCommand<AppSettings>("get_settings", {})
      return normalizeWindowSettings(settings.window)
    }
    const raw = window.sessionStorage.getItem(WINDOW_STORAGE_KEY)
    if (!raw) return DEFAULT_WINDOW_SETTINGS
    return normalizeWindowSettings(JSON.parse(raw) as Partial<WindowSettings>)
  } catch {
    return DEFAULT_WINDOW_SETTINGS
  }
}

/**
 * ウィンドウの見せ方を保存する。Tauri 側では保存と同時に窓へ反映される。
 * ブラウザ（モック）には反映する窓が無いので、保存だけして値を返す。
 */
export async function saveWindowSettings(settings: WindowSettings): Promise<void> {
  const normalized = normalizeWindowSettings(settings)
  if (isTauri()) {
    await invokeCommand<AppSettings>("set_window_settings", { window: normalized })
    return
  }
  window.sessionStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(normalized))
}

/**
 * フルスクリーンを解除する（Esc）。設定は書き換えないので、次の起動は保存済みの見せ方に戻る。
 * Tauri の外では解除する窓が無いので何もしない。
 */
export async function exitFullscreen(): Promise<void> {
  if (!isTauri()) return
  try {
    await invokeCommand<void>("exit_fullscreen", {})
  } catch {
    // 抜けられなくてもアプリは使える。失敗をログに出しても打つ手が無い。
  }
}
