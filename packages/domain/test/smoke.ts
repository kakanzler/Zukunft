import {
  addDays, addYears, diffDays, inclusiveDays, startOfWeek, startOfNextMonth,
  createTimeScale, timelineRange, defaultTimelineEnd, monthTicks, subTicks, today,
  hitTest, applyDrag, diffDates,
  computeStats, groupByStatus, groupByLabel, groupByParentLabel, groupTasks, missingRequiredFields,
  initialState, applyLocalChange, markSyncing, markSynced, markFailed, markConflict,
  rollback, resolveWithRemote, resolveWithLocal, nextPending, pendingCount,
  undo, redo, canUndo, canRedo, mergeRefresh, findTask,
  normalizeFieldName, resolveField, canEditDates,
  parseDependencyRefs, resolveDependencies, withDependencyRefs,
  detectCycles, formatCycle, edgeKey, cascade, applyChangeWithCascade,
  type ScheduleTask, type ProjectSchema,
} from "../src/index"

let failures = 0
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${label}: got ${a}, want ${e}`) }
  else console.log(`ok   ${label}`)
}

// --- date ---
eq("addDays across month", addDays("2026-08-30", 3), "2026-09-02")
eq("diffDays", diffDays("2026-09-01", "2026-09-10"), 9)
eq("inclusiveDays same day", inclusiveDays("2026-09-01", "2026-09-01"), 1)
eq("startOfWeek sunday->prev monday", startOfWeek("2026-09-06"), "2026-08-31")
eq("startOfWeek monday is itself", startOfWeek("2026-08-31"), "2026-08-31")
eq("startOfNextMonth december", startOfNextMonth("2026-12-15"), "2027-01-01")
eq("addYears", addYears("2026-09-02", 1), "2027-09-02")
// 「今日」はローカルの暦日。UTC で見ると JST の朝は前日になり、盤面が 1 日ずれる。
eq("today uses the local calendar day", today(new Date(2026, 8, 3, 0, 30)), "2026-09-03")
eq("today pads single digits", today(new Date(2026, 0, 5, 23, 59)), "2026-01-05")

// --- timescale ---
const scale = createTimeScale("2026-09-01", "2026-09-30", "week")
eq("scale width", scale.width, 30 * 12)
eq("toX origin", scale.toX("2026-09-01"), 0)
eq("toX +10d", scale.toX("2026-09-11"), 120)
eq("toDate rounds to day", scale.toDate(125), "2026-09-11")
eq("toDays rounds", scale.toDays(30), 3)
eq("range pads to week start", timelineRange(["2026-09-10"], "2026-09-01").origin, "2026-08-31")
eq("default end falls back to one year out", defaultTimelineEnd([], "2026-09-02"), "2027-09-02")
eq(
  "default end keeps the horizon when active issues end sooner",
  defaultTimelineEnd(["2026-10-01", "2027-01-15"], "2026-09-02"),
  "2027-09-02",
)
eq(
  "default end stretches past the horizon for a longer active issue",
  defaultTimelineEnd(["2026-10-01", "2028-03-31"], "2026-09-02"),
  "2028-03-31",
)
eq("month ticks count", monthTicks(scale).length, 1)
eq("week subticks label", subTicks(scale)[0]!.label, "WEEK 1")

// --- drag ---
eq("hitTest left edge", hitTest(3, 100), "resize-start")
eq("hitTest middle", hitTest(50, 100), "move")
eq("hitTest right edge", hitTest(96, 100), "resize-end")
eq("hitTest narrow bar is move", hitTest(2, 20), "move")

const task = {
  startDate: "2026-09-01", endDate: "2026-09-10",
} as unknown as Parameters<typeof applyDrag>[0]
eq("move +4", applyDrag(task, "move", 4), { startDate: "2026-09-05", endDate: "2026-09-14" })
eq("resize-start clamps to 1 day", applyDrag(task, "resize-start", 99), { startDate: "2026-09-10", endDate: "2026-09-10" })
eq("resize-end clamps to 1 day", applyDrag(task, "resize-end", -99), { startDate: "2026-09-01", endDate: "2026-09-01" })
eq("diffDates no change", diffDates(
  { startDate: "2026-09-01", endDate: "2026-09-10" },
  { startDate: "2026-09-01", endDate: "2026-09-10" }), null)
eq("diffDates start only", diffDates(
  { startDate: "2026-09-01", endDate: "2026-09-10" },
  { startDate: "2026-09-03", endDate: "2026-09-10" }), { startDate: "2026-09-03" })

// --- stats ---
const mk = (n: number, s: string, start: string, end: string, prog: number | null): ScheduleTask => ({
  id: `i${n}`, issueId: `gh${n}`, repositoryId: "repo", issueNumber: n, title: `T${n}`, body: "", url: "", issueState: "OPEN", startDate: start, endDate: end,
  status: s, priority: null, assignees: [], labels: [], milestone: { id: "ms-1", title: "v1", dueOn: "2026-09-30" },
  progress: prog, updatedAt: "2026-08-01T00:00:00Z", syncState: "synced",
  labelsComplete: true, fieldsComplete: true,
})
const tasks = [mk(1, "Planning", "2026-09-01", "2026-09-07", 100), mk(2, "Review", "2026-09-08", "2026-09-21", 0)]
eq("stats", computeStats(tasks), { taskCount: 2, weekCount: 3, milestoneCount: 1, completePercent: 50 })
eq("groupByStatus order", groupByStatus(tasks, ["Planning", "In Progress", "Review"]).map(g => g.label), ["PLANNING", "REVIEW"])

// --- Category 表示（ラベルの組み合わせでのグループ化） ---
{
  const withLabels: ScheduleTask[] = [
    { ...mk(1, "Planning", "2026-09-01", "2026-09-05", null),
      labels: [{ id: "l-design", name: "design", color: "a855f7" }] },
    { ...mk(2, "Review", "2026-09-02", "2026-09-06", null),
      labels: [
        { id: "l-backend", name: "backend", color: "0e8a16" },
        { id: "l-design", name: "design", color: "a855f7" },
      ] },
    { ...mk(3, "Planning", "2026-09-03", "2026-09-07", null), labels: [] },
    // #2 と同じ組み合わせだが GitHub が返す並びが逆のケース。
    { ...mk(4, "Review", "2026-09-04", "2026-09-08", null),
      labels: [
        { id: "l-design", name: "design", color: "a855f7" },
        { id: "l-backend", name: "backend", color: "0e8a16" },
      ] },
  ]
  const groups = groupByLabel(withLabels)
  eq("combinations are grouped alphabetically, unlabeled last",
     groups.map(g => g.label), ["BACKEND + DESIGN", "DESIGN", "NO LABEL"])
  eq("label order on the issue does not split the group",
     groups[0]!.tasks.map(t => t.issueNumber), [2, 4])
  eq("a single-label issue does not join the combination",
     groups[1]!.tasks.map(t => t.issueNumber), [1])
  eq("unlabeled issues are collected", groups[2]!.tasks.map(t => t.issueNumber), [3])
  // 重複しないことの直接の確認。ラベルごとに分けていた頃は 5 になっていた。
  eq("every issue appears exactly once",
     groups.reduce((n, g) => n + g.tasks.length, 0), withLabels.length)
  eq("group carries the first label's colour", groups[0]!.color, "#0e8a16")
  eq("no-label group has no colour", groups[2]!.color, undefined)
  eq("groupTasks dispatches on mode",
     groupTasks(withLabels, "label", []).length, groups.length)
  eq("groupTasks status mode still works",
     groupTasks(withLabels, "status", ["Planning", "Review"]).map(g => g.label),
     ["PLANNING", "REVIEW"])
}

// --- 親カテゴリ（Category 表示の 2 階層化） ---
{
  const cert = { id: "l-cert", name: "Certification", color: "f0cc19" }
  const ccar = { id: "l-ccar", name: "CCAR-F", color: "ff4d00" }
  const math = { id: "l-math", name: "Math", color: "0e8a16" }
  const claude = { id: "l-claude", name: "Claude", color: "fb4e04" }

  const tasks: ScheduleTask[] = [
    { ...mk(1, "Planning", "2026-09-01", "2026-09-05", null), labels: [cert, ccar] },
    { ...mk(2, "Review", "2026-09-02", "2026-09-06", null), labels: [ccar, cert] },
    { ...mk(3, "Planning", "2026-09-03", "2026-09-07", null), labels: [cert, math] },
    { ...mk(4, "Review", "2026-09-04", "2026-09-08", null), labels: [ccar] },
    { ...mk(5, "Planning", "2026-09-05", "2026-09-09", null), labels: [] },
    // 親を 2 つ持つ Issue。組み合わせで 1 つの親グループになる。
    { ...mk(6, "Review", "2026-09-06", "2026-09-10", null), labels: [claude, cert] },
  ]
  const groups = groupByParentLabel(tasks, ["Certification", "Claude"])

  eq("parents are sorted, orphans last",
     groups.map(g => g.label), ["CERTIFICATION", "CERTIFICATION + CLAUDE", "その他"])
  eq("parent counts every task below it", groups.map(g => g.tasks.length), [3, 1, 2])
  eq("children group by the remaining labels",
     groups[0]!.groups!.map(g => g.label), ["CCAR-F", "MATH"])
  eq("the parent label is dropped from the child name",
     groups[1]!.groups!.map(g => g.label), ["NO LABEL"])
  eq("a task without any parent label falls to その他",
     groups[2]!.tasks.map(t => t.issueNumber), [4, 5])
  eq("leaf tasks add up to the issue count",
     groups.reduce((n, g) => n + g.groups!.reduce((m, c) => m + c.tasks.length, 0), 0),
     tasks.length)
  eq("parent colour comes from the first parent label", groups[0]!.color, "#f0cc19")
  eq("no groups without parent labels configured",
     groupTasks(tasks, "label", []).every(g => g.groups === undefined), true)
  eq("no parent labels keeps the flat grouping",
     groupTasks(tasks, "label", []).map(g => g.label),
     groupByLabel(tasks).map(g => g.label))
  eq("groupTasks nests once parents are given",
     groupTasks(tasks, "label", [], ["Certification", "Claude"]).map(g => g.label),
     groups.map(g => g.label))
  eq("status mode ignores parent labels",
     groupTasks(tasks, "status", ["Planning", "Review"], ["Certification"]).map(g => g.label),
     ["PLANNING", "REVIEW"])
}

// --- schema validation ---
const schema: ProjectSchema = { projectId: "p", fields: [
  { id: "f1", name: "Status", dataType: "SINGLE_SELECT", options: [] },
  { id: "f2", name: "Start Date", dataType: "DATE", options: [] },
]}
eq("missing Target Date", missingRequiredFields(schema).map(f => f.name), ["Target Date"])

// --- フィールド名の表記ゆれ（GitHub 上では "Start date" のように書かれる） ---
eq("normalize drops case and spaces", normalizeFieldName("Start date"), "startdate")
eq("normalize drops underscores", normalizeFieldName("target_date"), "targetdate")

const looseSchema: ProjectSchema = { projectId: "p", fields: [
  { id: "f1", name: "status", dataType: "SINGLE_SELECT", options: [{ id: "o", name: "Todo" }] },
  { id: "f2", name: "Start date", dataType: "DATE", options: [] },
  { id: "f3", name: "End date", dataType: "DATE", options: [] },
]}
eq("loose names satisfy requirements", missingRequiredFields(looseSchema), [])
eq("loose names allow editing", canEditDates(looseSchema), true)
eq("resolve picks the start field", resolveField(looseSchema, "startDate", "DATE")!.id, "f2")
eq("resolve picks the end field", resolveField(looseSchema, "endDate", "DATE")!.id, "f3")

// 名前は合っているが型が違う場合は「不足」として扱う
const wrongType: ProjectSchema = { projectId: "p", fields: [
  { id: "f1", name: "Status", dataType: "SINGLE_SELECT", options: [] },
  { id: "f2", name: "Start Date", dataType: "TEXT", options: [] },
  { id: "f3", name: "Target Date", dataType: "DATE", options: [] },
]}
eq("wrong type counts as missing", missingRequiredFields(wrongType).map(f => f.name), ["Start Date"])
eq("wrong type blocks editing", canEditDates(wrongType), false)
// --- store: 楽観的更新とキュー（§16.2） ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-03" }, "m1")
  eq("local change applied", findTask(st, "i1")!.startDate, "2026-09-03")
  eq("marked pending", findTask(st, "i1")!.syncState, "pending")
  eq("queued", pendingCount(st), 1)
  eq("undo recorded", canUndo(st), true)
  eq("next pending is m1", nextPending(st)!.id, "m1")

  st = markSyncing(st, "m1")
  eq("syncing state", findTask(st, "i1")!.syncState, "syncing")
  eq("same task not sent twice", nextPending(st), null)

  const remote = { ...mk(1, "Planning", "2026-09-03", "2026-09-07", null), updatedAt: "2026-09-02T00:00:00Z" }
  st = markSynced(st, "m1", remote)
  eq("synced clears queue", pendingCount(st), 0)
  eq("synced adopts remote updatedAt", findTask(st, "i1")!.updatedAt, "2026-09-02T00:00:00Z")
}

// --- store: 失敗とロールバック（§16.2 手順 4） ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { endDate: "2026-09-20" }, "m1")
  st = markFailed(st, "m1", "boom")
  eq("failed state", findTask(st, "i1")!.syncState, "failed")
  st = rollback(st, "m1")
  eq("rollback restores endDate", findTask(st, "i1")!.endDate, "2026-09-07")
  eq("rollback clears queue", pendingCount(st), 0)
  eq("rollback drops undo entry", canUndo(st), false)
}

// --- store: 競合（§16.3） ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { endDate: "2026-09-10" }, "m1")
  const remote = { ...mk(1, "Planning", "2026-09-01", "2026-09-12", null), updatedAt: "2026-09-05T00:00:00Z" }
  st = markConflict(st, "m1", remote, "changed upstream")
  eq("conflict state", findTask(st, "i1")!.syncState, "conflict")
  eq("conflict not counted as pending work", pendingCount(st), 0)

  const withRemote = resolveWithRemote(st, "m1")
  eq("resolve with remote takes github value", findTask(withRemote, "i1")!.endDate, "2026-09-12")

  const withLocal = resolveWithLocal(st, "m1", "m2")
  eq("resolve with local re-queues", nextPending(withLocal)!.id, "m2")
  eq("retry uses remote updatedAt as base", nextPending(withLocal)!.expectedUpdatedAt, "2026-09-05T00:00:00Z")
  eq("resolve with local keeps local value", findTask(withLocal, "i1")!.endDate, "2026-09-10")
}

// --- store: Undo / Redo（§6.3.4） ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-05", endDate: "2026-09-11" }, "m1")
  st = undo(st, () => "m2")
  eq("undo restores dates", [findTask(st, "i1")!.startDate, findTask(st, "i1")!.endDate], ["2026-09-01", "2026-09-07"])
  eq("undo issues a new mutation", nextPending(st)!.id, "m2")
  eq("undo enables redo", canRedo(st), true)
  st = redo(st, () => "m3")
  eq("redo reapplies", findTask(st, "i1")!.startDate, "2026-09-05")
  eq("redo re-enables undo", canUndo(st), true)
}

// --- store: 未送信の変更は畳み込む（往復の無駄と偽の競合を避ける） ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-03", endDate: "2026-09-09" }, "m1")
  st = applyLocalChange(st, "i1", { startDate: "2026-09-05", endDate: "2026-09-11" }, "m2")
  eq("coalesced into one mutation", pendingCount(st), 1)
  const m = nextPending(st)!
  eq("coalesced keeps newest id", m.id, "m2")
  eq("coalesced rolls back to the original value", m.before, { startDate: "2026-09-01", endDate: "2026-09-07" })
  eq("coalesced targets the newest value", m.after, { startDate: "2026-09-05", endDate: "2026-09-11" })
  st = rollback(st, "m2")
  eq("rollback after coalescing restores the original", findTask(st, "i1")!.startDate, "2026-09-01")
}

// --- store: 送信中の変更は畳み込まない ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null)])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-03" }, "m1")
  st = markSyncing(st, "m1")
  st = applyLocalChange(st, "i1", { startDate: "2026-09-06" }, "m2")
  eq("in-flight mutation is left alone", pendingCount(st), 2)
}

// --- store: 日付が未設定のタスクにも日程を入れられる ---
{
  const undated: ScheduleTask = {
    ...mk(1, "Planning", "2026-09-01", "2026-09-07", null),
    startDate: null, endDate: null,
  }
  let st = initialState([undated])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-03", endDate: "2026-09-09" }, "m1")
  eq("undated task accepts a start date", findTask(st, "i1")!.startDate, "2026-09-03")
  eq("undated task accepts an end date", findTask(st, "i1")!.endDate, "2026-09-09")
  eq("undated task queues a mutation", nextPending(st)!.id, "m1")
  eq("mutation carries both dates", nextPending(st)!.change, { startDate: "2026-09-03", endDate: "2026-09-09" })
  // 元の「未設定」へ戻す手段が無いので Undo には積まない
  eq("initial scheduling is not undoable", canUndo(st), false)

  st = rollback(st, "m1")
  eq("rollback returns to undated", findTask(st, "i1")!.startDate, null)
}

// --- store: 再取得は未送信の変更を残す ---
{
  let st = initialState([mk(1, "Planning", "2026-09-01", "2026-09-07", null), mk(2, "Review", "2026-09-02", "2026-09-08", null)])
  st = applyLocalChange(st, "i1", { startDate: "2026-09-04" }, "m1")
  st = mergeRefresh(st, [mk(1, "Planning", "2026-09-01", "2026-09-07", null), mk(2, "Review", "2026-09-15", "2026-09-20", null)])
  eq("dirty task keeps local edit", findTask(st, "i1")!.startDate, "2026-09-04")
  eq("clean task takes refreshed value", findTask(st, "i2")!.startDate, "2026-09-15")
}

// --- dependency: 本文の宣言から辺を起こす ---
{
  eq("parses blocked-by", parseDependencyRefs("blocked-by: #101"), [101])
  eq("parses a list", parseDependencyRefs("blocked by #101, #102、#103"), [101, 102, 103])
  eq("parses depends-on and japanese", parseDependencyRefs("depends on #7\n依存: ＃8"), [7, 8])
  eq("dedupes", parseDependencyRefs("blocked-by: #5\ndepends-on: #5"), [5])
  eq("ignores fenced code", parseDependencyRefs("```\nblocked-by: #9\n```"), [])
  eq("ignores a bare issue link", parseDependencyRefs("#101 も参照"), [])

  const graph: ScheduleTask[] = [
    mk(1, "Planning", "2026-09-01", "2026-09-05", null),
    { ...mk(2, "Review", "2026-09-06", "2026-09-10", null), body: "blocked-by: #1" },
    { ...mk(3, "Review", "2026-09-11", "2026-09-15", null), body: "blocked-by: #2, #99" },
  ]
  eq("resolves declared edges", resolveDependencies(graph), [
    { fromTaskId: "i2", toTaskId: "i1" },
    { fromTaskId: "i3", toTaskId: "i2" },
  ])

  // Project に複数のリポジトリが載っていても、別リポジトリの同じ番号には繋がない
  const crossRepo: ScheduleTask[] = [
    { ...mk(1, "Planning", "2026-09-01", "2026-09-05", null), repositoryId: "other" },
    { ...mk(1, "Planning", "2026-09-01", "2026-09-05", null), id: "x1", repositoryId: "repo" },
    { ...mk(2, "Review", "2026-09-06", "2026-09-10", null), repositoryId: "repo", body: "blocked-by: #1" },
  ]
  eq("prefers the same repository", resolveDependencies(crossRepo), [
    { fromTaskId: "i2", toTaskId: "x1" },
  ])

  eq("drops self reference", resolveDependencies([
    { ...mk(1, "Planning", "2026-09-01", "2026-09-05", null), body: "blocked-by: #1" },
  ]), [])
}

