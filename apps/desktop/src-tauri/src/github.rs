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
const UPDATE_NUMBER_FIELD: &str =
    include_str!("../../../../packages/github/src/queries/updateNumberField.graphql");
const UPDATE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/updateIssue.graphql");
const UPDATE_ISSUE_KEEP_LABELS: &str =
    include_str!("../../../../packages/github/src/queries/updateIssueKeepLabels.graphql");
const REPOSITORY_LABELS: &str =
    include_str!("../../../../packages/github/src/queries/repositoryLabels.graphql");
const ASSIGNABLE_USERS: &str =
    include_str!("../../../../packages/github/src/queries/assignableUsers.graphql");
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
const CLEAR_PROJECT_FIELD: &str =
    include_str!("../../../../packages/github/src/queries/clearProjectField.graphql");
const PROJECT_REPOSITORIES: &str =
    include_str!("../../../../packages/github/src/queries/projectRepositories.graphql");
const VIEWER: &str = include_str!("../../../../packages/github/src/queries/viewer.graphql");
const CREATE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/createIssue.graphql");
const ADD_PROJECT_ITEM: &str =
    include_str!("../../../../packages/github/src/queries/addProjectItem.graphql");
const CLOSE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/closeIssue.graphql");
const REOPEN_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/reopenIssue.graphql");
const ISSUE_PARENT: &str =
    include_str!("../../../../packages/github/src/queries/issueParent.graphql");
const ADD_SUB_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/addSubIssue.graphql");
const REMOVE_SUB_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/removeSubIssue.graphql");
const DELETE_ISSUE: &str =
    include_str!("../../../../packages/github/src/queries/deleteIssue.graphql");

fn with_fragments(document: &str) -> String {
    format!("{FRAGMENTS}\n{document}")
}

/// 二次レート制限かどうか。GitHub はこれを 403 で返すので、ヘッダで見分ける。
///
/// 残量が 0 の 403 と、Retry-After が付いた 403 のどちらもレート制限。
/// 権限の問題と区別できないと、待てば直るものを失敗として捨ててしまう。
fn is_rate_limited(response: &reqwest::Response) -> bool {
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok());
    if header("retry-after").is_some() {
        return true;
    }
    header("x-ratelimit-remaining").map(|v| v.trim() == "0").unwrap_or(false)
}

/// 待ち時間の指定（秒）。Retry-After が無ければ x-ratelimit-reset との差を使う。
fn read_retry_after(response: &reqwest::Response) -> Option<u64> {
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok());
    if let Some(seconds) = header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()) {
        return Some(seconds);
    }
    let reset = header("x-ratelimit-reset")?.trim().parse::<u64>().ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    reset.checked_sub(now)
}

