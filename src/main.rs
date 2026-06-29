mod auth;
mod config;
mod rate_limit;
mod sanitize;
mod security;
mod sf;

use auth::{AccessError, AuthStore};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use config::AppConfig;
use rate_limit::{RateLimitDecision, RateLimitStore};
use security::fingerprint;
use serde::{Deserialize, Serialize};
use sf::{CleanRoute, SfClient};
use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

const SESSION_COOKIE: &str = "sf_track_session";
const EMPTY_MESSAGE: &str =
    "暂无轨迹，可能是手机号后四位不匹配、无查询权限、暂无路由或超过可查询时间范围。";
const GENERIC_ERROR: &str = "查询失败，请稍后再试。";

struct AppState {
    config: AppConfig,
    auth: AuthStore,
    rate_limits: RateLimitStore,
    sf_client: SfClient,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = AppConfig::from_env()?;
    let bind_addr = config.bind_addr.clone();
    let sf_env = config.sf_env;
    let sf_client = SfClient::new(
        config.sf_api_base_url.clone(),
        config.sf_partner_id.clone(),
        config.sf_check_word.clone(),
    );
    let state = Arc::new(AppState {
        auth: AuthStore::new(config.access_tokens.clone(), config.session_ttl),
        rate_limits: RateLimitStore::new(),
        sf_client,
        config,
    });

    let app = Router::new()
        .route("/sf-track", get(sf_track_page))
        .route("/api/sf/track", post(post_track))
        .nest_service("/assets", ServeDir::new("frontend/dist/assets"))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(4096))
        .with_state(state);

    let listener = TcpListener::bind(&bind_addr).await?;

    tracing::info!(bind_addr = %bind_addr, sf_env = ?sf_env, "server started");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

fn init_tracing() {
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("sf_track=info"));
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer())
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[derive(Debug, Deserialize)]
struct SfTrackQuery {
    token: Option<String>,
}

async fn sf_track_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SfTrackQuery>,
) -> Response {
    if let Some(token) = query
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return match state.auth.issue_session(token) {
            Ok((session_id, expires_at)) => {
                let max_age = (expires_at - chrono::Utc::now()).num_seconds().max(1);
                let cookie =
                    build_session_cookie(&session_id, max_age, state.config.session_cookie_secure);
                Response::builder()
                    .status(StatusCode::SEE_OTHER)
                    .header(header::LOCATION, "/sf-track")
                    .header(header::SET_COOKIE, cookie)
                    .header(header::CACHE_CONTROL, "no-store")
                    .header(header::REFERRER_POLICY, "no-referrer")
                    .body(Body::empty())
                    .expect("redirect response")
            }
            Err(error) => {
                tracing::warn!(reason = %access_error_kind(&error), "token page access denied");
                unauthorized_html(Some(clear_session_cookie(
                    state.config.session_cookie_secure,
                )))
            }
        };
    }

    let session_id = get_cookie(&headers, SESSION_COOKIE);
    if session_id
        .as_deref()
        .and_then(|value| state.auth.validate_session(value).ok())
        .is_none()
    {
        return unauthorized_html(Some(clear_session_cookie(
            state.config.session_cookie_secure,
        )));
    }

    match tokio::fs::read_to_string("frontend/dist/index.html").await {
        Ok(index) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(Body::from(index))
            .expect("index response"),
        Err(error) => {
            tracing::error!(error = %error, "frontend build output missing");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Html("页面暂不可用，请稍后再试。"),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct TrackRequest {
    #[serde(rename = "waybillNo")]
    waybill_no: String,
    #[serde(rename = "phoneLast4")]
    phone_last4: String,
}

#[derive(Debug, Serialize)]
struct TrackResponse {
    success: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'static str>,
    #[serde(rename = "mailNo", skip_serializing_if = "Option::is_none")]
    mail_no: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    routes: Option<Vec<CleanRoute>>,
}

async fn post_track(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<TrackRequest>,
) -> impl IntoResponse {
    let session_id = match get_cookie(&headers, SESSION_COOKIE) {
        Some(value) => value,
        None => return api_error(StatusCode::UNAUTHORIZED, "访问凭证无效或已过期。"),
    };
    let session = match state.auth.validate_session(&session_id) {
        Ok(session) => session,
        Err(error) => {
            tracing::warn!(reason = %access_error_kind(&error), "api session denied");
            return api_error(StatusCode::UNAUTHORIZED, "访问凭证无效或已过期。");
        }
    };

    let waybill_no = payload.waybill_no.trim().to_ascii_uppercase();
    let phone_last4 = payload.phone_last4.trim();
    if !is_valid_waybill_no(&waybill_no) || !is_valid_phone_last4(phone_last4) {
        return api_error(StatusCode::BAD_REQUEST, "参数格式不正确。");
    }

    let client_ip = client_ip(&headers, remote_addr);
    let waybill_fingerprint = fingerprint(&waybill_no);

    if !check_minute_limits(&state, &session.token_fingerprint, &client_ip) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "查询过于频繁，请稍后再试。");
    }

    let token_failure_key = format!(
        "fail:token:{}:waybill:{}",
        session.token_fingerprint, waybill_fingerprint
    );
    let ip_failure_key = format!(
        "fail:ip:{}:waybill:{}",
        fingerprint(&client_ip),
        waybill_fingerprint
    );

    if matches!(
        state.rate_limits.check_failure_lock(&token_failure_key),
        RateLimitDecision::Locked
    ) || matches!(
        state.rate_limits.check_failure_lock(&ip_failure_key),
        RateLimitDecision::Locked
    ) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "失败次数过多，请稍后再试。");
    }

    if let Err(error) = state.auth.consume_query_use(&session.token) {
        tracing::warn!(reason = %access_error_kind(&error), "token query use denied");
        return api_error(StatusCode::FORBIDDEN, "访问凭证已过期或次数已用完。");
    }

    match state.sf_client.query_routes(&waybill_no, phone_last4).await {
        Ok(result) if result.routes.is_empty() => {
            record_business_failure(&state, token_failure_key, ip_failure_key);
            (
                StatusCode::OK,
                Json(TrackResponse {
                    success: true,
                    status: "empty",
                    message: Some(EMPTY_MESSAGE),
                    mail_no: None,
                    routes: None,
                }),
            )
        }
        Ok(result) => {
            state.rate_limits.reset_business_failure(&token_failure_key);
            state.rate_limits.reset_business_failure(&ip_failure_key);
            (
                StatusCode::OK,
                Json(TrackResponse {
                    success: true,
                    status: "success",
                    message: None,
                    mail_no: Some(result.mail_no),
                    routes: Some(result.routes),
                }),
            )
        }
        Err(error) => {
            match &error {
                sf::SfError::ApiResult { code, message } => {
                    tracing::warn!(
                        kind = error.safe_kind(),
                        sf_code = %code,
                        sf_message = %message,
                        "sf query failed"
                    );
                }
                sf::SfError::BusinessResult { code, message } => {
                    tracing::warn!(
                        kind = error.safe_kind(),
                        sf_code = ?code,
                        sf_message = ?message,
                        "sf query failed"
                    );
                }
                _ => {
                    tracing::warn!(kind = error.safe_kind(), "sf query failed");
                }
            }
            api_error(StatusCode::BAD_GATEWAY, GENERIC_ERROR)
        }
    }
}

