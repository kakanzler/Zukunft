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
import addProjectItem from "./addProjectItem.graphql"
import updateDateField from "./updateDateField.graphql"
import updateIssue from "./updateIssue.graphql"
import repositoryLabels from "./repositoryLabels.graphql"
import createLabel from "./createLabel.graphql"
import clearDateField from "./clearDateField.graphql"

export const LIST_PROJECTS = listProjects
export const PROJECT_SCHEMA = projectSchema

/** items と単体取得は FieldValues フラグメントを必要とする。 */
export const PROJECT_ITEMS = `${fragments}\n${projectItems}`

/** 競合検出のため、書き込み直前に対象 item を取り直す（企画書 §16.3）。 */
export const ITEM_UPDATED_AT = `${fragments}\n${itemUpdatedAt}`

export const UPDATE_DATE_FIELD = updateDateField
export const UPDATE_ISSUE = updateIssue
export const REPOSITORY_LABELS = repositoryLabels
export const CREATE_LABEL = createLabel

/** createLabel は preview 扱い。この Accept を付けないと失敗する。 */
export const LABELS_PREVIEW_ACCEPT = "application/vnd.github.bane-preview+json"
export const CLEAR_DATE_FIELD = clearDateField
export const PROJECT_REPOSITORIES = projectRepositories
export const CREATE_ISSUE = createIssue
export const ADD_PROJECT_ITEM = addProjectItem
