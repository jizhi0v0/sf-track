use crate::{config::AccessTokenConfig, security::fingerprint};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SessionContext {
    pub token: String,
    pub token_fingerprint: String,
}

#[derive(Debug, Error)]
pub enum AccessError {
    #[error("access token is invalid")]
    InvalidToken,
    #[error("access token expired")]
    Expired,
    #[error("access token use limit exceeded")]
    MaxUsesExceeded,
    #[error("session is invalid")]
    InvalidSession,
}

#[derive(Debug, Clone)]
struct TokenState {
    expires_at: DateTime<Utc>,
    max_uses: u32,
    uses: u32,
}

#[derive(Debug, Clone)]
struct SessionState {
    token: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct AuthStore {
    tokens: Mutex<HashMap<String, TokenState>>,
    sessions: Mutex<HashMap<String, SessionState>>,
    session_ttl: Duration,
}

impl AuthStore {
    pub fn new(configs: Vec<AccessTokenConfig>, session_ttl: Duration) -> Self {
        let tokens = configs
            .into_iter()
            .map(|config| {
                (
                    config.token,
                    TokenState {
                        expires_at: config.expires_at,
                        max_uses: config.max_uses,
                        uses: 0,
                    },
                )
            })
            .collect();

        Self {
            tokens: Mutex::new(tokens),
            sessions: Mutex::new(HashMap::new()),
            session_ttl,
        }
    }

    pub fn issue_session(&self, token: &str) -> Result<(String, DateTime<Utc>), AccessError> {
        let expires_at = {
            let tokens = self.tokens.lock().expect("token lock");
            let state = tokens.get(token).ok_or(AccessError::InvalidToken)?;
            ensure_token_available(state)?;
            let session_expires_at = Utc::now()
                + ChronoDuration::from_std(self.session_ttl)
                    .unwrap_or_else(|_| ChronoDuration::seconds(1800));
            session_expires_at.min(state.expires_at)
        };

        let session_id = Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().expect("session lock");
        cleanup_expired_sessions(&mut sessions);
        sessions.insert(
            session_id.clone(),
            SessionState {
                token: token.to_string(),
                expires_at,
            },
        );

        Ok((session_id, expires_at))
    }

    pub fn validate_session(&self, session_id: &str) -> Result<SessionContext, AccessError> {
        let token = {
            let mut sessions = self.sessions.lock().expect("session lock");
            cleanup_expired_sessions(&mut sessions);
            let session = sessions
                .get(session_id)
                .ok_or(AccessError::InvalidSession)?;
            if session.expires_at <= Utc::now() {
                sessions.remove(session_id);
                return Err(AccessError::InvalidSession);
            }
            session.token.clone()
        };

        {
            let tokens = self.tokens.lock().expect("token lock");
            let state = tokens.get(&token).ok_or(AccessError::InvalidSession)?;
            ensure_token_available(state)?;
        }

        Ok(SessionContext {
            token_fingerprint: fingerprint(&token),
            token,
        })
    }

    pub fn consume_query_use(&self, token: &str) -> Result<(), AccessError> {
        let mut tokens = self.tokens.lock().expect("token lock");
        let state = tokens.get_mut(token).ok_or(AccessError::InvalidToken)?;
        ensure_token_available(state)?;
        state.uses += 1;
        Ok(())
    }
}

fn ensure_token_available(state: &TokenState) -> Result<(), AccessError> {
    if state.expires_at <= Utc::now() {
        return Err(AccessError::Expired);
    }
    if state.uses >= state.max_uses {
        return Err(AccessError::MaxUsesExceeded);
    }
    Ok(())
}

fn cleanup_expired_sessions(sessions: &mut HashMap<String, SessionState>) {
    let now = Utc::now();
    sessions.retain(|_, session| session.expires_at > now);
}