fn check_minute_limits(state: &AppState, token_fingerprint: &str, client_ip: &str) -> bool {
    let minute = Duration::from_secs(60);
    matches!(
        state
            .rate_limits
            .check_window(format!("minute:ip:{}", fingerprint(client_ip)), 10, minute),
        RateLimitDecision::Allowed
    ) && matches!(
        state
            .rate_limits
            .check_window(format!("minute:token:{token_fingerprint}"), 5, minute),
        RateLimitDecision::Allowed
    )
}

fn record_business_failure(state: &AppState, token_failure_key: String, ip_failure_key: String) {
    let lock_for = Duration::from_secs(30 * 60);
    // Production should move these counters to Redis or another shared store
    // so limits survive restarts and work across multiple service instances.
    state
        .rate_limits
        .record_business_failure(token_failure_key, 5, lock_for);
    state
        .rate_limits
        .record_business_failure(ip_failure_key, 5, lock_for);
}

fn api_error(status: StatusCode, message: &'static str) -> (StatusCode, Json<TrackResponse>) {
    (
        status,
        Json(TrackResponse {
            success: false,
            status: "error",
            message: Some(message),
            mail_no: None,
            routes: None,
        }),
    )
}

fn is_valid_waybill_no(value: &str) -> bool {
    let len = value.len();
    (6..=40).contains(&len) && value.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn is_valid_phone_last4(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|ch| ch.is_ascii_digit())
}

fn client_ip(headers: &HeaderMap, remote_addr: SocketAddr) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| remote_addr.ip().to_string())
}

fn get_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie_header.split(';').find_map(|part| {
        let (cookie_name, cookie_value) = part.trim().split_once('=')?;
        (cookie_name == name).then(|| cookie_value.to_string())
    })
}

fn build_session_cookie(session_id: &str, max_age_seconds: i64, secure: bool) -> String {
    let secure_part = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={session_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}{secure_part}"
    )
}

fn clear_session_cookie(secure: bool) -> String {
    let secure_part = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure_part}")
}

fn unauthorized_html(clear_cookie: Option<String>) -> Response {
    let body = r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问受限</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#20242a}.box{max-width:420px;padding:28px;border:1px solid #d9dee7;background:#fff;border-radius:8px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.7;margin:0;color:#59616f}</style></head><body><main class="box"><h1>访问受限</h1><p>该查询页仅供授权链接访问。请使用有效链接重新打开。</p></main></body></html>"#;
    let mut builder = Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer");
    if let Some(cookie) = clear_cookie {
        builder = builder.header(header::SET_COOKIE, cookie);
    }
    builder
        .body(Body::from(body))
        .expect("unauthorized response")
}

async fn not_found() -> impl IntoResponse {
    if Path::new("frontend/dist/index.html").exists() {
        Redirect::to("/sf-track").into_response()
    } else {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

fn access_error_kind(error: &AccessError) -> &'static str {
    match error {
        AccessError::InvalidToken => "invalid_token",
        AccessError::Expired => "expired",
        AccessError::MaxUsesExceeded => "max_uses",
        AccessError::InvalidSession => "invalid_session",
    }
}
