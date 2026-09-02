import type { ScheduleTask } from "./schedule"

/**
 * Issue 間の依存関係（企画書 §15.1）。
 *
 * 保存先は企画書では未決だが、Projects v2 のテキストフィールドを 1 本増やすと
 * Project の設定に手を入れないと使えなくなる。ここでは Issue 本文に書く案を採る。
 * 本文なら GitHub の画面でもそのまま読めて、このアプリを使わない人にも伝わる。
 */
export type Dependency = {
  /** 依存している側（本文に blocked-by を書いた Issue）のタスク id */
  fromTaskId: string
  /** 依存先。先に片付いている必要がある Issue のタスク id */
  toTaskId: string
}

/**
 * 依存関係を宣言する書き方。
 *
 * `blocked-by: #101, #102` のような 1 行を想定するが、日本語で書く人もいるので
 * 「依存: #101」も拾う。番号は全角の ＃ も受ける — 日本語入力のまま打つと
 * そちらになるため、書けているのに繋がらない、を避ける。
 */
const DEPENDENCY_PATTERN =
  /(?:blocked[-\s]?by|depends?[-\s]?on|依存(?:先|関係)?)\s*[:：]?\s*((?:[#＃]\d+[\s,、・]*)+)/gi

/** 本文から依存先の Issue 番号を取り出す。出現順、重複は畳む。 */
export function parseDependencyRefs(body: string): number[] {
  // 囲みコードの中は書き方の説明であることが多いので、宣言としては読まない。
  const text = body.replace(/```[\s\S]*?```/g, " ")
  const numbers: number[] = []
  for (const match of text.matchAll(DEPENDENCY_PATTERN)) {
    for (const ref of match[1]!.matchAll(/[#＃](\d+)/g)) {
      const number = Number(ref[1])
      if (Number.isFinite(number) && !numbers.includes(number)) numbers.push(number)
    }
  }
  return numbers
}

/**
 * 本文の宣言を、この Project に載っているタスク同士の辺に解決する。
 *
 * Project には複数のリポジトリの Issue が並びうるので、番号だけでは一意に決まらない。
 * まず同じリポジトリの中で引き、そこに無いときだけ、Project 全体で番号が
 * 1 つに定まる場合に限って引く。当てずっぽうで別リポジトリの同じ番号に
 * 繋いでしまうと、線が出ているのに関係が嘘、という最悪の状態になる。
 */
export function resolveDependencies(tasks: ScheduleTask[]): Dependency[] {
  const byRepo = new Map<string, Map<number, ScheduleTask>>()
  const byNumber = new Map<number, ScheduleTask[]>()
  for (const task of tasks) {
    const repo = byRepo.get(task.repositoryId) ?? new Map<number, ScheduleTask>()
    repo.set(task.issueNumber, task)
    byRepo.set(task.repositoryId, repo)
    byNumber.set(task.issueNumber, [...(byNumber.get(task.issueNumber) ?? []), task])
  }

  const dependencies: Dependency[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    for (const number of parseDependencyRefs(task.body)) {
      const sameRepo = byRepo.get(task.repositoryId)?.get(number)
      const candidates = byNumber.get(number)
      const target = sameRepo ?? (candidates?.length === 1 ? candidates[0] : undefined)
      // 自分自身への依存と、Project に載っていない Issue への参照は線にしない。
      if (!target || target.id === task.id) continue
      const key = `${task.id}>${target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      dependencies.push({ fromTaskId: task.id, toTaskId: target.id })
    }
  }
  return dependencies
}
