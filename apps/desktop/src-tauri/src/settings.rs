use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult, ErrorKind};

/// ウィンドウの見せ方。
///
/// 「フルスクリーン」「最大化」「指定サイズ」の 3 つしか無い。解像度そのものを
/// 変えるのではなく、あくまでこのアプリの窓の大きさを決めるだけ — ディスプレイの
/// 設定に手を出すと、アプリを閉じたあとに何が残るのかが利用者から見えなくなる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    /// 指定した幅・高さの窓。
    Windowed,
    Maximized,
    /// 既定。Gantt は横に長く、既定の窓では常に軸が切れるため。
    #[default]
    Fullscreen,
}

/// 既定値は tauri.conf.json の windows[0] に合わせる。
/// 設定ファイルが無い初回起動で窓の大きさが変わってしまわないようにするため。
const DEFAULT_WIDTH: f64 = 1440.0;
const DEFAULT_HEIGHT: f64 = 900.0;
/// tauri.conf.json の minWidth / minHeight。ここより小さい値は保存させない。
const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 600.0;
/// 手で settings.json を書き換えられても、画面外に飛ばない範囲に収める。
const MAX_WIDTH: f64 = 7680.0;
const MAX_HEIGHT: f64 = 4320.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSettings {
    #[serde(default)]
    pub mode: WindowMode,
    /// Windowed のときの幅（論理ピクセル）。他のモードでも、戻ったときのために保つ。
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
}

fn default_width() -> f64 {
    DEFAULT_WIDTH
}

fn default_height() -> f64 {
    DEFAULT_HEIGHT
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            mode: WindowMode::default(),
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
        }
    }
}

impl WindowSettings {
    /// 壊れた値（NaN、極端な大きさ）を落とす。窓が開けなくなる方が設定の失敗より重い。
    fn normalized(self) -> Self {
        let clamp = |value: f64, min: f64, max: f64, fallback: f64| {
            if value.is_finite() {
                value.clamp(min, max)
            } else {
                fallback
            }
        };
        Self {
            mode: self.mode,
            width: clamp(self.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH),
            height: clamp(self.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT),
        }
    }
}

/// アプリ内だけの設定。GitHub には一切書き戻さない。
///
/// ラベル名の意味は Project ごとに違う（同じ「Certification」でも、別の Project では
/// ただのラベルでありうる）ため、Project の node id をキーにして持つ。
/// BTreeMap なのは、保存のたびに JSON のキー順が入れ替わって差分が読めなくなるのを避けるため。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// project id -> 親カテゴリとして扱うラベル名
    #[serde(default)]
    pub parent_labels: BTreeMap<String, Vec<String>>,
    /// 窓の見せ方。Project に依らないので、こちらはキーを持たない。
    #[serde(default)]
    pub window: WindowSettings,
    /// 依存関係に合わせて日程を自動で後ろへずらすか（企画書 §15.2）。
    /// 既定は有効 — 依存関係を書いた時点で守りたいという意思表示なので、そちらに倒す。
    #[serde(default = "default_true")]
    pub auto_reschedule: bool,
}

fn default_true() -> bool {
    true
}

/// Default は derive しない。bool の derive は false なので、設定ファイルが
/// 無い / 壊れている初回起動だけ auto_reschedule が既定と逆になってしまう。
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            parent_labels: BTreeMap::new(),
            window: WindowSettings::default(),
            auto_reschedule: default_true(),
        }
    }
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

/// 自動の日程調整を切り替える。
///
/// Project に依らない設定なので、窓の見せ方と同じくキーを持たない。
#[tauri::command]
pub async fn set_auto_reschedule(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    settings.auto_reschedule = enabled;
    write(&app, &settings)?;
    Ok(settings)
}

/// 保存されている見せ方をメインウィンドウに反映する。
///
/// 失敗は握り潰す。ウィンドウ操作が拒まれても（プラットフォーム都合など）、
/// 起動できないよりは既定の大きさで開く方がよい。
pub fn apply_window_settings(app: &tauri::AppHandle) {
    let settings = read(app).window.normalized();
    apply(app, settings);
}

fn apply(app: &tauri::AppHandle, window_settings: WindowSettings) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match window_settings.mode {
        WindowMode::Fullscreen => {
            let _ = window.set_fullscreen(true);
        }
        WindowMode::Maximized => {
            let _ = window.set_fullscreen(false);
            let _ = window.maximize();
        }
        WindowMode::Windowed => {
            let _ = window.set_fullscreen(false);
            let _ = window.unmaximize();
            let _ = window.set_size(tauri::LogicalSize::new(
                window_settings.width,
                window_settings.height,
            ));
            let _ = window.center();
        }
    }
}

/// フルスクリーンだけを解除する（Esc）。
///
/// 設定は書き換えない。Esc はその場から抜けるための操作であって、
/// 「次からは窓で開く」という意思表示ではないため、次の起動は保存済みの見せ方に戻る。
/// 抜けた先は保存済みの幅・高さ。フルスクリーンを外しただけだと、
/// プラットフォームによっては直前の中途半端な大きさが残る。
#[tauri::command]
pub async fn exit_fullscreen(app: tauri::AppHandle) -> Result<(), AppError> {
    let settings = read(&app).window.normalized();
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    if !is_fullscreen {
        return Ok(());
    }
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::LogicalSize::new(settings.width, settings.height));
    let _ = window.center();
    Ok(())
}

/// 窓の見せ方を保存し、その場で反映する。
///
/// 保存だけして次の起動を待たせない。設定を変えた結果がその場で見えないと、
/// 効いているのかどうかを確かめる手立てが無い。
#[tauri::command]
pub async fn set_window_settings(
    app: tauri::AppHandle,
    window: WindowSettings,
) -> Result<AppSettings, AppError> {
    let window = window.normalized();
    let mut settings = read(&app);
    settings.window = window;
    write(&app, &settings)?;
    apply(&app, window);
    Ok(settings)
}
