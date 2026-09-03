"use client"

import { useState } from "react"
import type { Label } from "@zukunft/domain"

type Props = {
  /** 親カテゴリとして扱うラベル名（カテゴリ設定の値） */
  parentLabels: string[]
  /**
   * 名前で重複を除いたラベルの一覧。色の手掛かりに使う。
   * 別のリポジトリにしか無いラベルもここには載る。
   */
  labelCatalog: Label[]
  /** この Issue のリポジトリに定義済みのラベル。node id が引ける唯一の出所 */
  available: Label[]
  /** 現在 Issue に付いているラベル */
  selected: Label[]
  busy: boolean
  onChange: (labels: Label[]) => void
  /** リポジトリにラベルを作る。作れたら実体を返す */
  onCreate: (name: string, color: string) => Promise<Label | null>
  /**
   * 親カテゴリとして扱う名前の集合を差し替える（カテゴリ設定と同じ保存先）。
   * これがあると、この画面から親カテゴリそのものを増減できる。
   */
  onDesignate?: (names: string[]) => Promise<void> | void
}

/** LabelEditor と同じ既定色。作成の入口が 2 つあっても見た目を揃える。 */
const DEFAULT_COLOR = "3b82f6"

/**
 * この Issue をどの親カテゴリに置くかを選ぶ（企画書 §6.4.2）。
 *
 * 親カテゴリは GitHub 側ではただのラベルなので、選ぶ / 外すはそのラベルの
 * 付け外しそのもの。カテゴリ設定が持っているのは名前だけなので、ここで実体を
 * 引き直す。
 *
 * 複数選べるのは、Category 表示が親の組み合わせを 1 つのまとまりとして扱うため。
 * 順位を付けてどちらかに寄せるより、「両方に属する」と読める方が説明が要らない。
 */
export function ParentCategoryPicker({
  parentLabels, labelCatalog, available, selected, busy, onChange, onCreate, onDesignate,
}: Props) {
  // このリポジトリに無いラベルを作るのはリポジトリを書き換える操作なので、
  // 押した瞬間には作らず確認を挟む。
  const [creating, setCreating] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 親カテゴリそのものを選び直す欄。既定は閉じておく。
  const [designating, setDesignating] = useState(false)

  const selectedNames = new Set(
    selected.filter((l) => parentLabels.includes(l.name)).map((l) => l.name),
  )

  const resolve = (name: string): Label | null =>
    selected.find((l) => l.name === name) ?? available.find((l) => l.name === name) ?? null

  const colorFor = (name: string): string =>
    resolve(name)?.color || labelCatalog.find((l) => l.name === name)?.color || DEFAULT_COLOR

  const toggle = (name: string) => {
    setError(null)
    if (selectedNames.has(name)) {
      onChange(selected.filter((l) => l.name !== name))
      return
    }
    const label = resolve(name)
    // 実体が引けないラベルは、このリポジトリにまだ無い。作るかどうかを尋ねる。
    if (!label) {
      setCreating(name)
      return
    }
    onChange([...selected, label])
  }

  const create = async (name: string) => {
    setPending(true)
    let created: Label | null
    try {
      created = await onCreate(name, colorFor(name))
    } finally {
      setPending(false)
    }
    if (!created) {
      setError("作成できませんでした。ログを確認してください。")
      return
    }
    // 作っただけで付かないと「作成したのに反映されない」に見える。
    onChange([...selected, created])
    setCreating(null)
  }

  /** 親カテゴリの増減。カテゴリ設定を開かずにここで決められるようにする。 */
  const designate = async (name: string) => {
    if (!onDesignate) return
    setError(null)
    setPending(true)
    try {
      await onDesignate(
        parentLabels.includes(name)
          ? parentLabels.filter((n) => n !== name)
          : [...parentLabels, name],
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="zk-field">
      <span className="zk-field-label">Parent category</span>

      {/* 親カテゴリが 1 つも決まっていないと、これまではこの欄ごと出なかった。
          「設定できない」のか「設定する場所が別にある」のかが読めないので、
          未設定でも欄は出し、ここから決められるようにする。 */}
      {parentLabels.length === 0 && (
        <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
          親カテゴリはまだ決まっていません。下の「親カテゴリを選ぶ」から、
          上位のまとまりとして扱うラベルを選んでください。
        </span>
      )}

      <div className="zk-label-picker zk-label-picker--parents">
        {parentLabels.map((name) => {
          const on = selectedNames.has(name)
          const known = resolve(name) !== null
          return (
            <button
              type="button"
              key={name}
              className="zk-chip zk-chip--button"
              aria-pressed={on}
              disabled={busy || pending}
              title={
                known
                  ? "このラベルの付け外しになります"
                  : `${name} はこの Issue のリポジトリにまだありません。押すと作成できます。`
              }
              onClick={() => toggle(name)}
              style={on ? { borderColor: `#${colorFor(name)}`, color: `#${colorFor(name)}` } : undefined}
            >
              <span className="zk-legend-dot" style={{ background: `#${colorFor(name)}` }} />
              {name}
              {/* このリポジトリに無いことは、押す前に分かるようにしておく。 */}
              {!known && <span className="zk-chip-note">＋</span>}
            </button>
          )
        })}
      </div>

      {creating !== null && (
        <div className="zk-label-confirm">
          <span>
            {creating} はこのリポジトリにありません。作成して付けますか
          </span>
          <button
            type="button"
            className="zk-button"
            disabled={pending}
            onClick={() => create(creating)}
          >
            {pending ? "作成中…" : "作成して付ける"}
          </button>
          <button
            type="button"
            className="zk-button"
            disabled={pending}
            onClick={() => setCreating(null)}
          >
            やめる
          </button>
        </div>
      )}

      {error && <span className="zk-label-confirm">{error}</span>}

      {onDesignate && (
        <>
          <button
            type="button"
            className="zk-chip zk-chip--button"
            aria-pressed={designating}
            disabled={busy || pending}
            style={{ alignSelf: "start" }}
            onClick={() => setDesignating((v) => !v)}
          >
            {designating ? "閉じる" : "親カテゴリを選ぶ…"}
          </button>
          {designating && (
            <>
              <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
                どのラベルを上位のまとまりとして扱うかを決めます。GitHub 上では
                これまでどおり普通のラベルのままで、書き換えは行いません。
              </span>
              <div className="zk-label-picker">
                {labelCatalog.length === 0 ? (
                  <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
                    ラベルがありません。Issue にラベルを付けると候補に出ます。
                  </span>
                ) : (
                  labelCatalog.map((label) => (
                    <button
                      type="button"
                      key={label.name}
                      className="zk-chip zk-chip--button"
                      aria-pressed={parentLabels.includes(label.name)}
                      disabled={busy || pending}
                      onClick={() => designate(label.name)}
                    >
                      <span
                        className="zk-legend-dot"
                        style={{ background: label.color ? `#${label.color}` : "currentColor" }}
                      />
                      {label.name}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}

      <span className="zk-field-value zk-muted" style={{ fontSize: 11 }}>
        選んだ親カテゴリは、そのラベルとして Issue に付きます。複数選ぶと
        Category 表示では「A + B」のまとまりになります。
      </span>
    </div>
  )
}
