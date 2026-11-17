use crate::{
    config,
    error::{AppError, Result, check_cancel},
    i18n::{t, tr},
    logger::Logger,
    model::*,
    safety,
};
use aws_sdk_s3::{
    Client,
    config::{
        BehaviorVersion, Credentials, Region, RequestChecksumCalculation,
        ResponseChecksumValidation, retry::RetryConfig, timeout::TimeoutConfig,
    },
    presigning::PresigningConfig,
    primitives::{ByteStream, Length},
    types::{ChecksumAlgorithm, CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier},
};
use aws_smithy_types::body::SdkBody;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{StreamExt, stream};
use http_body_util::BodyExt;
use md5::{Digest, Md5};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
pub const MULTIPART_THRESHOLD: u64 = 100 * MIB;

#[derive(Clone, Default)]
pub struct Progress {
    pub loaded: u64,
    pub total: u64,
    pub completed: u64,
    pub parts: u64,
    pub active: u64,
    pub stats: Option<TaskStats>,
}
pub type ProgressHandler = Arc<dyn Fn(Progress) + Send + Sync>;
pub type ReserveTarget = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

#[derive(Clone)]
pub struct Context {
    pub cancel: CancellationToken,
    pub settings: TransferSettings,
    pub progress: ProgressHandler,
    pub reserve: ReserveTarget,
}
impl Default for Context {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            settings: config::defaults().transfer_settings,
            progress: Arc::new(|_| {}),
            reserve: Arc::new(|_| Ok(())),
        }
    }
}

#[derive(Clone)]
pub struct S3Service {
    pub client: Client,
    pub connection: ConnectionConfig,
    pub logger: Logger,
    slots: Arc<Semaphore>,
}

macro_rules! send {
    ($s:expr, $ctx:expr, $builder:expr) => {
        $s.request(
            $ctx,
            Box::pin(async { $builder.send().await.map_err(AppError::sdk) }),
        )
        .await
    };
}

#[derive(Default, Debug)]
pub struct OperationResult {
    pub stats: TaskStats,
    pub failed_items: Vec<BatchOperationFailedItem>,
    pub truncated: bool,
}
impl OperationResult {
    pub fn success() -> Self {
        Self {
            stats: TaskStats {
                total: 1,
                processed: 1,
                success: 1,
                ..Default::default()
            },
            ..Default::default()
        }
    }
    pub fn skip() -> Self {
        Self {
            stats: TaskStats {
                total: 1,
                processed: 1,
                skipped: 1,
                ..Default::default()
            },
            ..Default::default()
        }
    }
    pub fn failure(&mut self, key: &str, error: AppError) {
        self.stats.failed += 1;
        if self.failed_items.len() < 100 {
            self.failed_items.push(BatchOperationFailedItem {
                key: key.into(),
                reason: error.message,
                category: error.category,
                detail: error.detail,
            });
        } else {
            self.truncated = true;
        }
    }
    pub fn merge(&mut self, other: Self) {
        self.stats.total += other.stats.total;
        self.stats.processed += other.stats.processed;
        self.stats.success += other.stats.success;
        self.stats.failed += other.stats.failed;
        self.stats.skipped += other.stats.skipped;
        for failure in other.failed_items {
            if self.failed_items.len() < 100 {
                self.failed_items.push(failure);
            } else {
                self.truncated = true;
            }
        }
        self.truncated |= other.truncated;
    }
    pub fn report(&self) -> BatchOperationReport {
        BatchOperationReport {
            total: self.stats.total,
            success: self.stats.success,
            failed: self.stats.failed,
            skipped: self.stats.skipped,
            failed_items: self.failed_items.clone(),
            failed_items_truncated: self.truncated,
        }
    }
}

pub fn part_size(total: u64, configured_mb: u64) -> Result<u64> {
    let size = (configured_mb.clamp(5, 5120) * MIB).max(total.div_ceil(10000));
    if size > 5 * GIB {
        return Err(AppError::new("error.multipartRejected"));
    }
    Ok(size)
}
pub fn ranges(total: u64, size: u64) -> Vec<(u64, u64)> {
    (0..total)
        .step_by(size as usize)
        .map(|start| (start, (total - start).min(size)))
        .collect()
}

#[derive(Clone)]
struct Tracker {
    parts: Arc<Mutex<Vec<(u64, bool)>>>,
    total: u64,
    concurrency: u64,
    handler: ProgressHandler,
}
impl Tracker {
    fn new(total: u64, count: usize, ctx: &Context) -> Self {
        Self {
            parts: Arc::new(Mutex::new(vec![(0, false); count])),
            total,
            concurrency: ctx.settings.multipart_concurrency.clamp(1, 16),
            handler: ctx.progress.clone(),
        }
    }
    fn update(&self, index: usize, loaded: u64, completed: bool) {
        let mut parts = self.parts.lock().unwrap();
        parts[index] = (parts[index].0.max(loaded), completed || parts[index].1);
        let completed = parts.iter().filter(|p| p.1).count() as u64;
        let progress = Progress {
            loaded: parts.iter().map(|p| p.0).sum(),
            total: self.total,
            completed,
            parts: parts.len() as u64,
            active: (parts.len() as u64 - completed).min(self.concurrency),
            stats: None,
        };
        drop(parts);
        (self.handler)(progress);
    }
}

