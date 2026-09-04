use std::collections::BTreeMap;
use std::path::PathBuf;

// 画像のバイト列は JSON の IPC に乗らないので、画面との間では base64 の文字列で渡す。
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize};
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

/// 繰り返し方。packages/domain の `RecurrenceRule` と同じ形（`kind` で判別）にする。
///
/// 画面側の型に寄せるのは、設定ファイルと TypeScript の間で詰め替えを挟まないため。
/// 詰め替えを入れると、繰り返し方が増えるたびに両側の対応表を直すことになる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecurrenceRule {
    /// N 日ごと。1 なら毎日
    #[serde(rename_all = "camelCase")]
    Interval { interval_days: u32 },
    /// 1, 3, 5, 7, 11, 15 日で広がる並び。間隔は決まっているので値を持たない
    Spaced,
}

impl RecurrenceRule {
    /// 実行日の計算が進む値かどうか。間隔 0 は点が並ばないので日課として意味を持たない。
    fn is_usable(&self) -> bool {
        match self {
            Self::Interval { interval_days } => *interval_days >= 1,
            Self::Spaced => true,
        }
    }
}

/// 日課（繰り返し）の設定。
///
/// 日付はここに持たない。最初の実行日は Issue の Start Date、最後の実行日は
/// Target Date（空なら開始日から 1 年）をそのまま使う。設定側にも日付を持つと、横軸の
/// 範囲や絞り込みが見ている GitHub 側の日付と二重管理になって食い違う。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTask {
    /// 繰り返し方
    pub rule: RecurrenceRule,
    /// 実行した日（YYYY-MM-DD）。順序は問わない
    #[serde(default)]
    pub done: Vec<String>,
}

/// project id -> task id -> 日課の設定。
pub type DailyTasks = BTreeMap<String, BTreeMap<String, DailyTask>>;

/// 日課の設定を、読める項目だけ拾って組み立てる。
///
/// 素直に derive した Deserialize に任せると、形の合わない項目が 1 つあるだけで
/// JSON 全体の解釈が失敗する。read() は失敗を既定値に倒すので、日課 1 件の
/// 食い違いで親カテゴリもテーマも窓の大きさも消える。捨てるのはその項目だけにする。
fn collect_daily_tasks(raw: &serde_json::Value) -> DailyTasks {
    let mut result = DailyTasks::new();
    let Some(projects) = raw.as_object() else {
        return result;
    };
    for (project_id, tasks) in projects {
        let Some(tasks) = tasks.as_object() else {
            continue;
        };
        let mut kept: BTreeMap<String, DailyTask> = BTreeMap::new();
        for (task_id, value) in tasks {
            let Ok(task) = serde_json::from_value::<DailyTask>(value.clone()) else {
                continue;
            };
            if task.rule.is_usable() {
                kept.insert(task_id.clone(), task);
            }
        }
        // 中身が全部落ちた Project の項目は残さない。set_daily_task の削除と同じ形にする。
        if !kept.is_empty() {
            result.insert(project_id.clone(), kept);
        }
    }
    result
}

fn deserialize_daily_tasks<'de, D>(deserializer: D) -> Result<DailyTasks, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(collect_daily_tasks(&raw))
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
    /// マイルストーンの node id -> 割り当てたカテゴリ（ラベル名）。
    ///
    /// 題名ではなく id を鍵にするのは、GitHub 上で題名を変えても割り当てが
    /// 外れないようにするため。Project ではなくマイルストーンに属する設定なので、
    /// parent_labels のように project id で括らない。
    #[serde(default)]
    pub milestone_categories: BTreeMap<String, String>,
    /// 窓の見せ方。Project に依らないので、こちらはキーを持たない。
    #[serde(default)]
    pub window: WindowSettings,
    /// 依存関係に合わせて日程を自動で後ろへずらすか（企画書 §15.2）。
    /// 既定は有効 — 依存関係を書いた時点で守りたいという意思表示なので、そちらに倒す。
    #[serde(default = "default_true")]
    pub auto_reschedule: bool,
    /// 盤面の意匠。既定は今までの見た目。
    /// 値の妥当性は画面側（packages/gantt の isGanttTheme）で見る。ここは素通しにして、
    /// 意匠が増えるたびに Rust を直さずに済ませる。
    #[serde(default = "default_theme")]
    pub theme: String,
    /// project id -> task id -> 日課の設定。
    ///
    /// 鍵はタスクの id だが、parent_labels と同じく Project で括る。読み込まれる
    /// タスクの一覧は「いま開いている Project の分」だけなので、平らな対応表のまま
    /// 「消えた Issue の分を掘り取る」と、別の Project の日課まで巻き添えで消える。
    /// BTreeMap なのは、保存のたびに JSON のキー順が入れ替わって差分が読めなく
    /// なるのを避けるため。
    #[serde(default, deserialize_with = "deserialize_daily_tasks")]
    pub daily_tasks: DailyTasks,
    /// 背景画像の種類（image/png など）。画像そのものはここに持たない。
    ///
    /// write() は設定を毎回まるごと書き直すので、数 MB の画像を混ぜると
    /// 無関係な設定を 1 つ変えるたびに画像も書き直すことになる。実体は
    /// background_image.bin に置き、ここには data: URL を組み直すのに要る
    /// 種類だけを残す。None なら背景画像なし。
    #[serde(default)]
    pub background_image_mime: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "default".to_owned()
}

