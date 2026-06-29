use chrono::{DateTime, Utc};
use std::{env, time::Duration};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub bind_addr: String,
    pub sf_api_base_url: String,
    pub sf_partner_id: String,
    pub sf_check_word: String,
    pub sf_env: SfEnv,
    pub access_tokens: Vec<AccessTokenConfig>,
    pub session_ttl: Duration,
    pub session_cookie_secure: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SfEnv {
    Sandbox,
    Production,
}

#[derive(Debug, Clone)]
pub struct AccessTokenConfig {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub max_uses: u32,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required env var {0}")]
    MissingEnv(&'static str),
    #[error("invalid SF_ENV, expected sandbox or production")]
    InvalidSfEnv,
    #[error("TRACKING_ACCESS_TOKENS is empty")]
    EmptyTokens,
    #[error("invalid token entry: {0}")]
    InvalidTokenEntry(String),
    #[error("invalid token expiration in entry: {0}")]
    InvalidTokenExpiration(String),
    #[error("invalid token maxUses in entry: {0}")]
    InvalidTokenMaxUses(String),
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let sf_env = match env::var("SF_ENV")
            .unwrap_or_else(|_| "sandbox".to_string())
            .as_str()
        {
            "sandbox" => SfEnv::Sandbox,
            "production" => SfEnv::Production,
            _ => return Err(ConfigError::InvalidSfEnv),
        };

        let default_base = match sf_env {
            SfEnv::Sandbox => "https://sfapi-sbox.sf-express.com/std/service",
            SfEnv::Production => "https://sfapi.sf-express.com/std/service",
        };

        let token_text = required("TRACKING_ACCESS_TOKENS")?;

        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string()),
            sf_api_base_url: env::var("SF_API_BASE_URL")
                .unwrap_or_else(|_| default_base.to_string()),
            sf_partner_id: required("SF_PARTNER_ID")?,
            sf_check_word: required("SF_CHECK_WORD")?,
            sf_env,
            access_tokens: parse_access_tokens(&token_text)?,
            session_ttl: Duration::from_secs(
                env::var("SESSION_TTL_SECONDS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(1800),
            ),
            session_cookie_secure: parse_bool_env("SESSION_COOKIE_SECURE", false),
        })
    }
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::MissingEnv(name))
}

fn parse_bool_env(name: &str, default_value: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default_value)
}

pub fn parse_access_tokens(input: &str) -> Result<Vec<AccessTokenConfig>, ConfigError> {
    let mut tokens = Vec::new();

    for raw_entry in input.split(',') {
        let entry = raw_entry.trim();
        if entry.is_empty() {
            continue;
        }

        let first = entry
            .find(':')
            .ok_or_else(|| ConfigError::InvalidTokenEntry(entry.to_string()))?;
        let last = entry
            .rfind(':')
            .ok_or_else(|| ConfigError::InvalidTokenEntry(entry.to_string()))?;
        if first == last {
            return Err(ConfigError::InvalidTokenEntry(entry.to_string()));
        }

        let token = entry[..first].trim();
        let expires_at_text = entry[first + 1..last].trim();
        let max_uses_text = entry[last + 1..].trim();

        if token.is_empty() || expires_at_text.is_empty() || max_uses_text.is_empty() {
            return Err(ConfigError::InvalidTokenEntry(entry.to_string()));
        }

        let expires_at = DateTime::parse_from_rfc3339(expires_at_text)
            .map_err(|_| ConfigError::InvalidTokenExpiration(entry.to_string()))?
            .with_timezone(&Utc);
        let max_uses = max_uses_text
            .parse::<u32>()
            .map_err(|_| ConfigError::InvalidTokenMaxUses(entry.to_string()))?;
        if max_uses == 0 {
            return Err(ConfigError::InvalidTokenMaxUses(entry.to_string()));
        }

        tokens.push(AccessTokenConfig {
            token: token.to_string(),
            expires_at,
            max_uses,
        });
    }

    if tokens.is_empty() {
        return Err(ConfigError::EmptyTokens);
    }

    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339_token_entries_with_colons() {
        let tokens = parse_access_tokens("abc:2026-12-31T23:59:59Z:10,def:2027-01-01T00:00:00Z:5")
            .expect("tokens parse");

        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].token, "abc");
        assert_eq!(tokens[0].max_uses, 10);
    }
}
