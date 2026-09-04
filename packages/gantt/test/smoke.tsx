import { renderToStaticMarkup } from "react-dom/server"
import {
  type ScheduleTask,
  type ScheduledTask,
  type MilestoneMark,
  computeStats,
  createTimeScale,
  edgeKey,
  occurrences,
} from "@zukunft/domain"
import { buildRows, visibleRange, type Row } from "../src/rows"
import { estimateLabelWidth, onAxisMilestones, packMilestones } from "../src/milestones"
import { glowVar, statusSlot, statusVar } from "../src/colors"
import { isGanttTheme } from "../src/theme"
import { MILESTONE_FONT_SIZE, barPath, barWidth, buildLinks, type Placement } from "../src/Timeline"
import { KpiBar, StatusLegend } from "../src/KpiBar"
import { TaskPane } from "../src/TaskPane"
import { Timeline } from "../src/Timeline"
import { isTyping } from "../src/keyboard"
import type { DragState } from "../src/useBarDrag"

/**
 * 盤面の組み立てのテスト。
 *
 * ここが壊れても例外は出ない。行が 1 つ多い、矢印が逆を向く、畳んだつもりの
 * グループが開いている — どれも「動いてはいる画面」として出てしまい、目で見て
 * 気づくまで分からない。だから座標と行の並びを値として確かめる。
 *
 * ハーネスは packages/domain/test/smoke.ts / packages/github/test/smoke.ts と
 * 同じものを踏襲する。別の流儀を持ち込むより、3 つ並べて読めることを優先する。
 *
 * 対象から外したもの:
 * - 時間軸（createTimeScale / timelineRange / defaultTimelineEnd）と computeStats。
 *   gantt ではなく packages/domain にあり、そちらの smoke.ts が既に覆っている。
 *   ここでは「gantt が domain の結果を正しく画面へ運べているか」だけを見る。
 * - GanttChart。状態・キーボード・スクロールを束ねる殻で、props だけで決まる
 *   ところがほとんど無い。文字列に落としても確かめられることが残らない。
 * - useBarDrag。PointerEvent と setPointerCapture が要り、DOM 無しでは呼べない。
 *   ドラッグの計算そのもの（hitTest / applyDrag / diffDates）は domain 側にある。
 *
 * JSX を書くので拡張子だけ .tsx にしてある。中身の流儀は他の 2 つと同じ。
 */

