mod auth;
mod error;
mod github;
mod model;
mod settings;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use error::{AppError, AppResult, ErrorKind};
use github::GitHubClient;
use model::*;
use tauri_plugin_opener::OpenerExt;

/// アプリ全体で共有する状態。
///
/// フィールド ID の対応表をここにキャッシュする。ミューテーションには fieldId が
/// 必要だが、アプリが知っているのはフィールド「名」なので、Project を開いた時点で
/// 名前 → ID を引けるようにしておく（企画書 §7.3.3）。
#[derive(Default)]
pub struct AppState {
    http: reqwest::Client,
    /// project_id -> (field name -> field id)
    field_ids: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(github::USER_AGENT)
                // reqwest の既定は「待ち続ける」。スリープで死んだ接続がいつまでも
                // 返らず、復帰してからようやく通信エラーになるのを止める。
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                // 既定の 90s だと、スリープ中に OS が閉じた keep-alive のソケットを
                // 復帰後に使い回して 1 発目が必ず失敗する。張り直す方を常道にする。
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            field_ids: Mutex::new(HashMap::new()),
        }
    }

    fn client(&self) -> AppResult<GitHubClient> {
        Ok(GitHubClient::new(self.http.clone(), auth::resolve_token()?))
    }

    /// 正規化した名前で持つ。GitHub 上の表記ゆれを吸収するため。
    fn cache_fields(&self, project_id: &str, schema: &ProjectSchema) {
        let map = schema
            .fields
            .iter()
            .map(|f| (normalize_field_name(&f.name), f.id.clone()))
            .collect();
        if let Ok(mut cache) = self.field_ids.lock() {
            cache.insert(project_id.to_owned(), map);
        }
    }

    /// 役割から fieldId を引く。別名の優先順で探す。
    fn field_id(&self, project_id: &str, role: FieldRole) -> Option<String> {
        let cache = self.field_ids.lock().ok()?;
        let fields = cache.get(project_id)?;
        role.aliases()
            .iter()
            .find_map(|alias| fields.get(*alias).cloned())
    }

    /// フィールド不整合を受け取ったときはキャッシュを捨てる（企画書 §7.3.3）。
    fn invalidate_fields(&self, project_id: &str) {
        if let Ok(mut cache) = self.field_ids.lock() {
            cache.remove(project_id);
        }
    }
}

type State<'a> = tauri::State<'a, AppState>;

/* ---- 認証（企画書 §11） ---- */

#[tauri::command]
async fn auth_status(state: State<'_>) -> Result<AuthStatus, AppError> {
    auth::current_status(&state.http).await
}

#[tauri::command]
async fn auth_start_device_flow(state: State<'_>) -> Result<DeviceCode, AppError> {
    auth::start_device_flow(&state.http).await
}

#[tauri::command]
async fn auth_poll_device_flow(
    state: State<'_>,
    device_code: String,
) -> Result<AuthStatus, AppError> {
    auth::poll_device_flow(&state.http, &device_code).await
}

#[tauri::command]
async fn auth_sign_in_with_token(state: State<'_>, token: String) -> Result<AuthStatus, AppError> {
    auth::sign_in_with_token(&state.http, &token).await
}

#[tauri::command]
async fn auth_sign_out() -> Result<(), AppError> {
    // 環境変数が設定されている間は、資格情報ストアを消してもサインアウトにならない。
    // 「サインアウトしたのに使えたまま」を避けるため、黙って成功させない。
    if auth::token_from_env().is_some() {
        return Err(AppError::new(
            ErrorKind::Unsupported,
            "ZUKUNFT_GITHUB_TOKEN が設定されているためサインアウトできません。             環境変数を解除してからアプリを再起動してください",
        ));
    }
    auth::clear_token()
}