// --- dependency: 本文への書き戻し ---
{
  const body = "作業内容。\n\nblocked-by: #101\n\n- [ ] 実装"
  eq("rewrites an existing declaration",
     withDependencyRefs(body, [102, 103]),
     "作業内容。\n\nblocked-by: #102, #103\n\n- [ ] 実装")
  eq("round-trips", parseDependencyRefs(withDependencyRefs(body, [7, 3])), [3, 7])
  eq("sorts and dedupes", withDependencyRefs("x", [9, 2, 9]), "x\n\nblocked-by: #2, #9")
  eq("appends when there was none", withDependencyRefs("本文", [5]), "本文\n\nblocked-by: #5")
  eq("no double blank line", withDependencyRefs("本文\n", [5]), "本文\n\nblocked-by: #5")
  eq("empty removes the declaration", withDependencyRefs(body, []), "作業内容。\n\n- [ ] 実装")
  eq("keeps deliberate blank runs when nothing was dropped",
     withDependencyRefs("a\n\n\nb", [1]), "a\n\n\nb\n\nblocked-by: #1")
  eq("keeps the rest of an inline line",
     withDependencyRefs("これは blocked-by: #1 のはず", [2]),
     "blocked-by: #2\nこれは のはず")
  eq("leaves fenced code alone",
     withDependencyRefs("```\nblocked-by: #9\n```", [4]),
     "```\nblocked-by: #9\n```\n\nblocked-by: #4")
  eq("declaration position is kept",
     withDependencyRefs("a\nblocked-by: #1\nb", [2]), "a\nblocked-by: #2\nb")
}

