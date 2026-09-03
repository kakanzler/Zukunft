"use client"

import { useState } from "react"
import type { FilterChoices, TaskFilter } from "@zukunft/domain"
import { EMPTY_FILTER, isFilterActive } from "@zukunft/domain"

type Props = {
  filter: TaskFilter
  choices: FilterChoices
  /** 絞り込んだ結果の件数と、絞る前の件数 */
  shown: number
  total: number
  onChange: (filter: TaskFilter) => void
}

/** 軸ごとの見出しと、その軸が持つ値の取り出し方。 */
const AXES: { key: keyof FilterChoices; label: string; field: keyof TaskFilter }[] = [
  { key: "statuses", label: "Status", field: "statuses" },
  { key: "labels", label: "ラベル", field: "labels" },
  { key: "assignees", label: "担当", field: "assignees" },
  { key: "milestones", label: "Milestone", field: "milestones" },
]

/**
 * 一覧の絞り込み。
 *
 * 常に開いていると盤面の高さを取るので、既定は 1 行に畳んでおく。ただし
 * **絞り込み中はその事実を必ず出す** — 出ないタスクを「消えた」と誤解されると、
 * 同じ Issue をもう一度作られてしまう。
 */
export function FilterBar({ filter, choices, shown, total, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const active = isFilterActive(filter)

  const toggle = (field: keyof TaskFilter, value: string) => {
    const current = filter[field] as string[]
    onChange({
      ...filter,
      [field]: current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    })
  }

  return (
    <div className="zk-filter">
      <div className="zk-filter-row">
        <input
          className="zk-input zk-filter-text"
          value={filter.text}
          placeholder="番号かタイトルで絞り込む（/）"
          aria-label="絞り込み"
          data-zk-filter-input="true"
          onChange={(e) => onChange({ ...filter, text: e.target.value })}
        />
        <button
          className="zk-button"
          aria-pressed={open}
          onClick={() => setOpen((v) => !v)}
        >
          条件{open ? " ▲" : " ▼"}
        </button>
        <label className="zk-filter-closed">
          <input
            type="checkbox"
            checked={!filter.includeClosed}
            onChange={(e) => onChange({ ...filter, includeClosed: !e.target.checked })}
          />
          閉じた Issue を隠す
        </label>
        {/* 絞られていることが分かる状態を、畳んでいても画面に残す。 */}
        <span className="zk-filter-count">
          {active ? `表示 ${shown} / 全 ${total}` : `${total} 件`}
        </span>
        {active && (
          <button className="zk-button" onClick={() => onChange(EMPTY_FILTER)}>
            絞り込みを解除
          </button>
        )}
      </div>

      {open && (
        <div className="zk-filter-axes">
          {AXES.map((axis) => {
            const values = choices[axis.key]
            if (values.length === 0) return null
            const selected = filter[axis.field] as string[]
            return (
              <div className="zk-filter-axis" key={axis.key}>
                <span className="zk-field-label">{axis.label}</span>
                <div className="zk-label-picker">
                  {values.map((value) => (
                    <button
                      type="button"
                      key={value}
                      className="zk-chip zk-chip--button"
                      aria-pressed={selected.includes(value)}
                      onClick={() => toggle(axis.field, value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