/// Device Flow の承認 URL を OS の既定ブラウザで開く。
/// WebView 内の `<a target="_blank">` では外部ブラウザが開かないため、
/// Rust 側に明示的な経路を用意する。
///
/// 任意の URL を開ける口にしないよう、GitHub のホストに限定する。
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    const ALLOWED: [&str; 2] = ["https://github.com/", "https://www.github.com/"];
    if !ALLOWED.iter().any(|prefix| url.starts_with(prefix)) {
        return Err(AppError::new(
            ErrorKind::Forbidden,
            "GitHub 以外の URL は開けません",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::new(ErrorKind::Unknown, format!("URL を開けませんでした: {error}")))
}

/* ---- 読み取り（企画書 §7.1） ---- */

#[tauri::command]
async fn list_projects(state: State<'_>, login: String) -> Result<Vec<ProjectSummary>, AppError> {
    // login が空なら、サインインしている本人の Project を見る。
    let login = if login.trim().is_empty() {
        auth::current_status(&state.http)
            .await?
            .login
            .ok_or_else(|| AppError::new(ErrorKind::Unauthorized, "GitHub にサインインしていません"))?
    } else {
        login
    };
    state.client()?.list_projects(&login).await
}

#[tauri::command]
async fn get_project_schema(state: State<'_>, project_id: String) -> Result<ProjectSchema, AppError> {
    let schema = state.client()?.project_schema(&project_id).await?;
    state.cache_fields(&project_id, &schema);
    Ok(schema)
}

#[tauri::command]
async fn get_tasks(state: State<'_>, project_id: String) -> Result<Vec<ScheduleTask>, AppError> {
    state.client()?.project_tasks(&project_id).await
}

#[tauri::command]
async fn list_repositories(
    state: State<'_>,
    project_id: String,
) -> Result<Vec<RepositorySummary>, AppError> {
    state.client()?.project_repositories(&project_id).await
}

/// Issue のタイトル・本文を書き換える。
///
/// 日付フィールドと違い Issue 本体への書き込みなので、キュー（企画書 §16）は通さず
/// 直接送る。ただし競合は見る — updateIssue はタイトル・本文・ラベルを丸ごと
/// 置き換えるので、編集を始めてから GitHub 側が変わっていた場合、そのまま送ると
/// 相手の変更が消える。編集中に再読み込みが走ると実際にそうなっていた。
///
/// updatedAt での判定は本文以外の変更でも弾くが、書き換える範囲が広いぶん
/// 「弾きすぎ」の方を選ぶ。expected_updated_at が空なら見ない。
#[tauri::command]
async fn update_task_content(
    state: State<'_>,
    task_id: String,
    issue_id: String,
    content: TaskContent,
) -> Result<ScheduleTask, AppError> {
    let title = content.title.trim();
    if title.is_empty() {
        return Err(AppError::new(ErrorKind::Unknown, "タイトルを入力してください"));
    }
    if issue_id.is_empty() {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "Issue の識別子が取得できていません。再読み込みしてください",
        ));
    }

    let client = state.client()?;

    // 書き込み直前に取り直して、読み取り時点から変わっていないか確かめる。
    if !content.expected_updated_at.is_empty() {
        let current = client.item(&task_id).await?;
        if current.updated_at != content.expected_updated_at {
            return Err(AppError::conflict(
                "GitHub 側でこの Issue が更新されています",
                current,
            ));
        }
    }

    client
        .update_issue(
            &issue_id,
            title,
            &content.body,
            content.label_ids.as_deref(),
            content.assignee_ids.as_deref(),
            content.milestone_id.as_deref(),
        )
        .await?;
    client.item(&task_id).await
}

/// この Issue の親（sub-issue 関係）。
#[tauri::command]
async fn get_parent_issue(
    state: State<'_>,
    issue_id: String,
) -> Result<Option<ParentIssue>, AppError> {
    state.client()?.issue_parent(&issue_id).await
}

/// 親を付け替える。parent_issue_id が None なら外す。
///
/// 外すには今の親が要る（GitHub の removeSubIssue は親を指定する）ので、
/// まず引き直してから外す。付けるときは replaceParent に任せる。
#[tauri::command]
async fn set_parent_issue(
    state: State<'_>,
    issue_id: String,
    parent_issue_id: Option<String>,
) -> Result<(), AppError> {
    let client = state.client()?;
    match parent_issue_id {
        Some(parent) => client.add_sub_issue(&parent, &issue_id).await,
        None => match client.issue_parent(&issue_id).await? {
            Some(current) => client.remove_sub_issue(&current.issue_id, &issue_id).await,
            // 元から親が無いなら何もしない。外す操作が失敗したことにはしない。
            None => Ok(()),
        },
    }
}

#[tauri::command]
async fn list_labels(state: State<'_>, repository_id: String) -> Result<Vec<Label>, AppError> {
    state.client()?.repository_labels(&repository_id).await
}

/// この Issue に担当として付けられるユーザー。
/// ラベルと違い作成の口は無い。候補は権限に応じて GitHub 側が決める。
#[tauri::command]
async fn list_assignable_users(
    state: State<'_>,
    repository_id: String,
) -> Result<Vec<Assignee>, AppError> {
    state.client()?.assignable_users(&repository_id).await
}

