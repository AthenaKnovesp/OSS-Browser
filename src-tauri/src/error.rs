use crate::{i18n::t, logger::sanitize};
use serde::Serialize;
use std::sync::LazyLock;

static STATUS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?:statuscode\(|status:\s*)(\d{3})").unwrap());

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub message: String,
    pub detail: Option<String>,
    pub category: String,
    pub retryable: bool,
}

impl AppError {
    pub fn new(key: &str) -> Self {
        Self {
            message: t(key),
            detail: None,
            category: "unknown".into(),
            retryable: false,
        }
    }
    pub fn canceled() -> Self {
        Self {
            category: "user_canceled".into(),
            ..Self::new("error.taskCanceled")
        }
    }
    pub fn sdk(error: impl std::fmt::Debug) -> Self {
        let detail = sanitize(&format!("{error:?}"));
        let lower = detail.to_lowercase();
        let status = STATUS
            .captures(&lower)
            .and_then(|c| c[1].parse::<u16>().ok());
        let (key, category, retryable) = if lower.contains("timeout") || lower.contains("timed out")
        {
            ("error.networkTimeout", "network", true)
        } else if lower.contains("dispatchfailure")
            || lower.contains("connection reset")
            || lower.contains("dns")
        {
            ("error.endpointUnreachable", "network", true)
        } else if lower.contains("invalidaccesskeyid") || status == Some(401) {
            ("error.invalidAccessKeyId", "auth", false)
        } else if lower.contains("signaturedoesnotmatch") {
            ("error.invalidSecret", "auth", false)
        } else if lower.contains("accessdenied")
            || lower.contains("forbidden")
            || status == Some(403)
        {
            ("error.permissionDenied", "permission", false)
        } else if lower.contains("nosuchbucket") {
            ("error.bucketNotFound", "not_found", false)
        } else if lower.contains("nosuchkey") || lower.contains("notfound") || status == Some(404) {
            ("error.objectNotFound", "not_found", false)
        } else if lower.contains("precondition")
            || matches!(status, Some(409 | 412))
            || lower.contains("conflict")
        {
            ("error.operationFailed", "conflict", false)
        } else if lower.contains("sha256")
            || lower.contains("baddigest")
            || lower.contains("checksum")
            || lower.contains("invalidpart")
            || lower.contains("notimplemented")
        {
            ("error.checksumRejected", "s3_compatibility", false)
        } else if lower.contains("slowdown")
            || status.is_some_and(|s| s == 429 || s >= 500)
            || lower.contains("internalerror")
        {
            ("error.storageBusy", "network", true)
        } else {
            ("error.operationFailed", "unknown", false)
        };
        Self {
            message: t(key),
            detail: Some(detail),
            category: category.into(),
            retryable,
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        let network = matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::BrokenPipe
        );
        Self {
            message: t(if network {
                "error.networkTimeout"
            } else {
                "error.localFileBusy"
            }),
            detail: Some(sanitize(&error.to_string())),
            category: if network { "network" } else { "path_safety" }.into(),
            retryable: network,
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::sdk(error)
    }
}

pub fn check_cancel(token: &tokio_util::sync::CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        Err(AppError::canceled())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_and_stream_failures_keep_retry_semantics() {
        for status in [429, 500, 502, 503, 504] {
            assert!(AppError::sdk(format!("status: StatusCode({status})")).retryable);
        }
        for status in [401, 403, 404, 409, 412] {
            assert!(!AppError::sdk(format!("status: StatusCode({status})")).retryable);
        }
        assert_eq!(
            AppError::sdk("status: StatusCode(404)").category,
            "not_found"
        );
        assert!(
            AppError::from(std::io::Error::from(std::io::ErrorKind::ConnectionReset)).retryable
        );
        assert_eq!(
            AppError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).category,
            "path_safety"
        );
    }
}
