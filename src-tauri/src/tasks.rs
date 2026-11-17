use crate::{
    error::{AppError, Result},
    i18n::{now, t, tr},
    logger::{Logger, sanitized},
    model::*,
    s3::{Context, OperationResult, Progress, S3Service},
    safety,
};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const TERMINAL: &[&str] = &[
    "success",
    "failed",
    "partial_success",
    "canceled",
    "stopped",
];
#[derive(Clone, Debug)]
pub struct RemoteTarget {
    pub connection: String,
    pub bucket: String,
    pub key: String,
}
pub fn overlaps(a: &RemoteTarget, b: &RemoteTarget) -> bool {
    a.connection == b.connection
        && a.bucket == b.bucket
        && (a.key == b.key
            || (a.key.ends_with('/') && b.key.starts_with(&a.key))
            || (b.key.ends_with('/') && a.key.starts_with(&b.key)))
}

#[derive(Clone)]
enum Job {
    Upload {
        bucket: String,
        key: String,
        path: PathBuf,
        directory: bool,
        preserve: bool,
    },
    Download {
        bucket: String,
        key: String,
        target: PathBuf,
        base: PathBuf,
        skip: bool,
        overwrite: bool,
    },
    Delete {
        bucket: String,
        keys: Vec<String>,
    },
    Copy {
        request: CopyRequest,
        moving: bool,
    },
}
struct Internal {
    item: TaskItem,
    connection: ConnectionConfig,
    settings: TransferSettings,
    job: Job,
    token: CancellationToken,
    running: bool,
    started: Option<Instant>,
    last_emit: Option<Instant>,
    targets: Vec<RemoteTarget>,
    download: Option<PathBuf>,
}
struct Inner {
    tasks: HashMap<String, Internal>,
    queue: VecDeque<String>,
    concurrent: usize,
    shutting_down: bool,
    app: Option<tauri::AppHandle>,
}
pub struct TaskManager {
    inner: Mutex<Inner>,
    logger: Logger,
    completed: Notify,
}