/// Default は derive しない。bool の derive は false なので、設定ファイルが
/// 無い / 壊れている初回起動だけ auto_reschedule が既定と逆になってしまう。
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            parent_labels: BTreeMap::new(),
            milestone_categories: BTreeMap::new(),
            window: WindowSettings::default(),
            auto_reschedule: default_true(),
            theme: default_theme(),
            daily_tasks: DailyTasks::new(),
            background_image_mime: None,
        }
    }
}

/// 設定の置き場所。無ければ作る。
///
/// settings.json と背景画像は別のファイルだが、置き場所は同じ。
/// 保存先を決める判断が 2 か所に分かれると、片方だけ別の場所を指しうる。
fn config_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
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
    Ok(dir)
}

/// 設定ファイルの置き場所。無ければ作る。
fn settings_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("settings.json"))
}

/// 背景画像の実体の置き場所。
///
/// 拡張子を画像の種類（.png / .jpg）に合わせないのは、種類が変わったときに
/// 前の拡張子のファイルが残るため。中身の種類は settings.json 側が持つ。
fn background_image_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("background_image.bin"))
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
    write_atomically(&path, &text)
}

/// 一時ファイルへ書いてから置き換える。
///
/// 直接上書きすると、途中で落ちたときやディスクが一杯のときに、中途半端な JSON が
/// 残る。read() は壊れたファイルを既定値に倒すので、全 Project の親カテゴリと
/// テーマと窓の設定が理由も出ずに消える。書けたものだけが見えるようにする。
fn write_atomically(path: &std::path::Path, text: &str) -> AppResult<()> {
    write_bytes_atomically(path, text.as_bytes(), "設定")
}

/// 画像のようにテキストでないものも同じ流儀で置き換える。
///
/// what は失敗したときに名指しする対象（「設定」「背景画像」）。どちらが書けなかったのか
/// 分からないと、利用者は設定を開き直すべきか画像を選び直すべきかを決められない。
fn write_bytes_atomically(path: &std::path::Path, bytes: &[u8], what: &str) -> AppResult<()> {
    // 一時ファイルは元の拡張子に .tmp を足す。拡張子ごと差し替えると、
    // 別の名前のファイル（settings.tmp）が本体と紛らわしい場所に残りうる。
    let temp = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => path.with_extension(format!("{ext}.tmp")),
        None => path.with_extension("tmp"),
    };
    let save = |error: std::io::Error| {
        AppError::new(ErrorKind::Unknown, format!("{what}を保存できませんでした: {error}"))
    };
    std::fs::write(&temp, bytes).map_err(save)?;
    // Windows の rename は上書きしないので、std::fs::rename を使う
    // （こちらは既存を置き換える）。失敗したら一時ファイルを残さない。
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        save(error)
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

/// マイルストーンに割り当てるカテゴリ（ラベル名）を決める。
///
/// 空文字なら項目ごと消す。set_parent_labels と同じ流儀で、
/// 「割り当てを外した」印としての空文字がファイルに溜まらないようにするため。
#[tauri::command]
pub async fn set_milestone_category(
    app: tauri::AppHandle,
    milestone_id: String,
    label: String,
) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    // 突き合わせはラベル名で行うので、見えない前後の空白を持ち込ませない。
    let label = label.trim().to_owned();
    if label.is_empty() {
        settings.milestone_categories.remove(&milestone_id);
    } else {
        settings.milestone_categories.insert(milestone_id, label);
    }
    write(&app, &settings)?;
    Ok(settings)
}

