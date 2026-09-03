import {
  mapMilestones,
  mapProjectSchema,
  mapTask,
  mapTasks,
  statusOrder,
} from "../src/mapping"

/**
 * GraphQL 応答 → Domain Model の変換のテスト。
 *
 * ここが壊れると、間違った日付やラベルが黙って画面に出る。応答の形は
 * こちらの都合で変えられないので、実物に近い JSON を手で置いて確かめる。
 *
 * ハーネスは packages/domain/test/smoke.ts と同じものを踏襲する。
 * 別の流儀を持ち込むより、2 つ並べて読めることを優先する。
 */

let failures = 0
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${label}: got ${a}, want ${e}`) }
  else console.log(`ok   ${label}`)
}

/** item 1 件ぶんの応答。上書きしたいところだけ渡す。 */
const item = (over: Record<string, unknown> = {}) => ({
  id: "item-1",
  fieldValues: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { __typename: "ProjectV2ItemFieldDateValue", date: "2026-09-01", field: { name: "Start Date" } },
      { __typename: "ProjectV2ItemFieldDateValue", date: "2026-09-07", field: { name: "Target Date" } },
      { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In Progress", field: { name: "Status" } },
      { __typename: "ProjectV2ItemFieldNumberValue", number: 40, field: { name: "Progress" } },
    ],
  },
  content: {
    __typename: "Issue",
    id: "issue-1",
    number: 101,
    title: "Kickoff",
    url: "https://example/1",
    body: "本文",
    state: "OPEN",
    updatedAt: "2026-08-01T00:00:00Z",
    assignees: { pageInfo: { hasNextPage: false }, nodes: [{ id: "u1", login: "dev1", avatarUrl: "" }] },
    labels: { pageInfo: { hasNextPage: false }, nodes: [{ id: "l1", name: "design", color: "a855f7" }] },
    repository: { id: "repo-1" },
    milestone: { id: "ms-1", title: "v1", dueOn: "2026-09-30T00:00:00Z" },
  },
  ...over,
})
// この ; は消さないこと。次が素の { ブロックなので、無いと `({...})` を
// アロー関数の引数列と読まれ、ファイル全体が構文エラーになる。
;

// --- mapTask: 基本 ---
{
  const task = mapTask(item())!
  eq("maps ids", [task.id, task.issueId, task.repositoryId], ["item-1", "issue-1", "repo-1"])
  eq("maps dates", [task.startDate, task.endDate], ["2026-09-01", "2026-09-07"])
  eq("maps status", task.status, "In Progress")
  eq("maps progress", task.progress, 40)
  eq("maps labels", task.labels, [{ id: "l1", name: "design", color: "a855f7" }])
  eq("maps assignees", task.assignees, [{ id: "u1", login: "dev1", avatarUrl: "" }])
  // dueOn は日時で返るが、扱いは日付に揃える
  eq("milestone dueOn is a date", task.milestone!.dueOn, "2026-09-30")
  eq("complete by default",
     [task.labelsComplete, task.assigneesComplete, task.fieldsComplete], [true, true, true])
}

// --- mapTask: 表記ゆれと欠落 ---
{
  const renamed = item({
    fieldValues: {
      pageInfo: { hasNextPage: false },
      nodes: [
        // GitHub 上では "Start date" のように書かれることが多い
        { __typename: "ProjectV2ItemFieldDateValue", date: "2026-09-02", field: { name: "Start date" } },
        { __typename: "ProjectV2ItemFieldDateValue", date: "2026-09-08", field: { name: "Due Date" } },
      ],
    },
  })
  const task = mapTask(renamed)!
  eq("accepts field name variants", [task.startDate, task.endDate], ["2026-09-02", "2026-09-08"])

  const bare = mapTask(item({ fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] } }))!
  eq("missing values are null", [bare.startDate, bare.endDate, bare.status, bare.progress],
     [null, null, null, null])

  const closed = mapTask(item({ content: { ...item().content, state: "CLOSED" } }))!
  eq("reads closed state", closed.issueState, "CLOSED")
  // 状態が欠けている応答は「開いている」に寄せる
  const unknown = mapTask(item({ content: { ...item().content, state: undefined } }))!
  eq("missing state falls back to OPEN", unknown.issueState, "OPEN")
}

// --- mapTask: Issue でない item は落とす ---
{
  eq("draft issue is skipped", mapTask(item({ content: { __typename: "DraftIssue" } })), null)
  eq("null content is skipped", mapTask(item({ content: null })), null)
}

// --- mapTask: 取りこぼしの検出（この 2 つが A 群の回帰テスト） ---
{
  const labelsCut = mapTask(item({
    content: {
      ...item().content,
      labels: { pageInfo: { hasNextPage: true }, nodes: [{ id: "l1", name: "design", color: "" }] },
    },
  }))!
  eq("truncated labels are flagged", labelsCut.labelsComplete, false)
  eq("truncated labels do not affect fields", labelsCut.fieldsComplete, true)

  // assigneeIds も置き換え集合なので、読み切れていないまま保存させてはいけない。
  const assigneesCut = mapTask(item({
    content: {
      ...item().content,
      assignees: { pageInfo: { hasNextPage: true }, nodes: [{ id: "u1", login: "dev1", avatarUrl: "" }] },
    },
  }))!
  eq("truncated assignees are flagged", assigneesCut.assigneesComplete, false)
  eq("truncated assignees do not affect labels", assigneesCut.labelsComplete, true)

  const fieldsCut = mapTask(item({
    fieldValues: { pageInfo: { hasNextPage: true }, nodes: [] },
  }))!
  eq("truncated field values are flagged", fieldsCut.fieldsComplete, false)
  eq("truncated fields do not affect labels", fieldsCut.labelsComplete, true)
  eq("truncated fields do not affect assignees", fieldsCut.assigneesComplete, true)

  // pageInfo が無い応答は「読み切った」に倒す
  const noPageInfo = mapTask(item({
    fieldValues: { nodes: [] },
    content: { ...item().content, labels: { nodes: [] }, assignees: { nodes: [] } },
  }))!
  eq("absent pageInfo counts as complete",
     [noPageInfo.labelsComplete, noPageInfo.assigneesComplete, noPageInfo.fieldsComplete],
     [true, true, true])
}

// --- mapTasks: ページの終わりを endCursor で表す ---
{
  const page = (hasNextPage: boolean, endCursor: string | null) => ({
    node: { items: { pageInfo: { hasNextPage, endCursor }, nodes: [item()] } },
  })
  eq("last page has no cursor", mapTasks(page(false, "c1")).endCursor, null)
  eq("more pages return the cursor", mapTasks(page(true, "c1")).endCursor, "c1")
  // 続きがあると言われてもカーソルが無ければ辿れない
  eq("missing cursor stops paging", mapTasks(page(true, null)).endCursor, null)
  eq("maps every node", mapTasks(page(false, null)).tasks.length, 1)
  eq("empty response is empty", mapTasks({}).tasks, [])
}

// --- mapProjectSchema ---
{
  const raw = (hasNextPage = false) => ({
    node: {
      fields: {
        pageInfo: { hasNextPage, endCursor: "f1" },
        nodes: [
          { id: "f-status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "Planning" }, { id: "o2", name: "Done" }] },
          { id: "f-start", name: "Start Date", dataType: "DATE" },
          // id や name の無いものは書き込み先にならないので落とす
          { name: "壊れた定義" },
          { id: "f-unknown", name: "Iteration", dataType: "ITERATION" },
        ],
      },
    },
  })
  const { schema, endCursor } = mapProjectSchema("p1", raw())
  eq("keeps the project id", schema.projectId, "p1")
  eq("drops fields without id", schema.fields.map((f) => f.id), ["f-status", "f-start", "f-unknown"])
  eq("keeps single select options", schema.fields[0]!.options.map((o) => o.name), ["Planning", "Done"])
  eq("schema last page has no cursor", endCursor, null)
  eq("schema more pages return the cursor", mapProjectSchema("p1", raw(true)).endCursor, "f1")
  eq("status order follows the definition", statusOrder(schema), ["Planning", "Done"])
}

// --- mapMilestones ---
{
  const raw = (hasNextPage = false) => ({
    node: {
      milestones: {
        pageInfo: { hasNextPage, endCursor: "m1" },
        nodes: [
          { id: "ms-1", title: "v1", dueOn: "2026-09-30T00:00:00Z" },
          { id: "ms-2", title: "期日なし", dueOn: null },
          // id が無い Milestone は Issue に設定できない
          { title: "壊れた定義" },
        ],
      },
    },
  })
  const { milestones, endCursor } = mapMilestones(raw())
  eq("drops milestones without id", milestones.map((m) => m.id), ["ms-1", "ms-2"])
  eq("dueOn becomes a date", milestones[0]!.dueOn, "2026-09-30")
  eq("null dueOn stays null", milestones[1]!.dueOn, null)
  eq("milestone last page has no cursor", endCursor, null)
  eq("milestone more pages return the cursor", mapMilestones(raw(true)).endCursor, "m1")
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