/// Issue に設定できる Milestone の候補（OPEN のみ）。
#[tauri::command]
async fn list_milestones(
    state: State<'_>,
    repository_id: String,
) -> Result<Vec<Milestone>, AppError> {
    state.client()?.repository_milestones(&repository_id).await
}

/// マイルストーンを新規作成する。作成しただけでは Issue には付かないので、
/// 呼び出し側が update_task_content で付け直す。
///
/// 引数がリポジトリの node id ではなく `owner/repo` なのは、GraphQL に milestone の
/// mutation が無く REST を使うため（github.rs の create_milestone）。REST は
/// owner/repo で引くもので、node id では引けない。
#[tauri::command]
async fn create_milestone(
    state: State<'_>,
    name_with_owner: String,
    title: String,
    due_on: Option<String>,
    description: Option<String>,
) -> Result<Milestone, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::new(ErrorKind::Unknown, "マイルストーンの題を入力してください"));
    }

    // owner と repo に割れない値は、そのまま送っても GitHub 側で 404 になるだけで
    // 「どこに作ろうとしたのか」が分からない。ここで理由の分かる形で弾く。
    let (owner, repo) = name_with_owner.split_once('/').ok_or_else(|| {
        AppError::new(
            ErrorKind::NotFound,
            format!("リポジトリの指定が owner/repo の形ではありません（{name_with_owner}）"),
        )
    })?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return Err(AppError::new(
            ErrorKind::NotFound,
            format!("リポジトリの指定が owner/repo の形ではありません（{name_with_owner}）"),
        ));
    }

    // 期日は任意。空文字は「未指定」として扱う — UI の日付欄は未入力を空文字で返す。
    let due_on = due_on.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if let Some(due) = due_on {
        // 形を確かめてから送る。崩れた値でも GitHub は 422 を返すが、
        // どの項目が悪いのかは応答から読み取れない。
        let shaped = due.len() == 10
            && due.as_bytes().iter().enumerate().all(|(i, byte)| match i {
                4 | 7 => *byte == b'-',
                _ => byte.is_ascii_digit(),
            });
        if !shaped {
            return Err(AppError::new(
                ErrorKind::Unknown,
                "期日は YYYY-MM-DD の形で指定してください",
            ));
        }
    }
    let description = description.as_deref().map(str::trim).filter(|value| !value.is_empty());

    state.client()?.create_milestone(owner, repo, title, due_on, description).await
}

/// ラベルを新規作成する。作成しただけでは Issue には付かないので、
/// 呼び出し側が update_task_content で付け直す。
#[tauri::command]
async fn create_label(
    state: State<'_>,
    repository_id: String,
    name: String,
    color: String,
) -> Result<Label, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new(ErrorKind::Unknown, "ラベル名を入力してください"));
    }
    // GitHub は先頭の # を受け付けないため、付いていれば落とす。
    let color = color.trim().trim_start_matches('#').to_ascii_lowercase();
    if color.len() != 6 || !color.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::new(
            ErrorKind::Unknown,
            "色は 6 桁の 16 進で指定してください（例: 1d76db）",
        ));
    }
    state.client()?.create_label(&repository_id, name, &color).await
}

/// ラベルの定義自体を削除する。
///
/// Issue から外すのと違い、そのラベルが付いていたすべての Issue から外れ、
/// GitHub 側にも復元手段が無い。実行してよいかの判断は UI 側の確認に任せ、
/// ここでは識別子の欠落だけを弾く。
#[tauri::command]
async fn delete_label(state: State<'_>, label_id: String) -> Result<(), AppError> {
    if label_id.is_empty() {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "ラベルの識別子が取得できていません。再読み込みしてください",
        ));
    }
    state.client()?.delete_label(&label_id).await
}

/* ---- 作成 ---- */

