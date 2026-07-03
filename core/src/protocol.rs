//! JSON-RPC 2.0 protocol types shared by CLI and host.
//!
//! Notes:
//! - `Request` does NOT require an `id` from the CLI; host assigns its own.
//! - SW responds with whatever `id` it received from the host.
//! - `Response` envelope wraps either Success or Error.

use serde::{Deserialize, Serialize};

/// JSON-RPC request. CLI sends with `id: None`; host assigns before forwarding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl Request {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.into(),
            params,
        }
    }

    pub fn with_id(mut self, id: u64) -> Self {
        self.id = Some(id);
        self
    }
}

/// Top-level JSON-RPC response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Response {
    Success(SuccessResponse),
    Error(ErrorResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jsonrpc: String,
    pub id: u64,
    pub result: RpcResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jsonrpc: String,
    pub id: Option<u64>,
    pub error: Error,
}

/// Inner `result` payload: ok/data/meta envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}

/// Per-response metadata. Every CLI output embeds this.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operated: Option<OperatedTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<FocusSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatedTarget {
    pub window_id: i64,
    pub tab_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusSnapshot {
    pub window_id: i64,
    pub window_focused: bool,
    pub window_state: String,
    pub tab_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_group: Option<String>,
    pub matched_operated_target: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileRef {
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// JSON-RPC error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

/// `hello` handshake params (SW → host on connect).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloParams {
    pub instance_id: String,
    #[serde(default)]
    pub label: String,
    pub extension_version: String,
    pub chrome_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab: Option<TabRef>,
    #[serde(default)]
    pub open_tabs: Vec<TabRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabRef {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
