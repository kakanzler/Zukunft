use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult, ErrorKind};

/// アプリ内だけの設定。GitHub には一切書き戻さない。
///
/// ラベル名の意味は Project ごとに違う（同じ「Certification」でも、別の Project では
/// ただのラベルでありうる）ため、Project の node id をキーにして持つ。
/// BTreeMap なのは、保存のたびに JSON のキー順が入れ替わって差分が読めなくなるのを避けるため。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// project id -> 親カテゴリとして扱うラベル名
    #[serde(default)]
    pub parent_labels: BTreeMap<String, Vec<String>>,
}

/// 設定ファイルの置き場所。無ければ作る。
fn settings_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|error| {
        AppError::new(
            ErrorKind::Unknown,
            format!("設定の保存先を特定できませんでした: {error}"),
        )
    })?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|error| {
            AppError::new(
                ErrorKind::Unknown,
                format!("設定の保存先を作成できませんでした: {error}"),
            )
        })?;
    }
    Ok(dir.join("settings.json"))
}

/// 設定を読む。読めない場合は既定値を返す。
///
/// 失敗を握り潰すのは、この設定が「表示の好み」でしかないため。ファイルが無い初回起動も、
/// 手で編集して壊れた JSON も、アプリが開けない理由にはしない。
/// 壊れていた場合は次の書き込みで正しい内容に上書きされる。
fn read(app: &tauri::AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return AppSettings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// 設定を書く。読み取りと違い、失敗は握り潰さない。
/// 「保存した」と見えて次の起動で消えている方が、その場で失敗を知るより困る。
fn write(app: &tauri::AppHandle, settings: &AppSettings) -> AppResult<()> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|error| {
        AppError::new(ErrorKind::Unknown, format!("設定を変換できませんでした: {error}"))
    })?;
    std::fs::write(path, text).map_err(|error| {
        AppError::new(ErrorKind::Unknown, format!("設定を保存できませんでした: {error}"))
    })
}

/// 前後の空白を落とし、空文字と重複を除く。
/// ラベル名との突き合わせは名前の一致で行うので、見えない差異を持ち込ませない。
fn normalize(labels: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for label in labels {
        let trimmed = label.trim();
        if trimmed.is_empty() || result.iter().any(|kept| kept == trimmed) {
            continue;
        }
        result.push(trimmed.to_owned());
    }
    result
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, AppError> {
    Ok(read(&app))
}

/// その Project の親カテゴリ指定を丸ごと置き換える。
/// 空なら項目ごと消す。「選んでいない Project」の空配列がファイルに溜まらないようにするため。
#[tauri::command]
pub async fn set_parent_labels(
    app: tauri::AppHandle,
    project_id: String,
    labels: Vec<String>,
) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    let labels = normalize(labels);
    if labels.is_empty() {
        settings.parent_labels.remove(&project_id);
    } else {
        settings.parent_labels.insert(project_id, labels);
    }
    write(&app, &settings)?;
    Ok(settings)
}
