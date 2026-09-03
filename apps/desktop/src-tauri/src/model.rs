use serde::{Deserialize, Serialize};

/// UI の Domain Model（packages/domain/src/schedule.ts）に対応する型。
/// serde の camelCase 変換で TypeScript 側とそのまま噛み合う。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignee {
    pub login: String,
    pub avatar_url: String,
}

/// Issue のラベル。Category 表示のグループになる。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    /// ラベルの node id。Issue への付け外しに使う
    pub id: String,
    pub name: String,
    /// GitHub が返す 6 桁の 16 進。先頭に # は付かない
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    /// マイルストーンの node id。Issue への設定・解除に使う
    pub id: String,
    pub title: String,
    pub due_on: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTask {
    /// Projects v2 の item id。日付フィールドの書き込み先
    pub id: String,
    /// Issue 本体の node id。タイトル・本文の書き換え先
    pub issue_id: String,
    /// Issue が属するリポジトリの node id。ラベルの一覧・作成に使う
    pub repository_id: String,
    pub issue_number: i64,
    pub title: String,
    /// Issue の本文。空文字は「本文なし」を表す
    pub body: String,
    pub url: String,
    /// GitHub 上で開いているか閉じているか。"OPEN" | "CLOSED"
    pub issue_state: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignees: Vec<Assignee>,
    pub labels: Vec<Label>,
    pub milestone: Option<Milestone>,
    pub progress: Option<f64>,
    pub updated_at: String,
    pub sync_state: String,
    /// この Issue のラベルを全部読めているか。
    ///
    /// updateIssue の labelIds は「置き換え集合」なので、読み切れていない状態で
    /// 保存すると読めなかったラベルが Issue から永久に外れる。false なら送らない。
    pub labels_complete: bool,
    /// この item のフィールド値を全部読めているか。
    ///
    /// Projects v2 は値の入っている全フィールドを返すため、独自フィールドが増えると
    /// Start Date / Target Date が後ろへ押し出される。false のとき日付が None なら、
    /// それは「未設定」ではなく「読めていない」。
    pub fields_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDefinition {
    pub id: String,
    pub name: String,
    pub data_type: String,
    pub options: Vec<FieldOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSchema {
    pub project_id: String,
    pub fields: Vec<FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub owner_type: String,
    pub owner_login: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateChange {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Issue の作成先候補（Project にリンクされたリポジトリ）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub id: String,
    pub name_with_owner: String,
}

/// Issue 本体（タイトル・本文）の編集内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContent {
    pub title: String,
    pub body: String,
    /// 付け替え後のラベル。指定した集合で置き換える。
    /// None は「ラベルに触らない」（読み切れていないときに使う）
    pub label_ids: Option<Vec<String>>,
    /// 付け替え後の Milestone の node id。None は「マイルストーンを外す」
    pub milestone_id: Option<String>,
    /// 編集を始めた時点の updatedAt。空なら競合を見ない（企画書 §16.3）
    #[serde(default)]
    pub expected_updated_at: String,
}

/// 親 Issue（GitHub の sub-issue 関係）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentIssue {
    pub issue_id: String,
    pub number: i64,
    pub title: String,
    pub url: String,
}

/// アプリから新しい Issue を起票するときの入力。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTaskInput {
    pub repository_id: String,
    pub title: String,
    pub body: Option<String>,
    /// 作成時に付けるラベルの node id。None・空なら付けない
    pub label_ids: Option<Vec<String>>,
    /// 作成時に設定する Milestone の node id
    pub milestone_id: Option<String>,
    /// 作成直後に設定する Status の選択肢 id（Projects v2 の options[].id）。
    /// Issue には無い値なので、Project へ追加した後でないと書き込めない。
    pub status_option_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub login: Option<String>,
    /// "env" | "stored" | "none"。どこから来たトークンで動いているかを UI に示す。
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// 企画書 §5.2 が必須とするフィールド名（推奨表記）。
pub const FIELD_STATUS: &str = "Status";
pub const FIELD_START_DATE: &str = "Start Date";
pub const FIELD_TARGET_DATE: &str = "Target Date";

/// フィールドの役割。表記ゆれを吸収して引くために使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldRole {
    Status,
    StartDate,
    EndDate,
    Priority,
    Progress,
}

impl FieldRole {
    /// 受け付ける名前（正規化済み）。先頭が推奨名。
    /// TypeScript 側（packages/domain/src/schedule.ts）と同じ規則。
    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            FieldRole::Status => &["status", "state"],
            FieldRole::StartDate => &["startdate", "start", "begin", "startson"],
            FieldRole::EndDate => &["targetdate", "enddate", "duedate", "target", "end", "due", "endson"],
            FieldRole::Priority => &["priority"],
            FieldRole::Progress => &["progress", "percentcomplete", "percent"],
        }
    }

    /// 見つからなかったときにユーザーへ示す推奨名。
    pub fn preferred_name(self) -> &'static str {
        match self {
            FieldRole::Status => FIELD_STATUS,
            FieldRole::StartDate => FIELD_START_DATE,
            FieldRole::EndDate => FIELD_TARGET_DATE,
            FieldRole::Priority => "Priority",
            FieldRole::Progress => "Progress",
        }
    }
}

/// 大文字小文字・空白・記号を落とす。"Start date" と "Start Date" を同一視するため。
pub fn normalize_field_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
