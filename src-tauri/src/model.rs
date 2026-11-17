use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub profile_name: String,
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_secret_access_key: Option<bool>,
    pub force_path_style: bool,
    pub ssl: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_algorithm: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSettings {
    pub default_download_folder: String,
    pub concurrent_transfers: u64,
    pub multipart_concurrency: u64,
    pub chunk_size_mb: u64,
    pub retry_count: u64,
    pub overwrite_policy: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    pub remember_credentials_locally: bool,
    pub require_confirmation_before_delete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub language: String,
    pub disable_hardware_acceleration: bool,
    pub disable_gpu_shader_disk_cache: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub connections: Vec<ConnectionConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_connection_id: Option<String>,
    pub compact_mode: bool,
    pub transfer_settings: TransferSettings,
    pub security_settings: SecuritySettings,
    pub appearance_settings: AppearanceSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectItem {
    pub key: String,
    pub name: String,
    pub bucket: String,
    pub prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectListResult {
    pub objects: Vec<ObjectItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_continuation_token: Option<String>,
    pub is_truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStats {
    pub total: u64,
    pub processed: u64,
    pub success: u64,
    pub failed: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFailureInfo {
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperationFailedItem {
    pub key: String,
    pub reason: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperationReport {
    pub total: u64,
    pub success: u64,
    pub failed: u64,
    pub skipped: u64,
    pub failed_items: Vec<BatchOperationFailedItem>,
    pub failed_items_truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPartStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retried_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_speed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_seconds_remaining: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    pub r#type: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub progress: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_parts: Option<u64>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub retries: u64,
    pub max_retries: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<TaskStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<TaskFailureInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<BatchOperationReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_stats: Option<TaskPartStats>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<TaskStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_summary: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buckets: Option<Vec<BucketInfo>>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub connection_id: String,
    pub bucket: String,
    pub prefix: String,
    pub file_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_empty_folders: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub connection_id: String,
    pub bucket: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRequest {
    pub connection_id: String,
    pub source_bucket: String,
    pub source_key: String,
    pub target_bucket: String,
    pub target_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_exists_policy: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub connection_id: String,
    pub bucket: String,
    pub old_key: String,
    pub new_key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostics {
    pub app_name: String,
    pub app_version: String,
    pub tauri_version: String,
    pub webview_version: String,
    pub platform: String,
    pub arch: String,
    pub generated_at: String,
    pub user_data_path: String,
    pub config_file_path: String,
    pub secure_credential_storage_available: bool,
    pub config_summary: AppConfig,
    pub recent_logs: Vec<LogEntry>,
    pub failed_tasks: Vec<TaskItem>,
}