/// Issue を起票し、Project に追加して、指定があれば日付も入れる。
///
/// Issue の作成と Project への追加は別のミューテーションなので、
/// 追加に失敗すると「Issue はあるが Project に無い」状態が残る。
/// Issue の削除は破壊的なので自動では消さず、その旨をエラーに含めて
/// ユーザーに判断させる。
#[tauri::command]
async fn create_task(
    state: State<'_>,
    project_id: String,
    input: NewTaskInput,
) -> Result<ScheduleTask, AppError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::new(ErrorKind::Unknown, "タイトルを入力してください"));
    }

    let client = state.client()?;

    // 起票した Issue は自分に割り当てる。個人で使う道具なので、誰に振るかを
    // 毎回選ばせる意味が無い。ここで引けなければ起票そのものを止める — まだ
    // 何も作っていない段階なので取り返しがつくし、黙って未アサインで作ると
    // 「誰の担当でもない Issue」ができたことに気づけない。
    let assignee_id = client.viewer_id().await?;

    let issue_id = client
        .create_issue(
            &input.repository_id,
            title,
            input.body.as_deref(),
            input.label_ids.as_deref().unwrap_or(&[]),
            std::slice::from_ref(&assignee_id),
            input.milestone_id.as_deref(),
        )
        .await?;

    let item_id = match client.add_project_item(&project_id, &issue_id).await {
        Ok(id) => id,
        Err(error) => {
            return Err(AppError::new(
                error.kind,
                format!(
                    "Issue は作成されましたが Project に追加できませんでした（{}）。                     GitHub 上で Project に追加してください",
                    error.message
                ),
            ))
        }
    };

    // Status は Issue ではなく Projects v2 のフィールドなので、
    // Project へ追加した後でなければ書き込めない。ここも Issue は既に存在するので、
    // 失敗しても消さず「Status だけ入らなかった」と伝える。
    if let Some(option_id) = input
        .status_option_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let applied = match resolve_field_id(&state, &client, &project_id, FieldRole::Status).await
        {
            Ok(field_id) => {
                client
                    .update_single_select_field(&project_id, &item_id, &field_id, option_id)
                    .await
            }
            Err(error) => Err(error),
        };
        if let Err(error) = applied {
            state.invalidate_fields(&project_id);
            return Err(AppError::new(
                error.kind,
                format!(
                    "Issue は作成されましたが Status を設定できませんでした（{}）。                     GitHub 上で設定してください",
                    error.message
                ),
            ));
        }
    }

    // 日付は任意。入っていれば続けて設定する。失敗しても Issue 自体は残るため、
    // 日付だけ未設定の状態としてエラーを返す。
    for (role, value) in [
        (FieldRole::StartDate, input.start_date.as_deref()),
        (FieldRole::EndDate, input.end_date.as_deref()),
    ] {
        let Some(value) = value else { continue };
        let field_id = resolve_field_id(&state, &client, &project_id, role).await?;
        client
            .update_date_field(&project_id, &item_id, &field_id, value)
            .await?;
    }

    client.item(&item_id).await
}

/* ---- 書き込み（企画書 §7.3.3 / §16.2 / §16.3） ---- */

async fn resolve_field_id(
    state: &AppState,
    client: &GitHubClient,
    project_id: &str,
    role: FieldRole,
) -> AppResult<String> {
    if let Some(id) = state.field_id(project_id, role) {
        return Ok(id);
    }
    // 未キャッシュなら取り直す。Project を開かずに呼ばれた場合もここで回復する。
    let schema = client.project_schema(project_id).await?;
    state.cache_fields(project_id, &schema);
    state.field_id(project_id, role).ok_or_else(|| {
        let present = schema
            .fields
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        AppError::new(
            ErrorKind::FieldMissing,
            format!(
                "Project に「{}」に相当するフィールドがありません（現在: {}）",
                role.preferred_name(),
                if present.is_empty() { "なし" } else { &present }
            ),
        )
    })
}

#[tauri::command]
async fn update_task_dates(
    state: State<'_>,
    project_id: String,
    task_id: String,
    change: DateChange,
    expected_updated_at: String,
) -> Result<ScheduleTask, AppError> {
    let client = state.client()?;

    // 1. 書き込み直前に現在値を取り直し、読み取り時点から変わっていないか確かめる。
    //    Projects v2 にはバージョン番号が無いため updatedAt の一致で代用する（企画書 §16.3）。
    let current = client.item(&task_id).await?;
    if !expected_updated_at.is_empty() && current.updated_at != expected_updated_at {
        return Err(AppError::conflict(
            "GitHub 側が更新されています",
            current,
        ));
    }

    // 2. 変更するフィールドを並べる。バーの移動は 2 フィールドの更新になる。
    let mut updates: Vec<(FieldRole, String, Option<String>)> = Vec::new();
    if let Some(start) = change.start_date.clone() {
        updates.push((FieldRole::StartDate, start, current.start_date.clone()));
    }
    if let Some(end) = change.end_date.clone() {
        updates.push((FieldRole::EndDate, end, current.end_date.clone()));
    }
    if updates.is_empty() {
        return Ok(current);
    }

    // 3. 順に適用する。GraphQL にトランザクションが無いため、途中で失敗したら
    //    成功済みの分を元の値へ戻す（企画書 §16.2）。
    let mut applied: Vec<(FieldRole, Option<String>)> = Vec::new();
    for (role, value, previous) in &updates {
        let field_id = match resolve_field_id(&state, &client, &project_id, *role).await {
            Ok(id) => id,
            Err(error) => {
                state.invalidate_fields(&project_id);
                compensate(&state, &client, &project_id, &task_id, &applied).await;
                return Err(error);
            }
        };
        if let Err(error) = client
            .update_date_field(&project_id, &task_id, &field_id, value)
            .await
        {
            compensate(&state, &client, &project_id, &task_id, &applied).await;
            return Err(error);
        }
        applied.push((*role, previous.clone()));
    }

    // 4. 反映後の値を GitHub から読み直して返す。UI はこれで上書きする。
    client.item(&task_id).await
}

