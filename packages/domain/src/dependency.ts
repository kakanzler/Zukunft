import type { ScheduleTask } from "./schedule"

/**
 * Issue 間の依存関係（企画書 §15.1）。
 *
 * 保存先は Issue 本文。Projects v2 のテキストフィールドに持つ案もあったが、
 * そちらは Project の設定に手を入れないと使えない。本文なら GitHub の画面でも
 * そのまま読めて、このアプリを使わない人にも伝わる。
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

/** 番号を並べるときの区切り。書き出しはこの形に揃える。 */
const CANONICAL_PREFIX = "blocked-by: "

/**
 * 本文を行に分け、囲みコードの中かどうかを添える。
 *
 * 読み取りと書き換えで同じ判定を使うためにここへ集約する。片方だけが囲みを
 * 見ていると、読めない宣言を書き換える（またはその逆）ことになる。
 */
function linesWithFence(body: string): { text: string; fenced: boolean }[] {
  let inFence = false
  return body.split("\n").map((text) => {
    if (/^\s*```/.test(text)) {
      // 囲みの開始行・終了行そのものも「中」として扱う。宣言が書かれることはない。
      inFence = !inFence
      return { text, fenced: true }
    }
    return { text, fenced: inFence }
  })
}

function refsIn(text: string): number[] {
  const numbers: number[] = []
  for (const match of text.matchAll(DEPENDENCY_PATTERN)) {
    for (const ref of match[1]!.matchAll(/[#＃](\d+)/g)) {
      const number = Number(ref[1])
      if (Number.isFinite(number)) numbers.push(number)
    }
  }
  return numbers
}

/** 本文から依存先の Issue 番号を取り出す。出現順、重複は畳む。 */
export function parseDependencyRefs(body: string): number[] {
  const numbers: number[] = []
  for (const line of linesWithFence(body)) {
    // 囲みコードの中は書き方の説明であることが多いので、宣言としては読まない。
    if (line.fenced) continue
    for (const number of refsIn(line.text)) {
      if (!numbers.includes(number)) numbers.push(number)
    }
  }
  return numbers
}

/**
 * 本文の依存関係の宣言を、指定した番号の集合で置き換える（企画書 §15.1）。
 *
 * 宣言だけを差し替え、本文の他の部分には触らない。Issue の本文はミューテーション
 * で丸ごと置き換わるため、書き戻すのは「元の本文＋新しい宣言」でなければならない。
 *
 * 宣言は行の途中に書かれていることもあるので、行ごと消すのではなく該当部分だけを
 * 取り除く。取り除いた結果が空になった行は落とす（宣言だけの行だったということ）。
 * 新しい宣言は、最初に宣言があった位置へ入れる。書いた場所が動かないほうが、
 * 保存のたびに本文が組み変わるより読みやすい。
 */
export function withDependencyRefs(body: string, numbers: number[]): string {
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  const declaration = CANONICAL_PREFIX + unique.map((n) => `#${n}`).join(", ")

  const lines = linesWithFence(body)
  const kept: { text: string; fenced: boolean }[] = []
  let insertAt = -1
  let dropped = false

  for (const line of lines) {
    if (line.fenced || refsIn(line.text).length === 0) {
      kept.push(line)
      continue
    }
    if (insertAt < 0) insertAt = kept.length
    const stripped = line.text.replace(DEPENDENCY_PATTERN, "").trim()
    // 宣言だけの行は落とす。何か書いてあった行は、宣言を抜いた残りを保つ。
    if (stripped === "") dropped = true
    else kept.push({ text: stripped, fenced: false })
  }

  const rest = kept.map((line) => line.text)

  // 宣言を消しただけだと、その前後の空行が隣り合って空きが二重になる。畳むのは
  // 消したときだけ — 書き換えるときは同じ場所に新しい宣言が入るので空きは戻る。
  // 依存関係とは関係なく空行を 2 つ空けてある本文を、保存のたびに詰めたくもない。
  if (unique.length === 0) {
    return (dropped ? collapseBlankRuns(kept) : rest).join("\n")
  }

  if (insertAt < 0) {
    // 宣言が無かった本文。末尾に空行を 1 つ挟んでから足す。
    const tail = rest.length === 0 || rest[rest.length - 1]!.trim() === "" ? [] : [""]
    return [...rest, ...tail, declaration].join("\n")
  }
  return [...rest.slice(0, insertAt), declaration, ...rest.slice(insertAt)].join("\n")
}

/** 連続する空行を 1 つに畳む。囲みコードの中はそのまま。 */
function collapseBlankRuns(lines: { text: string; fenced: boolean }[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const blank = !line.fenced && line.text.trim() === ""
    if (blank && out.length > 0 && out[out.length - 1]!.trim() === "") continue
    out.push(line.text)
  }
  return out
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