/// 日課の項目を入れ替える。rule が無ければ（＝日課をやめるなら）消す。
///
/// コマンド本体から切り出しているのは、AppHandle 無しで確かめられるようにするため。
/// normalize と同じ扱いで、判断そのものはテストから直接呼ぶ。
fn put_daily_task(
    settings: &mut AppSettings,
    project_id: String,
    task_id: String,
    rule: Option<RecurrenceRule>,
    done: Vec<String>,
) {
    // 間隔 0 は点が並ばないので、日課として残しても意味がない。null と同じ扱いで消す。
    let rule = rule.filter(RecurrenceRule::is_usable);
    let Some(rule) = rule else {
        let Some(tasks) = settings.daily_tasks.get_mut(&project_id) else {
            return;
        };
        tasks.remove(&task_id);
        // 中が空になった Project の項目は落とす。set_parent_labels が空配列で
        // 項目を消すのと同じ流儀で、空の入れ物がファイルに溜まらないようにするため。
        if tasks.is_empty() {
            settings.daily_tasks.remove(&project_id);
        }
        return;
    };
    settings
        .daily_tasks
        .entry(project_id)
        .or_default()
        .insert(task_id, DailyTask { rule, done });
}

/// タスクを日課にする、または日課の内容（繰り返し方・実行した日）を置き換える。
///
/// rule が null なら項目ごと消す ＝ 日課をやめる。set_parent_labels と
/// 同じ流儀で、「やめた」印がファイルに溜まらないようにするため。
#[tauri::command]
pub async fn set_daily_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    rule: Option<RecurrenceRule>,
    done: Vec<String>,
) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    put_daily_task(&mut settings, project_id, task_id, rule, done);
    write(&app, &settings)?;
    Ok(settings)
}

/// その Project の日課から、いま存在しないタスクの分を落とす。消したら true。
///
/// task_ids が空なら何もしない。「タスクを読み込めなかった」と「本当に 0 件」を
/// ここでは区別できず、掘り取ると読み込みが失敗しただけでその Project の
/// 日課の設定が丸ごと消える。
fn prune_daily_tasks_of(settings: &mut AppSettings, project_id: &str, task_ids: &[String]) -> bool {
    if task_ids.is_empty() {
        return false;
    }
    let Some(tasks) = settings.daily_tasks.get_mut(project_id) else {
        return false;
    };
    let alive: std::collections::HashSet<&str> = task_ids.iter().map(String::as_str).collect();
    let before = tasks.len();
    tasks.retain(|task_id, _| alive.contains(task_id.as_str()));
    let removed = tasks.len() != before;
    if tasks.is_empty() {
        settings.daily_tasks.remove(project_id);
    }
    removed
}

/// 消えた Issue の日課の設定を掘り取る。
///
/// 鍵にしている task id は GitHub 側の都合で消える（Issue を消した、Project から
/// 外した）が、設定ファイルには残り続ける。同じ Project を開くたびに増える一方に
/// ならないよう、いま見えているタスクに無い分をここで落とす。
///
/// 何も消さなかったときは書かない。Project を切り替えるたびに同じ内容で
/// 設定ファイルを書き直すことになるため。
#[tauri::command]
pub async fn prune_daily_tasks(
    app: tauri::AppHandle,
    project_id: String,
    task_ids: Vec<String>,
) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    if prune_daily_tasks_of(&mut settings, &project_id, &task_ids) {
        write(&app, &settings)?;
    }
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

/// 盤面の意匠を切り替える。Project に依らない設定なのでキーを持たない。
#[tauri::command]
pub async fn set_theme(app: tauri::AppHandle, theme: String) -> Result<AppSettings, AppError> {
    let mut settings = read(&app);
    settings.theme = theme;
    write(&app, &settings)?;
    Ok(settings)
}

/// 画面へ渡す背景画像。
///
/// data: URL に組み立てるのは画面側。ここで組むと、Rust が「画像は data: URL で
/// 渡すもの」という画面都合の形を持つことになる。こちらは中身と種類だけを返す。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImage {
    pub base64: String,
    pub mime: String,
}

