"use client"

import { useEffect, useMemo } from "react"
import type { Mutation, MutationState, ScheduleTask } from "@zukunft/domain"

type Props = {
  queue: Mutation[]
  tasks: ScheduleTask[]
  /** 取り消し。グループのどれか 1 件の id を渡せば、操作 1 回分がまとめて戻る */
  onRollback: (mutationId: string) => void
  onClose: () => void
}

/** 送信の段階。利用者が次に何をすればいいかで言い分ける。 */
const STATE_LABEL: Record<MutationState, string> = {
  pending: "送信待ち",
  syncing: "送信中",
  failed: "失敗",
  conflict: "競合",
}

/**
 * 操作 1 回ぶんのまとまり。
 *
 * 依存に合わせた自動調整は 1 ドラッグで複数のタスクを動かすので、ミューテーション
 * 1 件ずつ並べると、利用者が 1 回動かしただけの操作が 5 行にも見える。
 * groupId でまとめ、「その操作で何が動いたか」の単位で見せる。
 */
type Group = {
  id: string
  members: Mutation[]
  /** グループ全体の段階。手を打つ必要のある方を代表にする */
  state: MutationState
}

const SEVERITY: MutationState[] = ["conflict", "failed", "syncing", "pending"]

function groupMutations(queue: Mutation[]): Group[] {
  const byGroup = new Map<string, Mutation[]>()
  for (const m of queue) {
    const members = byGroup.get(m.groupId)
    if (members) members.push(m)
    else byGroup.set(m.groupId, [m])
  }
  return [...byGroup.entries()].map(([id, members]) => ({
    id,
    members,
    state: SEVERITY.find((s) => members.some((m) => m.state === s)) ?? "pending",
  }))
}

function formatDates(d: { startDate: string | null; endDate: string | null }): string {
  // 片方だけ入っている状態は実際にある（開始だけ決まっている、など）。
  // 「—」で埋めて、両方見えている形を崩さない。
  return `${d.startDate ?? "—"} 〜 ${d.endDate ?? "—"}`
}

/**
 * 送信待ちの変更の一覧（企画書 §16.2）。
 *
 * 日付は楽観的に盤面へ反映されるので、送る前に「何がどう変わって送られようと
 * しているか」を確かめる場所がどこにも無かった。失敗して初めてログに取り消しの
 * ボタンが出る作りだったため、送信が通ってしまう前に止める手段が無い。
 */
export function PendingChanges({ queue, tasks, onRollback, onClose }: Props) {
  const groups = useMemo(() => groupMutations(queue), [queue])
  const titleOf = useMemo(() => {
    const map = new Map(tasks.map((t) => [t.id, t]))
    return (taskId: string) => {
      const task = map.get(taskId)
      // 再読み込みと入れ違うと、送信待ちのタスクが一覧から消えていることがある。
      // 行ごと落とすと取り消せなくなるので、番号が引けなくても行は残す。
      return task ? `#${task.issueNumber} ${task.title}` : "(一覧にないタスク)"
    }
  }, [tasks])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="保留中の変更"
    >
      <div className="zk-modal zk-modal--pending">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>保留中の変更</div>
          <button className="zk-button" onClick={onClose} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-modal-body">
          {groups.length === 0 ? (
            <div className="zk-pending-empty">送信待ちの変更はありません。</div>
          ) : (
            <div className="zk-pending-list">
              {groups.map((group) => (
                <div className="zk-pending-group" key={group.id}>
                  <div className="zk-pending-head">
                    <span className={`zk-pending-state zk-pending-state--${group.state}`}>
                      {STATE_LABEL[group.state]}
                    </span>
                    <span className="zk-pending-count">
                      {group.members.length > 1
                        ? `1 回の操作で ${group.members.length} 件`
                        : "1 件"}
                    </span>
                    <button
                      className="zk-button zk-button--danger"
                      onClick={() => onRollback(group.members[0]!.id)}
                    >
                      取り消す
                    </button>
                  </div>

                  {group.state === "syncing" && (
                    <div className="zk-pending-note">
                      送信中のものは止められません。取り消すと盤面は元に戻りますが、
                      GitHub 側は送信が通ることがあります。ずれは次の再読み込みで揃います。
                    </div>
                  )}

                  <div className="zk-pending-rows">
                    {group.members.map((m) => (
                      <div className="zk-pending-row" key={m.id}>
                        <span className="zk-pending-task">{titleOf(m.taskId)}</span>
                        <span className="zk-pending-dates">
                          <span className="zk-pending-before">{formatDates(m.before)}</span>
                          <span className="zk-pending-arrow">→</span>
                          <span className="zk-pending-after">{formatDates(m.after)}</span>
                        </span>
                        {m.error && <span className="zk-pending-error">{m.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="zk-modal-foot">
          <span className="zk-pending-foot-note">
            送信は自動で進みます。取り消しは操作 1 回ぶんをまとめて戻します。
          </span>
          <button className="zk-button" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