impl TaskManager {
    pub fn new(logger: Logger) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                tasks: HashMap::new(),
                queue: VecDeque::new(),
                concurrent: 3,
                shutting_down: false,
                app: None,
            }),
            logger,
            completed: Notify::new(),
        })
    }
    pub fn attach(&self, app: tauri::AppHandle) {
        self.inner.lock().unwrap().app = Some(app);
    }
    pub fn set_concurrency(self: &Arc<Self>, n: u64) {
        self.inner.lock().unwrap().concurrent = n.clamp(1, 8) as usize;
        self.pump();
    }
    pub fn list(&self) -> Vec<TaskItem> {
        let inner = self.inner.lock().unwrap();
        let mut tasks: Vec<_> = inner.tasks.values().map(|t| sanitized(&t.item)).collect();
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        tasks
    }
    pub fn upload(
        self: &Arc<Self>,
        connection: ConnectionConfig,
        request: UploadRequest,
        settings: TransferSettings,
    ) -> Result<Vec<TaskItem>> {
        if request.file_paths.is_empty()
            && request.directory_paths.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(AppError::new("main.validation.uploadRequired"));
        }
        let bucket = safety::bucket(&request.bucket)?;
        let prefix = safety::prefix(&request.prefix)?;
        let mut prepared = Vec::new();
        for (path, directory) in request.file_paths.into_iter().map(|p| (p, false)).chain(
            request
                .directory_paths
                .unwrap_or_default()
                .into_iter()
                .map(|p| (p, true)),
        ) {
            let path = PathBuf::from(path);
            let info = std::fs::symlink_metadata(&path)?;
            if info.is_symlink() || (directory && !info.is_dir()) || (!directory && !info.is_file())
            {
                return Err(AppError::new("scanner.skippedNonRegular"));
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::new("error.uploadPathOutsideFolder"))?
                .to_string();
            let key = safety::key(
                &format!("{prefix}{name}{}", if directory { "/" } else { "" }),
                false,
                directory,
            )?;
            let job = Job::Upload {
                bucket: bucket.clone(),
                key: key.clone(),
                path: path.clone(),
                directory,
                preserve: request.preserve_empty_folders.unwrap_or(true),
            };
            let target = RemoteTarget {
                connection: connection.id.clone(),
                bucket: bucket.clone(),
                key: key.clone(),
            };
            prepared.push((
                name,
                path.to_string_lossy().into_owned(),
                format!("{bucket}/{key}"),
                job,
                target,
            ));
        }
        let mut result = Vec::new();
        let mut inner = self.inner.lock().unwrap();
        for (name, source, target, job, remote) in prepared {
            match insert(
                &mut inner,
                "upload",
                name,
                source,
                target,
                connection.clone(),
                settings.clone(),
                job,
                Some(remote),
                None,
            ) {
                Ok(item) => {
                    emit(&inner, &item);
                    result.push(item);
                }
                Err(error) if error.message == t("error.remoteTargetReserved") => {}
                Err(error) => return Err(error),
            }
        }
        drop(inner);
        self.pump();
        Ok(result)
    }
    pub fn download(
        self: &Arc<Self>,
        connection: ConnectionConfig,
        request: DownloadRequest,
        base: PathBuf,
        settings: TransferSettings,
    ) -> Result<TaskItem> {
        let bucket = safety::bucket(&request.bucket)?;
        let key = safety::existing_key(&request.key, false, false)?;
        let name = Path::new(&key)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::new("error.pathTraversalBlocked"))?
            .to_string();
        let requested = request
            .save_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| base.join(&name));
        let raw = safety::inside(&base, &requested)?;
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down {
            return Err(AppError::new("error.appShuttingDown"));
        }
        let reserved = |path: &Path| {
            inner.tasks.values().any(|task| {
                task.download
                    .as_ref()
                    .is_some_and(|p| safety::path_id(p) == safety::path_id(path))
            })
        };
        let mut target = raw.clone();
        let overwrite = settings.overwrite_policy == "overwrite";
        let skip = settings.overwrite_policy == "skip" && (raw.exists() || reserved(&raw));
        if overwrite && reserved(&target) {
            return Err(AppError::new("error.downloadTargetReserved"));
        }
        if !overwrite && !skip {
            let mut index = 1;
            while target.exists() || reserved(&target) {
                if index >= 10000 {
                    return Err(AppError::new("error.downloadPathUnavailable"));
                }
                target = safety::renamed_path(&raw, index);
                index += 1;
            }
        }
        let job = Job::Download {
            bucket: bucket.clone(),
            key: key.clone(),
            target: target.clone(),
            base,
            skip,
            overwrite,
        };
        let item = insert(
            &mut inner,
            "download",
            name,
            format!("{bucket}/{key}"),
            target.to_string_lossy().into(),
            connection,
            settings,
            job,
            None,
            if skip { None } else { Some(target) },
        )?;
        emit(&inner, &item);
        drop(inner);
        self.pump();
        Ok(item)
    }
    pub fn delete(
        self: &Arc<Self>,
        connection: ConnectionConfig,
        request: DeleteRequest,
        settings: TransferSettings,
    ) -> Result<TaskItem> {
        let bucket = safety::bucket(&request.bucket)?;
        let mut keys = request.keys.unwrap_or_default();
        if let Some(key) = request.key {
            keys.push(key);
        }
        let mut keys = keys
            .into_iter()
            .map(|key| safety::existing_key(&key, false, true))
            .collect::<Result<Vec<_>>>()?;
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            return Err(AppError::new("error.keyRequired"));
        }
        let name = if keys.len() == 1 {
            keys[0].clone()
        } else {
            format!("{} objects", keys.len())
        };
        self.enqueue(
            "delete",
            name.clone(),
            format!("{bucket}/{name}"),
            String::new(),
            connection,
            settings,
            Job::Delete { bucket, keys },
            None,
            None,
        )
    }
    pub fn copy(
        self: &Arc<Self>,
        kind: &str,
        connection: ConnectionConfig,
        mut request: CopyRequest,
        settings: TransferSettings,
    ) -> Result<TaskItem> {
        request.source_bucket = safety::bucket(&request.source_bucket)?;
        request.target_bucket = safety::bucket(&request.target_bucket)?;
        request.source_key = safety::existing_key(&request.source_key, false, true)?;
        let folder = request.source_key.ends_with('/');
        request.target_key = safety::key(&request.target_key, false, folder)?;
        if folder {
            request.target_key = safety::prefix(&request.target_key)?;
        }
        safety::move_target(
            &request.source_bucket,
            &request.source_key,
            &request.target_bucket,
            &request.target_key,
        )?;
        if request
            .target_exists_policy
            .as_deref()
            .is_some_and(|p| !["overwrite", "skip", "autoRename"].contains(&p))
        {
            return Err(AppError::new("error.operationFailed"));
        }
        let source = format!("{}/{}", request.source_bucket, request.source_key);
        let target = format!("{}/{}", request.target_bucket, request.target_key);
        let remote = RemoteTarget {
            connection: connection.id.clone(),
            bucket: request.target_bucket.clone(),
            key: request.target_key.clone(),
        };
        self.enqueue(
            kind,
            request
                .source_key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("")
                .into(),
            source,
            target,
            connection,
            settings,
            Job::Copy {
                request,
                moving: kind != "copy",
            },
            Some(remote),
            None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        self: &Arc<Self>,
        kind: &str,
        name: String,
        source: String,
        target: String,
        connection: ConnectionConfig,
        settings: TransferSettings,
        job: Job,
        remote: Option<RemoteTarget>,
        download: Option<PathBuf>,
    ) -> Result<TaskItem> {
        let mut inner = self.inner.lock().unwrap();
        let item = insert(
            &mut inner, kind, name, source, target, connection, settings, job, remote, download,
        )?;
        emit(&inner, &item);
        drop(inner);
        self.pump();
        Ok(item)
    }
    fn pump(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down {
            return;
        }
        let running = inner.tasks.values().filter(|t| t.running).count();
        let count = inner.concurrent.saturating_sub(running);
        let mut start = Vec::new();
        for _ in 0..count {
            let Some(id) = inner.queue.pop_front() else {
                break;
            };
            if let Some(task) = inner.tasks.get_mut(&id) {
                if task.item.status != "pending" {
                    continue;
                }
                task.running = true;
                task.started = Some(Instant::now());
                task.item.status = "running".into();
                task.item.started_at = Some(now());
                task.item.updated_at = now();
                start.push((id, task.item.clone()));
            }
        }
        for (_, item) in &start {
            emit(&inner, item);
        }
        drop(inner);
        for (id, item) in start {
            self.logger.operation(
                "task",
                "start",
                &tr("task.start", &[("name", item.name)]),
                item.stats.as_ref(),
                Some(&id),
            );
            let manager = self.clone();
            tokio::spawn(async move {
                let outcome = manager.execute(&id).await;
                manager.finish(&id, outcome);
                manager.pump();
            });
        }
    }
    async fn execute(self: &Arc<Self>, id: &str) -> Result<OperationResult> {
        let (connection, settings, job, token, max_retries) = {
            let inner = self.inner.lock().unwrap();
            let task = &inner.tasks[id];
            (
                task.connection.clone(),
                task.settings.clone(),
                task.job.clone(),
                task.token.clone(),
                task.item.max_retries,
            )
        };
        let weak = Arc::downgrade(self);
        let progress_id = id.to_string();
        let progress = Arc::new(move |p: Progress| {
            if let Some(manager) = weak.upgrade() {
                manager.progress(&progress_id, p);
            }
        });
        let weak = Arc::downgrade(self);
        let reserve_id = id.to_string();
        let reserve = Arc::new(move |key: &str| {
            weak.upgrade()
                .ok_or_else(|| AppError::new("error.appShuttingDown"))?
                .reserve_resolved(&reserve_id, key)
        });
        let ctx = Context {
            cancel: token.clone(),
            settings,
            progress,
            reserve,
        };
        let service = S3Service::new(connection, self.logger.clone())?;
        for attempt in 0..=max_retries {
            let outcome = match &job {
                Job::Upload {
                    bucket,
                    key,
                    path,
                    directory,
                    preserve,
                } => {
                    if *directory {
                        let prefix = key
                            .trim_end_matches('/')
                            .rsplit_once('/')
                            .map(|(p, _)| format!("{p}/"))
                            .unwrap_or_default();
                        service
                            .upload_directory(bucket, &prefix, path, *preserve, &ctx)
                            .await
                    } else {
                        service.upload(bucket, key, path, &ctx).await
                    }
                }
                Job::Download {
                    bucket,
                    key,
                    target,
                    base,
                    skip,
                    overwrite,
                } => {
                    if *skip {
                        Ok(OperationResult::skip())
                    } else {
                        service
                            .download(bucket, key, target, base, *overwrite, &ctx)
                            .await
                    }
                }
                Job::Delete { bucket, keys } => service.delete(bucket, keys, &ctx).await,
                Job::Copy { request, moving } => service.copy(request, *moving, &ctx).await,
            };
            match outcome {
                Err(error) if error.retryable && attempt < max_retries && !token.is_cancelled() => {
                    let delay = Duration::from_secs((1u64 << attempt.min(3)).min(10));
                    self.update(id, |task| {
                        task.item.retries = attempt + 1;
                        task.item.failure = Some(failure(&error, Some(delay.as_millis() as u64)));
                    });
                    self.logger.write(
                        "warn",
                        &tr(
                            "task.retryLater",
                            &[
                                ("seconds", delay.as_secs().to_string()),
                                ("name", self.name(id)),
                            ],
                        ),
                        error.detail.as_deref(),
                        "Task",
                    );
                    tokio::select! { _=token.cancelled()=>return Err(AppError::canceled()), _=tokio::time::sleep(delay)=>{} }
                }
                result => return result,
            }
        }
        unreachable!()
    }
    fn name(&self, id: &str) -> String {
        self.inner.lock().unwrap().tasks[id].item.name.clone()
    }
    fn reserve_resolved(&self, id: &str, key: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let task = inner
            .tasks
            .get(id)
            .ok_or_else(|| AppError::new("error.operationFailed"))?;
        let Job::Copy { request, .. } = &task.job else {
            return Ok(());
        };
        let remote = RemoteTarget {
            connection: task.connection.id.clone(),
            bucket: request.target_bucket.clone(),
            key: key.into(),
        };
        if inner.tasks.iter().any(|(other_id, task)| {
            other_id != id && task.targets.iter().any(|target| overlaps(target, &remote))
        }) {
            return Err(AppError::new("error.remoteTargetReserved"));
        }
        let task = inner.tasks.get_mut(id).unwrap();
        if !task.targets.iter().any(|t| t.key == key) {
            task.targets.push(remote);
        }
        if !request_source_folder(&task.job) {
            task.item.target = format!("{}/{}", task.targets[0].bucket, key);
        }
        Ok(())
    }
    fn progress(&self, id: &str, p: Progress) {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.tasks.get_mut(id) else {
            return;
        };
        if TERMINAL.contains(&task.item.status.as_str()) {
            return;
        }
        task.item.progress = p
            .loaded
            .saturating_mul(100)
            .checked_div(p.total)
            .unwrap_or(0)
            .min(99);
        if let Some(stats) = p.stats {
            task.item.stats = Some(stats);
        }
        task.item.transferred_bytes = Some(p.loaded);
        task.item.total_bytes = Some(p.total);
        task.item.completed_parts = Some(p.completed);
        task.item.total_parts = Some(p.parts);
        let elapsed = task
            .started
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let speed = p
            .loaded
            .saturating_mul(1000)
            .checked_div(elapsed)
            .unwrap_or(0);
        task.item.speed = Some(speed);
        task.item.part_stats = Some(TaskPartStats {
            total_parts: Some(p.parts),
            completed_parts: Some(p.completed),
            active_parts: Some(p.active),
            average_speed: Some(speed),
            estimated_seconds_remaining: p.total.saturating_sub(p.loaded).checked_div(speed),
            ..Default::default()
        });
        task.item.updated_at = now();
        if task
            .last_emit
            .is_none_or(|last| last.elapsed() >= Duration::from_millis(250))
        {
            task.last_emit = Some(Instant::now());
            let item = task.item.clone();
            emit(&inner, &item);
        }
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut Internal)) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner.tasks.get_mut(id) {
            update(task);
            task.item.updated_at = now();
            let item = task.item.clone();
            emit(&inner, &item);
        }
    }
    fn finish(&self, id: &str, result: Result<OperationResult>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.tasks.get_mut(id) else {
            return;
        };
        let canceled = task.token.is_cancelled();
        match result {
            Ok(result) => {
                let partial =
                    result.stats.failed > 0 && result.stats.success + result.stats.skipped > 0;
                task.item.status = if partial {
                    "partial_success"
                } else if canceled {
                    "canceled"
                } else if result.stats.failed > 0 {
                    "failed"
                } else {
                    "success"
                }
                .into();
                if task.item.status == "success"
                    || task.item.status == "partial_success"
                    || task.item.status == "failed"
                {
                    task.item.progress = 100;
                }
                task.item.stats = Some(result.stats.clone());
                task.item.report = Some(result.report());
                if result.stats.failed > 0 {
                    task.item.error_message = result.failed_items.first().map(|e| e.reason.clone());
                    task.item.failure = result.failed_items.first().map(|e| TaskFailureInfo {
                        category: e.category.clone(),
                        message: e.reason.clone(),
                        detail: e.detail.clone(),
                        retryable: false,
                        retry_after_ms: None,
                        occurred_at: now(),
                    });
                }
            }
            Err(error) => {
                task.item.status = if canceled { "canceled" } else { "failed" }.into();
                task.item.error_message = Some(error.message.clone());
                task.item.failure = Some(failure(&error, None));
                if let Some(stats) = &mut task.item.stats {
                    stats.total = stats.total.max(1);
                    stats.processed = stats.total;
                    stats.failed = stats.total.saturating_sub(stats.success + stats.skipped);
                }
            }
        }
        task.running = false;
        if let Some(parts) = &mut task.item.part_stats {
            parts.active_parts = Some(0);
        }
        task.targets.clear();
        task.download = None;
        task.item.completed_at = Some(now());
        task.item.updated_at = now();
        task.item.duration_ms = task.started.map(|s| s.elapsed().as_millis() as u64);
        let item = task.item.clone();
        emit(&inner, &item);
        prune(&mut inner);
        drop(inner);
        let key = match item.status.as_str() {
            "failed" => "task.failed",
            "partial_success" => "task.partialSuccess",
            "canceled" => "task.canceled",
            _ => "task.finish",
        };
        self.logger.operation(
            "task",
            &item.status,
            &tr(key, &[("name", item.name)]),
            item.stats.as_ref(),
            Some(&item.id),
        );
        self.completed.notify_waiters();
    }
    pub fn cancel(self: &Arc<Self>, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner.tasks.get_mut(id) {
            if TERMINAL.contains(&task.item.status.as_str()) {
                return;
            }
            task.token.cancel();
            task.item.status = "canceled".into();
            task.item.updated_at = now();
            task.item.completed_at = Some(now());
            if !task.running {
                task.targets.clear();
                task.download = None;
            }
            let item = task.item.clone();
            inner.queue.retain(|queued| queued != id);
            emit(&inner, &item);
        }
        drop(inner);
        self.pump();
    }
    pub fn retry(self: &Arc<Self>, id: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.tasks.get(id) else {
            return Ok(());
        };
        if task.item.status != "failed" || task.running {
            return Ok(());
        }
        if inner.shutting_down {
            return Err(AppError::new("error.appShuttingDown"));
        }
        let remote = match &task.job {
            Job::Upload { bucket, key, .. } => Some(RemoteTarget {
                connection: task.connection.id.clone(),
                bucket: bucket.clone(),
                key: key.clone(),
            }),
            Job::Copy { request, .. } => Some(RemoteTarget {
                connection: task.connection.id.clone(),
                bucket: request.target_bucket.clone(),
                key: request.target_key.clone(),
            }),
            _ => None,
        };
        if remote.as_ref().is_some_and(|r| {
            inner
                .tasks
                .iter()
                .any(|(other, t)| other != id && t.targets.iter().any(|target| overlaps(target, r)))
        }) {
            return Err(AppError::new("error.remoteTargetReserved"));
        }
        let download = match &task.job {
            Job::Download { target, skip, .. } if !skip => Some(target.clone()),
            _ => None,
        };
        if download.as_ref().is_some_and(|p| {
            inner.tasks.iter().any(|(other, t)| {
                other != id
                    && t.download
                        .as_ref()
                        .is_some_and(|d| safety::path_id(p) == safety::path_id(d))
            })
        }) {
            return Err(AppError::new("error.downloadTargetReserved"));
        }
        let task = inner.tasks.get_mut(id).unwrap();
        task.targets = remote.into_iter().collect();
        task.download = download;
        task.token = CancellationToken::new();
        task.started = None;
        task.last_emit = None;
        task.item = TaskItem {
            status: "pending".into(),
            progress: 0,
            retries: 0,
            error_message: None,
            failure: None,
            report: None,
            part_stats: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            transferred_bytes: None,
            total_bytes: None,
            completed_parts: None,
            total_parts: None,
            speed: None,
            stats: None,
            updated_at: now(),
            ..task.item.clone()
        };
        let item = task.item.clone();
        inner.queue.push_back(id.into());
        emit(&inner, &item);
        drop(inner);
        self.pump();
        Ok(())
    }
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner
            .tasks
            .retain(|_, t| t.running || !TERMINAL.contains(&t.item.status.as_str()));
    }
    pub async fn shutdown(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.shutting_down = true;
            inner.queue.clear();
            for task in inner.tasks.values_mut() {
                if !TERMINAL.contains(&task.item.status.as_str()) {
                    task.token.cancel();
                    task.item.status = "canceled".into();
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let notified = self.completed.notified();
                if !self.inner.lock().unwrap().tasks.values().any(|t| t.running) {
                    break;
                }
                notified.await;
            }
        })
        .await;
    }
}