/// 背景画像を書き、設定側に種類を控える。
///
/// コマンド本体から切り出しているのは、put_daily_task と同じく AppHandle 無しで
/// 確かめられるようにするため。
fn put_background_image(
    path: &std::path::Path,
    settings: &mut AppSettings,
    encoded: &str,
    mime: &str,
) -> AppResult<()> {
    let mime = mime.trim();
    if mime.is_empty() {
        return Err(AppError::new(
            ErrorKind::Unsupported,
            "画像の種類が分かりませんでした。別の画像を選んでください",
        ));
    }
    let bytes = BASE64.decode(encoded).map_err(|error| {
        AppError::new(ErrorKind::Unsupported, format!("背景画像を読み取れませんでした: {error}"))
    })?;
    // 読み取れても中身が空なら書かない。「保存した」と見えて背景が変わらないより、
    // その場で失敗を知る方がよい（write が失敗を握り潰さないのと同じ理由）。
    if bytes.is_empty() {
        return Err(AppError::new(ErrorKind::Unsupported, "背景画像の中身が空でした"));
    }
    write_bytes_atomically(path, &bytes, "背景画像")?;
    settings.background_image_mime = Some(mime.to_owned());
    Ok(())
}

/// 保存されている背景画像を読む。無ければ None。
///
/// 種類だけ残っていて実体が無いことはありうる（手で消された、保存の途中で落ちた）。
/// 食い違いは失敗にせず「背景画像なし」に倒す — 背景が出ないだけで、アプリは使える。
fn take_background_image(
    path: &std::path::Path,
    settings: &AppSettings,
) -> Option<BackgroundImage> {
    let mime = settings.background_image_mime.as_ref()?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(BackgroundImage { base64: BASE64.encode(bytes), mime: mime.clone() })
}

/// 背景画像を消す。無ければ何もしない。
fn drop_background_image(path: &std::path::Path, settings: &mut AppSettings) -> AppResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        // 既に無いなら、消し終わっている状態と区別する意味が無い。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::new(
                ErrorKind::Unknown,
                format!("背景画像を消せませんでした: {error}"),
            ))
        }
    }
    settings.background_image_mime = None;
    Ok(())
}

/// 背景画像を選び直す。画像は settings.json ではなく別ファイルに置く。
#[tauri::command]
pub async fn set_background_image(
    app: tauri::AppHandle,
    base64: String,
    mime: String,
) -> Result<AppSettings, AppError> {
    let path = background_image_path(&app)?;
    let mut settings = read(&app);
    put_background_image(&path, &mut settings, &base64, &mime)?;
    write(&app, &settings)?;
    Ok(settings)
}

/// 背景画像をやめる。実体のファイルごと消す — 使わない数 MB を残しておく理由が無い。
#[tauri::command]
pub async fn clear_background_image(app: tauri::AppHandle) -> Result<AppSettings, AppError> {
    let path = background_image_path(&app)?;
    let mut settings = read(&app);
    drop_background_image(&path, &mut settings)?;
    write(&app, &settings)?;
    Ok(settings)
}

