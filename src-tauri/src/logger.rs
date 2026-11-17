use crate::{i18n::now, model::LogEntry};
use regex::Regex;
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};
use tauri::Emitter;

static FILTERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
    (Regex::new(r#"(?i)https?://[^\s\"'<>?]+\?[^\s\"'<>]*(?:x-amz-|awsaccesskeyid|signature=)[^\s\"'<>]*"#).unwrap(), "[redacted signed URL]"),
    (Regex::new(r"(?i)([a-z][a-z\d+.-]{0,31}://)[^\s/@:]+(?::[^\s/@]*)?@").unwrap(), "$1[redacted]@"),
    (Regex::new(r"(?i)(Authorization\s*[:=]\s*)[^\r\n,}\]]+").unwrap(), "$1[redacted]"),
    (Regex::new(r#"(?i)([?&](?:X-Amz-[\w-]+|AWSAccessKeyId|Signature)=)[^&\s\"'<>]+"#).unwrap(), "$1[redacted]"),
    (Regex::new(r#"(?i)\b(accessKeyId|secretAccessKey|sessionToken|Authorization|X-Amz-[\w-]+)\b([\"'\s:=]+)([^&\s\"',}\]]+)"#).unwrap(), "$1$2[redacted]"),
    (Regex::new(r"(?i)(AWS4-HMAC-SHA256 Credential=)[^,\s]+").unwrap(), "$1[redacted]"),
]
});

pub fn sanitize(text: &str) -> String {
    FILTERS
        .iter()
        .fold(text.to_string(), |text, (pattern, replacement)| {
            pattern.replace_all(&text, *replacement).into_owned()
        })
}

// Redact individual strings so JSON quoting and structure remain valid.
pub fn sanitized<T: Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    fn visit(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(s) => *s = sanitize(s),
            serde_json::Value::Array(items) => items.iter_mut().for_each(visit),
            serde_json::Value::Object(map) => map.values_mut().for_each(visit),
            _ => {}
        }
    }
    let mut value = serde_json::to_value(value).expect("serializable diagnostics");
    visit(&mut value);
    serde_json::from_value(value).expect("unchanged diagnostics shape")
}

struct Inner {
    logs: VecDeque<LogEntry>,
    app: Option<tauri::AppHandle>,
    directory: PathBuf,
}
#[derive(Clone)]
pub struct Logger(Arc<Mutex<Inner>>);
impl Logger {
    pub fn new(directory: PathBuf) -> Self {
        Self(Arc::new(Mutex::new(Inner {
            logs: VecDeque::new(),
            app: None,
            directory,
        })))
    }
    pub fn attach(&self, app: tauri::AppHandle) {
        self.0.lock().unwrap().app = Some(app);
    }
    pub fn list(&self) -> Vec<LogEntry> {
        self.0.lock().unwrap().logs.iter().cloned().collect()
    }
    pub fn write(&self, level: &str, message: &str, detail: Option<&str>, module: &str) {
        self.record(LogEntry {
            level: level.into(),
            message: sanitize(message),
            detail: detail.map(sanitize),
            module: Some(module.into()),
            ..Default::default()
        });
    }
    pub fn operation(
        &self,
        operation: &str,
        status: &str,
        message: &str,
        stats: Option<&crate::model::TaskStats>,
        task_id: Option<&str>,
    ) {
        self.record(LogEntry {
            level: match status {
                "success" => "success",
                "failed" => "error",
                "partial_success" => "warn",
                _ => "info",
            }
            .into(),
            message: message.into(),
            operation: Some(operation.into()),
            operation_status: Some(status.into()),
            stats: stats.cloned(),
            task_id: task_id.map(str::to_string),
            module: Some(
                if operation.starts_with("task") {
                    "Task"
                } else {
                    "S3"
                }
                .into(),
            ),
            ..Default::default()
        });
    }
    fn record(&self, mut log: LogEntry) {
        log.id = uuid::Uuid::new_v4().to_string();
        log.timestamp = now();
        let log = sanitized(&log);
        let mut inner = self.0.lock().unwrap();
        inner.logs.push_back(log.clone());
        while inner.logs.len() > 5000 {
            inner.logs.pop_front();
        }
        if let Some(app) = &inner.app {
            let _ = app.emit_to("main", "log:added", &log);
        }
        let _ = append(&inner.directory, &log);
    }
    pub fn clear(&self) -> crate::error::Result<()> {
        let mut inner = self.0.lock().unwrap();
        for name in ["oss-browser.log", "oss-browser.log.1"] {
            match fs::remove_file(inner.directory.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        inner.logs.clear();
        Ok(())
    }
}

fn append(directory: &std::path::Path, log: &LogEntry) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let path = directory.join("oss-browser.log");
    let mut log = log.clone();
    log.message = log.message.chars().take(256 * 1024).collect();
    log.detail = log.detail.map(|s| s.chars().take(256 * 1024).collect());
    let line = serde_json::to_string(&log)? + "\n";
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > 5 * 1024 * 1024 {
        let backup = path.with_extension("log.1");
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        if path.exists() {
            fs::rename(&path, backup)?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_and_signed_urls_are_redacted() {
        let text = sanitize(
            "Authorization: Bearer auth-secret\nsessionToken=\"session-secret\" https://user:password@example.test/path https://bucket.example.test/key?X-Amz-Credential=credential&X-Amz-Signature=signature",
        );
        for secret in ["auth-secret", "session-secret", "password", "signature"] {
            assert!(!text.contains(secret), "{text}");
        }
    }
    #[test]
    fn logs_rotate_within_two_five_megabyte_files() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::new(dir.path().into());
        let payload = "x".repeat(1024 * 1024);
        for _ in 0..24 {
            logger.write("info", &payload, None, "S3");
        }
        logger.write("info", &"y".repeat(6 * 1024 * 1024), None, "S3");
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 2);
        for file in files {
            assert!(file.unwrap().metadata().unwrap().len() <= 5 * 1024 * 1024);
        }
        logger.clear().unwrap();
        assert!(logger.list().is_empty());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
