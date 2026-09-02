"use client"

import { useEffect, useState } from "react"
import type { GanttTheme } from "@zukunft/gantt"
import {
  DEFAULT_WINDOW_SETTINGS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type WindowMode,
  type WindowSettings,
} from "@/settings"

/** 意匠の選択肢。値は packages/gantt の GanttTheme と揃える。 */
const THEMES: { theme: GanttTheme; label: string; note: string }[] = [
  { theme: "default", label: "Default", note: "これまでの見た目" },
  { theme: "blue-system", label: "BlueSystem", note: "青を基調に、今日とマイルストーンを赤で差す" },
]

type Props = {
  settings: WindowSettings
  /** 依存関係に合わせて日程を後ろへずらすか（企画書 §15.2） */
  autoReschedule: boolean
  /** 盤面の意匠 */
  theme: GanttTheme
  busy: boolean
  /** Tauri の外（モック）では反映する窓が無い。その旨を画面に出すために受け取る。 */
  applies: boolean
  /**
   * 保存先は窓の設定と別だが、押すボタンは 1 つにする。
   * 「保存して反映」で片方しか保存されない画面は説明が要る。
   */
  onSave: (settings: WindowSettings, autoReschedule: boolean, theme: GanttTheme) => void
  onClose: () => void
}

const MODES: { mode: WindowMode; label: string; description: string }[] = [
  {
    mode: "windowed",
    label: "ウィンドウ",
    description: "下で指定した大きさで開く",
  },
  {
    mode: "maximized",
    label: "最大化",
    description: "タスクバーを残したまま画面いっぱいに広げる",
  },
  {
    mode: "fullscreen",
    label: "フルスクリーン",
    description: "画面全体を占有する（F11 相当）",
  },
]

/** よく使う大きさ。ここに無い値は幅・高さを直接入れられる。 */
const PRESETS: { width: number; height: number }[] = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

/**
 * アプリの設定。Project に依らない、アプリ全体の振る舞いを扱う。
 *
 * ウィンドウについて「解像度」と言ってもディスプレイの設定には触れない。変えるのは
 * このアプリの窓の大きさだけで、閉じたあとに何かが残ることはない — そこは画面にも
 * 書いておく。
 */
export function SettingsModal({
  settings, autoReschedule, theme, busy, applies, onSave, onClose,
}: Props) {
  const [draft, setDraft] = useState<WindowSettings>(settings)
  const [autoDraft, setAutoDraft] = useState(autoReschedule)
  const [themeDraft, setThemeDraft] = useState<GanttTheme>(theme)

  // 保存済みの値は開いた後に届くことがある（Rust 側の読み取りを待つ）。
  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    setAutoDraft(autoReschedule)
  }, [autoReschedule])

  useEffect(() => {
    setThemeDraft(theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, busy])

  const windowed = draft.mode === "windowed"
  // 小さすぎる窓は Gantt が読めなくなるので、保存させずにその場で止める。
  const tooSmall = draft.width < MIN_WINDOW_WIDTH || draft.height < MIN_WINDOW_HEIGHT

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="設定"
    >
      <div className="zk-modal">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>設定</div>
          <button className="zk-button" onClick={onClose} disabled={busy} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-modal-body">
          {/* 窓についての断りなので、窓の設定の直前に置く。画面の冒頭に置くと、
              下にある日程の設定まで「窓の話」に読めてしまう。 */}
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            ウィンドウで変わるのは Zukunft の窓の大きさだけです。ディスプレイの解像度
            そのものには触れないので、アプリを閉じれば元の画面のままです。
            {!applies && "　（ブラウザで開いているため、ここでの指定は窓に反映されません）"}
          </div>

          <div className="zk-field">
            <span className="zk-field-label">起動時の表示</span>
            <div style={{ display: "grid", gap: 4 }}>
              {MODES.map((option) => (
                <label
                  key={option.mode}
                  style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 }}
                >
                  <input
                    type="radio"
                    name="zk-window-mode"
                    checked={draft.mode === option.mode}
                    disabled={busy}
                    onChange={() => setDraft((prev) => ({ ...prev, mode: option.mode }))}
                  />
                  <span>{option.label}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {option.description}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="zk-field">
            <span className="zk-field-label">ウィンドウの大きさ</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="number"
                className="zk-input"
                style={{ width: 96 }}
                value={draft.width}
                min={MIN_WINDOW_WIDTH}
                step={10}
                disabled={busy || !windowed}
                aria-label="幅"
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, width: Number(e.target.value) || 0 }))
                }
              />
              <span style={{ color: "var(--text-secondary)" }}>×</span>
              <input
                type="number"
                className="zk-input"
                style={{ width: 96 }}
                value={draft.height}
                min={MIN_WINDOW_HEIGHT}
                step={10}
                disabled={busy || !windowed}
                aria-label="高さ"
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, height: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {PRESETS.map((preset) => (
                <button
                  key={`${preset.width}x${preset.height}`}
                  className="zk-button"
                  disabled={busy || !windowed}
                  aria-pressed={draft.width === preset.width && draft.height === preset.height}
                  onClick={() =>
                    setDraft((prev) => ({ ...prev, width: preset.width, height: preset.height }))
                  }
                >
                  {preset.width}×{preset.height}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
              {!windowed
                ? "「ウィンドウ」を選ぶと大きさを指定できます。ここでの値は、ウィンドウに戻したときに使われます。"
                : tooSmall
                  ? `最小は ${MIN_WINDOW_WIDTH}×${MIN_WINDOW_HEIGHT} です。`
                  : "Gantt が読める大きさを保つため、これより小さくはできません。"}
            </span>
          </div>

          {/* 見た目は好みの話で、窓の大きさや日程の規則とは別のもの。節を分けて置く。 */}
          <div className="zk-field">
            <span className="zk-field-label">盤面の見た目</span>
            <div style={{ display: "grid", gap: 4 }}>
              {THEMES.map((option) => (
                <label
                  key={option.theme}
                  style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 }}
                >
                  <input
                    type="radio"
                    name="zk-gantt-theme"
                    checked={themeDraft === option.theme}
                    disabled={busy}
                    onChange={() => setThemeDraft(option.theme)}
                  />
                  <span style={{ fontWeight: 600 }}>{option.label}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{option.note}</span>
                </label>
              ))}
            </div>
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
              変わるのは Gantt の盤面だけです。ログは同じままで、GitHub 側にも何も起きません。
            </span>
          </div>

          <div className="zk-field">
            <span className="zk-field-label">日程の自動調整</span>
            <label style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={autoDraft}
                disabled={busy}
                onChange={(e) => setAutoDraft(e.target.checked)}
              />
              <span>依存関係に合わせて自動で日程を後ろへずらす</span>
            </label>
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
              依存先の終了日より前に始まっている Issue だけを後ろへずらします。前倒しはしません。
              まとめて動いた分は Ctrl+Z 一回で戻せます。
            </span>
          </div>
        </div>

        <div className="zk-modal-foot">
          <button
            className="zk-button"
            disabled={busy}
            onClick={() => {
              setDraft(DEFAULT_WINDOW_SETTINGS)
              setAutoDraft(true)
              setThemeDraft("default")
            }}
          >
            既定に戻す
          </button>
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button
            className="zk-button"
            disabled={busy || tooSmall}
            onClick={() => onSave(draft, autoDraft, themeDraft)}
          >
            {busy ? "保存中…" : "保存して反映"}
          </button>
        </div>
      </div>
    </div>
  )
}