fn rate_limit_message(retry_after: Option<u64>) -> String {
    match retry_after {
        Some(seconds) if seconds > 0 => {
            format!("GitHub のレート制限に達しました。約 {seconds} 秒後に再試行できます")
        }
        _ => "GitHub のレート制限に達しました。時間をおいて再試行してください".to_owned(),
    }
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
        // 分類の前にヘッダを読む。本文を読むと response を消費してしまう。
        let retry_after = read_retry_after(&response);
        let rate_limited = is_rate_limited(&response);

        match status.as_u16() {
            401 => return Err(AppError::new(ErrorKind::Unauthorized, "トークンが無効です")),
            // GitHub は二次レート制限も 403 で返す。全部を権限の問題にすると、
            // 「待てば直る」ものに「権限を確認してください」と案内してしまい、
            // しかも再送されないまま失敗として残る。
            403 if rate_limited => {
                return Err(AppError::new(ErrorKind::RateLimited, rate_limit_message(retry_after)))
            }
            403 => {
                return Err(AppError::new(
                    ErrorKind::Forbidden,
                    "この Project を操作する権限がありません",
                ))
            }
            404 => return Err(AppError::new(ErrorKind::NotFound, "Project が見つかりません")),
            429 => {
                return Err(AppError::new(ErrorKind::RateLimited, rate_limit_message(retry_after)))
            }
            // 5xx は GitHub 側の一時的な不調。待てば直るものとして再送に載せる。
            code if (500..600).contains(&code) => {
                return Err(AppError::new(
                    ErrorKind::Network,
                    format!("GitHub が {status} を返しました。時間をおいて再試行します"),
                ))
            }
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

    /// 接続を最後まで辿り、各ページの data をそのまま返す（企画書 §7.3.2）。
    ///
    /// GraphQL の接続はどれも pageInfo + nodes の同じ形なので、辿り方はここ 1 箇所に置く。
    /// ページごとの data を返すのは、list_projects のように接続の外側
    /// （__typename）も要る呼び出しがあるため。
    ///
    /// `path` は data から接続までのキー列。after は呼び出し側の variables に
    /// 上書きで載せるので、クエリ側が `$after: String` を宣言していること。
    async fn pages(&self, query: &str, variables: Value, path: &[&str]) -> AppResult<Vec<Value>> {
        let mut collected = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let mut vars = variables.clone();
            vars["after"] = json!(after);
            let data = self.graphql(query, vars).await?;

            let mut connection = Some(&data);
            for key in path {
                connection = connection.and_then(|value| value.get(*key));
            }
            let page = connection.and_then(|c| c.get("pageInfo"));
            let has_next = page
                .and_then(|p| p.get("hasNextPage"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let next = page
                .and_then(|p| p.get("endCursor"))
                .and_then(Value::as_str)
                .map(str::to_owned);

            collected.push(data);

            // カーソルが返らないのに続きがあると言われたら、そこで止める。
            // 同じページを永久に取り直すより、取り切れなかった方がまし。
            if !has_next || next.is_none() {
                break;
            }
            after = next;
        }
        Ok(collected)
    }

    pub async fn list_projects(&self, login: &str) -> AppResult<Vec<ProjectSummary>> {
        let pages = self
            .pages(LIST_PROJECTS, json!({ "login": login }), &["repositoryOwner", "projectsV2"])
            .await?;

        let mut projects = Vec::new();
        for data in &pages {
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

            for node in nodes.into_iter().flatten() {
                if let Some(summary) = project_summary(node, owner_type, login) {
                    projects.push(summary);
                }
            }
        }
        Ok(projects)
    }

    /// フィールド定義も辿る。読み落とすと、既にある Date / Status を
    /// 「作れ」と案内してしまう。
    pub async fn project_schema(&self, project_id: &str) -> AppResult<ProjectSchema> {
        let pages = self
            .pages(PROJECT_SCHEMA, json!({ "projectId": project_id }), &["node", "fields"])
            .await?;
        let mut fields = Vec::new();
        for data in &pages {
            fields.extend(map_schema(project_id, data).fields);
        }
        Ok(ProjectSchema {
            project_id: project_id.to_owned(),
            fields,
        })
    }

    /// items は 100 件ずつ endCursor で辿る（企画書 §7.3.2）。
    pub async fn project_tasks(&self, project_id: &str) -> AppResult<Vec<ScheduleTask>> {
        let query = with_fragments(PROJECT_ITEMS);
        let pages = self
            .pages(&query, json!({ "projectId": project_id }), &["node", "items"])
            .await?;
        let mut tasks = Vec::new();
        for data in &pages {
            for node in data
                .get("node")
                .and_then(|n| n.get("items"))
                .and_then(|i| i.get("nodes"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(task) = map_task(node) {
                    tasks.push(task);
                }
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
    ///
    /// label_ids が None のときは labelIds を持たない別のドキュメントを送る。
    /// 変数を null にするのではなく input からキーごと落とすことで、
    /// 「ラベルには触らない」を曖昧さなく表す。
    ///
    /// assignee_ids も同じ置き換え集合だが、こちらは変数を載せないだけで済む。
    /// 値の無い変数を使った input のキーは GraphQL 側で丸ごと落ちるので、
    /// ドキュメントを分けなくても「担当には触らない」になる。
    pub async fn update_issue(
        &self,
        issue_id: &str,
        title: &str,
        body: &str,
        label_ids: Option<&[String]>,
        assignee_ids: Option<&[String]>,
        milestone_id: Option<&str>,
    ) -> AppResult<()> {
        let mut variables = json!({
            "issueId": issue_id,
            "title": title,
            "body": body,
            // Option<&str> は None がそのまま null になる。
            // 変数を省くと GitHub 側は「変更しない」と解釈するため、明示的に載せる。
            "milestoneId": milestone_id,
        });
        // None のときはキーごと載せない。null を載せると「担当を全部外す」になる。
        if let Some(ids) = assignee_ids {
            variables["assigneeIds"] = json!(ids);
        }
        let document = match label_ids {
            Some(ids) => {
                variables["labelIds"] = json!(ids);
                UPDATE_ISSUE
            }
            None => UPDATE_ISSUE_KEEP_LABELS,
        };
        self.graphql(document, variables)
        .await
        .map(|_| ())
    }

    /// リポジトリに定義済みのラベル一覧。
    /// 読み落とすと、既にある名前での作成が失敗して理由が読めなくなる。
    pub async fn repository_labels(&self, repository_id: &str) -> AppResult<Vec<Label>> {
        let pages = self
            .pages(
                REPOSITORY_LABELS,
                json!({ "repositoryId": repository_id }),
                &["node", "labels"],
            )
            .await?;
        let mut labels = Vec::new();
        for data in &pages {
            let nodes = data
                .get("node")
                .and_then(|n| n.get("labels"))
                .and_then(|l| l.get("nodes"))
                .and_then(Value::as_array);
            labels.extend(nodes.into_iter().flatten().filter_map(read_label));
        }
        Ok(labels)
    }

    /// この Issue に担当として付けられるユーザー。
    /// 読み落とすと、実際には割り当てられる人が候補に出ない。
    pub async fn assignable_users(&self, repository_id: &str) -> AppResult<Vec<Assignee>> {
        let pages = self
            .pages(
                ASSIGNABLE_USERS,
                json!({ "repositoryId": repository_id }),
                &["node", "assignableUsers"],
            )
            .await?;
        let mut users = Vec::new();
        for data in &pages {
            let nodes = data
                .get("node")
                .and_then(|n| n.get("assignableUsers"))
                .and_then(|u| u.get("nodes"))
                .and_then(Value::as_array);
            users.extend(nodes.into_iter().flatten().filter_map(read_assignee));
        }
        Ok(users)
    }

    /// Issue に設定できる Milestone の候補（OPEN のみ）。
    pub async fn repository_milestones(&self, repository_id: &str) -> AppResult<Vec<Milestone>> {
        let pages = self
            .pages(
                REPOSITORY_MILESTONES,
                json!({ "repositoryId": repository_id }),
                &["node", "milestones"],
            )
            .await?;
        let mut milestones = Vec::new();
        for data in &pages {
            let nodes = data
                .get("node")
                .and_then(|n| n.get("milestones"))
                .and_then(|m| m.get("nodes"))
                .and_then(Value::as_array);
            milestones.extend(nodes.into_iter().flatten().filter_map(read_milestone));
        }
        Ok(milestones)
    }

    /// この Issue の親（sub-issue 関係）。設定が無ければ None。
    ///
    /// 一覧の取得とは別のクエリにしてある。sub-issue のフィールドが使えない
    /// GitHub ではここが失敗するが、その場合も詳細の 1 欄が出ないだけで済む。
    pub async fn issue_parent(&self, issue_id: &str) -> AppResult<Option<ParentIssue>> {
        let data = self
            .graphql(ISSUE_PARENT, json!({ "issueId": issue_id }))
            .await?;
        let parent = data
            .get("node")
            .and_then(|n| n.get("parent"))
            .filter(|p| !p.is_null());
        Ok(parent.and_then(|p| {
            Some(ParentIssue {
                issue_id: p.get("id")?.as_str()?.to_owned(),
                number: p.get("number").and_then(Value::as_i64).unwrap_or(0),
                title: p.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                url: p.get("url").and_then(Value::as_str).unwrap_or("").to_owned(),
            })
        }))
    }

    /// 親を付ける。既に別の親が付いていても付け替える（replaceParent）。
    pub async fn add_sub_issue(&self, parent_issue_id: &str, issue_id: &str) -> AppResult<()> {
        self.graphql(
            ADD_SUB_ISSUE,
            json!({ "issueId": parent_issue_id, "subIssueId": issue_id }),
        )
        .await
        .map(|_| ())
    }

    /// 親を外す。
    pub async fn remove_sub_issue(&self, parent_issue_id: &str, issue_id: &str) -> AppResult<()> {
        self.graphql(
            REMOVE_SUB_ISSUE,
            json!({ "issueId": parent_issue_id, "subIssueId": issue_id }),
        )
        .await
        .map(|_| ())
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

    /// 読み落としたリポジトリの Issue は「ラベル候補ゼロ」になり、保存すると
    /// ラベルが全部外れる。ここは特に切ってはいけない。
    pub async fn project_repositories(&self, project_id: &str) -> AppResult<Vec<RepositorySummary>> {
        let pages = self
            .pages(
                PROJECT_REPOSITORIES,
                json!({ "projectId": project_id }),
                &["node", "repositories"],
            )
            .await?;
        let mut repositories = Vec::new();
        for data in &pages {
            let nodes = data
                .get("node")
                .and_then(|n| n.get("repositories"))
                .and_then(|r| r.get("nodes"))
                .and_then(Value::as_array);
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
        }
        Ok(repositories)
    }

    /// Issue を作成し、その node id を返す。
    /// ラベルと Milestone は作成時に一緒に送る。後から付け直すと
    /// 通知が二重に飛ぶうえ、途中で失敗すると中途半端な Issue が残るため。
    /// サインインしているユーザー自身の node id。
    ///
    /// 呼ぶたびに引き直す。トークンはサインインし直しで入れ替わるのに、この
    /// プロセスは生きたままなので、覚えておくと別のアカウントに切り替えた後も
    /// 前のユーザーに割り当ててしまう。往復 1 回はこの間違いに見合わない。
    pub async fn viewer_id(&self) -> AppResult<String> {
        let data = self.graphql(VIEWER, json!({})).await?;
        data.get("viewer")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                AppError::new(ErrorKind::Unknown, "サインインしているユーザーを特定できませんでした")
            })
    }

    pub async fn create_issue(
        &self,
        repository_id: &str,
        title: &str,
        body: Option<&str>,
        label_ids: &[String],
        assignee_ids: &[String],
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
                    "assigneeIds": assignee_ids,
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

    /// NUMBER（Progress など）の値を変更する。
    /// 範囲の妥当性は呼び出し側で見る。GitHub 側は任意の数を受けるため、
    /// ここで弾くと「Progress だから 0〜100」という前提が通信層に紛れ込む。
    pub async fn update_number_field(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
        value: f64,
    ) -> AppResult<()> {
        self.graphql(
            UPDATE_NUMBER_FIELD,
            json!({
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "number": value,
            }),
        )
        .await
        .map(|_| ())
    }

    /// フィールドの値を未設定へ戻す。型を問わない。
    /// 0 や空文字の書き込みでは代用できない — Projects v2 では「未設定」と
    /// 「0 が入っている」が別の状態で、一覧やビューでの見え方も変わる。
    pub async fn clear_field(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
    ) -> AppResult<()> {
        self.graphql(
            CLEAR_PROJECT_FIELD,
            json!({ "projectId": project_id, "itemId": item_id, "fieldId": field_id }),
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

/// 担当 1 人ぶん。id が無いものは落とす。
/// 付け外しは node id で送るので、id を欠いたまま選ばせると必ず失敗する。
fn read_assignee(value: &Value) -> Option<Assignee> {
    Some(Assignee {
        id: value.get("id")?.as_str()?.to_owned(),
        login: value.get("login")?.as_str()?.to_owned(),
        avatar_url: value.get("avatarUrl").and_then(Value::as_str).unwrap_or("").to_owned(),
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

/// GitHub が返す日付・日時から先頭の YYYY-MM-DD を取る。
///
/// バイト数ではなく文字数で切る。len() で見て text[..10] とすると、先頭 10 バイトの
/// 途中に多バイト文字の境界が来たときに panic する。GitHub は今のところ ASCII しか
/// 返さないが、ここは Tauri コマンドから届く値なので、落ちない形にしておく。
fn read_date(value: Option<&str>) -> Option<String> {
    let date: String = value?.chars().take(10).collect();
    if date.chars().count() < 10 {
        return None;
    }
    Some(date)
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
        .map(|list| list.iter().filter_map(read_assignee).collect())
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
        labels_complete: is_complete(content.get("labels")),
        assignees_complete: is_complete(content.get("assignees")),
        fields_complete: is_complete(item.get("fieldValues")),
    })
}

/// その接続を読み切れたか。pageInfo が無ければ読み切った扱い。
///
/// 読み切れていないラベルで updateIssue を呼ぶと、読めなかった分が Issue から
/// 永久に外れる。ここで印を付け、画面側が保存を止められるようにする。
fn is_complete(connection: Option<&Value>) -> bool {
    !connection
        .and_then(|c| c.get("pageInfo"))
        .and_then(|p| p.get("hasNextPage"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_date_takes_the_leading_day() {
        assert_eq!(read_date(Some("2026-09-30T00:00:00Z")).as_deref(), Some("2026-09-30"));
        assert_eq!(read_date(Some("2026-09-30")).as_deref(), Some("2026-09-30"));
    }

    #[test]
    fn read_date_rejects_what_is_too_short() {
        assert_eq!(read_date(Some("2026-09")), None);
        assert_eq!(read_date(None), None);
    }

    /// バイトで切っていた頃はここで panic していた。
    #[test]
    fn read_date_does_not_panic_on_multibyte() {
        assert_eq!(read_date(Some("日付ではない値")), None);
        assert_eq!(read_date(Some("あいうえおかきくけこさ")).as_deref(), Some("あいうえおかきくけこ"));
    }

    #[test]
    fn is_complete_defaults_to_true() {
        // pageInfo を選択していない応答は「読み切った」に倒す。
        assert!(is_complete(None));
        assert!(is_complete(Some(&json!({}))));
        assert!(is_complete(Some(&json!({ "pageInfo": { "hasNextPage": false } }))));
    }

    #[test]
    fn is_complete_detects_truncation() {
        assert!(!is_complete(Some(&json!({ "pageInfo": { "hasNextPage": true } }))));
    }

    #[test]
    fn map_task_flags_truncated_labels() {
        let item = json!({
            "id": "item-1",
            "fieldValues": { "pageInfo": { "hasNextPage": false }, "nodes": [] },
            "content": {
                "__typename": "Issue",
                "id": "issue-1",
                "number": 101,
                "labels": { "pageInfo": { "hasNextPage": true }, "nodes": [] }
            }
        });
        let task = map_task(&item).expect("Issue なので変換できる");
        assert!(!task.labels_complete);
        assert!(task.fields_complete);
    }

    #[test]
    fn rate_limit_message_uses_retry_after() {
        assert!(rate_limit_message(Some(42)).contains("42"));
        // 0 や不明のときは秒数を出さない。「約 0 秒後」は案内になっていない。
        assert!(!rate_limit_message(Some(0)).contains("0 秒"));
        assert!(!rate_limit_message(None).contains("秒後"));
    }

    #[test]
    fn map_task_skips_non_issues() {
        let draft = json!({ "id": "item-1", "content": { "__typename": "DraftIssue" } });
        assert!(map_task(&draft).is_none());
    }
}
