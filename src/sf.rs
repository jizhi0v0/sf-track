use crate::sanitize::{sanitize_accept_address, sanitize_route_remark};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

pub const SERVICE_CODE: &str = "EXP_RECE_SEARCH_ROUTES";

#[derive(Clone)]
pub struct SfClient {
    http: reqwest::Client,
    base_url: String,
    partner_id: String,
    check_word: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CleanRoute {
    #[serde(rename = "acceptTime")]
    pub accept_time: String,
    #[serde(rename = "acceptAddress")]
    pub accept_address: String,
    pub remark: String,
    #[serde(rename = "opCode", skip_serializing_if = "Option::is_none")]
    pub op_code: Option<String>,
}

#[derive(Debug)]
pub struct SfTrackResult {
    pub mail_no: String,
    pub routes: Vec<CleanRoute>,
}

#[derive(Debug, Error)]
pub enum SfError {
    #[error("failed to serialize sf msgData")]
    SerializeMsgData(#[from] serde_json::Error),
    #[error("failed to serialize sf form")]
    SerializeForm(#[from] serde_urlencoded::ser::Error),
    #[error("sf request failed")]
    Request(#[from] reqwest::Error),
    #[error("sf api result was not successful: {code}")]
    ApiResult { code: String, message: String },
    #[error("sf api result data was missing")]
    MissingResultData,
    #[error("sf api result data was invalid")]
    InvalidResultData(serde_json::Error),
    #[error("sf business result was not successful")]
    BusinessResult {
        code: Option<String>,
        message: Option<String>,
    },
}

impl SfError {
    pub fn safe_kind(&self) -> &'static str {
        match self {
            SfError::SerializeMsgData(_) => "serialize_msg_data",
            SfError::SerializeForm(_) => "serialize_form",
            SfError::Request(_) => "request",
            SfError::ApiResult { .. } => "api_result",
            SfError::MissingResultData => "missing_result_data",
            SfError::InvalidResultData(_) => "invalid_result_data",
            SfError::BusinessResult { .. } => "business_result",
        }
    }
}

impl SfClient {
    pub fn new(base_url: String, partner_id: String, check_word: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url,
            partner_id,
            check_word,
        }
    }

    pub async fn query_routes(
        &self,
        waybill_no: &str,
        phone_last4: &str,
    ) -> Result<SfTrackResult, SfError> {
        let msg_data = SfMsgDataRequest {
            language: "0",
            tracking_type: "1",
            tracking_number: vec![waybill_no],
            method_type: "1",
            check_phone_no: phone_last4,
        };
        let msg_data_json = serde_json::to_string(&msg_data)?;
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let request_id = Uuid::new_v4().to_string();
        let msg_digest = build_msg_digest(&msg_data_json, &timestamp, &self.check_word);

        let form = SfForm {
            partner_id: &self.partner_id,
            request_id: &request_id,
            service_code: SERVICE_CODE,
            timestamp: &timestamp,
            msg_digest: &msg_digest,
            msg_data: &msg_data_json,
        };
        let body = serde_urlencoded::to_string(&form)?;

        let outer = self
            .http
            .post(&self.base_url)
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded;charset=UTF-8",
            )
            .body(body)
            .send()
            .await?
            .error_for_status()?
            .json::<SfOuterResponse>()
            .await?;

        if outer.api_result_code != "A1000" {
            return Err(SfError::ApiResult {
                code: outer.api_result_code,
                message: outer.api_error_msg,
            });
        }

        let result_data = outer.api_result_data.ok_or(SfError::MissingResultData)?;
        let inner = serde_json::from_str::<SfInnerResponse>(&result_data)
            .map_err(SfError::InvalidResultData)?;

        if !inner.success || inner.error_code.as_deref() != Some("S0000") {
            return Err(SfError::BusinessResult {
                code: inner.error_code,
                message: inner.error_msg,
            });
        }

        let mut route_resps = inner.msg_data.route_resps;
        let first = route_resps.pop().unwrap_or_default();
        let mail_no = first.mail_no.unwrap_or_else(|| waybill_no.to_string());
        let mut routes = first
            .routes
            .into_iter()
            .map(|route| CleanRoute {
                accept_time: route.accept_time.unwrap_or_default(),
                accept_address: route
                    .accept_address
                    .as_deref()
                    .map(sanitize_accept_address)
                    .unwrap_or_default(),
                remark: route
                    .remark
                    .as_deref()
                    .map(sanitize_route_remark)
                    .unwrap_or_default(),
                op_code: route.op_code.filter(|value| !value.trim().is_empty()),
            })
            .collect::<Vec<_>>();

        routes.sort_by(|left, right| right.accept_time.cmp(&left.accept_time));

        Ok(SfTrackResult { mail_no, routes })
    }
}

pub fn build_msg_digest(msg_data: &str, timestamp: &str, check_word: &str) -> String {
    let input = format!("{msg_data}{timestamp}{check_word}");
    let encoded = java_url_encode(&input);
    let digest = md5::compute(encoded.as_bytes());
    STANDARD.encode(digest.0)
}

fn java_url_encode(input: &str) -> String {
    let encoded = serde_urlencoded::to_string([("v", input)]).expect("url encoding cannot fail");
    encoded
        .strip_prefix("v=")
        .expect("encoded marker exists")
        .to_string()
}

#[derive(Debug, Serialize)]
struct SfMsgDataRequest<'a> {
    language: &'a str,
    #[serde(rename = "trackingType")]
    tracking_type: &'a str,
    #[serde(rename = "trackingNumber")]
    tracking_number: Vec<&'a str>,
    #[serde(rename = "methodType")]
    method_type: &'a str,
    #[serde(rename = "checkPhoneNo")]
    check_phone_no: &'a str,
}