let failures = 0
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${label}: got ${a}, want ${e}`) }
  else console.log(`ok   ${label}`)
}

/** タスク 1 件。見たいところだけ渡す。 */
const task = (over: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id: "t1",
  issueId: "i1",
  repositoryId: "r1",
  issueNumber: 1,
  title: "タスク",
  body: "",
  url: "https://example/1",
  issueState: "OPEN",
  startDate: null,
  endDate: null,
  status: null,
  priority: null,
  assignees: [],
  labels: [],
  milestone: null,
  progress: null,
  updatedAt: "2026-08-01T00:00:00Z",
  syncState: "synced",
  labelsComplete: true,
  assigneesComplete: true,
  fieldsComplete: true,
  ...over,
})

const STATUS_ORDER = ["Todo", "In Progress", "Done"]

/** 出現回数を数える。描画結果は文字列なので、個数はこれで見る。 */
const count = (haystack: string, pattern: RegExp): number =>
  (haystack.match(pattern) ?? []).length

// --- buildRows: Status でのグループ化 ---
{
  const tasks = [
    task({ id: "a", issueNumber: 1, status: "Todo", startDate: "2026-09-01", endDate: "2026-09-03" }),
    task({ id: "b", issueNumber: 2, status: "In Progress", startDate: "2026-09-02", endDate: "2026-09-05" }),
    task({ id: "c", issueNumber: 3, status: "Todo", startDate: "2026-09-04", endDate: "2026-09-06" }),
    task({ id: "d", issueNumber: 4 }),
  ]
  const rows = buildRows(tasks, STATUS_ORDER, new Set())

  eq(
    "rows put each group header directly above its own tasks",
    rows.map((r) => r.key),
    ["g:Todo", "t:a", "t:c", "g:In Progress", "t:b", "g:\u0000no-status", "t:d"],
  )
  eq(
    "group headers are labelled in the field definition order",
    rows.filter((r) => r.kind === "group").map((r) => r.label),
    ["TODO", "IN PROGRESS", "NO STATUS"],
  )
  eq("a group header counts the tasks under it", (rows[0] as Row & { kind: "group" }).count, 2)
  eq("group headers sit at depth 0", (rows[0] as Row & { kind: "group" }).depth, 0)
  eq("tasks sit one level below their group", (rows[1] as Row & { kind: "task" }).depth, 1)
  // 色は Status の定義順（企画書 §6.4.1）。ここがずれるとバーの色分けが崩れる。
  eq("a task takes its colour slot from the status order", (rows[4] as Row & { kind: "task" }).statusIndex, 1)
  eq("a task with no status falls back to the first colour slot", (rows[6] as Row & { kind: "task" }).statusIndex, 0)
  eq("no tasks means no rows at all", buildRows([], STATUS_ORDER, new Set()), [])
}

// --- buildRows: 折り畳み ---
{
  const tasks = [
    task({ id: "a", issueNumber: 1, status: "Todo", startDate: "2026-09-01", endDate: "2026-09-03" }),
    task({ id: "b", issueNumber: 2, status: "In Progress", startDate: "2026-09-02", endDate: "2026-09-05" }),
  ]
  eq(
    "a collapsed group hides its tasks but keeps its header",
    buildRows(tasks, STATUS_ORDER, new Set(["Todo"])).map((r) => r.key),
    ["g:Todo", "g:In Progress", "t:b"],
  )
  eq(
    "a collapsed group header says it is collapsed",
    (buildRows(tasks, STATUS_ORDER, new Set(["Todo"]))[0] as Row & { kind: "group" }).collapsed,
    true,
  )
  eq(
    "collapsing everything leaves only the headers",
    buildRows(tasks, STATUS_ORDER, new Set(["Todo", "In Progress"])).map((r) => r.key),
    ["g:Todo", "g:In Progress"],
  )
}

// --- buildRows: 親カテゴリの 2 階層 ---
{
  const label = (name: string) => ({ id: `l-${name}`, name, color: "a855f7" })
  const tasks = [
    task({ id: "p1", issueNumber: 1, labels: [label("school"), label("math")], startDate: "2026-09-01", endDate: "2026-09-02" }),
    task({ id: "p2", issueNumber: 2, labels: [label("school")], startDate: "2026-09-03", endDate: "2026-09-04" }),
    task({ id: "p3", issueNumber: 3, labels: [label("work")], startDate: "2026-09-05", endDate: "2026-09-06" }),
  ]
  const rows = buildRows(tasks, STATUS_ORDER, new Set(), "label", ["school", "work"])

  eq(
    "a parent label nests its child groups under one header",
    rows.map((r) => (r.kind === "group" ? `${r.depth}:${r.label}` : `${r.depth}:${r.task.id}`)),
    ["0:SCHOOL", "1:MATH", "2:p1", "1:NO LABEL", "2:p2", "0:WORK", "1:NO LABEL", "2:p3"],
  )
  // 子グループの名前は親をまたいで重複する（どの親の下にも NO LABEL が出る）。
  // キーに親を前置していないと、片方を畳んだだけで両方畳まれる。
  eq(
    "collapsing NO LABEL under one parent leaves the other parent's NO LABEL open",
    buildRows(tasks, STATUS_ORDER, new Set(["school\u0000\u0000no-label"]), "label", ["school", "work"])
      .map((r) => (r.kind === "group" ? `${r.depth}:${r.label}` : `${r.depth}:${r.task.id}`)),
    ["0:SCHOOL", "1:MATH", "2:p1", "1:NO LABEL", "0:WORK", "1:NO LABEL", "2:p3"],
  )
  eq(
    "collapsing a parent hides the whole subtree",
    buildRows(tasks, STATUS_ORDER, new Set(["school"]), "label", ["school", "work"]).map((r) => r.key),
    ["g:school", "g:work", "g:work\u0000\u0000no-label", "t:p3"],
  )
}

// --- visibleRange: 仮想化の範囲 ---
{
  eq("no rows means nothing to draw", visibleRange(0, 320, 32, 0), { start: 0, end: 0 })
  // 高さが決まる前（初回レンダー）は 0 で呼ばれる。ここで全行返すと初回だけ重い。
  eq("an unmeasured viewport draws nothing", visibleRange(0, 0, 32, 100), { start: 0, end: 0 })
  eq("fewer rows than the viewport are all drawn", visibleRange(0, 320, 32, 5), { start: 0, end: 5 })
  eq("the top of a long list starts at row 0", visibleRange(0, 320, 32, 100), { start: 0, end: 26 })
  // overscan の分だけ手前へ広げる。負の添字にはしない。
  eq("a small scroll never produces a negative start", visibleRange(64, 320, 32, 100), { start: 0, end: 26 })
  eq("scrolling moves the window by whole rows", visibleRange(1000, 320, 32, 100), { start: 23, end: 49 })
  eq("the window never runs past the last row", visibleRange(3200, 320, 32, 100), { start: 92, end: 100 })
  eq("overscan can be turned off", visibleRange(320, 320, 32, 100, 0), { start: 10, end: 20 })
}

// --- colors: Status 色の巡回 ---
{
  eq("the first status takes the first colour", statusSlot(0), 0)
  eq("colours wrap round after the last one", statusSlot(4), 0)
  // indexOf の -1 がそのまま来ると var(--status--1-to) という無い変数になる。
  eq("a negative status index still lands on a real slot", statusSlot(-1), 3)
  eq("legend dots read the fill colour variable", statusVar(5), "var(--status-1-to)")
  eq("bar glow reads the glow variable of the same slot", glowVar(2), "var(--status-2-glow)")
}

// --- theme: 保存値の検証 ---
{
  eq("the shipped themes are accepted", [isGanttTheme("default"), isGanttTheme("blue-system")], [true, true])
  // 設定は保存されて戻ってくる。知らない値で盤面が描けなくならないこと。
  eq("an unknown saved theme is rejected", isGanttTheme("midnight"), false)
  eq("a non-string saved theme is rejected", [isGanttTheme(null), isGanttTheme(0)], [false, false])
}

// --- Timeline: バーの寸法 ---
{
  const day = createTimeScale("2026-09-01", "2026-09-30", "day")
  const month = createTimeScale("2026-09-01", "2026-09-30", "month")
  const bar = (startDate: string, endDate: string) =>
    task({ startDate, endDate }) as ScheduledTask

  eq("a bar spans both its end days", barWidth(bar("2026-09-01", "2026-09-03"), day), 96)
  eq("a one-day task is still one day wide", barWidth(bar("2026-09-01", "2026-09-01"), day), 32)
  eq("zooming out shrinks the bar with the scale", barWidth(bar("2026-09-01", "2026-09-03"), month), 12)

  // 四隅とも同じ小さな角。右だけ半円にすると帯の終わりが尖って、
  // 始まりと終わりの重みが揃わない。
  eq(
    "a wide bar has the same small corner at both ends",
    barPath(0, 0, 100, 22),
    "M 2 0 H 98 A 2 2 0 0 1 100 2 V 20 A 2 2 0 0 1 98 22 H 2" +
      " A 2 2 0 0 1 0 20 V 2 A 2 2 0 0 1 2 0 Z",
  )
  // rect の rx が横と縦を別々に丸めていたころ、幅 2px のバーは高さ 22px の
  // レンズになっていた。半径は幅の半分を超えないこと。
  eq(
    "a 2px bar never rounds wider than itself",
    barPath(0, 0, 2, 22),
    "M 1 0 H 1 A 1 1 0 0 1 2 1 V 21 A 1 1 0 0 1 1 22 H 1" +
      " A 1 1 0 0 1 0 21 V 1 A 1 1 0 0 1 1 0 Z",
  )
}

// --- Timeline: 依存の矢印 ---
{
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  const ROW_HEIGHT = 32
  const scheduled = (id: string, startDate: string, endDate: string) =>
    task({ id, startDate, endDate }) as ScheduledTask
  const placed = new Map<string, Placement>([
    ["a", { index: 0, statusIndex: 0, task: scheduled("a", "2026-09-01", "2026-09-02") }],
    ["b", { index: 1, statusIndex: 1, task: scheduled("b", "2026-09-05", "2026-09-06") }],
  ])
  const all = { start: 0, end: 2 }
  const noCycle: ReadonlySet<string> = new Set()
  const links = (
    deps: { fromTaskId: string; toTaskId: string }[],
    visible = all,
    cyclic = noCycle,
    drag: DragState | null = null,
  ) => buildLinks(deps, placed, scale, ROW_HEIGHT, visible, cyclic, drag, "u")

  const back = links([{ fromTaskId: "b", toTaskId: "a" }])
  eq("a dependency with both ends drawn becomes one arrow", back.length, 1)
  // 依存先が手前にあるときは左へ戻る。端点を近い側に取らないと、線がバーの上を
  // 横切って、どちらが先かが読めなくなる。
  eq("a backwards arrow leaves the left edge of the waiting bar", back[0]!.x1, 128)
  eq("a backwards arrow lands on the right edge of the bar it waits for", back[0]!.x2, 64)
  // マイルストーンを本体の外に出したので、行の y は行番号そのもの（帯のぶんの下駄は無い）。
  // 矢印だけ下駄を履いたままだと、線がバーから外れた高さに出る。
  eq("arrow ends sit on the vertical middle of their rows", [back[0]!.y1, back[0]!.y2], [48, 16])
  eq("an arrow is coloured from its own status to the target's", [back[0]!.fromColor, back[0]!.toColor],
     ["var(--status-1-to)", "var(--status-0-to)"])

  const forward = links([{ fromTaskId: "a", toTaskId: "b" }])
  eq("a forward arrow leaves the right edge and lands on the left", [forward[0]!.x1, forward[0]!.x2], [64, 128])

  // 折り畳んだグループの中や、日付が未設定で描かれていない行には引けない。
  eq("no arrow is drawn to a row that is not on the board", links([{ fromTaskId: "a", toTaskId: "gone" }]).length, 0)
  eq("no arrow is drawn when both ends are scrolled off the same side",
     links([{ fromTaskId: "a", toTaskId: "b" }], { start: 2, end: 10 }).length, 0)
  eq("an arrow survives when only one end is on screen",
     links([{ fromTaskId: "a", toTaskId: "b" }], { start: 0, end: 1 }).length, 1)

  eq("a cyclic edge is marked so it can be drawn in the danger colour",
     links([{ fromTaskId: "b", toTaskId: "a" }], all, new Set([edgeKey("b", "a")]))[0]!.cyclic, true)
  eq("a non-cyclic edge is not marked", back[0]!.cyclic, false)

  // ドラッグ中は仮の日付で引き直す。元の位置に線が残ると、依存先を見ながら
  // 日程を動かせない。
  const dragging: DragState = {
    taskId: "a",
    mode: "move",
    deltaDays: 9,
    preview: { startDate: "2026-09-10", endDate: "2026-09-11" },
    pointer: { x: 0, y: 0 },
  }
  eq("an arrow follows the dragged bar's preview dates",
     links([{ fromTaskId: "b", toTaskId: "a" }], all, noCycle, dragging)[0]!.x2, 288)
}

// --- milestones: 段組み ---
{
  const mark = (id: string, title: string, dueOn: string): MilestoneMark => ({ id, title, dueOn })
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  const pack = (marks: MilestoneMark[], fontSize = 12) =>
    packMilestones(marks, scale.toX, scale.pxPerDay, fontSize)

  eq("wide (CJK) characters are estimated wider than narrow ones",
     estimateLabelWidth("あ", 12) > estimateLabelWidth("a", 12), true)

  // 軸の外は段を数える前に落とす。描かれないものが段を占めると、盤面には何も
  // 無いのに帯だけ 1 段高くなる。軸より手前は x が負になるので、左端に居座って
  // 見えている方を下の段へ押し出す。
  const spanning = [
    mark("before", "軸より前", "2026-08-01"),
    mark("inside", "軸の中", "2026-09-10"),
    mark("after", "軸より後", "2026-10-15"),
  ]
  eq("milestones off the axis are dropped before packing",
     onAxisMilestones(spanning, scale.origin, scale.end).map((m) => m.id), ["inside"])
  eq("the edges of the axis count as on it",
     onAxisMilestones(
       [mark("o", "左端", scale.origin), mark("e", "右端", scale.end)],
       scale.origin, scale.end,
     ).length, 2)
  eq("dropping the off-axis ones keeps the band at one lane",
     pack(onAxisMilestones(spanning, scale.origin, scale.end)).laneCount, 1)

  // 離れていれば重ならないので全部 1 段のまま。
  const apart = pack([mark("m1", "v1", "2026-09-01"), mark("m2", "v2", "2026-09-20")])
  eq("well-spaced milestones stay on one lane", apart.laneCount, 1)
  eq("well-spaced milestones are all on lane 0", apart.placed.map((p) => p.lane), [0, 0])

  // 隣り合っていて重なれば、期日が後ろのものが 2 段目へ送られる。
  const overlapping = pack([mark("m1", "非常に長いマイルストーンの題名です", "2026-09-01"), mark("m2", "v2", "2026-09-02")])
  eq("overlapping milestones split into two lanes", overlapping.laneCount, 2)
  eq("the later due date is pushed to lane 1",
     overlapping.placed.map((p) => p.lane), [0, 1])

  // 3 つが隣接して重なれば 3 段になる。
  const triple = pack([
    mark("m1", "長いマイルストーンの題名A", "2026-09-01"),
    mark("m2", "長いマイルストーンの題名B", "2026-09-02"),
    mark("m3", "長いマイルストーンの題名C", "2026-09-03"),
  ])
  eq("three overlapping milestones need three lanes", triple.laneCount, 3)

  // 0 件でも帯は消えない。
  eq("an empty list still reports one lane", pack([]).laneCount, 1)
}

/*
 * ここから下は描画のテスト。
 *
 * jsdom も testing-library も入れず、react-dom/server で文字列に落として見る。
 * 見たいのは「props がそのまま画面の数と文字になるか」だけなので、本物の DOM は
 * 要らない。依存を増やさずに済む方を取る。
 *
 * 見られないもの: クリック・ドラッグ・useEffect（サーバ描画では走らない）。
 * それらは domain 側の純関数と手での確認に任せる。
 */

// --- KpiBar: computeStats の値がタイルに出る ---
{
  const tasks = [
    task({ id: "a", issueNumber: 1, startDate: "2026-09-01", endDate: "2026-09-03", progress: 100,
           milestone: { id: "m1", title: "v1", dueOn: "2026-09-30" } }),
    task({ id: "b", issueNumber: 2, startDate: "2026-09-04", endDate: "2026-09-20", progress: 50,
           milestone: { id: "m1", title: "v1", dueOn: "2026-09-30" } }),
    task({ id: "c", issueNumber: 3 }),
  ]
  const stats = computeStats(tasks)
  const html = renderToStaticMarkup(<KpiBar stats={stats} />)
  const values = [...html.matchAll(/class="zk-kpi-value">([^<]*)</g)].map((m) => m[1])

  eq("the KPI bar shows four tiles", count(html, /class="zk-kpi-tile"/g), 4)
  eq(
    "every KPI tile carries the value computeStats produced",
    values,
    [String(stats.taskCount), String(stats.weekCount), String(stats.milestoneCount), `${stats.completePercent}%`],
  )
  eq(
    "KPI tiles keep the labels of the plan (企画書 §6.4.2)",
    [...html.matchAll(/class="zk-kpi-label">([^<]*)</g)].map((m) => m[1]),
    ["Tasks", "Weeks", "Milestones", "Complete"],
  )
  // タイルの数字が素通しであることの裏取り。1 件でも欠けると規模を読み違える。
  eq("the task count tile counts unscheduled tasks too", values[0], "3")
}

// --- StatusLegend: Status の数だけ点が出る ---
{
  const statuses = ["Todo", "In Progress", "Review", "Done", "Icebox"]
  const html = renderToStaticMarkup(<StatusLegend statuses={statuses} />)

  eq("the legend draws one dot per status", count(html, /class="zk-legend-dot"/g), statuses.length)
  eq("the legend names every status", statuses.every((name) => html.includes(name)), true)
  // 色は 4 本しかないので 5 つ目は先頭に戻る。ここが崩れると存在しない CSS 変数
  // （--status-4-to）を引き、点が透明になる。
  eq("a fifth status wraps back to the first colour", count(html, /--status-0-to/g), 2)
  eq("no legend dot asks for a colour that does not exist", count(html, /--status-4-to/g), 0)

  eq("no statuses means no legend items", count(renderToStaticMarkup(<StatusLegend statuses={[]} />),
     /class="zk-legend-item"/g), 0)
}

// --- TaskPane: 行数が rows と一致する ---
{
  const tasks = [
    task({ id: "a", issueNumber: 11, title: "設計", status: "Todo", startDate: "2026-09-01", endDate: "2026-09-03" }),
    task({ id: "b", issueNumber: 12, title: "実装", status: "Todo", startDate: "2026-09-04", endDate: "2026-09-06" }),
    task({ id: "c", issueNumber: 13, title: "日付未定", status: "In Progress" }),
  ]
  const rows = buildRows(tasks, STATUS_ORDER, new Set())
  const ROW_HEIGHT = 32
  // ハンドラを渡さない読み取り専用の使い方でも落ちないこと（Web ビューがこれ）。
  const html = renderToStaticMarkup(
    <TaskPane rows={rows} rowHeight={ROW_HEIGHT} milestoneHeight={ROW_HEIGHT}
              visible={{ start: 0, end: rows.length }} onToggleGroup={() => {}} />,
  )

  eq("the task pane draws exactly one element per row", count(html, /class="zk-row[ "]/g), rows.length)
  eq("row titles come straight from the tasks",
     [...html.matchAll(/class="zk-row-title">([^<]*)</g)].map((m) => m[1]),
     ["TODO", "設計", "実装", "IN PROGRESS", "日付未定"])
  // マイルストーンは行の外（貼り付く見出し行）に出したので、本体には余白が無い。
  // 余分な帯が残っていると、左の行名と右のバーが横にずれる。
  eq("the pane is exactly as tall as its rows", html.includes(`height:${rows.length * ROW_HEIGHT}px`), true)
  eq("the first row starts at the top of the body", html.includes("top:0;"), true)
  // 貼り付く見出しは盤面側の帯と対。片方だけ消えると以降の行が横にずれる。
  eq("the pane opens with the milestone heading", count(html, /class="zk-pane-milestone"/g), 1)
  // 畳めない見出しなので、グループ見出しの当たり判定を持ってはいけない。
  eq("the milestone heading is not clickable", html.includes('zk-pane-milestone" role='), false)
  // 日付の無いタスクはバーが出ない。左で見分けが付かないと「消えた」に見える。
  eq("a task with no dates is marked unscheduled", count(html, /zk-row--unscheduled/g), 1)

  // 仮想化。可視範囲の外は組み立てないこと。
  const windowed = renderToStaticMarkup(
    <TaskPane rows={rows} rowHeight={ROW_HEIGHT} milestoneHeight={ROW_HEIGHT}
              visible={{ start: 1, end: 3 }} onToggleGroup={() => {}} />,
  )
  eq("only the visible slice of rows is built", count(windowed, /class="zk-row[ "]/g), 2)
  eq("a row outside the visible slice is not built", windowed.includes("日付未定"), false)
  // slice の先頭を 0 から数え直すと、スクロールした瞬間に全行が上へ跳ぶ。
  eq("a windowed row keeps its absolute position", windowed.includes(`top:${1 * ROW_HEIGHT}px`), true)

  const selected = renderToStaticMarkup(
    <TaskPane rows={rows} rowHeight={ROW_HEIGHT} milestoneHeight={ROW_HEIGHT}
              visible={{ start: 0, end: rows.length }} onToggleGroup={() => {}} selectedTaskId="b" />,
  )
  eq("exactly one row is marked as selected", count(selected, /zk-row--selected/g), 1)
}

// --- Timeline: バーとマイルストーンの数 ---
{
  const tasks = [
    task({ id: "a", issueNumber: 11, status: "Todo", startDate: "2026-09-01", endDate: "2026-09-03" }),
    task({ id: "b", issueNumber: 12, status: "Todo", startDate: "2026-09-04", endDate: "2026-09-06" }),
    task({ id: "c", issueNumber: 13, status: "In Progress" }),
  ]
  const rows = buildRows(tasks, STATUS_ORDER, new Set())
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  // 段を決めるのは GanttChart の仕事なので、ここでは詰めた結果を渡す。
  const inRange: MilestoneMark = { id: "m1", title: "v1", dueOn: "2026-09-30" }
  const outOfRange: MilestoneMark = { id: "m2", title: "圏外", dueOn: "2026-12-01" }
  const html = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[{ mark: inRange, lane: 0 }, { mark: outOfRange, lane: 0 }]}
              milestoneHeight={32}
              onTaskDatesChange={() => {}} />,
  )

  // 日付の無いタスクとグループ見出しにはバーが無い。数が合わないと、
  // 引けないバーを引いて盤面が壊れるか、引けるバーが消えている。
  eq("the board draws one bar per scheduled task", count(html, /class="zk-bar"/g), 2)
  // Timeline は渡されたものをそのまま描く。軸の外を落とすのは段を数える前
  // （GanttChart の onAxisMilestones）— ここで落とすと、帯の高さだけが
  // 落とす前の段数のまま残って空の段ができる。
  eq("the board draws every milestone it is given", count(html, /class="zk-milestone"/g), 2)
  // 菱形は本体の外の、貼り付く帯に描く。本体に描くと下へ辿った先で消える。
  eq("the milestone lives in its own pinned row", count(html, /class="zk-milestone-row"/g), 1)
  // ハンドラを渡さない読み取り専用ビューでは押せないままにする。
  eq("a board without a handler leaves milestones unclickable",
     [html.includes("zk-milestone-hit"), html.includes("cursor:pointer")], [false, false])
  // その帯を出した以上、本体には余白が要らない。残っていると左ペインとずれる。
  eq("the board is exactly as tall as its rows", html.includes(`height="${rows.length * 32}"`), true)
  eq("the board is as wide as the time scale", html.includes(`width="${scale.width}"`), true)

  // 押せる盤面だけ、題名まで覚えた当たり判定を敷く。
  const clickable = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[{ mark: inRange, lane: 0 }]} milestoneHeight={32}
              onMilestoneOpen={() => {}} onTaskDatesChange={() => {}} />,
  )
  eq("a board with a handler gets a wide hit area",
     count(clickable, /class="zk-milestone-hit"/g), 1)

  // カテゴリの色は菱形と題名を包む <g> に変数として乗せる。菱形だけに乗せると
  // 題名から読めず、色を当てたときに片方だけが変わる。
  const tinted = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[{ mark: { ...inRange, color: "#ff8800" }, lane: 0 }]}
              milestoneHeight={32} onTaskDatesChange={() => {}} />,
  )
  eq("a milestone with a category colour puts it on the group both shapes read",
     [tinted.includes("zk-milestone--tinted"),
      tinted.includes("--zk-milestone-color:#ff8800"),
      tinted.includes("--zk-ms-color:#ff8800")],
     [true, true, true])
  // 変数は菱形ではなく <g> 側。ここが菱形に戻ると題名が色に付いてこない。
  eq("the tint is not pinned to the diamond alone",
     /<path class="zk-milestone zk-milestone--tinted"[^>]*style=/.test(tinted), false)

  // 2 段になったら帯も 2 段ぶん高くなる。1 段のままだと、下の段の菱形が
  // 帯の外へはみ出して、下から上がってくる行に重なる。
  const packed = packMilestones(
    [
      { id: "m1", title: "非常に長いマイルストーンの題名です", dueOn: "2026-09-01" },
      { id: "m2", title: "v2", dueOn: "2026-09-02" },
    ],
    scale.toX, scale.pxPerDay, MILESTONE_FONT_SIZE,
  )
  const twoLanes = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={packed.placed} milestoneHeight={packed.laneCount * 32}
              onTaskDatesChange={() => {}} />,
  )
  eq("overlapping milestones need a second lane", packed.laneCount, 2)
  eq("the milestone band is as tall as the lanes it holds",
     twoLanes.includes("height:64px"), true)
  // 2 段目の高さは 1 段目の真下（lane * rowHeight の中央）。
  eq("the second lane is drawn a whole row below the first",
     twoLanes.includes('y="48"'), true)

  const empty = renderToStaticMarkup(
    <Timeline rows={[]} scale={scale} rowHeight={32} visible={{ start: 0, end: 0 }}
              milestones={[]} milestoneHeight={32} onTaskDatesChange={() => {}} />,
  )
  eq("an empty board still draws the axis and no bars",
     [count(empty, /class="zk-bar"/g), count(empty, /class="zk-thead-month"/g) > 0], [0, true])
}

/*
 * --- Timeline / TaskPane: 日課は点で描く ---
 *
 * 日課は GitHub 上では普通の Issue のままで、変えているのは描き方だけ。
 * バーが残っていたり、点の数が実行日と食い違ったりしても例外にはならないので、
 * 数と印を値として確かめる。
 */
{
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  // 3 日おき。9/01, 9/04, 9/07 の 3 回で終わる。
  const bounded = task({
    id: "d", issueNumber: 21, status: "Todo",
    startDate: "2026-09-01", endDate: "2026-09-07",
  })
  // 終わりを決めていない（Target Date が空）。開始日から 1 年、横軸の右端が手前ならそこまで。
  const endless = task({ id: "e", issueNumber: 22, status: "Todo", startDate: "2026-09-01" })
  const dailyRule = { kind: "interval" as const, intervalDays: 3 }
  const daily = { d: { rule: dailyRule, done: ["2026-09-04" as const] } }
  const rows = buildRows([bounded], STATUS_ORDER, new Set())
  const html = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[]} milestoneHeight={32} dailyTasks={daily}
              onToggleDailyDone={() => {}} onTaskDatesChange={() => {}} />,
  )

  // 日課にバーが出ると、繰り返しが 1 本の期間として読めてしまう。
  eq("a daily task draws no bar", count(html, /class="zk-bar"/g), 0)
  eq("a daily task draws one dot per occurrence",
     count(html, /class="zk-daily-dot/g),
     occurrences("2026-09-01", "2026-09-07", dailyRule, scale.end).length)
  // 実行済みだけが光る。未実行まで光ると、どこまでやったのかが読めない。
  eq("only the done occurrences glow",
     [count(html, /zk-daily-dot--done/g), count(html, /zk-daily-dot--todo/g)], [1, 2])
  // 発光色は Status ごと。バーと同じ変数で載せる。
  eq("a done dot carries the status glow colour", html.includes(`--bar-glow:${glowVar(0)}`), true)
  // 点は日の中央。マイルストーンの菱形と同じ置き方で、同じ日のものが縦に揃う。
  eq("a dot sits at the centre of its day",
     html.includes(`cx="${scale.toX("2026-09-01") + scale.pxPerDay / 2}"`), true)

  // Target Date が空でも点は並ぶ。ここで isScheduled に落ちると、
  // 終わりを決めていない日課が盤面から消える。
  const endlessRows = buildRows([endless], STATUS_ORDER, new Set())
  const endlessHtml = renderToStaticMarkup(
    <Timeline rows={endlessRows} scale={scale} rowHeight={32}
              visible={{ start: 0, end: endlessRows.length }}
              milestones={[]} milestoneHeight={32}
              dailyTasks={{ e: { rule: { kind: "interval", intervalDays: 7 }, done: [] } }}
              onTaskDatesChange={() => {}} />,
  )
  eq("an open-ended daily task runs to the right edge of the axis",
     count(endlessHtml, /class="zk-daily-dot/g),
     occurrences("2026-09-01", null, { kind: "interval", intervalDays: 7 }, scale.end).length)
  // ハンドラを渡さない読み取り専用ビューでは押せないままにする。
  eq("a board without a handler leaves the dots unclickable",
     endlessHtml.includes("cursor:pointer"), false)

  // 起点が無ければ点は置けない。日課の指定だけが残っていても落ちないこと。
  const undated = buildRows([task({ id: "u", issueNumber: 23, status: "Todo" })], STATUS_ORDER, new Set())
  const undatedHtml = renderToStaticMarkup(
    <Timeline rows={undated} scale={scale} rowHeight={32} visible={{ start: 0, end: undated.length }}
              milestones={[]} milestoneHeight={32}
              dailyTasks={{ u: { rule: { kind: "interval", intervalDays: 1 }, done: [] } }}
              onTaskDatesChange={() => {}} />,
  )
  eq("a daily task with no start date draws nothing",
     count(undatedHtml, /class="zk-daily-dot/g), 0)

  // 左ペイン。終わりを決めていない日課は Target Date が空だが、繰り返し中なので
  // 「日付未設定」の斜体にはしない。盤面と同じ dailyTasks で判定する。
  const pane = renderToStaticMarkup(
    <TaskPane rows={endlessRows} rowHeight={32} milestoneHeight={32}
              visible={{ start: 0, end: endlessRows.length }} onToggleGroup={() => {}}
              dailyTasks={{ e: { rule: { kind: "interval", intervalDays: 7 }, done: [] } }} />,
  )
  eq("a daily task is not shown as unscheduled", count(pane, /zk-row--unscheduled/g), 0)
  const paneWithout = renderToStaticMarkup(
    <TaskPane rows={endlessRows} rowHeight={32} milestoneHeight={32}
              visible={{ start: 0, end: endlessRows.length }} onToggleGroup={() => {}} />,
  )
  eq("the same task without the daily setting is still unscheduled",
     count(paneWithout, /zk-row--unscheduled/g), 1)
}

/*
 * --- Timeline: 日課には依存の矢印を引かない ---
 *
 * 日課はバーではなく点で描く。矢印はバーの端を掴んで引くので、日課を端に持つ
 * 依存をそのまま渡すと空間に向かって着いてしまう。placed から日課を外して、
 * それ以外の組は今までどおり矢印が出ることも合わせて確かめる。
 */
{
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  const normalTasks = [
    task({ id: "a", issueNumber: 31, status: "Todo", startDate: "2026-09-01", endDate: "2026-09-02" }),
    task({ id: "b", issueNumber: 32, status: "Todo", startDate: "2026-09-05", endDate: "2026-09-06" }),
  ]
  const rows = buildRows(normalTasks, STATUS_ORDER, new Set())
  const normalHtml = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[]} milestoneHeight={32}
              dependencies={[{ fromTaskId: "b", toTaskId: "a" }]}
              onTaskDatesChange={() => {}} />,
  )
  eq("a dependency between two ordinary tasks still draws an arrow",
     count(normalHtml, /class="zk-dep"/g), 1)

  const withDaily = [
    task({ id: "c", issueNumber: 33, status: "Todo", startDate: "2026-09-01", endDate: "2026-09-02" }),
    task({ id: "d", issueNumber: 34, status: "Todo", startDate: "2026-09-05" }),
  ]
  const dailyRows = buildRows(withDaily, STATUS_ORDER, new Set())
  const dailyHtml = renderToStaticMarkup(
    <Timeline rows={dailyRows} scale={scale} rowHeight={32} visible={{ start: 0, end: dailyRows.length }}
              milestones={[]} milestoneHeight={32}
              dailyTasks={{ d: { rule: { kind: "interval", intervalDays: 1 }, done: [] } }}
              dependencies={[{ fromTaskId: "d", toTaskId: "c" }]}
              onTaskDatesChange={() => {}} />,
  )
  eq("a dependency touching a daily task draws no arrow",
     count(dailyHtml, /class="zk-dep"/g), 0)
}

/*
 * --- Timeline: マイルストーンへ向かう線 ---
 *
 * 線を引くのは「親 Issue を持たないタスク」からだけ。同じ期日へ向かう線が束に
 * なると、菱形の手前が塗り潰されてどのバーの話か読めなくなる。絞り込みが効いて
 * いなくても例外は出ないので、本数を値として確かめる。
 */
{
  const scale = createTimeScale("2026-09-01", "2026-09-30", "day")
  const linked = [
    task({ id: "a", issueId: "gh-a", issueNumber: 41, status: "Todo",
           startDate: "2026-09-01", endDate: "2026-09-03",
           milestone: { id: "m1", title: "v1", dueOn: "2026-09-20" } }),
    task({ id: "b", issueId: "gh-b", issueNumber: 42, status: "Todo",
           startDate: "2026-09-05", endDate: "2026-09-07",
           milestone: { id: "m1", title: "v1", dueOn: "2026-09-20" } }),
  ]
  const rows = buildRows(linked, STATUS_ORDER, new Set())
  const mark: MilestoneMark = { id: "m1", title: "v1", dueOn: "2026-09-20" }
  const board = (links: { taskId: string; milestoneId: string }[] | undefined) =>
    renderToStaticMarkup(
      <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
                milestones={[{ mark, lane: 0 }]} milestoneHeight={32}
                milestoneLinks={links} onTaskDatesChange={() => {}} />,
    )

  // 親を持たない a からだけ引く（b は a の子、という想定で渡さない）。
  const one = board([{ taskId: "a", milestoneId: "m1" }])
  eq("a milestone link is drawn for the task it is given",
     count(one, /class="zk-ms-link"/g), 1)
  // 線の上端は本体の上端（y = 0）。菱形は貼り付く別の帯にあり、またげない。
  // 曲線なので終点は 3 次ベジエの最後の座標として出る。
  eq("the line stops at the top of the board",
     one.includes(`, ${scale.toX("2026-09-20") + scale.pxPerDay / 2} 0"`), true)
  // 依存の矢印と同じで、出るのはバーの右端。中央から真上に伸ばすと、バーを跨いで
  // 生えたように見えてどこから出た線か読めない。
  // a は 09-01..09-03 の 3 日ぶん。day ズームは 1 日 32px なので右端は原点 + 96。
  eq("the line leaves from the right edge of the bar",
     one.includes(`M ${scale.toX("2026-09-01") + 96} `), true)
  eq("the line is a curve, not a straight run", one.includes(" C "), true)
  // 色は菱形と同じ。揃えないと、どの菱形へ向かう線か分からない。
  eq("the line takes the milestone colour", one.includes('stroke="var(--zk-milestone-color)"'), true)
  // 依存の矢印とは別物。先端（marker）は付けない。
  eq("a milestone link is not an arrow",
     [count(one, /class="zk-dep"/g), count(one, /class="zk-dep-head"/g)], [0, 0])

  // 親を持つタスクの分は milestoneLinkSources が落とすので、ここへは来ない。
  // 来た分だけを引くことを、両方渡した場合の本数で確かめる。
  eq("every link it is given is drawn",
     count(board([{ taskId: "a", milestoneId: "m1" }, { taskId: "b", milestoneId: "m1" }]),
           /class="zk-ms-link"/g), 2)

  // 渡さない読み取り専用ビュー（apps/web）では 1 本も引かない。
  eq("a board with no links draws none", count(board(undefined), /class="zk-ms-link"/g), 0)

  // 菱形が描かれていない期日へは引かない。向かう先の無い線になる。
  eq("a link to a milestone that is not on the axis draws nothing",
     count(board([{ taskId: "a", milestoneId: "gone" }]), /class="zk-ms-link"/g), 0)

  // 可視範囲の外の行は矢印と同じ扱いで落とす。
  const windowed = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: 1 }}
              milestones={[{ mark, lane: 0 }]} milestoneHeight={32}
              milestoneLinks={[{ taskId: "b", milestoneId: "m1" }]}
              onTaskDatesChange={() => {}} />,
  )
  eq("a row outside the window draws no line", count(windowed, /class="zk-ms-link"/g), 0)

  // 日課はバーではなく点で描く。バーの上端を掴む線は引けない。
  const daily = renderToStaticMarkup(
    <Timeline rows={rows} scale={scale} rowHeight={32} visible={{ start: 0, end: rows.length }}
              milestones={[{ mark, lane: 0 }]} milestoneHeight={32}
              dailyTasks={{ a: { rule: { kind: "interval", intervalDays: 1 }, done: [] } }}
              milestoneLinks={[{ taskId: "a", milestoneId: "m1" }]}
              onTaskDatesChange={() => {}} />,
  )
  eq("a daily task draws no milestone link", count(daily, /class="zk-ms-link"/g), 0)
}

