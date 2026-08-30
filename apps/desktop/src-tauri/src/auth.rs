use std::env;

use serde::Deserialize;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{AuthStatus, DeviceCode};

/// OS の Secure Storage に置く資格情報（企画書 §11 / §17）。
/// トークンを平文ファイルへ書かないため、keyring 経由でのみ読み書きする。
const SERVICE: &str = "dev.zukunft.app";
const ACCOUNT: &str = "github-token";

/// Device Flow に使う OAuth App / GitHub App の Client ID。
/// 配布物ごとに異なるため、ビルド時の環境変数から取り込む。
/// 未設定でも PAT でのサインインは使えるようにしておく（企画書 §11）。
const CLIENT_ID: Option<&str> = option_env!("ZUKUNFT_GITHUB_CLIENT_ID");

/// Projects v2 の読み書きに必要な最小スコープ（企画書 §17）。
const SCOPES: &str = "repo project";

fn entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(AppError::from)
}

/// トークンの入手元。どちらが使われているかを UI に見せるために区別する。
/// 環境変数を設定したのにサインインを求められる、あるいはサインアウトしたのに
/// 使えたままになる、といった混乱を避けるため。
pub fn token_source() -> &'static str {
    if token_from_env().is_some() {
        "env"
    } else if stored_token().is_ok() {
        "stored"
    } else {
        "none"
    }
}

/// アプリ内でトークンが必要になったときの唯一の入口。
///
/// 環境変数を資格情報ストアより優先する。サインイン判定とデータ取得で
/// 別々の解決をすると、「取得はできるのにサインイン画面から進めない」
/// という食い違いが起きるため、必ずここを通す。
pub fn resolve_token() -> AppResult<String> {
    match token_from_env() {
        Some(token) => Ok(token),
        None => stored_token(),
    }
}

pub fn stored_token() -> AppResult<String> {
    let token = entry()?.get_password().map_err(AppError::from)?;
    if token.is_empty() {
        return Err(AppError::new(ErrorKind::Unauthorized, "GitHub にサインインしていません"));
    }
    Ok(token)
}

pub fn store_token(token: &str) -> AppResult<()> {
    entry()?.set_password(token).map_err(AppError::from)
}

pub fn clear_token() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // 元から入っていない場合はサインアウト済みとみなす。
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(AppError::from(other)),
    }
}

fn client_id() -> AppResult<&'static str> {
    CLIENT_ID.filter(|id| !id.is_empty()).ok_or_else(|| {
        AppError::new(
            ErrorKind::Unsupported,
            "Device Flow の Client ID がビルドに埋め込まれていません。\
             ZUKUNFT_GITHUB_CLIENT_ID を設定してビルドするか、\
             Personal Access Token でサインインしてください",
        )
    })
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Viewer {
    login: String,
}

#[derive(Deserialize)]
struct ViewerData {
    viewer: Viewer,
}

#[derive(Deserialize)]
struct ViewerEnvelope {
    data: Option<ViewerData>,
}

/// Device Flow の開始（企画書 §11）。
/// リダイレクト URI を用意せず、クライアントシークレットも埋め込まずに済む。
pub async fn start_device_flow(http: &reqwest::Client) -> AppResult<DeviceCode> {
    let response = http
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id()?), ("scope", SCOPES)])
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorKind::Unknown,
            format!("Device Flow を開始できませんでした ({})", response.status()),
        ));
    }

    let body: DeviceCodeResponse = response.json().await?;
    Ok(DeviceCode {
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        device_code: body.device_code,
        interval: body.interval,
        expires_in: body.expires_in,
    })
}

/// 認可待ちのポーリング 1 回分。
/// まだ承認されていない間は Unauthorized を返すので、UI 側が interval 秒ごとに呼び直す。
pub async fn poll_device_flow(http: &reqwest::Client, device_code: &str) -> AppResult<AuthStatus> {
    let response = http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id()?),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;

    let body: AccessTokenResponse = response.json().await?;
    if let Some(token) = body.access_token {
        store_token(&token)?;
        return current_status(http).await;
    }

    let error = body.error.unwrap_or_else(|| "unknown".into());
    let message = match error.as_str() {
        "authorization_pending" => "ブラウザでの承認を待っています",
        "slow_down" => "ポーリングが速すぎます。少し待ってから再試行します",
        "expired_token" => "コードの有効期限が切れました。やり直してください",
        "access_denied" => "承認が拒否されました",
        _ => "認可を完了できませんでした",
    };
    Err(AppError::new(ErrorKind::Unauthorized, message))
}

/// 保存済みトークンで viewer を引き、サインイン状態を確認する。
pub async fn current_status(http: &reqwest::Client) -> AppResult<AuthStatus> {
    let source = token_source();
    let token = match resolve_token() {
        Ok(token) => token,
        Err(_) => return Ok(AuthStatus { signed_in: false, login: None, source: "none".into() }),
    };

    let response = http
        .post(crate::github::ENDPOINT)
        .bearer_auth(&token)
        .header("User-Agent", crate::github::USER_AGENT)
        .json(&serde_json::json!({ "query": "query { viewer { login } }" }))
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(AuthStatus { signed_in: false, login: None, source: source.into() });
    }

    let envelope: ViewerEnvelope = response.json().await?;
    Ok(match envelope.data {
        Some(data) => AuthStatus {
            signed_in: true,
            login: Some(data.viewer.login),
            source: source.into(),
        },
        None => AuthStatus { signed_in: false, login: None, source: source.into() },
    })
}

/// プロトタイプ用の PAT 直接入力（企画書 §11）。
/// 検証してから保存し、無効なトークンを Secure Storage に残さない。
pub async fn sign_in_with_token(http: &reqwest::Client, token: &str) -> AppResult<AuthStatus> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(ErrorKind::Unauthorized, "トークンが空です"));
    }
    store_token(trimmed)?;
    let status = current_status(http).await?;
    if !status.signed_in {
        clear_token()?;
        return Err(AppError::new(ErrorKind::Unauthorized, "このトークンでは認証できませんでした"));
    }
    Ok(status)
}

/// 環境変数からの取り込み。開発時に毎回サインインしなくて済むようにする。
pub fn token_from_env() -> Option<String> {
    env::var("ZUKUNFT_GITHUB_TOKEN").ok().filter(|t| !t.is_empty())
}