impl S3Service {
    pub fn new(mut connection: ConnectionConfig, logger: Logger) -> Result<Self> {
        config::validate_connection(&mut connection)?;
        let endpoint = if connection.endpoint.starts_with("http://")
            || connection.endpoint.starts_with("https://")
        {
            connection.endpoint.clone()
        } else {
            format!(
                "{}://{}",
                if connection.ssl { "https" } else { "http" },
                connection.endpoint
            )
        };
        let cfg = aws_sdk_s3::config::Builder::new()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(connection.region.clone()))
            .endpoint_url(endpoint)
            .force_path_style(connection.force_path_style)
            .credentials_provider(Credentials::new(
                &connection.access_key_id,
                connection.secret_access_key.clone().unwrap_or_default(),
                connection.session_token.clone(),
                None,
                "oss-browser",
            ))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(120))
                    .operation_attempt_timeout(Duration::from_secs(120))
                    .build(),
            )
            .retry_config(RetryConfig::standard().with_max_attempts(3))
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        Ok(Self {
            client: Client::from_conf(cfg),
            connection,
            logger,
            slots: Arc::new(Semaphore::new(16)),
        })
    }
    async fn request<T>(
        &self,
        ctx: &Context,
        // SDK futures can exceed Windows debug worker stacks when nested in batch operations.
        request: Pin<Box<impl Future<Output = Result<T>>>>,
    ) -> Result<T> {
        tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => Err(AppError::canceled()),
            result = async { let _permit = self.slots.acquire().await.map_err(AppError::sdk)?; request.await } => result,
        }
    }
    pub async fn test(&self, ctx: &Context) -> Result<TestConnectionResult> {
        if let Some(bucket) = &self.connection.default_bucket {
            send!(self, ctx, self.client.head_bucket().bucket(bucket))?;
            return Ok(TestConnectionResult {
                ok: true,
                buckets: Some(vec![BucketInfo {
                    name: bucket.clone(),
                    creation_date: None,
                }]),
                message: tr("s3.testBucketAccessible", &[("bucket", bucket.clone())]),
            });
        }
        Ok(TestConnectionResult {
            ok: true,
            buckets: Some(self.buckets(ctx).await?),
            message: t("s3.testSuccess"),
        })
    }
    pub async fn buckets(&self, ctx: &Context) -> Result<Vec<BucketInfo>> {
        if let Some(bucket) = &self.connection.default_bucket {
            return Ok(vec![BucketInfo {
                name: bucket.clone(),
                creation_date: None,
            }]);
        }
        let result = send!(self, ctx, self.client.list_buckets())?;
        Ok(result
            .buckets()
            .iter()
            .filter_map(|b| {
                b.name().map(|name| BucketInfo {
                    name: name.into(),
                    creation_date: b.creation_date().map(|d| d.to_string()),
                })
            })
            .collect())
    }
    pub async fn list(
        &self,
        bucket: &str,
        prefix: &str,
        token: Option<String>,
        max: u64,
        mode: &str,
        ctx: &Context,
    ) -> Result<ObjectListResult> {
        let bucket = safety::bucket(bucket)?;
        let prefix = safety::existing_key(prefix, true, true)?;
        if !(1..=1000).contains(&max) {
            return Err(AppError::new("error.operationFailed"));
        }
        let output = send!(
            self,
            ctx,
            self.client
                .list_objects_v2()
                .bucket(&bucket)
                .prefix(&prefix)
                .set_delimiter((mode != "flat").then(|| "/".into()))
                .set_continuation_token(token)
                .max_keys(max as i32)
        )?;
        let mut objects = HashMap::new();
        for item in output.common_prefixes() {
            if let Some(key) = item.prefix() {
                safety::existing_key(key, false, true)?;
                objects.insert(
                    key.to_string(),
                    object(&bucket, &prefix, key, None, None, None),
                );
            }
        }
        for item in output.contents() {
            let Some(key) = item.key() else { continue };
            if mode != "flat" && (key == prefix || (mode == "folders" && !key.ends_with('/'))) {
                continue;
            }
            safety::existing_key(key, false, true)?;
            objects.entry(key.to_string()).or_insert_with(|| {
                object(
                    &bucket,
                    &prefix,
                    key,
                    item.size().map(|v| v.max(0) as u64),
                    item.last_modified().map(|d| d.to_string()),
                    item.storage_class().map(|c| c.as_str().into()),
                )
            });
        }
        let mut objects: Vec<_> = objects.into_values().collect();
        objects.sort_by(|a, b| {
            b.is_folder
                .cmp(&a.is_folder)
                .then_with(|| a.name.cmp(&b.name))
        });
        let token = output.next_continuation_token().map(str::to_string);
        Ok(ObjectListResult {
            objects,
            is_truncated: token.is_some(),
            next_continuation_token: token,
        })
    }
    pub async fn head(
        &self,
        bucket: &str,
        key: &str,
        ctx: &Context,
    ) -> Result<aws_sdk_s3::operation::head_object::HeadObjectOutput> {
        send!(self, ctx, self.client.head_object().bucket(bucket).key(key))
    }
    pub async fn metadata(&self, bucket: &str, key: &str, ctx: &Context) -> Result<ObjectMetadata> {
        let output = self.head(bucket, key, ctx).await?;
        Ok(ObjectMetadata {
            content_type: output.content_type,
            content_length: output.content_length.map(|n| n.max(0) as u64),
            last_modified: output.last_modified.map(|d| d.to_string()),
            storage_class: output.storage_class.map(|c| c.as_str().into()),
            etag: output.e_tag,
            metadata: output.metadata.unwrap_or_default(),
        })
    }
    pub async fn url(&self, bucket: &str, key: &str) -> Result<String> {
        Ok(self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .presigned(
                PresigningConfig::expires_in(Duration::from_secs(3600)).map_err(AppError::sdk)?,
            )
            .await
            .map_err(AppError::sdk)?
            .uri()
            .into())
    }
    pub async fn folder(&self, bucket: &str, prefix: &str, ctx: &Context) -> Result<()> {
        let prefix = safety::prefix(prefix)?;
        if prefix.is_empty() {
            return Err(AppError::new("error.keyRequired"));
        }
        send!(
            self,
            ctx,
            self.client
                .put_object()
                .bucket(bucket)
                .key(prefix)
                .body(ByteStream::from_static(b""))
                .content_type("application/x-directory")
        )?;
        Ok(())
    }
    pub async fn upload(
        &self,
        bucket: &str,
        key: &str,
        path: &Path,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let info = fs::symlink_metadata(path).await?;
        if !info.is_file() || info.is_symlink() {
            return Err(AppError::new("scanner.skippedNonRegular"));
        }
        let algorithm = self
            .connection
            .checksum_algorithm
            .as_deref()
            .unwrap_or("disabled");
        let result = self
            .upload_with_checksum(bucket, key, path, info.len(), algorithm, ctx)
            .await;
        if let Err(error) = &result
            && algorithm != "SHA256"
            && error
                .detail
                .as_deref()
                .is_some_and(|d| d.to_lowercase().contains("sha256"))
            && !ctx.cancel.is_cancelled()
        {
            self.logger.write("warn", &t("s3.sha256Retry"), None, "S3");
            return self
                .upload_with_checksum(bucket, key, path, info.len(), "SHA256", ctx)
                .await;
        }
        result
    }
    async fn upload_with_checksum(
        &self,
        bucket: &str,
        key: &str,
        path: &Path,
        total: u64,
        algorithm: &str,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let content_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();
        if total < MULTIPART_THRESHOLD {
            let tracker = Tracker::new(total, 1, ctx);
            let checksum = file_checksum(path, 0, total, algorithm, &ctx.cancel).await?;
            let body = upload_body(path, 0, total, tracker.clone(), 0).await?;
            let mut request = self
                .client
                .put_object()
                .bucket(bucket)
                .key(key)
                .content_type(content_type)
                .content_length(total as i64)
                .body(body);
            if algorithm == "SHA256" {
                request = request.checksum_sha256(checksum.unwrap_or_default());
            } else if algorithm == "CRC32" {
                request = request.checksum_crc32(checksum.unwrap_or_default());
            }
            send!(self, ctx, request)?;
            tracker.update(0, total, true);
            return Ok(OperationResult::success());
        }
        let size = part_size(total, ctx.settings.chunk_size_mb)?;
        let ranges = ranges(total, size);
        let tracker = Tracker::new(total, ranges.len(), ctx);
        let output = send!(
            self,
            ctx,
            self.client
                .create_multipart_upload()
                .bucket(bucket)
                .key(key)
                .content_type(content_type)
                .set_checksum_algorithm(
                    (algorithm != "disabled").then(|| ChecksumAlgorithm::from(algorithm))
                )
        )?;
        let id = output
            .upload_id()
            .ok_or_else(|| AppError::new("error.multipartUploadIdMissing"))?
            .to_string();
        let run = async {
            let mut work = stream::iter(ranges.into_iter().enumerate().map(
                |(index, (start, length))| {
                    let tracker = tracker.clone();
                    let id = &id;
                    async move {
                        let checksum =
                            file_checksum(path, start, length, algorithm, &ctx.cancel).await?;
                        let body = upload_body(path, start, length, tracker.clone(), index).await?;
                        let mut request = self
                            .client
                            .upload_part()
                            .bucket(bucket)
                            .key(key)
                            .upload_id(id)
                            .part_number(index as i32 + 1)
                            .content_length(length as i64)
                            .body(body);
                        if algorithm == "SHA256" {
                            request = request.set_checksum_sha256(checksum);
                        } else if algorithm == "CRC32" {
                            request = request.set_checksum_crc32(checksum);
                        }
                        let output = send!(self, ctx, request)?;
                        let etag = output
                            .e_tag
                            .ok_or_else(|| AppError::new("error.multipartPartEtagMissing"))?;
                        tracker.update(index, length, true);
                        Ok::<_, AppError>(
                            CompletedPart::builder()
                                .part_number(index as i32 + 1)
                                .e_tag(etag)
                                .set_checksum_sha256(output.checksum_sha256)
                                .set_checksum_crc32(output.checksum_crc32)
                                .build(),
                        )
                    }
                },
            ))
            .buffer_unordered(ctx.settings.multipart_concurrency.clamp(1, 16) as usize);
            let mut parts = Vec::new();
            while let Some(part) = work.next().await {
                parts.push(part?);
            }
            parts.sort_by_key(|p| p.part_number());
            send!(
                self,
                ctx,
                self.client
                    .complete_multipart_upload()
                    .bucket(bucket)
                    .key(key)
                    .upload_id(&id)
                    .multipart_upload(
                        CompletedMultipartUpload::builder()
                            .set_parts(Some(parts))
                            .build()
                    )
            )?;
            Ok(OperationResult::success())
        }
        .await;
        if run.is_err() {
            self.abort(bucket, key, &id).await;
        }
        run
    }
    async fn abort(&self, bucket: &str, key: &str, id: &str) {
        // Cleanup must outlive the canceled request token, but is bounded independently.
        match tokio::time::timeout(
            Duration::from_secs(2),
            self.client
                .abort_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(id)
                .send(),
        )
        .await
        {
            Ok(Ok(_)) => {}
            other => self.logger.write(
                "warn",
                &t("error.abortMultipartCleanupFailed"),
                Some(&format!("{other:?}")),
                "S3",
            ),
        }
    }
    pub async fn download(
        &self,
        bucket: &str,
        key: &str,
        target: &Path,
        base: &Path,
        overwrite: bool,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let target = safety::inside(base, target)?;
        let partials = base.join(".oss-browser-partials");
        fs::create_dir_all(&partials).await?;
        let partials = fs::canonicalize(&partials).await?;
        let canonical_base = fs::canonicalize(base).await?;
        if !partials.starts_with(&canonical_base) {
            return Err(AppError::new("error.pathTraversalBlocked"));
        }
        let temp = partials.join(format!("{}.downloading", uuid::Uuid::new_v4()));
        let run = async {
            let head = self.head(bucket,key,ctx).await?;
            let total = head.content_length().unwrap_or(0).max(0) as u64;
            let size = if total < MULTIPART_THRESHOLD { total.max(1) } else { part_size(total,ctx.settings.chunk_size_mb)? };
            let mut ranges = ranges(total,size);
            if ranges.is_empty() { ranges.push((0,0)); }
            let ranged = total >= MULTIPART_THRESHOLD;
            let tracker = Tracker::new(total,ranges.len(),ctx);
            let file = fs::OpenOptions::new().create_new(true).write(true).open(&temp).await?;
            file.set_len(total).await?; drop(file);
            let mut work = stream::iter(ranges.into_iter().enumerate().map(|(index,(start,length))| {
                let head = &head; let temp = &temp; let tracker = tracker.clone();
                async move {
                    let request = self.client.get_object().bucket(bucket).key(key).set_version_id(head.version_id.clone()).set_if_match(head.e_tag.clone()).set_range(ranged.then(|| format!("bytes={start}-{}",start+length-1)));
                    let output = send!(self,ctx,request)?;
                    if ranged && output.content_range.as_deref() != Some(&format!("bytes {start}-{}/{total}",start+length-1)) { return Err(AppError::new("error.incompleteDownload")); }
                    let mut body = output.body.into_async_read();
                    let mut file = fs::OpenOptions::new().write(true).open(temp).await?;
                    file.seek(std::io::SeekFrom::Start(start)).await?;
                    let mut loaded = 0; let mut buffer = vec![0;64*1024];
                    loop {
                        let count = tokio::select! {
                            biased;
                            _ = ctx.cancel.cancelled() => return Err(AppError::canceled()),
                            read = tokio::time::timeout(Duration::from_secs(120),body.read(&mut buffer)) => read.map_err(AppError::sdk)??,
                        };
                        if count == 0 { break; }
                        if loaded + count as u64 > length { return Err(AppError::new("error.incompletePart")); }
                        file.write_all(&buffer[..count]).await?; loaded += count as u64;
                        tracker.update(index,loaded,false);
                    }
                    if loaded != length { return Err(AppError::new("error.incompletePart")); }
                    file.sync_all().await?; tracker.update(index,loaded,true); Ok::<_,AppError>(())
                }
            })).buffer_unordered(ctx.settings.multipart_concurrency.clamp(1,16) as usize);
            while let Some(result) = work.next().await { result?; }
            check_cancel(&ctx.cancel)?;
            if fs::metadata(&temp).await?.len() != total { return Err(AppError::new("error.tempFileSizeMismatch")); }
            safety::inside(base,&target)?;
            config::commit_file(&temp,&target,overwrite)?;
            Ok(OperationResult::success())
        }.await;
        if run.is_err() {
            let _ = fs::remove_file(&temp).await;
        }
        run
    }
    pub async fn delete_one(
        &self,
        bucket: &str,
        key: &str,
        version: Option<String>,
        etag: Option<String>,
        ctx: &Context,
    ) -> Result<()> {
        send!(
            self,
            ctx,
            self.client
                .delete_object()
                .bucket(bucket)
                .key(key)
                .set_version_id(version)
                .set_if_match(etag)
                .customize()
                .mutate_request(|request| {
                    request
                        .headers_mut()
                        .insert("content-md5", "1B2M2Y8AsgTpgAmY7PhCfg==");
                })
        )?;
        Ok(())
    }
    async fn delete_batch(
        &self,
        bucket: &str,
        keys: &[String],
        ctx: &Context,
    ) -> Result<OperationResult> {
        let objects = keys
            .iter()
            .map(|key| {
                ObjectIdentifier::builder()
                    .key(key)
                    .build()
                    .map_err(AppError::sdk)
            })
            .collect::<Result<Vec<_>>>()?;
        let output = send!(
            self,
            ctx,
            self.client
                .delete_objects()
                .bucket(bucket)
                .delete(
                    Delete::builder()
                        .set_objects(Some(objects))
                        .quiet(true)
                        .build()
                        .map_err(AppError::sdk)?
                )
                .customize()
                .mutate_request(|request| {
                    let md5 =
                        STANDARD.encode(Md5::digest(request.body().bytes().unwrap_or_default()));
                    request.headers_mut().insert("content-md5", md5);
                })
        )?;
        let mut result = OperationResult {
            stats: TaskStats {
                total: keys.len() as u64,
                processed: keys.len() as u64,
                success: keys.len() as u64,
                ..Default::default()
            },
            ..Default::default()
        };
        for error in output.errors() {
            result.stats.success = result.stats.success.saturating_sub(1);
            result.failure(
                error.key().unwrap_or(""),
                AppError::sdk(format!(
                    "{}: {}",
                    error.code().unwrap_or(""),
                    error.message().unwrap_or("")
                )),
            );
        }
        Ok(result)
    }
    pub async fn delete(
        &self,
        bucket: &str,
        keys: &[String],
        ctx: &Context,
    ) -> Result<OperationResult> {
        let mut result = OperationResult::default();
        let mut covered = HashSet::new();
        for key in keys {
            if covered
                .iter()
                .any(|prefix: &String| key.starts_with(prefix))
            {
                continue;
            }
            let run = async {
                if !key.ends_with('/') {
                    return self
                        .delete_batch(bucket, std::slice::from_ref(key), ctx)
                        .await;
                }
                let mut aggregate = OperationResult::default();
                let mut token = None;
                loop {
                    let page = self
                        .list(bucket, key, token.clone(), 1000, "flat", ctx)
                        .await;
                    let page = match page {
                        Ok(page) => page,
                        Err(error) if aggregate.stats.processed > 0 => {
                            aggregate.stats.total += 1;
                            aggregate.stats.processed += 1;
                            aggregate.failure(key, error);
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                    let keys: Vec<_> = page.objects.into_iter().map(|o| o.key).collect();
                    if !keys.is_empty() {
                        match self.delete_batch(bucket, &keys, ctx).await {
                            Ok(batch) => aggregate.merge(batch),
                            Err(error) => {
                                aggregate.stats.total += keys.len() as u64;
                                aggregate.stats.processed += keys.len() as u64;
                                for key in &keys {
                                    aggregate.failure(key, error.clone());
                                }
                            }
                        }
                    }
                    token = page.next_continuation_token;
                    if token.is_none() {
                        break;
                    }
                }
                Ok(aggregate)
            }
            .await;
            match run {
                Ok(batch) => result.merge(batch),
                Err(error) if result.stats.processed > 0 => {
                    result.stats.total += 1;
                    result.stats.processed += 1;
                    result.failure(key, error);
                }
                Err(error) => return Err(error),
            }
            if key.ends_with('/') {
                covered.insert(key.clone());
            }
        }
        Ok(result)
    }
    pub async fn resolve_target(
        &self,
        bucket: &str,
        key: &str,
        policy: &str,
        ctx: &Context,
    ) -> Result<Option<String>> {
        if policy == "overwrite" {
            (ctx.reserve)(key)?;
            return Ok(Some(key.into()));
        }
        for index in 0..10000 {
            let candidate = if index == 0 {
                key.into()
            } else {
                safety::key(&safety::renamed(key, index), false, true)?
            };
            match self.head(bucket, &candidate, ctx).await {
                Ok(_) if policy == "skip" || key.ends_with('/') => return Ok(None),
                Ok(_) => {}
                Err(error) if error.category == "not_found" => match (ctx.reserve)(&candidate) {
                    Ok(()) => return Ok(Some(candidate)),
                    Err(_) if policy == "autoRename" => continue,
                    Err(error) => return Err(error),
                },
                Err(error) => return Err(error),
            }
        }
        Err(AppError::new("error.targetKeyUnavailable"))
    }
    pub async fn copy(
        &self,
        request: &CopyRequest,
        moving: bool,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let policy = request
            .target_exists_policy
            .as_deref()
            .unwrap_or("autoRename");
        if !request.source_key.ends_with('/') {
            return self.copy_one(request, policy, moving, ctx).await;
        }
        let target_prefix = safety::prefix(&request.target_key)?;
        let mut token = None;
        let mut result = OperationResult::default();
        loop {
            let page = match self
                .list(
                    &request.source_bucket,
                    &request.source_key,
                    token.clone(),
                    1000,
                    "flat",
                    ctx,
                )
                .await
            {
                Ok(page) => page,
                Err(error) if result.stats.processed > 0 => {
                    result.stats.total += 1;
                    result.stats.processed += 1;
                    result.failure(&request.source_key, error);
                    break;
                }
                Err(error) => return Err(error),
            };
            let mut work = stream::iter(page.objects.into_iter().map(|object| {
                let target_prefix = &target_prefix;
                async move {
                    let suffix = object
                        .key
                        .strip_prefix(&request.source_key)
                        .ok_or_else(|| AppError::new("error.sourceNotInPrefix"))?;
                    let input = CopyRequest {
                        source_key: object.key.clone(),
                        target_key: safety::key(&format!("{target_prefix}{suffix}"), false, true)?,
                        ..request.clone()
                    };
                    let outcome = self.copy_one(&input, policy, moving, ctx).await;
                    Ok::<_, AppError>((object.key, outcome))
                }
            }))
            .buffer_unordered(ctx.settings.multipart_concurrency.clamp(1, 16) as usize);
            while let Some(outcome) = work.next().await {
                match outcome {
                    Ok((_, Ok(item))) => result.merge(item),
                    Ok((key, Err(error))) => {
                        result.stats.total += 1;
                        result.stats.processed += 1;
                        result.failure(&key, error);
                    }
                    Err(error) => {
                        result.stats.total += 1;
                        result.stats.processed += 1;
                        result.failure(&request.source_key, error);
                    }
                }
            }
            token = page.next_continuation_token;
            if token.is_none() {
                break;
            }
        }
        Ok(result)
    }
    async fn copy_one(
        &self,
        request: &CopyRequest,
        policy: &str,
        moving: bool,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let target = self
            .resolve_target(&request.target_bucket, &request.target_key, policy, ctx)
            .await?;
        if target.is_none() && (!moving || !request.source_key.ends_with('/')) {
            return Ok(OperationResult::skip());
        }
        let head = self
            .head(&request.source_bucket, &request.source_key, ctx)
            .await?;
        let total = head.content_length().unwrap_or(0).max(0) as u64;
        let source = safety::copy_source(
            &request.source_bucket,
            &request.source_key,
            head.version_id(),
        );
        if let Some(target) = &target {
            if total < 5 * GIB {
                send!(
                    self,
                    ctx,
                    self.client
                        .copy_object()
                        .bucket(&request.target_bucket)
                        .key(target)
                        .copy_source(&source)
                        .set_copy_source_if_match(head.e_tag.clone())
                )?;
            } else {
                self.multipart_copy(request, target, &head, &source, total, ctx)
                    .await?;
            }
            let size = part_size(total, ctx.settings.chunk_size_mb)?;
            let parts = if total < 5 * GIB {
                1
            } else {
                total.div_ceil(size)
            };
            (ctx.progress)(Progress {
                loaded: total,
                total,
                completed: parts,
                parts,
                active: 0,
                stats: None,
            });
        }
        let mut result = if target.is_some() {
            OperationResult::success()
        } else {
            OperationResult::skip()
        };
        // An existing folder marker needs no copy; only an empty source marker may be removed.
        if moving && (target.is_some() || head.content_length() == Some(0)) {
            let immutable_version = head
                .version_id()
                .is_some_and(|v| !v.is_empty() && v != "null");
            let deletion = if !immutable_version && head.e_tag().is_none_or(str::is_empty) {
                Err(AppError::new("error.copyCompletedDeleteSourceFailed"))
            } else {
                self.delete_one(
                    &request.source_bucket,
                    &request.source_key,
                    head.version_id.clone(),
                    if immutable_version {
                        None
                    } else {
                        head.e_tag.clone()
                    },
                    ctx,
                )
                .await
            };
            if let Err(mut error) = deletion {
                error.message = format!(
                    "{}: {}",
                    t("error.targetCreatedDeleteSourceFailed"),
                    error.message
                );
                result.stats.total += 1;
                result.stats.processed += 1;
                result.failure(&request.source_key, error);
            }
        }
        Ok(result)
    }
    async fn multipart_copy(
        &self,
        request: &CopyRequest,
        target: &str,
        head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
        source: &str,
        total: u64,
        ctx: &Context,
    ) -> Result<()> {
        let created = send!(
            self,
            ctx,
            self.client
                .create_multipart_upload()
                .bucket(&request.target_bucket)
                .key(target)
                .set_content_type(head.content_type.clone())
                .set_cache_control(head.cache_control.clone())
                .set_content_disposition(head.content_disposition.clone())
                .set_content_encoding(head.content_encoding.clone())
                .set_content_language(head.content_language.clone())
                .set_expires(head.expires_string.as_deref().and_then(|s| {
                    aws_smithy_types::DateTime::from_str(
                        s,
                        aws_smithy_types::date_time::Format::HttpDate,
                    )
                    .ok()
                }))
                .set_metadata(head.metadata.clone())
                .set_website_redirect_location(head.website_redirect_location.clone())
        )?;
        let id = created
            .upload_id()
            .ok_or_else(|| AppError::new("error.multipartUploadIdMissing"))?
            .to_string();
        let run = async {
            let ranges = ranges(total, part_size(total, ctx.settings.chunk_size_mb)?);
            let tracker = Tracker::new(total, ranges.len(), ctx);
            let mut work = stream::iter(ranges.into_iter().enumerate().map(
                |(index, (start, length))| {
                    let id = &id;
                    let tracker = tracker.clone();
                    async move {
                        let output = send!(
                            self,
                            ctx,
                            self.client
                                .upload_part_copy()
                                .bucket(&request.target_bucket)
                                .key(target)
                                .upload_id(id)
                                .part_number(index as i32 + 1)
                                .copy_source(source)
                                .set_copy_source_if_match(head.e_tag.clone())
                                .copy_source_range(format!("bytes={start}-{}", start + length - 1))
                        )?;
                        let etag = output
                            .copy_part_result
                            .and_then(|p| p.e_tag)
                            .ok_or_else(|| AppError::new("error.multipartPartEtagMissing"))?;
                        tracker.update(index, length, true);
                        Ok::<_, AppError>(
                            CompletedPart::builder()
                                .part_number(index as i32 + 1)
                                .e_tag(etag)
                                .build(),
                        )
                    }
                },
            ))
            .buffer_unordered(ctx.settings.multipart_concurrency.clamp(1, 16) as usize);
            let mut parts = Vec::new();
            while let Some(part) = work.next().await {
                parts.push(part?);
            }
            parts.sort_by_key(|p| p.part_number());
            send!(
                self,
                ctx,
                self.client
                    .complete_multipart_upload()
                    .bucket(&request.target_bucket)
                    .key(target)
                    .upload_id(&id)
                    .multipart_upload(
                        CompletedMultipartUpload::builder()
                            .set_parts(Some(parts))
                            .build()
                    )
            )?;
            Ok(())
        }
        .await;
        if run.is_err() {
            self.abort(&request.target_bucket, target, &id).await;
        }
        run
    }
    pub async fn upload_directory(
        &self,
        bucket: &str,
        prefix: &str,
        root: &Path,
        preserve_empty: bool,
        ctx: &Context,
    ) -> Result<OperationResult> {
        let name = root
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| AppError::new("error.uploadPathOutsideFolder"))?;
        let root_key = safety::prefix(&format!("{}{name}", safety::prefix(prefix)?))?;
        let mut pending = vec![root.to_path_buf()];
        let mut files = Vec::new();
        let mut empty = Vec::new();
        let mut result = OperationResult::default();
        while let Some(dir) = pending.pop() {
            check_cancel(&ctx.cancel)?;
            let info = fs::symlink_metadata(&dir).await?;
            if info.is_symlink() {
                result.stats.skipped += 1;
                continue;
            }
            let mut entries = fs::read_dir(&dir).await?;
            let mut has_entries = false;
            while let Some(entry) = entries.next_entry().await? {
                check_cancel(&ctx.cancel)?;
                let kind = entry.file_type().await?;
                if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                    result.stats.skipped += 1;
                    self.logger.write(
                        "warn",
                        &t("scanner.skippedSymlink"),
                        Some(&entry.path().to_string_lossy()),
                        "S3",
                    );
                    continue;
                }
                has_entries = true;
                if kind.is_dir() {
                    pending.push(entry.path());
                } else {
                    files.push(entry.path());
                }
            }
            if !has_entries && preserve_empty {
                empty.push(dir);
            }
        }
        result.stats.total = result.stats.skipped;
        result.stats.processed = result.stats.skipped;
        for dir in empty {
            let relative = dir
                .strip_prefix(root)
                .map_err(AppError::sdk)?
                .to_string_lossy()
                .replace('\\', "/");
            let key = safety::prefix(&format!("{root_key}{relative}"))?;
            result.stats.total += 1;
            result.stats.processed += 1;
            match self.folder(bucket, &key, ctx).await {
                Ok(()) => result.stats.success += 1,
                Err(error) => result.failure(&key, error),
            }
        }
        let mut total_bytes = 0;
        for path in &files {
            total_bytes += fs::metadata(path).await?.len();
        }
        let loaded = Arc::new(Mutex::new(vec![0u64; files.len()]));
        result.stats.total += files.len() as u64;
        let shared_stats = Arc::new(Mutex::new(result.stats.clone()));
        let mut work = stream::iter(files.into_iter().enumerate().map(|(index, path)| {
            let loaded = loaded.clone();
            let stats = shared_stats.clone();
            let root_key = &root_key;
            async move {
                let relative = path
                    .strip_prefix(root)
                    .map_err(AppError::sdk)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let key = safety::key(&format!("{root_key}{relative}"), false, false)?;
                let progress = ctx.progress.clone();
                let stats = stats.clone();
                let file_context = Context {
                    progress: Arc::new(move |p| {
                        let mut bytes = loaded.lock().unwrap();
                        bytes[index] = p.loaded;
                        progress(Progress {
                            loaded: bytes.iter().sum(),
                            total: total_bytes,
                            stats: Some(stats.lock().unwrap().clone()),
                            ..p
                        });
                    }),
                    ..ctx.clone()
                };
                let outcome = self.upload(bucket, &key, &path, &file_context).await;
                Ok::<_, AppError>((key, outcome))
            }
        }))
        .buffer_unordered(ctx.settings.multipart_concurrency.clamp(1, 16) as usize);
        while let Some(outcome) = work.next().await {
            result.stats.processed += 1;
            match outcome {
                Ok((_, Ok(_))) => result.stats.success += 1,
                Ok((key, Err(error))) => result.failure(&key, error),
                Err(error) => result.failure(&root_key, error),
            }
            *shared_stats.lock().unwrap() = result.stats.clone();
            (ctx.progress)(Progress {
                loaded: loaded.lock().unwrap().iter().sum(),
                total: total_bytes,
                stats: Some(result.stats.clone()),
                ..Default::default()
            });
        }
        Ok(result)
    }
}

