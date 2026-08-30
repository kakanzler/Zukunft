import {
  addDays, diffDays, inclusiveDays, startOfWeek, startOfNextMonth,
  createTimeScale, timelineRange, monthTicks, subTicks,
  hitTest, applyDrag, diffDates,
  computeStats, groupByStatus, groupByLabel, groupTasks, missingRequiredFields,
  initialState, applyLocalChange, markSyncing, markSynced, markFailed, markConflict,
  rollback, resolveWithRemote, resolveWithLocal, nextPending, pendingCount,
  undo, redo, canUndo, canRedo, mergeRefresh, findTask,
  normalizeFieldName, resolveField, canEditDates,
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

// --- timescale ---
const scale = createTimeScale("2026-09-01", "2026-09-30", "week")
eq("scale width", scale.width, 30 * 12)
eq("toX origin", scale.toX("2026-09-01"), 0)
eq("toX +10d", scale.toX("2026-09-11"), 120)
eq("toDate rounds to day", scale.toDate(125), "2026-09-11")
eq("toDays rounds", scale.toDays(30), 3)
eq("range pads to week start", timelineRange(["2026-09-10"], "2026-09-01").origin, "2026-08-31")
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
  id: `i${n}`, issueId: `gh${n}`, repositoryId: "repo", issueNumber: n, title: `T${n}`, body: "", url: "", startDate: start, endDate: end,
  status: s, priority: null, assignees: [], labels: [], milestone: { title: "v1", dueOn: "2026-09-30" },
  progress: prog, updatedAt: "2026-08-01T00:00:00Z", syncState: "synced",
})
const tasks = [mk(1, "Planning", "2026-09-01", "2026-09-07", 100), mk(2, "Review", "2026-09-08", "2026-09-21", 0)]
eq("stats", computeStats(tasks), { taskCount: 2, weekCount: 3, milestoneCount: 1, completePercent: 50 })
eq("groupByStatus order", groupByStatus(tasks, ["Planning", "In Progress", "Review"]).map(g => g.label), ["PLANNING", "REVIEW"])

// --- Category 表示（ラベルでのグループ化） ---
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
  ]
  const groups = groupByLabel(withLabels)
  eq("labels are grouped alphabetically, unlabeled last",
     groups.map(g => g.label), ["BACKEND", "DESIGN", "NO LABEL"])
  eq("an issue appears in every label it carries",
     groups.find(g => g.key === "design")!.tasks.map(t => t.issueNumber), [1, 2])
  eq("unlabeled issues are collected", groups[2]!.tasks.map(t => t.issueNumber), [3])
  eq("group carries the label colour", groups[0]!.color, "#0e8a16")
  eq("no-label group has no colour", groups[2]!.color, undefined)
  eq("groupTasks dispatches on mode",
     groupTasks(withLabels, "label", []).length, groups.length)
  eq("groupTasks status mode still works",
     groupTasks(withLabels, "status", ["Planning", "Review"]).map(g => g.label),
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
  st = undo(st, "m2")
  eq("undo restores dates", [findTask(st, "i1")!.startDate, findTask(st, "i1")!.endDate], ["2026-09-01", "2026-09-07"])
  eq("undo issues a new mutation", nextPending(st)!.id, "m2")
  eq("undo enables redo", canRedo(st), true)
  st = redo(st, "m3")
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