/// 背景画像を読む。get_settings には混ぜない。
///
/// 設定は Project を開くたびなど何度も読まれるので、混ぜると そのたびに数 MB を
/// IPC に載せることになる。起動時に 1 回だけ呼ぶ別のコマンドにしてある。
#[tauri::command]
pub async fn get_background_image(
    app: tauri::AppHandle,
) -> Result<Option<BackgroundImage>, AppError> {
    let path = background_image_path(&app)?;
    let settings = read(&app);
    Ok(take_background_image(&path, &settings))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enable_auto_reschedule() {
        // derive の Default は bool を false にするので、ここが既定と逆になっていた。
        let settings = AppSettings::default();
        assert!(settings.auto_reschedule);
        assert_eq!(settings.theme, "default");
        assert!(settings.parent_labels.is_empty());
        assert!(settings.milestone_categories.is_empty());
        // 何も設定していないうちは日課も無い。既定で 1 件でも入っていると、
        // 覚えのないタスクが点で描かれる。
        assert!(settings.daily_tasks.is_empty());
    }

    fn interval(days: u32) -> RecurrenceRule {
        RecurrenceRule::Interval { interval_days: days }
    }

    /// テスト用に日課を 1 件入れる。
    fn with_daily(settings: &mut AppSettings, project_id: &str, task_id: &str) {
        put_daily_task(
            settings,
            project_id.to_owned(),
            task_id.to_owned(),
            Some(interval(3)),
            Vec::new(),
        );
    }

    #[test]
    fn dropping_the_rule_removes_the_daily_task() {
        let mut settings = AppSettings::default();
        put_daily_task(
            &mut settings,
            "p1".to_owned(),
            "t1".to_owned(),
            Some(interval(3)),
            vec!["2026-09-01".to_owned()],
        );
        assert_eq!(settings.daily_tasks["p1"]["t1"].rule, interval(3));
        assert_eq!(settings.daily_tasks["p1"]["t1"].done, vec!["2026-09-01".to_owned()]);

        // 「やめた」印としての項目を残すと、日課でないタスクの分がファイルに溜まる。
        // Project の中が空になったら、その入れ物ごと落とす。
        put_daily_task(&mut settings, "p1".to_owned(), "t1".to_owned(), None, Vec::new());
        assert!(settings.daily_tasks.is_empty());
    }

    #[test]
    fn a_zero_interval_removes_the_daily_task() {
        let mut settings = AppSettings::default();
        with_daily(&mut settings, "p1", "t1");
        // 間隔 0 では点が 1 つも並ばない。日課として残しても意味を持たないので消す。
        put_daily_task(
            &mut settings,
            "p1".to_owned(),
            "t1".to_owned(),
            Some(interval(0)),
            Vec::new(),
        );
        assert!(settings.daily_tasks.is_empty());
    }

    #[test]
    fn a_spaced_rule_survives_a_round_trip() {
        let mut settings = AppSettings::default();
        put_daily_task(
            &mut settings,
            "p1".to_owned(),
            "t1".to_owned(),
            Some(RecurrenceRule::Spaced),
            Vec::new(),
        );
        let text = serde_json::to_string(&settings).unwrap();
        let read_back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(read_back.daily_tasks["p1"]["t1"].rule, RecurrenceRule::Spaced);
    }

    #[test]
    fn pruning_without_task_ids_keeps_everything() {
        let mut settings = AppSettings::default();
        with_daily(&mut settings, "p1", "t1");
        // タスクを読み込めなかった場合と「本当に 0 件」を区別できない。
        // ここで掘ると、読み込みが失敗しただけで日課の設定が丸ごと消える。
        assert!(!prune_daily_tasks_of(&mut settings, "p1", &[]));
        assert!(settings.daily_tasks["p1"].contains_key("t1"));
    }

    #[test]
    fn pruning_keeps_the_other_projects() {
        let mut settings = AppSettings::default();
        with_daily(&mut settings, "p1", "t1");
        with_daily(&mut settings, "p2", "t2");

        // 読み込まれるタスクは開いている Project の分だけ。p1 を掘るときに
        // p2 の日課まで巻き添えにしてはならない。
        assert!(prune_daily_tasks_of(&mut settings, "p1", &["t9".to_owned()]));
        assert!(!settings.daily_tasks.contains_key("p1"));
        assert!(settings.daily_tasks["p2"].contains_key("t2"));
    }

    #[test]
    fn pruning_empties_the_project_entry() {
        let mut settings = AppSettings::default();
        with_daily(&mut settings, "p1", "t1");
        with_daily(&mut settings, "p1", "t2");

        // 残る分があるうちは Project の項目もそのまま。
        assert!(prune_daily_tasks_of(&mut settings, "p1", &["t1".to_owned()]));
        assert_eq!(settings.daily_tasks["p1"].len(), 1);

        // 全部消えたら、空の入れ物を残さず Project の項目ごと落とす。
        assert!(prune_daily_tasks_of(&mut settings, "p1", &["t9".to_owned()]));
        assert!(settings.daily_tasks.is_empty());
    }

    #[test]
    fn the_old_flat_shape_does_not_take_the_settings_down() {
        // 未リリースなので移行はしないが、手元に残っている古い形（task id を直に
        // 鍵にし、interval_days を持つ）で設定が丸ごと既定値に落ちてはいけない。
        let text = r#"{
            "parentLabels": { "p1": ["design"] },
            "dailyTasks": { "t1": { "intervalDays": 3, "done": [] } }
        }"#;
        let settings: AppSettings = serde_json::from_str(text).unwrap();
        assert_eq!(settings.parent_labels["p1"], vec!["design".to_owned()]);
        // 読めない項目は捨てる。
        assert!(settings.daily_tasks.is_empty());
    }

    #[test]
    fn an_unreadable_daily_task_does_not_drop_its_neighbours() {
        let text = r#"{
            "dailyTasks": {
                "p1": {
                    "broken": { "rule": { "kind": "nonesuch" } },
                    "t1": { "rule": { "kind": "spaced" }, "done": ["2026-09-01"] }
                }
            }
        }"#;
        let settings: AppSettings = serde_json::from_str(text).unwrap();
        assert!(!settings.daily_tasks["p1"].contains_key("broken"));
        assert_eq!(settings.daily_tasks["p1"]["t1"].rule, RecurrenceRule::Spaced);
    }

    #[test]
    fn normalize_drops_blanks_and_duplicates() {
        let labels = normalize(vec![
            " design ".to_owned(),
            "design".to_owned(),
            "   ".to_owned(),
            "backend".to_owned(),
        ]);
        assert_eq!(labels, vec!["design".to_owned(), "backend".to_owned()]);
    }

    /// テスト用の空の置き場所。AppHandle 無しで背景画像の読み書きを確かめるため、
    /// 実際の app_config_dir の代わりにここを使う。
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zukunft-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_background_image_survives_a_round_trip() {
        let dir = scratch_dir("background-round-trip");
        let path = dir.join("background_image.bin");
        let mut settings = AppSettings::default();
        // 既定では背景画像を持たない。覚えのない画像が敷かれていてはいけない。
        assert!(settings.background_image_mime.is_none());

        let encoded = BASE64.encode([0x89u8, 0x50, 0x4e, 0x47]);
        put_background_image(&path, &mut settings, &encoded, " image/png ").unwrap();
        // 前後の空白は落とす。data: URL の種類として、そのままでは使えない。
        assert_eq!(settings.background_image_mime.as_deref(), Some("image/png"));

        let image = take_background_image(&path, &settings).unwrap();
        assert_eq!(image.base64, encoded);
        assert_eq!(image.mime, "image/png");
        // 画像の実体は settings.json には入れない。
        assert!(!serde_json::to_string(&settings).unwrap().contains(&encoded));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clearing_the_background_image_removes_the_file() {
        let dir = scratch_dir("background-clear");
        let path = dir.join("background_image.bin");
        let mut settings = AppSettings::default();
        put_background_image(&path, &mut settings, &BASE64.encode([1u8, 2, 3]), "image/png")
            .unwrap();

        drop_background_image(&path, &mut settings).unwrap();
        assert!(!path.exists());
        assert!(settings.background_image_mime.is_none());
        assert!(take_background_image(&path, &settings).is_none());

        // 既に消えていても失敗にしない。消し終わっている状態と区別する意味が無い。
        drop_background_image(&path, &mut settings).unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_broken_base64_does_not_write_an_empty_file() {
        let dir = scratch_dir("background-broken");
        let path = dir.join("background_image.bin");
        let mut settings = AppSettings::default();

        // 黙って空のファイルを書くと、背景が真っ黒になった理由が誰にも分からない。
        assert!(put_background_image(&path, &mut settings, "!! not base64 !!", "image/png").is_err());
        assert!(put_background_image(&path, &mut settings, "", "image/png").is_err());
        assert!(!path.exists());
        assert!(settings.background_image_mime.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_file_reads_as_no_background_image() {
        let dir = scratch_dir("background-missing");
        let path = dir.join("background_image.bin");
        // 種類だけ残って実体が無い食い違いはありうる（手で消された、保存が途中で落ちた）。
        // ここで落ちると、背景画像のせいでアプリが開けなくなる。
        let mut settings = AppSettings::default();
        settings.background_image_mime = Some("image/png".to_owned());
        assert!(take_background_image(&path, &settings).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_replaces_the_previous_content() {
        let dir = std::env::temp_dir().join("zukunft-settings-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        write_atomically(&path, "{\"a\":1}").unwrap();
        write_atomically(&path, "{\"a\":2}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        // 一時ファイルを残さない
        assert!(!path.with_extension("json.tmp").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