/// Status（Projects v2 の SINGLE_SELECT）を変更する。
///
/// 日付と違い競合検出（expectedUpdatedAt）を行わない。Status は Projects v2 の
/// フィールド値であって Issue 本体ではないため、変更しても Issue の updatedAt が動かない。
/// updatedAt での判定は Status の競合を検出できず、無関係な本文編集を弾くだけになる。
#[tauri::command]
async fn update_task_status(
    state: State<'_>,
    project_id: String,
    task_id: String,
    option_id: String,
) -> Result<ScheduleTask, AppError> {
    if option_id.trim().is_empty() {
        return Err(AppError::new(
            ErrorKind::Unknown,
            "Status の選択肢が指定されていません",
        ));
    }

    let client = state.client()?;
    let field_id = match resolve_field_id(&state, &client, &project_id, FieldRole::Status).await {
        Ok(id) => id,
        Err(error) => {
            // フィールド不整合はキャッシュが古い可能性があるので捨てる（企画書 §7.3.3）。
            state.invalidate_fields(&project_id);
            return Err(error);
        }
    };

    client
        .update_single_select_field(&project_id, &task_id, &field_id, &option_id)
        .await?;

    // 反映後の値を GitHub から読み直して返す。UI はこれで上書きする。
    client.item(&task_id).await
}

/// Priority（Projects v2 の SINGLE_SELECT）を変更する。`option_id` が None なら未設定に戻す。
///
/// Status と同じく競合検出は行わない。Projects v2 のフィールド値であって Issue 本体では
/// ないため、変更しても Issue の updatedAt が動かず、updatedAt では競合を判定できない。
#[tauri::command]
async fn update_task_priority(
    state: State<'_>,
    project_id: String,
    task_id: String,
    option_id: Option<String>,
) -> Result<ScheduleTask, AppError> {
    // 空文字は「未設定にしたい」のか「選び損ねた」のか読めない。None と同じには扱わず、
    // 呼び出し側の取り違えとしてここで止める。
    if option_id.as_deref().is_some_and(|id| id.trim().is_empty()) {
        return Err(AppError::new(
            ErrorKind::Unknown,
            "Priority の選択肢が指定されていません",
        ));
    }

    let client = state.client()?;
    let field_id = match resolve_field_id(&state, &client, &project_id, FieldRole::Priority).await {
        Ok(id) => id,
        Err(error) => {
            // フィールド不整合はキャッシュが古い可能性があるので捨てる（企画書 §7.3.3）。
            state.invalidate_fields(&project_id);
            return Err(error);
        }
    };

    match option_id {
        Some(id) => {
            client
                .update_single_select_field(&project_id, &task_id, &field_id, &id)
                .await?
        }
        None => client.clear_field(&project_id, &task_id, &field_id).await?,
    }

    // 反映後の値を GitHub から読み直して返す。UI はこれで上書きする。
    client.item(&task_id).await
}