#[allow(clippy::too_many_arguments)]
fn insert(
    inner: &mut Inner,
    kind: &str,
    name: String,
    source: String,
    target: String,
    connection: ConnectionConfig,
    settings: TransferSettings,
    job: Job,
    remote: Option<RemoteTarget>,
    download: Option<PathBuf>,
) -> Result<TaskItem> {
    if inner.shutting_down {
        return Err(AppError::new("error.appShuttingDown"));
    }
    if remote.as_ref().is_some_and(|r| {
        inner
            .tasks
            .values()
            .any(|t| t.targets.iter().any(|target| overlaps(target, r)))
    }) {
        return Err(AppError::new("error.remoteTargetReserved"));
    }
    let item = TaskItem {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: Some(connection.id.clone()),
        connection_name: Some(connection.profile_name.clone()),
        r#type: kind.into(),
        name,
        source,
        target,
        status: "pending".into(),
        created_at: now(),
        updated_at: now(),
        max_retries: if ["copy", "move", "rename"].contains(&kind) {
            0
        } else {
            settings.retry_count
        },
        stats: Some(TaskStats {
            total: match &job {
                Job::Upload {
                    directory: true, ..
                } => 0,
                Job::Delete { keys, .. } => keys.len() as u64,
                _ => 1,
            },
            ..Default::default()
        }),
        ..Default::default()
    };
    inner.queue.push_back(item.id.clone());
    inner.tasks.insert(
        item.id.clone(),
        Internal {
            item: item.clone(),
            connection,
            settings,
            job,
            token: CancellationToken::new(),
            running: false,
            started: None,
            last_emit: None,
            targets: remote.into_iter().collect(),
            download,
        },
    );
    Ok(item)
}
fn emit(inner: &Inner, item: &TaskItem) {
    if let Some(app) = &inner.app {
        let _ = app.emit_to("main", "task:updated", sanitized(item));
    }
}
fn failure(error: &AppError, delay: Option<u64>) -> TaskFailureInfo {
    TaskFailureInfo {
        category: error.category.clone(),
        message: error.message.clone(),
        detail: error.detail.clone(),
        retryable: error.retryable,
        retry_after_ms: delay,
        occurred_at: now(),
    }
}
fn request_source_folder(job: &Job) -> bool {
    matches!(job,Job::Copy {request,..} if request.source_key.ends_with('/'))
}
fn prune(inner: &mut Inner) {
    let mut terminal: Vec<_> = inner
        .tasks
        .iter()
        .filter(|(_, t)| !t.running && TERMINAL.contains(&t.item.status.as_str()))
        .map(|(id, t)| (id.clone(), t.item.updated_at.clone()))
        .collect();
    terminal.sort_by(|a, b| b.1.cmp(&a.1));
    for (id, _) in terminal.into_iter().skip(1000) {
        inner.tasks.remove(&id);
    }
}

