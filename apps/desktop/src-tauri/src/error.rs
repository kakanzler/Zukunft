use serde::Serialize;

use crate::model::ScheduleTask;

/// UI 側の `GitHubErrorKind`（packages/github/src/repository.ts）と 1 対 1 で対応する。
/// 分類ごとに対処を出し分けるため、原因を潰さずここで区別する（企画書 §18）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    Unauthorized,
    Forbidden,
    NotFound,
    FieldMissing,
    RateLimited,
    Network,
    Conflict,
    Unsupported,
    Unknown,
}

/// Tauri command が Err で返す形。JS 側では reject の値として受け取る。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    /// 競合時に GitHub 側の現在値を載せる（企画書 §16.3）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<ScheduleTask>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), remote: None }
    }

    pub fn conflict(message: impl Into<String>, remote: ScheduleTask) -> Self {
        Self { kind: ErrorKind::Conflict, message: message.into(), remote: Some(remote) }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        // タイムアウトも接続断も、UI から見れば「通信できない」で同じ対処になる。
        AppError::new(ErrorKind::Network, format!("GitHub に接続できませんでした: {error}"))
    }
}

impl From<keyring::Error> for AppError {
    fn from(error: keyring::Error) -> Self {
        match error {
            keyring::Error::NoEntry => {
                AppError::new(ErrorKind::Unauthorized, "GitHub にサインインしていません")
            }
            other => AppError::new(ErrorKind::Unknown, format!("資格情報を読めませんでした: {other}")),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