// --- cycle: 循環の検出（§15.1） ---
{
  const dep = (n: number, refs: number[]) => ({
    ...mk(n, "Planning", "2026-09-01", "2026-09-05", null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })

  const acyclic = [dep(1, []), dep(2, [1]), dep(3, [2])]
  eq("no cycle in a chain", detectCycles(acyclic).cycles.length, 0)
  eq("no cyclic edges in a chain", detectCycles(acyclic).cyclicEdges.size, 0)

  const pair = [dep(1, [2]), dep(2, [1])]
  const pairReport = detectCycles(pair)
  eq("two-node cycle found", pairReport.cycles.length, 1)
  eq("two-node cycle message", formatCycle(pairReport.cycles[0]!), "循環: #101 → #102 → #101")
  eq("both edges are cyclic", pairReport.cyclicEdges.size, 2)

  // 3 ノードの循環に弦（i2 → i1）を足す。後退辺だけを拾う実装では弦が循環扱いにならない。
  const chorded = [dep(1, [2]), dep(2, [3, 1]), dep(3, [1])]
  const chordReport = detectCycles(chorded)
  eq("chord is cyclic too", chordReport.cyclicEdges.has(edgeKey("i2", "i1")), true)
  eq("all three tasks are cyclic", chordReport.cyclicTaskIds.size, 3)

  // 循環にぶら下がるだけのタスクは循環ではない。
  const hanging = [dep(1, [2]), dep(2, [1]), dep(3, [1])]
  const hangingReport = detectCycles(hanging)
  eq("dependent of a cycle is not cyclic", hangingReport.cyclicTaskIds.has("i3"), false)
  eq("edge into a cycle is not cyclic", hangingReport.cyclicEdges.has(edgeKey("i3", "i1")), false)

  const selfRef = [{ ...dep(1, []), body: "blocked-by: #101" }]
  eq("self reference makes no edge", detectCycles(selfRef).cycles.length, 0)
}

// --- cascade: 依存に合わせて後ろへ押す（§15.2） ---
{
  const dep = (n: number, refs: number[], start: string, end: string) => ({
    ...mk(n, "Planning", start, end, null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })

  // #2 は #1 に依存。#1 は 09-10 に終わるのに #2 は 09-05 開始 → 違反。
  const simple = [dep(1, [], "2026-09-01", "2026-09-10"), dep(2, [1], "2026-09-05", "2026-09-08")]
  eq("pushes a violating dependent", cascade(simple, "i1"),
     [{ taskId: "i2", startDate: "2026-09-11", endDate: "2026-09-14" }])

  // 余裕があれば動かさない。前倒しはしない。
  const slack = [dep(1, [], "2026-09-01", "2026-09-10"), dep(2, [1], "2026-09-20", "2026-09-25")]
  eq("slack is preserved", cascade(slack, "i1"), [])

  // 依存先の終了日と同じ日に始まるのは違反（後に始まる必要がある）。
  const touching = [dep(1, [], "2026-09-01", "2026-09-10"), dep(2, [1], "2026-09-10", "2026-09-12")]
  eq("same-day start is a violation", cascade(touching, "i1")[0]!.startDate, "2026-09-11")

  // 3 連鎖。2 件目は 1 件目の新しい終了日から計算される。
  const chain = [
    dep(1, [], "2026-09-01", "2026-09-10"),
    dep(2, [1], "2026-09-05", "2026-09-06"),
    dep(3, [2], "2026-09-07", "2026-09-08"),
  ]
  eq("chain cascades in blocker-first order", cascade(chain, "i1"), [
    { taskId: "i2", startDate: "2026-09-11", endDate: "2026-09-12" },
    { taskId: "i3", startDate: "2026-09-13", endDate: "2026-09-14" },
  ])

  // 依存先が 2 つ。遅い方に合わせ、出るのは 1 回だけ。
  const twoBlockers = [
    dep(1, [], "2026-09-01", "2026-09-10"),
    dep(2, [], "2026-09-01", "2026-09-20"),
    dep(3, [1, 2], "2026-09-05", "2026-09-06"),
  ]
  eq("waits for the latest blocker", cascade(twoBlockers, "i1"),
     [{ taskId: "i3", startDate: "2026-09-21", endDate: "2026-09-22" }])

  // ダイヤモンド。単純な BFS だと #4 が 2 回出る。
  const diamond = [
    dep(1, [], "2026-09-01", "2026-09-10"),
    dep(2, [1], "2026-09-02", "2026-09-03"),
    dep(3, [1], "2026-09-02", "2026-09-04"),
    dep(4, [2, 3], "2026-09-05", "2026-09-06"),
  ]
  const diamondEdits = cascade(diamond, "i1")
  eq("diamond emits each task once", diamondEdits.length, 3)
  eq("diamond joins after the later branch",
     diamondEdits.find((e) => e.taskId === "i4")!.startDate, "2026-09-14")

  // 日付未設定のタスクは飛ばす。
  const undated = [
    dep(1, [], "2026-09-01", "2026-09-10"),
    { ...dep(2, [1], "2026-09-05", "2026-09-06"), startDate: null, endDate: null },
  ]
  eq("undated dependent is skipped", cascade(undated, "i1"), [])

  // 循環していても返ってくる（無限ループしない）。
  const cyclic = [
    dep(1, [], "2026-09-01", "2026-09-10"),
    dep(2, [1, 3], "2026-09-05", "2026-09-06"),
    dep(3, [2], "2026-09-05", "2026-09-06"),
  ]
  eq("cyclic tasks are excluded", cascade(cyclic, "i1"), [])
}

// --- store: カスケードは 1 つの Undo エントリにまとまる ---
{
  const dep = (n: number, refs: number[], start: string, end: string) => ({
    ...mk(n, "Planning", start, end, null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })
  let seq = 0
  const next = () => `g${++seq}`

  let st = initialState([
    dep(1, [], "2026-09-01", "2026-09-05"),
    dep(2, [1], "2026-09-03", "2026-09-04"),
    dep(3, [2], "2026-09-05", "2026-09-06"),
  ])
  st = applyChangeWithCascade(st, "i1", { endDate: "2026-09-10" }, next)
  eq("cascade queues one mutation per task", pendingCount(st), 3)
  eq("cascade is one undo entry", st.undo.length, 1)
  eq("the entry holds every moved task", st.undo[0]!.items.length, 3)
  eq("downstream moved", findTask(st, "i3")!.startDate, "2026-09-13")

  st = undo(st, next)
  eq("one undo reverts the whole group", [
    findTask(st, "i1")!.endDate, findTask(st, "i2")!.startDate, findTask(st, "i3")!.startDate,
  ], ["2026-09-05", "2026-09-03", "2026-09-05"])
  eq("undo empties the stack", canUndo(st), false)
  eq("undo enables redo for the group", canRedo(st), true)

  st = redo(st, next)
  eq("redo reapplies the whole group", findTask(st, "i3")!.startDate, "2026-09-13")
  eq("redo restores the undo entry", st.undo.length, 1)
}

// --- store: 自動調整を切れば 1 件だけ ---
{
  const dep = (n: number, refs: number[], start: string, end: string) => ({
    ...mk(n, "Planning", start, end, null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })
  let seq = 0
  const next = () => `g${++seq}`
  let st = initialState([
    dep(1, [], "2026-09-01", "2026-09-05"),
    dep(2, [1], "2026-09-03", "2026-09-04"),
  ])
  st = applyChangeWithCascade(st, "i1", { endDate: "2026-09-10" }, next, { autoReschedule: false })
  eq("auto reschedule off moves only the dragged task", pendingCount(st), 1)
  eq("dependent is left where it was", findTask(st, "i2")!.startDate, "2026-09-03")
}

// --- store: グループが直前の操作にくっつかない ---
{
  const dep = (n: number, refs: number[], start: string, end: string) => ({
    ...mk(n, "Planning", start, end, null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })
  let seq = 0
  const next = () => `g${++seq}`
  let st = initialState([
    dep(1, [], "2026-09-01", "2026-09-05"),
    dep(2, [1], "2026-09-03", "2026-09-04"),
    dep(3, [], "2026-09-01", "2026-09-02"),
  ])
  st = applyChangeWithCascade(st, "i3", { endDate: "2026-09-04" }, next)
  st = applyChangeWithCascade(st, "i1", { endDate: "2026-09-10" }, next)
  eq("separate actions stay separate entries", st.undo.length, 2)
  eq("the earlier entry keeps its own item", st.undo[0]!.items.length, 1)

  st = undo(st, next)
  eq("undo reverts only the latest group", findTask(st, "i3")!.endDate, "2026-09-04")
  eq("the earlier action survives", canUndo(st), true)
}

// --- store: ロールバックはグループごと落とす ---
{
  const dep = (n: number, refs: number[], start: string, end: string) => ({
    ...mk(n, "Planning", start, end, null),
    body: refs.length === 0 ? "" : `blocked-by: ${refs.map((r) => `#${100 + r}`).join(", ")}`,
    issueNumber: 100 + n,
  })
  let seq = 0
  const next = () => `g${++seq}`
  let st = initialState([
    dep(1, [], "2026-09-01", "2026-09-05"),
    dep(2, [1], "2026-09-03", "2026-09-04"),
  ])
  st = applyChangeWithCascade(st, "i1", { endDate: "2026-09-10" }, next)
  const pushed = st.queue.find((m) => m.taskId === "i2")!
  st = rollback(st, pushed.id)
  eq("rollback reverts the failed task", findTask(st, "i2")!.startDate, "2026-09-03")
  eq("rollback drops the whole group", canUndo(st), false)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