/*
 * --- keyboard: いま文字を打っているか ---
 *
 * 最後に置くのは、ここで偽の HTMLElement / document を globalThis に載せるため。
 * 先に置くと react-dom がそれを本物の DOM と読み違えかねない。判定そのものは
 * instanceof と tagName だけなので、その 2 つを持つ偽物で足りる。
 */
{
  class FakeElement {
    constructor(readonly tagName: string, readonly isContentEditable = false) {}
  }
  const globals = globalThis as unknown as Record<string, unknown>
  globals.HTMLElement = FakeElement
  const el = (tagName: string, isContentEditable = false) =>
    new FakeElement(tagName, isContentEditable) as unknown as EventTarget

  eq("typing in a text box counts as typing", isTyping(el("INPUT")), true)
  eq("typing in a textarea counts as typing", isTyping(el("TEXTAREA")), true)
  eq("an open select counts as typing", isTyping(el("SELECT")), true)
  eq("a contenteditable body counts as typing", isTyping(el("DIV", true)), true)
  // ここが false でないと、盤面の j / k / e が一切効かなくなる。
  eq("a plain div is not typing", isTyping(el("DIV")), false)
  eq("nothing focused is not typing", isTyping(null), false)
  // 入力欄の中で押した Ctrl+Z が盤面の日付を巻き戻していた事故の防止線。
  globals.document = { activeElement: el("INPUT") }
  eq("with no argument it asks what is focused right now", isTyping(), true)
  globals.document = { activeElement: null }
  eq("with no argument and nothing focused it is not typing", isTyping(), false)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