pub fn cleanup_partials(base: &Path) -> Result<()> {
    let directory = base.join(".oss-browser-partials");
    if !directory.exists() {
        return Ok(());
    }
    let directory = std::fs::canonicalize(directory)?;
    let base = std::fs::canonicalize(base)?;
    if !directory.starts_with(base) {
        return Err(AppError::new("error.pathTraversalBlocked"));
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext == "downloading")
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn copy_validates_the_final_target_before_enqueuing() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TaskManager::new(Logger::new(directory.path().join("logs")));
        for (source, target) in [
            ("folder/", "folder"),
            ("folder/child/", "folder"),
            ("file", "folder/"),
        ] {
            let request = CopyRequest {
                connection_id: "test".into(),
                source_bucket: "bucket".into(),
                target_bucket: "bucket".into(),
                source_key: source.into(),
                target_key: target.into(),
                ..Default::default()
            };
            assert!(
                manager
                    .copy(
                        "copy",
                        ConnectionConfig::default(),
                        request,
                        crate::config::defaults().transfer_settings
                    )
                    .is_err(),
                "{source} -> {target}"
            );
        }
        assert!(manager.list().is_empty());
    }
    #[test]
    fn remote_target_conflicts() {
        let target = |c: &str, b: &str, k: &str| RemoteTarget {
            connection: c.into(),
            bucket: b.into(),
            key: k.into(),
        };
        assert!(overlaps(
            &target("a", "b", "folder/"),
            &target("a", "b", "folder/file")
        ));
        assert!(overlaps(
            &target("a", "b", "file"),
            &target("a", "b", "file")
        ));
        assert!(!overlaps(
            &target("a", "b", "folder/"),
            &target("other", "b", "folder/file")
        ));
        assert!(!overlaps(
            &target("a", "b", "folder/"),
            &target("a", "b", "folders/file")
        ));
    }
    #[tokio::test]
    async fn canceled_running_task_keeps_reservations_until_runner_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TaskManager::new(Logger::new(directory.path().into()));
        let connection = ConnectionConfig {
            id: "test".into(),
            ..Default::default()
        };
        let request = CopyRequest {
            connection_id: "test".into(),
            source_bucket: "source".into(),
            source_key: "key".into(),
            target_bucket: "target".into(),
            target_key: "object".into(),
            target_exists_policy: None,
        };
        let mut inner = manager.inner.lock().unwrap();
        let item = insert(
            &mut inner,
            "copy",
            "name".into(),
            "source/key".into(),
            "target/object".into(),
            connection,
            crate::config::defaults().transfer_settings,
            Job::Copy {
                request,
                moving: false,
            },
            Some(RemoteTarget {
                connection: "test".into(),
                bucket: "target".into(),
                key: "object".into(),
            }),
            None,
        )
        .unwrap();
        inner.tasks.get_mut(&item.id).unwrap().running = true;
        inner.tasks.get_mut(&item.id).unwrap().item.status = "running".into();
        inner.queue.clear();
        drop(inner);
        manager.cancel(&item.id);
        manager.clear();
        assert_eq!(manager.list().len(), 1);
        assert_eq!(
            manager.inner.lock().unwrap().tasks[&item.id].targets.len(),
            1
        );
        manager.reserve_resolved(&item.id, "object (1)").unwrap();
        assert_eq!(
            manager.inner.lock().unwrap().tasks[&item.id].targets.len(),
            2
        );
        manager.finish(&item.id, Err(AppError::canceled()));
        assert!(
            manager.inner.lock().unwrap().tasks[&item.id]
                .targets
                .is_empty()
        );
        manager.clear();
        assert!(manager.list().is_empty());
    }
    #[tokio::test]
    async fn upload_validates_the_entire_batch_before_enqueuing() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("valid.txt");
        std::fs::write(&file, b"test").unwrap();
        let manager = TaskManager::new(Logger::new(directory.path().into()));
        manager.inner.lock().unwrap().concurrent = 0;
        for invalid in [
            directory.path().join("missing.txt"),
            directory.path().to_path_buf(),
        ] {
            assert!(
                manager
                    .upload(
                        ConnectionConfig::default(),
                        UploadRequest {
                            bucket: "test-bucket".into(),
                            file_paths: vec![
                                file.to_string_lossy().into(),
                                invalid.to_string_lossy().into()
                            ],
                            ..Default::default()
                        },
                        crate::config::defaults().transfer_settings,
                    )
                    .is_err()
            );
            let inner = manager.inner.lock().unwrap();
            assert!(inner.tasks.is_empty());
            assert!(inner.queue.is_empty());
        }
        let second = directory.path().join("second.txt");
        std::fs::write(&second, b"second").unwrap();
        let items = manager
            .upload(
                ConnectionConfig::default(),
                UploadRequest {
                    bucket: "test-bucket".into(),
                    file_paths: vec![
                        file.to_string_lossy().into(),
                        file.to_string_lossy().into(),
                        second.to_string_lossy().into(),
                    ],
                    ..Default::default()
                },
                crate::config::defaults().transfer_settings,
            )
            .unwrap();
        assert_eq!(items.len(), 2);
        let inner = manager.inner.lock().unwrap();
        assert_eq!(inner.tasks.len(), 2);
        assert_eq!(inner.queue.len(), 2);
    }
    #[tokio::test]
    async fn upload_rejects_empty_input_before_enqueuing() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TaskManager::new(Logger::new(directory.path().into()));
        assert!(
            manager
                .upload(
                    ConnectionConfig::default(),
                    UploadRequest::default(),
                    crate::config::defaults().transfer_settings
                )
                .is_err()
        );
        assert!(manager.list().is_empty());
    }
}