/// Progress（Projects v2 の NUMBER）を変更する。`value` が None なら未設定に戻す。
///
/// Status と同じく競合検出は行わない。Projects v2 のフィールド値であって Issue 本体では
/// ないため、変更しても Issue の updatedAt が動かず、updatedAt では競合を判定できない。
#[tauri::command]
async fn update_task_progress(
    state: State<'_>,
    project_id: String,
    task_id: String,
    value: Option<f64>,
) -> Result<ScheduleTask, AppError> {
    // GitHub の NUMBER フィールドは任意の数を受けるので、送れてしまってから
    // 「120% の進捗」が Project に残る。進捗率として意味を持つ範囲でここで止める。
    if let Some(v) = value {
        if !(0.0..=100.0).contains(&v) {
            return Err(AppError::new(
                ErrorKind::Unknown,
                "Progress は 0〜100 で指定してください（進捗率として扱うため）",
            ));
        }
    }

    let client = state.client()?;
    let field_id = match resolve_field_id(&state, &client, &project_id, FieldRole::Progress).await {
        Ok(id) => id,
        Err(error) => {
            // フィールド不整合はキャッシュが古い可能性があるので捨てる（企画書 §7.3.3）。
            state.invalidate_fields(&project_id);
            return Err(error);
        }
    };

    match value {
        Some(v) => {
            client
                .update_number_field(&project_id, &task_id, &field_id, v)
                .await?
        }
        None => client.clear_field(&project_id, &task_id, &field_id).await?,
    }

    // 反映後の値を GitHub から読み直して返す。UI はこれで上書きする。
    client.item(&task_id).await
}

/// Issue を閉じる / 開き直す。
///
/// Status（Projects v2 のフィールド）とは別物で、GitHub 上の Issue そのものを動かす。
/// 反映後の値は item として読み直す。Issue だけを見ても Projects v2 の
/// フィールド値は分からず、UI が持つタスクを丸ごと置き換えられないため。
#[tauri::command]
async fn set_task_state(
    state: State<'_>,
    task_id: String,
    issue_id: String,
    issue_state: String,
) -> Result<ScheduleTask, AppError> {
    if issue_id.is_empty() {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "Issue の識別子が取得できていません。再読み込みしてください",
        ));
    }

    let client = state.client()?;
    match issue_state.as_str() {
        "CLOSED" => client.close_issue(&issue_id).await?,
        "OPEN" => client.reopen_issue(&issue_id).await?,
        other => {
            return Err(AppError::new(
                ErrorKind::Unknown,
                format!("Issue の状態「{other}」は指定できません"),
            ))
        }
    }
    client.item(&task_id).await
}

/// Issue を削除する。
///
/// Project から外すのではなく Issue そのものが消え、GitHub 側にも復元手段が無い。
/// 元に戻せない以上、実行してよいかの判断は UI 側の確認ダイアログに任せ、
/// ここでは識別子の欠落だけを弾く。
#[tauri::command]
async fn delete_task(state: State<'_>, issue_id: String) -> Result<(), AppError> {
    if issue_id.is_empty() {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "Issue の識別子が取得できていません。再読み込みしてください",
        ));
    }
    state.client()?.delete_issue(&issue_id).await
}

/// 部分適用の取り消し。ここも失敗した場合は GitHub 側が中間状態のまま残るため、
/// 呼び出し元は失敗として扱い、ユーザーに再取得を促す（企画書 §16.2）。
async fn compensate(
    state: &AppState,
    client: &GitHubClient,
    project_id: &str,
    task_id: &str,
    applied: &[(FieldRole, Option<String>)],
) {
    for (role, previous) in applied.iter().rev() {
        let Ok(field_id) = resolve_field_id(state, client, project_id, *role).await else {
            continue;
        };
        // 元々値が無かった場合は上書きでは戻せないので消す。
        let _ = match previous {
            Some(value) => client
                .update_date_field(project_id, task_id, &field_id, value)
                .await,
            None => client.clear_date_field(project_id, task_id, &field_id).await,
        };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            auth_status,
            auth_start_device_flow,
            auth_poll_device_flow,
            auth_sign_in_with_token,
            auth_sign_out,
            open_external,
            list_projects,
            get_project_schema,
            get_tasks,
            list_repositories,
            create_task,
            update_task_content,
            get_parent_issue,
            set_parent_issue,
            list_labels,
            list_assignable_users,
            list_milestones,
            create_milestone,
            create_label,
            delete_label,
            update_task_dates,
            update_task_status,
            update_task_priority,
            update_task_progress,
            set_task_state,
            delete_task,
            settings::get_settings,
            settings::set_parent_labels,
            settings::set_milestone_category,
            settings::set_daily_task,
            settings::set_window_settings,
            settings::set_auto_reschedule,
            settings::set_theme,
            settings::exit_fullscreen,
        ])
        // 保存されている窓の見せ方は、画面が出る前に当てる。
        // 起動後に当てると、既定の大きさで一度描いてから跳ねるのが見えてしまう。
        .setup(|app| {
            settings::apply_window_settings(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Zukunft");
}
