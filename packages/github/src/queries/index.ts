/**
 * GraphQL ドキュメント（企画書 §7.3）。
 *
 * 文面は隣の `.graphql` ファイルが正本で、Rust 側（デスクトップ）は
 * 同じファイルを `include_str!` で読む。TypeScript と Rust に
 * 別々の文字列を持たせて食い違わせないための構成。
 */
import fragments from "./fragments.graphql"
import itemUpdatedAt from "./itemUpdatedAt.graphql"
import listProjects from "./listProjects.graphql"
import projectItems from "./projectItems.graphql"
import projectSchema from "./projectSchema.graphql"
import projectRepositories from "./projectRepositories.graphql"
import createIssue from "./createIssue.graphql"
import viewer from "./viewer.graphql"
import addProjectItem from "./addProjectItem.graphql"
import updateDateField from "./updateDateField.graphql"
import updateSingleSelectField from "./updateSingleSelectField.graphql"
import updateNumberField from "./updateNumberField.graphql"
import updateIssue from "./updateIssue.graphql"
import updateIssueKeepLabels from "./updateIssueKeepLabels.graphql"
import repositoryLabels from "./repositoryLabels.graphql"
import assignableUsers from "./assignableUsers.graphql"
import repositoryMilestones from "./repositoryMilestones.graphql"
import createLabel from "./createLabel.graphql"
import deleteLabel from "./deleteLabel.graphql"
import clearDateField from "./clearDateField.graphql"
import clearProjectField from "./clearProjectField.graphql"
import closeIssue from "./closeIssue.graphql"
import reopenIssue from "./reopenIssue.graphql"
import deleteIssue from "./deleteIssue.graphql"
import issueParent from "./issueParent.graphql"
import addSubIssue from "./addSubIssue.graphql"
import removeSubIssue from "./removeSubIssue.graphql"

export const LIST_PROJECTS = listProjects
export const PROJECT_SCHEMA = projectSchema

/** items と単体取得は FieldValues フラグメントを必要とする。 */
export const PROJECT_ITEMS = `${fragments}\n${projectItems}`

/** 競合検出のため、書き込み直前に対象 item を取り直す（企画書 §16.3）。 */
export const ITEM_UPDATED_AT = `${fragments}\n${itemUpdatedAt}`

export const UPDATE_DATE_FIELD = updateDateField

/** Status の変更。選択肢は optionId で指定する。 */
export const UPDATE_SINGLE_SELECT_FIELD = updateSingleSelectField

/** Progress の変更。NUMBER フィールドは数値をそのまま送る。 */
export const UPDATE_NUMBER_FIELD = updateNumberField
export const UPDATE_ISSUE = updateIssue

/** ラベルを読み切れていないときに使う。labelIds を input ごと持たない。 */
export const UPDATE_ISSUE_KEEP_LABELS = updateIssueKeepLabels
export const REPOSITORY_LABELS = repositoryLabels

/** Issue に担当として付けられるユーザー。ラベルと違い作成はできず、候補は GitHub 側が決める。 */
export const ASSIGNABLE_USERS = assignableUsers

/** Issue に設定できる Milestone の候補（OPEN のみ）。 */
export const REPOSITORY_MILESTONES = repositoryMilestones
export const CREATE_LABEL = createLabel

/** ラベル定義そのものを消す。付いていた Issue すべてから外れ、取り消せない。 */
export const DELETE_LABEL = deleteLabel

/** createLabel / deleteLabel は preview 扱い。この Accept を付けないと失敗する。 */
export const LABELS_PREVIEW_ACCEPT = "application/vnd.github.bane-preview+json"
export const CLEAR_DATE_FIELD = clearDateField

/** 型を問わずフィールドの値を消す。未設定へ戻すのに使う。 */
export const CLEAR_PROJECT_FIELD = clearProjectField
export const PROJECT_REPOSITORIES = projectRepositories
export const CREATE_ISSUE = createIssue

/** サインインしているユーザー自身。起票時の担当に使う node id を引く。 */
export const VIEWER = viewer
export const ADD_PROJECT_ITEM = addProjectItem

/** Issue の開閉。Projects v2 のフィールドではなく Issue 本体を動かす。 */
export const CLOSE_ISSUE = closeIssue
export const REOPEN_ISSUE = reopenIssue

/** Issue ごと消す。取り消せないので、呼ぶ前に UI 側で確認を取る。 */
export const DELETE_ISSUE = deleteIssue

/** sub-issue（親子関係）。使えない GitHub もあるので一覧の選択には混ぜない。 */
export const ISSUE_PARENT = issueParent
export const ADD_SUB_ISSUE = addSubIssue
export const REMOVE_SUB_ISSUE = removeSubIssue
