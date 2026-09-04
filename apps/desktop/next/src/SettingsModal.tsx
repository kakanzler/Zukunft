"use client"

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
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

/**
 * 背景画像の上限。
 *
 * 画像は base64 にして IPC で渡すので、実体より 3 割ほど大きい文字列になる。
 * 8MB を超える写真をそのまま敷いても見た目は変わらないのに、起動のたびに
 * その分を読むことになる。読み込む前に file.size で弾く。
 */
const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024

type Props = {
  settings: WindowSettings
  /** 依存関係に合わせて日程を後ろへずらすか（企画書 §15.2） */
  autoReschedule: boolean
  /** 盤面の意匠 */
  theme: GanttTheme
  /** 盤面の地に敷く画像（data: URL）。敷いていなければ null */
  backgroundImage: string | null
  busy: boolean
  /** Tauri の外（モック）では反映する窓が無い。その旨を画面に出すために受け取る。 */
  applies: boolean
  /**
   * トークンの入手元。"env" は環境変数で、サインアウトしても効き続ける。
   * 押しても何も変わらないボタンを出さないために受け取る。
   */
  authSource: string
  /** サインアウト。渡さなければその節ごと出さない（ブラウザのモックなど） */
  onSignOut?: () => Promise<void> | void
  /**
   * 保存先は窓の設定と別だが、押すボタンは 1 つにする。
   * 「保存して反映」で片方しか保存されない画面は説明が要る。
   */
  onSave: (
    settings: WindowSettings,
    autoReschedule: boolean,
    theme: GanttTheme,
    backgroundImage: string | null,
  ) => void
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

/** 左に並ぶカテゴリ。id は設定項目の所属と対応する。 */
const CATEGORIES: { id: string; label: string }[] = [
  { id: "window", label: "ウィンドウ" },
  { id: "appearance", label: "外観" },
  { id: "schedule", label: "日程" },
  { id: "account", label: "アカウント" },
]

/**
 * 設定項目 1 つ。
 *
 * 検索の当たり判定に使う語をここに持たせる。表示名だけで引くと、
 * 「フルスクリーン」を探しているのに「起動時の表示」でしか出てこない、
 * といったことが起きる。
 */
type Setting = {
  id: string
  category: string
  title: string
  /** 見出しの下に出す 1 行。何が変わるのかをここで言い切る */
  summary: string
  /** 検索で拾わせたい語。title と summary は自動で含める */
  keywords?: string[]
  render: () => ReactNode
}

function matches(setting: Setting, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  const haystack = [setting.title, setting.summary, ...(setting.keywords ?? [])]
    .join(" ")
    .toLowerCase()
  // 空白区切りの語をすべて含むもの。絞り込みを重ねられるようにする。
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

/**
 * アプリの設定。
 *
 * 構成は specifications/apeearance/appearance_settings.png に倣う。上に検索、
 * 左にカテゴリ、右に本文。項目が増えても 1 本のスクロールに積み上がらない。
 *
 * 検索中はカテゴリの選択を無視して、当たった項目を全部出す。探している設定が
 * どのカテゴリにあるかを知っている必要が無いのが、この構成の効きどころ。
 */
export function SettingsModal({
  settings, autoReschedule, theme, backgroundImage, busy, applies, authSource,
  onSignOut, onSave, onClose,
}: Props) {
  const [draft, setDraft] = useState<WindowSettings>(settings)
  const [autoDraft, setAutoDraft] = useState(autoReschedule)
  const [themeDraft, setThemeDraft] = useState<GanttTheme>(theme)
  const [backgroundDraft, setBackgroundDraft] = useState<string | null>(backgroundImage)
  /** 選べなかった理由。選んだその場に出さないと、押しても何も起きないように見える。 */
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  // ファイル選択は隠してあり、押されるのは隣のボタン。参照はそれを繋ぐためだけ。
  const fileInput = useRef<HTMLInputElement>(null)
  // サインアウトは取り消せない（トークンを資格情報ストアから消す）ので、
  // 削除と同じく確認を 1 段挟む。
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [category, setCategory] = useState(CATEGORIES[0]!.id)
  const [query, setQuery] = useState("")

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
    setBackgroundDraft(backgroundImage)
  }, [backgroundImage])

  /**
   * 選ばれた画像を下書きに取り込む。
   *
   * 保存はここでしない。他の外観設定と同じく「保存して反映」でまとめて適用する。
   * 大きすぎるものは読み込む前に弾く — base64 にしてから捨てるのは、数 MB を
   * 無駄に文字列へ広げてから同じ結論に至るだけ。
   */
  const pickBackground = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_BACKGROUND_BYTES) {
      const size = (file.size / 1024 / 1024).toFixed(1)
      setBackgroundError(`この画像は ${size}MB です。背景に使えるのは 8MB までです。`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL の結果は data: URL の文字列。そうでなければ読めていない。
      if (typeof reader.result !== "string") {
        setBackgroundError("画像を読み取れませんでした。別の画像を選んでください。")
        return
      }
      setBackgroundError(null)
      setBackgroundDraft(reader.result)
    }
    reader.onerror = () => {
      setBackgroundError("画像を読み取れませんでした。別の画像を選んでください。")
    }
    reader.readAsDataURL(file)
  }

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

  const settingList: Setting[] = [
    {
      id: "window-mode",
      category: "window",
      title: "起動時の表示",
      summary: "次に開いたときの窓の出方を決めます。",
      keywords: ["フルスクリーン", "最大化", "ウィンドウ", "full screen", "maximize"],
      render: () => (
        <div className="zk-set-choices">
          {MODES.map((option) => (
            <label className="zk-set-choice" key={option.mode}>
              <input
                type="radio"
                name="zk-window-mode"
                checked={draft.mode === option.mode}
                disabled={busy}
                onChange={() => setDraft((prev) => ({ ...prev, mode: option.mode }))}
              />
              <span className="zk-set-choice-label">{option.label}</span>
              <span className="zk-set-choice-note">{option.description}</span>
            </label>
          ))}
        </div>
      ),
    },
    {
      id: "window-size",
      category: "window",
      title: "ウィンドウの大きさ",
      summary:
        "変わるのは Zukunft の窓の大きさだけです。ディスプレイの解像度そのものには触れません。",
      keywords: ["解像度", "幅", "高さ", "size", "resolution"],
      render: () => (
        <>
          <div className="zk-set-size">
            <input
              type="number"
              className="zk-input"
              value={draft.width}
              min={MIN_WINDOW_WIDTH}
              step={10}
              disabled={busy || !windowed}
              aria-label="幅"
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, width: Number(e.target.value) || 0 }))
              }
            />
            <span className="zk-set-times">×</span>
            <input
              type="number"
              className="zk-input"
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
          <div className="zk-set-presets">
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
          <span className="zk-set-note">
            {!windowed
              ? "「ウィンドウ」を選ぶと大きさを指定できます。ここでの値は、ウィンドウに戻したときに使われます。"
              : tooSmall
                ? `最小は ${MIN_WINDOW_WIDTH}×${MIN_WINDOW_HEIGHT} です。`
                : "Gantt が読める大きさを保つため、これより小さくはできません。"}
            {!applies && "　ブラウザで開いているため、ここでの指定は窓に反映されません。"}
          </span>
        </>
      ),
    },
    {
      id: "theme",
      category: "appearance",
      title: "盤面の見た目",
      summary: "変わるのは Gantt の盤面だけです。ログは同じままで、GitHub 側にも何も起きません。",
      keywords: ["テーマ", "配色", "色", "theme", "bluesystem", "default"],
      render: () => (
        <div className="zk-set-choices">
          {THEMES.map((option) => (
            <label className="zk-set-choice" key={option.theme}>
              <input
                type="radio"
                name="zk-gantt-theme"
                checked={themeDraft === option.theme}
                disabled={busy}
                onChange={() => setThemeDraft(option.theme)}
              />
              <span className="zk-set-choice-label">{option.label}</span>
              <span className="zk-set-choice-note">{option.note}</span>
            </label>
          ))}
        </div>
      ),
    },
    {
      id: "background-image",
      category: "appearance",
      title: "背景画像",
      summary:
        "選んだ画像を盤面の地に敷きます。画像はこの PC の中だけに保存され、GitHub には何も送りません。",
      keywords: ["壁紙", "背景", "画像", "写真", "background", "wallpaper", "image"],
      render: () => (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="zk-set-file-input"
            disabled={busy}
            aria-label="背景に使う画像を選ぶ"
            onChange={(e) => {
              pickBackground(e.target.files?.[0])
              // 同じ画像を選び直しても change が起きるように、値を空へ戻す。
              e.target.value = ""
            }}
          />
          <div className="zk-set-presets">
            <button
              type="button"
              className="zk-button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              画像を選ぶ…
            </button>
            {backgroundDraft && (
              <button
                type="button"
                className="zk-button"
                disabled={busy}
                onClick={() => {
                  setBackgroundDraft(null)
                  setBackgroundError(null)
                }}
              >
                背景を外す
              </button>
            )}
          </div>
          {backgroundDraft ? (
            <img className="zk-set-preview" src={backgroundDraft} alt="選んだ背景画像" />
          ) : (
            <span className="zk-set-note">まだ選んでいません。</span>
          )}
          {backgroundError && <span className="zk-set-danger">{backgroundError}</span>}
          <span className="zk-set-note">
            画面の中央を基準に、切れないよう引き伸ばして敷きます。BlueSystem では
            サイドバーや一覧が半透明なので、その下からこの画像が透けます。
          </span>
        </>
      ),
    },
    {
      id: "auto-reschedule",
      category: "schedule",
      title: "日程の自動調整",
      summary:
        "依存先の終了日より前に始まっている Issue だけを後ろへずらします。前倒しはしません。",
      keywords: ["依存", "カスケード", "blocked-by", "自動"],
      render: () => (
        <>
          <label className="zk-set-check">
            <input
              type="checkbox"
              checked={autoDraft}
              disabled={busy}
              onChange={(e) => setAutoDraft(e.target.checked)}
            />
            <span>依存関係に合わせて自動で日程を後ろへずらす</span>
          </label>
          <span className="zk-set-note">まとめて動いた分は Ctrl+Z 一回で戻せます。</span>
        </>
      ),
    },
    ...(onSignOut
      ? [
          {
            id: "sign-out",
            category: "account",
            title: "サインアウト",
            summary: "保存したトークンを消します。アカウントを切り替えるときに使います。",
            keywords: ["ログアウト", "トークン", "token", "sign out"],
            render: () =>
              confirmingSignOut ? (
                <div className="zk-set-danger">
                  <span>
                    サインアウトすると保存したトークンを消します。次の起動でサインインし直しになります
                  </span>
                  <div className="zk-set-presets">
                    <button
                      type="button"
                      className="zk-button zk-button--danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirmingSignOut(false)
                        void onSignOut()
                      }}
                    >
                      サインアウトする
                    </button>
                    <button
                      type="button"
                      className="zk-button"
                      disabled={busy}
                      onClick={() => setConfirmingSignOut(false)}
                    >
                      やめる
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="zk-button zk-button--danger"
                    style={{ justifySelf: "start" }}
                    disabled={busy || authSource === "env"}
                    onClick={() => setConfirmingSignOut(true)}
                  >
                    サインアウト
                  </button>
                  {authSource === "env" && (
                    <span className="zk-set-note">
                      環境変数のトークンで動いています。消せるのは資格情報ストアの分だけなので、
                      まず ZUKUNFT_GITHUB_TOKEN を外してください。
                    </span>
                  )}
                </>
              ),
          },
        ]
      : []),
  ]

  const searching = query.trim() !== ""
  const shown = settingList.filter((s) =>
    searching ? matches(s, query) : s.category === category,
  )

  /** カテゴリごとの当たり件数。検索中に「どこにあるか」を左で示す。 */
  const hits = useMemo(() => {
    const counts = new Map<string, number>()
    if (!searching) return counts
    for (const s of settingList) {
      if (matches(s, query)) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
    }
    return counts
    // settingList は毎レンダリング作り直されるが、所属と検索語だけで決まる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searching, Boolean(onSignOut)])

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
      <div className="zk-modal zk-modal--settings">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>設定</div>
          <button className="zk-button" onClick={onClose} disabled={busy} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-set-search">
          <input
            className="zk-input"
            value={query}
            placeholder="設定を検索"
            aria-label="設定を検索"
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && (
            <button className="zk-button" onClick={() => setQuery("")}>検索を解除</button>
          )}
        </div>

        <div className="zk-set">
          <nav className="zk-set-nav" aria-label="設定のカテゴリ">
            {CATEGORIES.map((c) => {
              const count = hits.get(c.id) ?? 0
              return (
                <button
                  key={c.id}
                  className="zk-set-nav-item"
                  // 検索中は選択ではなく当たりの有無を示す。押せば検索を解いてそこへ移る。
                  aria-pressed={searching ? count > 0 : category === c.id}
                  disabled={searching && count === 0}
                  onClick={() => {
                    setQuery("")
                    setCategory(c.id)
                  }}
                >
                  <span>{c.label}</span>
                  {searching && count > 0 && <span className="zk-set-nav-count">{count}</span>}
                </button>
              )
            })}
          </nav>

          <div className="zk-set-body">
            <h2 className="zk-set-title">
              {searching
                ? `「${query.trim()}」に一致する設定`
                : CATEGORIES.find((c) => c.id === category)!.label}
            </h2>
            {shown.length === 0 ? (
              <span className="zk-set-note">一致する設定がありません。</span>
            ) : (
              shown.map((s) => (
                <section className="zk-set-item" key={s.id}>
                  <h3 className="zk-set-item-title">{s.title}</h3>
                  <p className="zk-set-item-summary">{s.summary}</p>
                  {s.render()}
                </section>
              ))
            )}
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
              setBackgroundDraft(null)
              setBackgroundError(null)
            }}
          >
            既定に戻す
          </button>
          <button className="zk-button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button
            className="zk-button zk-button--primary"
            disabled={busy || tooSmall}
            onClick={() => onSave(draft, autoDraft, themeDraft, backgroundDraft)}
          >
            {busy ? "保存中…" : "保存して反映"}
          </button>
        </div>
      </div>
    </div>
  )
}
