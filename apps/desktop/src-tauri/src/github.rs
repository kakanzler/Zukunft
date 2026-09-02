use serde_json::{json, Value};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::*;

pub const ENDPOINT: &str = "https://api.github.com/graphql";
pub const USER_AGENT: &str = "zukunft-desktop";

/// GraphQL の文面は packages/github/src/queries/*.graphql が正本。
/// TypeScript 側（Web の読み取り実装）と同じファイルを読むことで、
/// 2 言語に別々の文字列を持たせて食い違わせないようにする（企画書 §7.3）。
const FRAGMENTS: &str = include_str!("../../../../packages/github/src/queries/fragments.graphql");
const LIST_PROJECTS: &str =
    include_str!("../../../../packages/github/src/queries/listProjects.graphql");
const PROJECT_SCHEMA: &str =
    include_str!("../../../../packages/github/src/queries/projectSchema.graphql");
const PROJECT_ITEMS: &str =
    include_str!("../../../../packages/github/src/queries/projectItems.graphql");
const ITEM_UPDATED_AT: &str =
    include_str!("../../../../packages/github/src/queries/itemUpdatedAt.graphql");
const UPDATE_DATE_FIELD: &str =
    include_str!("../../../../packages/github/src/queries/updateDateField.graphql");
const UPDATE_SINGLE_SELECT_FIELD: &str =
    include_str!("../../../../packages/github/src/queries/updateSingleSelectField.graphql");
const UPDATE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/updateIssue.graphql");
const REPOSITORY_LABELS: &str =
    include_str!("../../../../packages/github/src/queries/repositoryLabels.graphql");
const REPOSITORY_MILESTONES: &str =
    include_str!("../../../../packages/github/src/queries/repositoryMilestones.graphql");
const CREATE_LABEL: &str =
    include_str!("../../../../packages/github/src/queries/createLabel.graphql");
const DELETE_LABEL: &str =
    include_str!("../../../../packages/github/src/queries/deleteLabel.graphql");

/// createLabel / deleteLabel は preview 扱いで、この Accept を付けないと失敗する。
const LABELS_PREVIEW_ACCEPT: &str = "application/vnd.github.bane-preview+json";
const CLEAR_DATE_FIELD: &str =
    include_str!("../../../../packages/github/src/queries/clearDateField.graphql");
const PROJECT_REPOSITORIES: &str =
    include_str!("../../../../packages/github/src/queries/projectRepositories.graphql");
const CREATE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/createIssue.graphql");
const ADD_PROJECT_ITEM: &str =
    include_str!("../../../../packages/github/src/queries/addProjectItem.graphql");
const CLOSE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/closeIssue.graphql");
const REOPEN_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/reopenIssue.graphql");
const DELETE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/deleteIssue.graphql");

fn with_fragments(document: &str) -> String {
    format!("{FRAGMENTS}\n{document}")
}

/// GraphQL は HTTP 200 でエラーを返すため、本文を見て分類し直す。
/// 認証状態の判定（auth::current_status）とデータ取得の両方から使う。
///
/// レート制限は type: "RATE_LIMITED" だけでなく type: "RATE_LIMIT" や
/// code: "graphql_rate_limit" でも返ってくる。どれか一つしか見ていないと
/// 残りが Unknown に落ち、「待てば直る」ことを UI に伝えられなくなるため、
/// 併せて拾う。
pub fn graphql_error(body: &Value) -> Option<AppError> {
    let first = body.get("errors").and_then(Value::as_array)?.first()?;
    let message = first
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("GitHub がエラーを返しました");
    let kind = match (
        first.get("type").and_then(Value::as_str),
        first.get("code").and_then(Value::as_str),
    ) {
        (Some("RATE_LIMITED" | "RATE_LIMIT"), _)
        | (_, Some("graphql_rate_limit" | "rate_limited")) => ErrorKind::RateLimited,
        (Some("NOT_FOUND"), _) => ErrorKind::NotFound,
        (Some("FORBIDDEN"), _) => ErrorKind::Forbidden,
        (Some("UNAUTHORIZED"), _) => ErrorKind::Unauthorized,
        _ => ErrorKind::Unknown,
    };
    Some(AppError::new(kind, message))
}

pub struct GitHubClient {
    http: reqwest::Client,
    token: String,
}

impl GitHubClient {
    pub fn new(http: reqwest::Client, token: String) -> Self {
        Self { http, token }
    }

