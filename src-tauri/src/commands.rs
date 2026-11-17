use crate::{
    config::{self, ConfigStore},
    error::{AppError, Result},
    i18n::{self, now, t, tr},
    logger::{Logger, sanitized},
    model::*,
    s3::{Context, S3Service},
    safety,
    tasks::TaskManager,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub config: ConfigStore,
    pub logger: Logger,
    pub tasks: Arc<TaskManager>,
    pub downloads: PathBuf,
    pub closing: AtomicBool,
    pub service: Mutex<Option<S3Service>>,
}
impl AppState {
    fn sync(&self) {
        let config = self.config.get();
        i18n::set_language(&config.appearance_settings.language);
        self.tasks
            .set_concurrency(config.transfer_settings.concurrent_transfers);
    }
    fn active_service(&self, id: &str) -> Result<S3Service> {
        let connection = self.config.active(id)?;
        let mut current = self.service.lock().unwrap();
        if current.as_ref().is_none_or(|s| s.connection != connection) {
            *current = Some(S3Service::new(connection, self.logger.clone())?);
        }
        Ok(current.as_ref().unwrap().clone())
    }
    pub fn download_folder(&self) -> PathBuf {
        let configured = self.config.raw().transfer_settings.default_download_folder;
        if configured.is_empty() {
            self.downloads.clone()
        } else {
            PathBuf::from(configured)
        }
    }
}
fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    serde_json::from_value(
        args.get(index)
            .cloned()
            .ok_or_else(|| AppError::new("error.operationFailed"))?,
    )
    .map_err(Into::into)
}
fn optional<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<Option<T>> {
    args.get(index)
        .filter(|v| !v.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}
fn value<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(Into::into)
}