fn object(
    bucket: &str,
    prefix: &str,
    key: &str,
    size: Option<u64>,
    modified: Option<String>,
    class: Option<String>,
) -> ObjectItem {
    let is_folder = key.ends_with('/');
    ObjectItem {
        key: key.into(),
        name: {
            let relative = key.strip_prefix(prefix).unwrap_or(key);
            relative.strip_suffix('/').unwrap_or(relative).into()
        },
        bucket: bucket.into(),
        prefix: prefix.into(),
        size,
        is_folder,
        r#type: if is_folder {
            "Folder".into()
        } else {
            mime_guess::from_path(key)
                .first_or_octet_stream()
                .to_string()
        },
        storage_class: class,
        last_modified: modified,
        url: None,
    }
}

async fn upload_body(
    path: &Path,
    start: u64,
    length: u64,
    tracker: Tracker,
    index: usize,
) -> Result<ByteStream> {
    let body = ByteStream::read_from()
        .path(path)
        .offset(start)
        .length(Length::Exact(length))
        .build()
        .await
        .map_err(AppError::sdk)?;
    Ok(body.map(move |body| {
        let tracker = tracker.clone();
        let mut loaded = 0;
        SdkBody::from_body_1_x(body.map_frame(move |frame| {
            if let Some(data) = frame.data_ref() {
                loaded += data.len() as u64;
                tracker.update(index, loaded, false);
            }
            frame
        }))
    }))
}

async fn file_checksum(
    path: &Path,
    start: u64,
    length: u64,
    algorithm: &str,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    if algorithm == "disabled" {
        return Ok(None);
    }
    let mut file = fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left = length;
    let mut buffer = vec![0; 64 * 1024];
    let mut sha = sha2::Sha256::new();
    let mut crc = crc32fast::Hasher::new();
    while left > 0 {
        check_cancel(cancel)?;
        let take = left.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..take]).await?;
        if count == 0 {
            return Err(AppError::new("error.incompletePart"));
        }
        if algorithm == "SHA256" {
            sha.update(&buffer[..count]);
        } else {
            crc.update(&buffer[..count]);
        }
        left -= count as u64;
    }
    Ok(Some(if algorithm == "SHA256" {
        STANDARD.encode(sha.finalize())
    } else {
        STANDARD.encode(crc.finalize().to_be_bytes())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multipart_bounds() {
        assert_eq!(part_size(10, 1).unwrap(), 5 * MIB);
        let total = 5 * 1024 * GIB;
        let size = part_size(total, 8).unwrap();
        assert!(total.div_ceil(size) <= 10000);
        assert_eq!(ranges(11, 5), vec![(0, 5), (5, 5), (10, 1)]);
    }
}