    async fn graphql(&self, query: &str, variables: Value) -> AppResult<Value> {
        self.graphql_with_accept(query, variables, None).await
    }

    /// preview 扱いのミューテーション用に Accept を差し替えられるようにする。
    async fn graphql_with_accept(
        &self,
        query: &str,
        variables: Value,
        accept: Option<&str>,
    ) -> AppResult<Value> {
        let mut request = self
            .http
            .post(ENDPOINT)
            .bearer_auth(&self.token)
            .header("User-Agent", USER_AGENT);
        if let Some(accept) = accept {
            request = request.header("Accept", accept);
        }
        let response = request
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await?;

        let status = response.status();
        match status.as_u16() {
            401 => return Err(AppError::new(ErrorKind::Unauthorized, "トークンが無効です")),
            403 => {
                return Err(AppError::new(
                    ErrorKind::Forbidden,
                    "この Project を操作する権限がありません",
                ))
            }
            404 => return Err(AppError::new(ErrorKind::NotFound, "Project が見つかりません")),
            _ if !status.is_success() => {
                return Err(AppError::new(
                    ErrorKind::Unknown,
                    format!("GitHub が {status} を返しました"),
                ))
            }
            _ => {}
        }

        let body: Value = response.json().await?;

        // GraphQL は HTTP 200 でエラーを返すため、ここでも分類し直す。
        if let Some(error) = graphql_error(&body) {
            return Err(error);
        }

        body.get("data")
            .cloned()
            .filter(|data| !data.is_null())
            .ok_or_else(|| AppError::new(ErrorKind::Unknown, "GitHub の応答が空でした"))
    }

    pub async fn list_projects(&self, login: &str) -> AppResult<Vec<ProjectSummary>> {
        let data = self.graphql(LIST_PROJECTS, json!({ "login": login })).await?;
        let owner = data
            .get("repositoryOwner")
            .filter(|owner| !owner.is_null())
            .ok_or_else(|| {
                AppError::new(
                    ErrorKind::NotFound,
                    format!("GitHub に「{login}」が見つかりません"),
                )
            })?;

        let owner_type = match owner.get("__typename").and_then(Value::as_str) {
            Some("Organization") => "organization",
            _ => "user",
        };

        let nodes = owner
            .get("projectsV2")
            .and_then(|p| p.get("nodes"))
            .and_then(Value::as_array);

        let mut projects = Vec::new();
        for node in nodes.into_iter().flatten() {
            if let Some(summary) = project_summary(node, owner_type, login) {
                projects.push(summary);
            }
        }
        Ok(projects)
    }

    pub async fn project_schema(&self, project_id: &str) -> AppResult<ProjectSchema> {
        let data = self
            .graphql(PROJECT_SCHEMA, json!({ "projectId": project_id }))
            .await?;
        Ok(map_schema(project_id, &data))
    }