#[tauri::command]
pub async fn dispatch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value> {
    if window.label() != "main" {
        return Err(AppError::new("error.untrustedIpcSender"));
    }
    let result = dispatch_inner(&app, &window, &state, &channel, &args).await;
    if let Err(error) = &result {
        state
            .logger
            .write("error", &error.message, error.detail.as_deref(), "IPC");
    }
    result
}
async fn dispatch_inner(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    state: &AppState,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "window:minimize" => {
            window.minimize().map_err(AppError::sdk)?;
            Ok(Value::Null)
        }
        "window:maximize" => {
            if window.is_maximized().map_err(AppError::sdk)? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(AppError::sdk)?;
            Ok(Value::Null)
        }
        "window:is-maximized" => value(window.is_maximized().map_err(AppError::sdk)?),
        "window:close" => {
            request_exit(app);
            Ok(Value::Null)
        }
        "dialog:select-files" | "dialog:select-folder" | "dialog:select-upload-folder" => {
            let dialog = app
                .dialog()
                .file()
                .set_parent(window)
                .set_title(t(match channel {
                    "dialog:select-files" => "main.dialog.selectUploadFiles",
                    "dialog:select-upload-folder" => "main.dialog.selectUploadFolder",
                    _ => "main.dialog.selectDownloadDirectory",
                }));
            let files = channel == "dialog:select-files";
            Ok(tauri::async_runtime::spawn_blocking(move || {
                if files {
                    json!(
                        dialog
                            .blocking_pick_files()
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|p| p.into_path().ok())
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                    )
                } else {
                    json!(
                        dialog
                            .blocking_pick_folder()
                            .and_then(|p| p.into_path().ok())
                            .map(|p| p.to_string_lossy().into_owned())
                    )
                }
            })
            .await
            .map_err(AppError::sdk)?)
        }
        "config:get" => {
            state.sync();
            value(state.config.get())
        }
        "config:save-connection" => {
            let connection: ConnectionConfig = arg(args, 0)?;
            let name = connection.profile_name.clone();
            let result = state.config.save_connection(connection)?;
            state.sync();
            state.logger.write(
                "info",
                &tr("main.connectionSaved", &[("name", name)]),
                None,
                "Config",
            );
            value(result)
        }
        "config:delete-connection" => {
            let result = state.config.delete(&arg::<String>(args, 0)?)?;
            *state.service.lock().unwrap() = None;
            state
                .logger
                .write("info", &t("main.connectionDeleted"), None, "Config");
            value(result)
        }
        "config:set-active-connection" => {
            let result = state.config.set_active(&arg::<String>(args, 0)?)?;
            state.sync();
            state
                .logger
                .write("info", &t("main.activeConnectionChanged"), None, "Config");
            value(result)
        }
        "config:save-settings" => {
            let result = state.config.settings(arg(args, 0)?)?;
            state.sync();
            state
                .logger
                .write("info", &t("main.settingsSaved"), None, "Config");
            value(result)
        }
        "s3:test-connection" => {
            let mut connection = state.config.merged_secret(arg(args, 0)?);
            config::validate_connection(&mut connection)?;
            let service = S3Service::new(connection, state.logger.clone())?;
            state.logger.operation(
                "testConnection",
                "start",
                &tr(
                    "s3.testStart",
                    &[("name", service.connection.profile_name.clone())],
                ),
                None,
                None,
            );
            let result = match tokio::time::timeout(
                Duration::from_secs(30),
                service.test(&Context::default()),
            )
            .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => TestConnectionResult {
                    ok: false,
                    buckets: None,
                    message: error.message,
                },
                Err(_) => return Err(AppError::new("error.requestTimeout")),
            };
            state.logger.operation(
                "testConnection",
                if result.ok { "success" } else { "failed" },
                &result.message,
                None,
                None,
            );
            value(result)
        }
        "s3:list-buckets"
        | "s3:list-objects"
        | "s3:list-objects-flat"
        | "s3:list-folders"
        | "s3:create-folder"
        | "s3:metadata"
        | "s3:generate-url" => {
            let id: String = arg(args, 0)?;
            let service = state.active_service(&id)?;
            let ctx = Context::default();
            let (operation, start_key, success_key) = match channel {
                "s3:list-buckets" => (
                    "listBuckets",
                    "s3.listBucketsStart",
                    "s3.listBucketsSuccess",
                ),
                "s3:list-objects-flat" => (
                    "listObjects",
                    "s3.listObjectsFlatStart",
                    "s3.listObjectsFlatSuccess",
                ),
                "s3:list-folders" => (
                    "listFolders",
                    "s3.listFoldersStart",
                    "s3.listFoldersSuccess",
                ),
                "s3:create-folder" => (
                    "createFolder",
                    "s3.createFolderStart",
                    "s3.createFolderSuccess",
                ),
                "s3:metadata" => ("metadata", "s3.metadataStart", "s3.metadataSuccess"),
                "s3:generate-url" => ("generateUrl", "s3.urlStart", "s3.urlSuccess"),
                _ => (
                    "listObjects",
                    "s3.listObjectsStart",
                    "s3.listObjectsSuccess",
                ),
            };
            let target = args
                .iter()
                .skip(1)
                .take(2)
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("/");
            state.logger.operation(
                operation,
                "start",
                &tr(start_key, &[("target", target.clone())]),
                None,
                None,
            );
            let read = async {
                if channel == "s3:list-buckets" {
                    return value(service.buckets(&ctx).await?);
                }
                let bucket = safety::bucket(&arg::<String>(args, 1)?)?;
                let key: String = arg(args, 2)?;
                match channel {
                    "s3:list-objects" | "s3:list-objects-flat" | "s3:list-folders" => {
                        let prefix = safety::existing_key(&key, true, true)?;
                        let token: Option<String> = optional(args, 3)?;
                        let max: u64 = optional(args, 4)?.unwrap_or(1000);
                        if token.as_deref().is_some_and(str::is_empty) {
                            return Err(AppError::new("error.operationFailed"));
                        }
                        let mode = match channel {
                            "s3:list-objects-flat" => "flat",
                            "s3:list-folders" => "folders",
                            _ => "objects",
                        };
                        value(
                            service
                                .list(&bucket, &prefix, token, max, mode, &ctx)
                                .await?,
                        )
                    }
                    "s3:create-folder" => {
                        service.folder(&bucket, &key, &ctx).await?;
                        Ok(Value::Null)
                    }
                    "s3:metadata" => value(
                        service
                            .metadata(&bucket, &safety::existing_key(&key, false, true)?, &ctx)
                            .await?,
                    ),
                    "s3:generate-url" => value(
                        service
                            .url(&bucket, &safety::existing_key(&key, false, false)?)
                            .await?,
                    ),
                    _ => unreachable!(),
                }
            };
            let output = tokio::time::timeout(Duration::from_secs(30), read)
                .await
                .map_err(|_| AppError::new("error.requestTimeout"))??;
            state.logger.operation(
                operation,
                "success",
                &tr(
                    success_key,
                    &[
                        ("target", target),
                        ("count", output.as_array().map_or(0, Vec::len).to_string()),
                    ],
                ),
                None,
                None,
            );
            Ok(output)
        }
        "task:upload" => {
            let request: UploadRequest = arg(args, 0)?;
            let connection = state.config.active(&request.connection_id)?;
            value(
                state
                    .tasks
                    .upload(connection, request, state.config.raw().transfer_settings)?,
            )
        }
        "task:download" => {
            let request: DownloadRequest = arg(args, 0)?;
            let connection = state.config.active(&request.connection_id)?;
            value(state.tasks.download(
                connection,
                request,
                state.download_folder(),
                state.config.raw().transfer_settings,
            )?)
        }
        "task:delete" => {
            let request: DeleteRequest = arg(args, 0)?;
            let connection = state.config.active(&request.connection_id)?;
            value(
                state
                    .tasks
                    .delete(connection, request, state.config.raw().transfer_settings)?,
            )
        }
        "task:copy" | "task:move" => {
            let request: CopyRequest = arg(args, 0)?;
            let connection = state.config.active(&request.connection_id)?;
            value(state.tasks.copy(
                if channel == "task:copy" {
                    "copy"
                } else {
                    "move"
                },
                connection,
                request,
                state.config.raw().transfer_settings,
            )?)
        }
        "task:rename" => {
            let request: RenameRequest = arg(args, 0)?;
            let connection = state.config.active(&request.connection_id)?;
            value(state.tasks.copy(
                "rename",
                connection,
                CopyRequest {
                    connection_id: request.connection_id,
                    source_bucket: request.bucket.clone(),
                    target_bucket: request.bucket,
                    source_key: request.old_key,
                    target_key: request.new_key,
                    target_exists_policy: Some("autoRename".into()),
                },
                state.config.raw().transfer_settings,
            )?)
        }
        "task:list" => value(state.tasks.list()),
        "task:cancel" => {
            state.tasks.cancel(&arg::<String>(args, 0)?);
            Ok(Value::Null)
        }
        "task:retry" => {
            state.tasks.retry(&arg::<String>(args, 0)?)?;
            Ok(Value::Null)
        }
        "task:clear-completed" => {
            state.tasks.clear();
            Ok(Value::Null)
        }
        "log:list" => value(state.logger.list()),
        "log:clear" => {
            state.logger.clear()?;
            Ok(Value::Null)
        }
        "app:get-diagnostics" => value(diagnostics(app, state)),
        "app:export-diagnostics" => {
            let report = diagnostics(app, state);
            let dialog = app
                .dialog()
                .file()
                .set_parent(window)
                .set_title(t("settings.exportDiagnostics"))
                .add_filter("JSON", &["json"])
                .set_file_name(format!(
                    "oss-browser-diagnostics-{}.json",
                    chrono::Utc::now().format("%Y%m%d-%H%M%S")
                ));
            let path = tauri::async_runtime::spawn_blocking(move || {
                dialog.blocking_save_file().and_then(|p| p.into_path().ok())
            })
            .await
            .map_err(AppError::sdk)?;
            if let Some(path) = path {
                config::atomic_write(&path, &serde_json::to_vec_pretty(&report)?)?;
                value(path.to_string_lossy().to_string())
            } else {
                Ok(Value::Null)
            }
        }
        _ => Err(AppError::new("error.untrustedIpcSender")),
    }
}
fn diagnostics(app: &tauri::AppHandle, state: &AppState) -> AppDiagnostics {
    let mut config = state.config.get();
    for c in &mut config.connections {
        c.access_key_id = "[redacted]".into();
    }
    let mut logs = state.logger.list();
    if logs.len() > 200 {
        logs.drain(..logs.len() - 200);
    }
    sanitized(&AppDiagnostics {
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.into(),
        webview_version: tauri::webview_version().unwrap_or_default(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        generated_at: now(),
        user_data_path: state
            .config
            .path
            .parent()
            .unwrap_or(&state.config.path)
            .to_string_lossy()
            .into(),
        config_file_path: state.config.path.to_string_lossy().into(),
        secure_credential_storage_available: state.config.secure(),
        config_summary: config,
        recent_logs: logs,
        failed_tasks: state
            .tasks
            .list()
            .into_iter()
            .filter(|t| ["failed", "partial_success"].contains(&t.status.as_str()))
            .take(100)
            .collect(),
    })
}
pub fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let tasks = state.tasks.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tasks.shutdown().await;
        app.exit(0);
    });
}