#[derive(Debug, Serialize)]
struct SfForm<'a> {
    #[serde(rename = "partnerID")]
    partner_id: &'a str,
    #[serde(rename = "requestID")]
    request_id: &'a str,
    #[serde(rename = "serviceCode")]
    service_code: &'a str,
    timestamp: &'a str,
    #[serde(rename = "msgDigest")]
    msg_digest: &'a str,
    #[serde(rename = "msgData")]
    msg_data: &'a str,
}

#[derive(Debug, Deserialize)]
struct SfOuterResponse {
    #[serde(default, rename = "apiErrorMsg")]
    api_error_msg: String,
    #[serde(default, rename = "apiResponseID")]
    _api_response_id: String,
    #[serde(rename = "apiResultCode")]
    api_result_code: String,
    #[serde(rename = "apiResultData")]
    api_result_data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SfInnerResponse {
    success: bool,
    #[serde(rename = "errorCode")]
    error_code: Option<String>,
    #[serde(default, rename = "errorMsg")]
    error_msg: Option<String>,
    #[serde(default, rename = "msgData")]
    msg_data: SfInnerMsgData,
}

#[derive(Debug, Default, Deserialize)]
struct SfInnerMsgData {
    #[serde(default, rename = "routeResps")]
    route_resps: Vec<SfRouteResp>,
}

#[derive(Debug, Default, Deserialize)]
struct SfRouteResp {
    #[serde(default, rename = "mailNo")]
    mail_no: Option<String>,
    #[serde(default)]
    routes: Vec<SfRoute>,
}

#[derive(Debug, Deserialize)]
struct SfRoute {
    #[serde(default, rename = "acceptTime")]
    accept_time: Option<String>,
    #[serde(default, rename = "acceptAddress")]
    accept_address: Option<String>,
    #[serde(default)]
    remark: Option<String>,
    #[serde(default, rename = "opCode")]
    op_code: Option<String>,
    #[serde(flatten)]
    _extra: HashMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sf_digest_from_exact_msg_data_string() {
        let msg_data = r#"{"language":"0","trackingType":"1","trackingNumber":["SF0213844341359"],"methodType":"1","checkPhoneNo":"1234"}"#;
        let digest = build_msg_digest(msg_data, "1710000000000", "test-check-word");

        assert_eq!(digest, "EXnRFlBgTv0+WqIpnKhc3Q==");
    }
}