    /// items は 100 件ずつ endCursor で辿る（企画書 §7.3.2）。
    pub async fn project_tasks(&self, project_id: &str) -> AppResult<Vec<ScheduleTask>> {
        let query = with_fragments(PROJECT_ITEMS);
        let mut tasks = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let data = self
                .graphql(&query, json!({ "projectId": project_id, "after": after }))
                .await?;
            let items = data.get("node").and_then(|n| n.get("items"));
            for node in items
                .and_then(|i| i.get("nodes"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(task) = map_task(node) {
                    tasks.push(task);
                }
            }
            let page = items.and_then(|i| i.get("pageInfo"));
            let has_next = page
                .and_then(|p| p.get("hasNextPage"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !has_next {
                break;
            }
            after = page
                .and_then(|p| p.get("endCursor"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            if after.is_none() {
                break;
            }
        }
        Ok(tasks)
    }

    /// 書き込み直前の再取得。競合検出（企画書 §16.3）に使う。
    pub async fn item(&self, item_id: &str) -> AppResult<ScheduleTask> {
        let query = with_fragments(ITEM_UPDATED_AT);
        let data = self.graphql(&query, json!({ "itemId": item_id })).await?;
        data.get("node")
            .and_then(map_task)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "対象のタスクが見つかりません"))
    }

    /// Issue 本体（タイトル・本文・ラベル・Milestone）を書き換える。
    /// label_ids は「置き換え後の集合」で、渡した内容がそのまま Issue のラベルになる。
    /// milestone_id が None のときは JSON の null を送り、Milestone を外す。
    pub async fn update_issue(
        &self,
        issue_id: &str,
        title: &str,
        body: &str,
        label_ids: &[String],
        milestone_id: Option<&str>,
    ) -> AppResult<()> {
        self.graphql(
            UPDATE_ISSUE,
            json!({
                "issueId": issue_id,
                "title": title,
                "body": body,
                "labelIds": label_ids,
                // Option<&str> は None がそのまま null になる。
                // 変数を省くと GitHub 側は「変更しない」と解釈するため、明示的に載せる。
                "milestoneId": milestone_id,
            }),
        )
        .await
        .map(|_| ())
    }

    /// リポジトリに定義済みのラベル一覧。
    pub async fn repository_labels(&self, repository_id: &str) -> AppResult<Vec<Label>> {
        let data = self
            .graphql(REPOSITORY_LABELS, json!({ "repositoryId": repository_id }))
            .await?;
        let nodes = data
            .get("node")
            .and_then(|n| n.get("labels"))
            .and_then(|l| l.get("nodes"))
            .and_then(Value::as_array);
        Ok(nodes
            .into_iter()
            .flatten()
            .filter_map(read_label)
            .collect())
    }

    /// Issue に設定できる Milestone の候補（OPEN のみ）。
    pub async fn repository_milestones(&self, repository_id: &str) -> AppResult<Vec<Milestone>> {
        let data = self
            .graphql(REPOSITORY_MILESTONES, json!({ "repositoryId": repository_id }))
            .await?;
        let nodes = data
            .get("node")
            .and_then(|n| n.get("milestones"))
            .and_then(|m| m.get("nodes"))
            .and_then(Value::as_array);
        Ok(nodes
            .into_iter()
            .flatten()
            .filter_map(read_milestone)
            .collect())
    }

    /// ラベルの新規作成。preview の Accept が必要（LABELS_PREVIEW_ACCEPT）。
    pub async fn create_label(
        &self,
        repository_id: &str,
        name: &str,
        color: &str,
    ) -> AppResult<Label> {
        let data = self
            .graphql_with_accept(
                CREATE_LABEL,
                json!({ "repositoryId": repository_id, "name": name, "color": color }),
                Some(LABELS_PREVIEW_ACCEPT),
            )
            .await?;
        data.get("createLabel")
            .and_then(|c| c.get("label"))
            .and_then(read_label)
            .ok_or_else(|| AppError::new(ErrorKind::Unknown, "ラベルを作成できませんでした"))
    }

    /// ラベル定義そのものの削除。preview の Accept が必要（LABELS_PREVIEW_ACCEPT）。
    /// 付いていた Issue すべてから外れ、GitHub 側にも復元手段が無い。
    pub async fn delete_label(&self, label_id: &str) -> AppResult<()> {
        self.graphql_with_accept(
            DELETE_LABEL,
            json!({ "labelId": label_id }),
            Some(LABELS_PREVIEW_ACCEPT),
        )
        .await
        .map(|_| ())
    }

    /// フィールドの値を消す。元々未設定だったものを戻すのに使う。
    pub async fn clear_date_field(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
    ) -> AppResult<()> {
        self.graphql(
            CLEAR_DATE_FIELD,
            json!({ "projectId": project_id, "itemId": item_id, "fieldId": field_id }),
        )
        .await
        .map(|_| ())
    }

    pub async fn project_repositories(&self, project_id: &str) -> AppResult<Vec<RepositorySummary>> {
        let data = self
            .graphql(PROJECT_REPOSITORIES, json!({ "projectId": project_id }))
            .await?;
        let nodes = data
            .get("node")
            .and_then(|n| n.get("repositories"))
            .and_then(|r| r.get("nodes"))
            .and_then(Value::as_array);
        let mut repositories = Vec::new();
        for node in nodes.into_iter().flatten() {
            let (Some(id), Some(name)) = (
                node.get("id").and_then(Value::as_str),
                node.get("nameWithOwner").and_then(Value::as_str),
            ) else {
                continue;
            };
            repositories.push(RepositorySummary {
                id: id.to_owned(),
                name_with_owner: name.to_owned(),
            });
        }
        Ok(repositories)
    }

    /// Issue を作成し、その node id を返す。
    /// ラベルと Milestone は作成時に一緒に送る。後から付け直すと
    /// 通知が二重に飛ぶうえ、途中で失敗すると中途半端な Issue が残るため。
    pub async fn create_issue(
        &self,
        repository_id: &str,
        title: &str,
        body: Option<&str>,
        label_ids: &[String],
        milestone_id: Option<&str>,
    ) -> AppResult<String> {
        let data = self
            .graphql(
                CREATE_ISSUE,
                json!({
                    "repositoryId": repository_id,
                    "title": title,
                    "body": body,
                    "labelIds": label_ids,
                    // Option<&str> は None がそのまま null になる。
                    "milestoneId": milestone_id,
                }),
            )
            .await?;
        data.get("createIssue")
            .and_then(|c| c.get("issue"))
            .and_then(|i| i.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| AppError::new(ErrorKind::Unknown, "Issue を作成できませんでした"))
    }

    /// 作成した Issue を Project に追加し、item id を返す。
    pub async fn add_project_item(&self, project_id: &str, content_id: &str) -> AppResult<String> {
        let data = self
            .graphql(
                ADD_PROJECT_ITEM,
                json!({ "projectId": project_id, "contentId": content_id }),
            )
            .await?;
        data.get("addProjectV2ItemById")
            .and_then(|a| a.get("item"))
            .and_then(|i| i.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                AppError::new(ErrorKind::Unknown, "Issue を Project に追加できませんでした")
            })
    }

    pub async fn update_date_field(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
        date: &str,
    ) -> AppResult<()> {
        self.graphql(
            UPDATE_DATE_FIELD,
            json!({
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "date": date,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Issue を閉じる。Projects v2 のフィールドではなく Issue 本体を動かすため、
    /// 対象は item id ではなく Issue の node id。
    pub async fn close_issue(&self, issue_id: &str) -> AppResult<()> {
        self.graphql(CLOSE_ISSUE, json!({ "issueId": issue_id }))
            .await
            .map(|_| ())
    }

    /// 閉じた Issue を開き直す。close_issue と対になる。
    pub async fn reopen_issue(&self, issue_id: &str) -> AppResult<()> {
        self.graphql(REOPEN_ISSUE, json!({ "issueId": issue_id }))
            .await
            .map(|_| ())
    }

    /// Issue を削除する。Project から外すのではなく Issue そのものが消え、
    /// GitHub 側にも復元手段が無い。呼び出し側で必ず確認を取ってから使う。
    pub async fn delete_issue(&self, issue_id: &str) -> AppResult<()> {
        self.graphql(DELETE_ISSUE, json!({ "issueId": issue_id }))
            .await
            .map(|_| ())
    }

    /// SINGLE_SELECT（Status など）の値を変更する。
    /// 選択肢は名前ではなく optionId（ProjectSchema の options[].id）で指定する。
    pub async fn update_single_select_field(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
        option_id: &str,
    ) -> AppResult<()> {
        self.graphql(
            UPDATE_SINGLE_SELECT_FIELD,
            json!({
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "optionId": option_id,
            }),
        )
        .await
        .map(|_| ())
    }
}

/* ---- GraphQL 応答 → Domain Model（企画書 §7.1） ---- */

fn project_summary(node: &Value, owner_type: &str, login: &str) -> Option<ProjectSummary> {
    Some(ProjectSummary {
        id: node.get("id")?.as_str()?.to_owned(),
        number: node.get("number").and_then(Value::as_i64).unwrap_or(0),
        title: node.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
        url: node.get("url").and_then(Value::as_str).unwrap_or("").to_owned(),
        owner_type: owner_type.to_owned(),
        owner_login: login.to_owned(),
    })
}

fn map_schema(project_id: &str, data: &Value) -> ProjectSchema {
    let nodes = data
        .get("node")
        .and_then(|n| n.get("fields"))
        .and_then(|f| f.get("nodes"))
        .and_then(Value::as_array);

    let mut fields = Vec::new();
    for node in nodes.into_iter().flatten() {
        let (Some(id), Some(name)) = (
            node.get("id").and_then(Value::as_str),
            node.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let options = node
            .get("options")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|o| {
                        Some(FieldOption {
                            id: o.get("id")?.as_str()?.to_owned(),
                            name: o.get("name")?.as_str()?.to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        fields.push(FieldDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            data_type: node
                .get("dataType")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN")
                .to_owned(),
            options,
        });
    }

    ProjectSchema { project_id: project_id.to_owned(), fields }
}

/// 日付は `YYYY-MM-DD` に切り詰める。GitHub は Date 型でも
/// 日時形式を返すことがあるため、UI に渡す前にここで揃える。
fn read_label(value: &Value) -> Option<Label> {
    Some(Label {
        id: value.get("id")?.as_str()?.to_owned(),
        name: value.get("name")?.as_str()?.to_owned(),
        color: value.get("color").and_then(Value::as_str).unwrap_or("").to_owned(),
    })
}

/// id の無い Milestone は Issue に設定できないので落とす。
fn read_milestone(value: &Value) -> Option<Milestone> {
    Some(Milestone {
        id: value.get("id")?.as_str()?.to_owned(),
        title: value.get("title")?.as_str()?.to_owned(),
        due_on: read_date(value.get("dueOn").and_then(Value::as_str)),
    })
}

fn read_date(value: Option<&str>) -> Option<String> {
    let text = value?;
    if text.len() < 10 {
        return None;
    }
    Some(text[..10].to_owned())
}

/// item の fieldValues を「フィールド名 → 値」で引ける形に畳む。
/// Projects v2 は値が設定されているフィールドしか返さないため、未設定は欠落する。
fn index_field_values(item: &Value) -> std::collections::HashMap<String, &Value> {
    // 名前は正規化して入れる。GitHub 上の表記ゆれ（"Start date" など）でも
    // 同じ役割として引けるようにするため。
    let mut map = std::collections::HashMap::new();
    let nodes = item
        .get("fieldValues")
        .and_then(|f| f.get("nodes"))
        .and_then(Value::as_array);
    for value in nodes.into_iter().flatten() {
        if let Some(name) = value
            .get("field")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
        {
            map.insert(normalize_field_name(name), value);
        }
    }
    map
}

/// 役割に対応する値を、別名の優先順で引く。
fn value_of<'a>(
    values: &std::collections::HashMap<String, &'a Value>,
    role: FieldRole,
) -> Option<&'a Value> {
    role.aliases().iter().find_map(|alias| values.get(*alias).copied())
}

/// Issue を指さない item（Draft issue や PR）は Gantt の対象外。
fn map_task(item: &Value) -> Option<ScheduleTask> {
    let content = item.get("content")?;
    if content.get("__typename").and_then(Value::as_str) != Some("Issue") {
        return None;
    }
    let issue_number = content.get("number").and_then(Value::as_i64)?;
    let values = index_field_values(item);

    let assignees = content
        .get("assignees")
        .and_then(|a| a.get("nodes"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Assignee {
                        login: a.get("login")?.as_str()?.to_owned(),
                        avatar_url: a
                            .get("avatarUrl")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let labels = content
        .get("labels")
        .and_then(|l| l.get("nodes"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(read_label).collect())
        .unwrap_or_default();

    let milestone = content.get("milestone").filter(|m| !m.is_null()).map(|m| Milestone {
        id: m.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
        title: m.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
        due_on: read_date(m.get("dueOn").and_then(Value::as_str)),
    });

    let select_name = |role: FieldRole| {
        value_of(&values, role)
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let date_value = |role: FieldRole| {
        read_date(value_of(&values, role).and_then(|v| v.get("date")).and_then(Value::as_str))
    };

    Some(ScheduleTask {
        id: item.get("id")?.as_str()?.to_owned(),
        issue_id: content.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
        repository_id: content
            .get("repository")
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        issue_number,
        title: content
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        body: content.get("body").and_then(Value::as_str).unwrap_or("").to_owned(),
        url: content.get("url").and_then(Value::as_str).unwrap_or("").to_owned(),
        // 選択に入っていない応答では欠けるので、開いている扱いに寄せる。
        // 閉じたものを開いていると誤るより、逆のほうが害が大きい。
        issue_state: match content
            .get("state")
            .and_then(Value::as_str)
            .map(str::to_ascii_uppercase)
            .as_deref()
        {
            Some("CLOSED") => "CLOSED".to_owned(),
            _ => "OPEN".to_owned(),
        },
        start_date: date_value(FieldRole::StartDate),
        end_date: date_value(FieldRole::EndDate),
        status: select_name(FieldRole::Status),
        priority: select_name(FieldRole::Priority),
        assignees,
        labels,
        milestone,
        progress: value_of(&values, FieldRole::Progress)
            .and_then(|v| v.get("number"))
            .and_then(Value::as_f64),
        updated_at: content
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        sync_state: "synced".to_owned(),
    })
}
