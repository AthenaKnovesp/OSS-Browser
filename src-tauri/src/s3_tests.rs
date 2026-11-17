use crate::{
    config,
    logger::Logger,
    model::*,
    s3::{Context, S3Service},
    tasks::TaskManager,
};
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{HeaderMap, Method, Request, Response, Uri},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
struct Recorded {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
}
struct Mock {
    endpoint: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
    directory: tempfile::TempDir,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Mock {
    async fn start(handler: impl Fn(&Recorded) -> Response<Body> + Send + Sync + 'static) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let handler = Arc::new(handler);
        let router = Router::new().fallback(move |request: Request<Body>| {
            let handler = handler.clone();
            let captured = captured.clone();
            async move {
                let (parts, body) = request.into_parts();
                let body = to_bytes(body, 256 * 1024 * 1024).await.unwrap();
                let request = Recorded {
                    method: parts.method,
                    uri: parts.uri,
                    headers: parts.headers,
                    body,
                };
                let response = handler(&request);
                captured.lock().unwrap().push(request);
                response
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint,
            requests,
            task,
            directory: tempfile::tempdir().unwrap(),
        }
    }
    fn service(&self) -> S3Service {
        let mut service = S3Service::new(
            ConnectionConfig {
                id: "test".into(),
                profile_name: "test".into(),
                endpoint: self.endpoint.clone(),
                region: "us-east-1".into(),
                access_key_id: "test".into(),
                secret_access_key: Some("test".into()),
                force_path_style: true,
                ..Default::default()
            },
            Logger::new(self.directory.path().join("logs")),
        )
        .unwrap();
        service.client = aws_sdk_s3::Client::from_conf(
            service
                .client
                .config()
                .to_builder()
                .retry_config(
                    aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1),
                )
                .build(),
        );
        service
    }
    fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}
fn xml(text: &str) -> Response<Body> {
    Response::builder()
        .header("content-type", "application/xml")
        .body(Body::from(text.to_string()))
        .unwrap()
}
fn head(size: u64, version: Option<&str>) -> Response<Body> {
    let mut response = Response::builder()
        .header("content-length", size)
        .header("etag", "\"etag-v1\"")
        .header("content-type", "application/octet-stream");
    if let Some(version) = version {
        response = response.header("x-amz-version-id", version);
    }
    response.body(Body::empty()).unwrap()
}
fn error(code: &str, status: u16) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/xml")
        .body(Body::from(format!(
            "<Error><Code>{code}</Code><Message>{code}</Message></Error>"
        )))
        .unwrap()
}
fn copy_request() -> CopyRequest {
    CopyRequest {
        connection_id: "test".into(),
        source_bucket: "source".into(),
        source_key: " key\\with-space ".into(),
        target_bucket: "target".into(),
        target_key: "object".into(),
        target_exists_policy: Some("overwrite".into()),
    }
}

#[tokio::test]
async fn null_version_move_keeps_a_changed_source() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            return head(1, Some("null"));
        }
        if r.method == Method::PUT {
            return xml("<CopyObjectResult><ETag>copied</ETag></CopyObjectResult>");
        }
        if r.method == Method::DELETE {
            return error("PreconditionFailed", 412);
        }
        panic!("unexpected request");
    })
    .await;
    let result = server
        .service()
        .copy(&copy_request(), true, &Context::default())
        .await
        .unwrap();
    let requests = server.recorded();
    let deletion = requests
        .iter()
        .find(|r| r.method == Method::DELETE)
        .unwrap();
    assert_eq!(
        deletion
            .headers
            .get("if-match")
            .and_then(|v| v.to_str().ok()),
        Some("\"etag-v1\"")
    );
    assert!(
        deletion
            .uri
            .query()
            .unwrap_or("")
            .contains("versionId=null")
    );
    assert_eq!((result.stats.success, result.stats.failed), (1, 1));
}

#[tokio::test]
async fn null_version_without_etag_is_not_deleted() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            let mut response = head(1, Some("null"));
            response.headers_mut().remove("etag");
            return response;
        }
        if r.method == Method::PUT {
            return xml("<CopyObjectResult><ETag>copied</ETag></CopyObjectResult>");
        }
        if r.method == Method::DELETE {
            return Response::builder().status(204).body(Body::empty()).unwrap();
        }
        panic!("unexpected request");
    })
    .await;
    let result = server
        .service()
        .copy(&copy_request(), true, &Context::default())
        .await
        .unwrap();
    assert_eq!((result.stats.success, result.stats.failed), (1, 1));
    assert!(!server.recorded().iter().any(|r| r.method == Method::DELETE));
}

#[tokio::test]
async fn directory_merge_keeps_markers_and_auto_renames_only_files() {
    for moving in [false, true] {
        let server = Mock::start(|r| {
            if r.method == Method::GET { return xml("<ListBucketResult><Contents><Key>from/</Key><Size>0</Size></Contents><Contents><Key>from/file.txt</Key><Size>1</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>"); }
            if r.method == Method::HEAD && r.uri.path() == "/source/from/" { return head(0, None); }
            if r.method == Method::HEAD && r.uri.path().starts_with("/source/") { return head(1, None); }
            if r.method == Method::HEAD && ["/target/to/", "/target/to/file.txt"].contains(&r.uri.path()) { return head(0, None); }
            if r.method == Method::HEAD { return error("NoSuchKey", 404); }
            if r.method == Method::PUT { return xml("<CopyObjectResult><ETag>copied</ETag></CopyObjectResult>"); }
            if r.method == Method::DELETE { return Response::builder().status(204).body(Body::empty()).unwrap(); }
            panic!("unexpected request");
        }).await;
        let request = CopyRequest {
            connection_id: "test".into(),
            source_bucket: "source".into(),
            source_key: "from/".into(),
            target_bucket: "target".into(),
            target_key: "to/".into(),
            target_exists_policy: Some("autoRename".into()),
        };
        let result = server
            .service()
            .copy(&request, moving, &Context::default())
            .await
            .unwrap();
        assert_eq!(
            (
                result.stats.success,
                result.stats.skipped,
                result.stats.failed
            ),
            (1, 1, 0)
        );
        let requests = server.recorded();
        let puts: Vec<_> = requests
            .iter()
            .filter(|r| r.method == Method::PUT)
            .map(|r| r.uri.path())
            .collect();
        assert_eq!(puts, ["/target/to/file%20%281%29.txt"]);
        let removed_marker = requests
            .iter()
            .any(|r| r.method == Method::DELETE && r.uri.path() == "/source/from/");
        assert_eq!(removed_marker, moving);
    }
}

#[tokio::test]
async fn copy_and_delete_bind_to_one_source_version() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            head(1, Some("version 1"))
        } else if r.method == Method::PUT {
            xml("<CopyObjectResult><ETag>etag-v2</ETag></CopyObjectResult>")
        } else {
            xml("")
        }
    })
    .await;
    let result = server
        .service()
        .copy(&copy_request(), true, &Context::default())
        .await
        .unwrap();
    assert_eq!(result.stats.success, 1);
    let requests = server.recorded();
    assert_eq!(
        requests.iter().filter(|r| r.method == Method::HEAD).count(),
        1
    );
    let copy = requests.iter().find(|r| r.method == Method::PUT).unwrap();
    assert_eq!(
        copy.headers["x-amz-copy-source"],
        "source/%20key%5Cwith-space%20?versionId=version%201"
    );
    assert_eq!(copy.headers["x-amz-copy-source-if-match"], "\"etag-v1\"");
    let delete = requests
        .iter()
        .find(|r| r.method == Method::DELETE)
        .unwrap();
    assert!(
        delete
            .uri
            .query()
            .unwrap()
            .contains("versionId=version%201")
    );
    assert!(!delete.headers.contains_key("if-match"));
    assert!(delete.headers.contains_key("content-md5"));
}

#[tokio::test]
async fn changed_source_is_kept_and_reported_as_partial() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            head(1, None)
        } else if r.method == Method::PUT {
            xml("<CopyObjectResult><ETag>copy</ETag></CopyObjectResult>")
        } else {
            error("PreconditionFailed", 412)
        }
    })
    .await;
    let result = server
        .service()
        .copy(&copy_request(), true, &Context::default())
        .await
        .unwrap();
    assert_eq!(result.stats.success, 1);
    assert_eq!(result.stats.failed, 1);
    assert_eq!(result.stats.total, 2);
    let requests = server.recorded();
    let deletion = requests
        .iter()
        .find(|r| r.method == Method::DELETE)
        .unwrap();
    assert_eq!(deletion.headers["if-match"], "\"etag-v1\"");
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.method == Method::DELETE)
            .count(),
        1
    );
}

#[tokio::test]
async fn canceled_multipart_copy_aborts_without_deleting_source() {
    let ctx = Context::default();
    let cancel = ctx.cancel.clone();
    let reserve = ctx.reserve.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let server=Mock::start(move|r|{
        if r.method==Method::HEAD{head(5*1024*1024*1024,None)}
        else if r.method==Method::POST && r.uri.query().unwrap_or("").contains("uploads"){xml("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>")}
        else if r.method==Method::PUT{xml("<CopyPartResult><ETag>part</ETag></CopyPartResult>")}
        else{count.fetch_add(1,Ordering::SeqCst);xml("<CompleteMultipartUploadResult><ETag>copy</ETag></CompleteMultipartUploadResult>")}
    }).await;
    // Cancel through the progress callback after the sole part is copied; no source deletion may run.
    let ctx = Context {
        settings: TransferSettings {
            chunk_size_mb: 5120,
            ..ctx.settings
        },
        progress: Arc::new(move |p| {
            if p.completed == p.parts {
                cancel.cancel();
            }
        }),
        reserve,
        ..ctx
    };
    assert!(
        server
            .service()
            .copy(&copy_request(), true, &ctx)
            .await
            .is_err()
    );
    assert!(
        !server
            .recorded()
            .iter()
            .any(|r| r.method == Method::DELETE && r.uri.path().starts_with("/source"))
    );
}

#[tokio::test]
async fn multipart_copy_uses_captured_identity_and_metadata() {
    let server=Mock::start(|r|{
        if r.method==Method::HEAD{head(5*1024*1024*1024,Some("version-2"))}
        else if r.method==Method::POST && r.uri.query().unwrap_or("").contains("uploads"){xml("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>")}
        else if r.method==Method::PUT{xml("<CopyPartResult><ETag>part</ETag></CopyPartResult>")}
        else{xml("<CompleteMultipartUploadResult><ETag>copy</ETag></CompleteMultipartUploadResult>")}
    }).await;
    let ctx = Context {
        settings: TransferSettings {
            chunk_size_mb: 5120,
            ..config::defaults().transfer_settings
        },
        ..Default::default()
    };
    assert_eq!(
        server
            .service()
            .copy(&copy_request(), false, &ctx)
            .await
            .unwrap()
            .stats
            .success,
        1
    );
    let requests = server.recorded();
    let parts: Vec<_> = requests
        .iter()
        .filter(|r| r.method == Method::PUT)
        .collect();
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0].headers["x-amz-copy-source-if-match"],
        "\"etag-v1\""
    );
    assert!(
        parts[0].headers["x-amz-copy-source"]
            .to_str()
            .unwrap()
            .ends_with("?versionId=version-2")
    );
    assert_eq!(
        parts[0].headers["x-amz-copy-source-range"],
        "bytes=0-5368709119"
    );
}

#[tokio::test]
async fn canceled_move_after_copy_commit_reports_partial_success() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            head(1, None)
        } else {
            xml("<CopyObjectResult><ETag>copy</ETag></CopyObjectResult>")
        }
    })
    .await;
    let ctx = Context::default();
    let token = ctx.cancel.clone();
    let ctx = Context {
        progress: Arc::new(move |_| token.cancel()),
        ..ctx
    };
    let result = server
        .service()
        .copy(&copy_request(), true, &ctx)
        .await
        .unwrap();
    assert_eq!(result.stats.success, 1);
    assert_eq!(result.stats.failed, 1);
    assert_eq!(result.stats.total, 2);
    assert!(!server.recorded().iter().any(|r| r.method == Method::DELETE));
}

#[tokio::test]
async fn delete_paginates_and_caps_failure_samples() {
    let server=Mock::start(|r|{
        if r.method==Method::GET {
            let second=r.uri.query().unwrap_or("").contains("continuation-token");let count=if second{1}else{100};let offset=if second{100}else{0};
            let contents=(offset..offset+count).map(|i|format!("<Contents><Key>folder/item-{i}</Key><Size>1</Size></Contents>")).collect::<String>();
            xml(&format!("<ListBucketResult>{contents}{}<IsTruncated>{}</IsTruncated></ListBucketResult>",if second{""}else{"<NextContinuationToken>next</NextContinuationToken>"},!second))
        }else{
            let text=String::from_utf8_lossy(&r.body);let pattern=regex::Regex::new("<Key>(.*?)</Key>").unwrap();let errors=pattern.captures_iter(&text).map(|c|format!("<Error><Key>{}</Key><Code>AccessDenied</Code><Message>denied</Message></Error>",&c[1])).collect::<String>();
            assert!(r.headers.contains_key("content-md5"));xml(&format!("<DeleteResult>{errors}</DeleteResult>"))
        }
    }).await;
    let result = server
        .service()
        .delete("bucket", &["folder/".into()], &Context::default())
        .await
        .unwrap();
    assert_eq!(result.stats.failed, 101);
    assert_eq!(result.failed_items.len(), 100);
    assert!(result.truncated);
    assert_eq!(
        server
            .recorded()
            .iter()
            .filter(|r| r.method == Method::GET)
            .count(),
        2
    );
}

#[tokio::test]
async fn later_page_failure_returns_committed_copy_progress() {
    let server=Mock::start(|r|{
        if r.method==Method::GET{if r.uri.query().unwrap_or("").contains("continuation-token"){error("AccessDenied",403)}else{xml("<ListBucketResult><Contents><Key>folder/first</Key><Size>1</Size></Contents><NextContinuationToken>next</NextContinuationToken></ListBucketResult>")}}
        else if r.method==Method::HEAD{head(1,None)}else{xml("<CopyObjectResult><ETag>copy</ETag></CopyObjectResult>")}
    }).await;
    let request = CopyRequest {
        source_key: "folder/".into(),
        target_key: "destination/".into(),
        ..copy_request()
    };
    let result = server
        .service()
        .copy(&request, false, &Context::default())
        .await
        .unwrap();
    assert_eq!(result.stats.success, 1);
    assert_eq!(result.stats.failed, 1);
    assert_eq!(result.stats.total, 2);
}

#[tokio::test]
async fn missing_target_auto_rename_reserves_final_key_before_copy() {
    let reserved = Arc::new(Mutex::new(Vec::new()));
    let captured = reserved.clone();
    let server = Mock::start(move |r| {
        if r.method == Method::HEAD && r.uri.path() == "/target/object" {
            head(1, None)
        } else if r.method == Method::HEAD && r.uri.path().starts_with("/target/") {
            error("NoSuchKey", 404)
        } else if r.method == Method::HEAD {
            head(1, None)
        } else {
            assert!(!captured.lock().unwrap().is_empty());
            xml("<CopyObjectResult><ETag>copy</ETag></CopyObjectResult>")
        }
    })
    .await;
    let keys = reserved.clone();
    let ctx = Context {
        reserve: Arc::new(move |key| {
            keys.lock().unwrap().push(key.to_string());
            Ok(())
        }),
        ..Default::default()
    };
    let request = CopyRequest {
        target_exists_policy: Some("autoRename".into()),
        ..copy_request()
    };
    server.service().copy(&request, false, &ctx).await.unwrap();
    assert_eq!(*reserved.lock().unwrap(), vec!["object (1)"]);
}

#[tokio::test]
async fn range_download_rejects_short_body_and_cleans_temporary_files() {
    let server = Mock::start(|r| {
        if r.method == Method::HEAD {
            head(100 * 1024 * 1024, None)
        } else {
            Response::builder()
                .header("content-range", "bytes 0-8388607/104857600")
                .body(Body::from("short"))
                .unwrap()
        }
    })
    .await;
    let service = server.service();
    let base = server.directory.path().join("download");
    std::fs::create_dir(&base).unwrap();
    assert!(
        service
            .download(
                "bucket",
                "object",
                &base.join("file"),
                &base,
                false,
                &Context::default()
            )
            .await
            .is_err()
    );
    assert!(!base.join("file").exists());
    assert_eq!(
        std::fs::read_dir(base.join(".oss-browser-partials"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn sha256_required_retry_and_zero_byte_upload() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let count = attempts.clone();
    let server = Mock::start(move |r| {
        count.fetch_add(1, Ordering::SeqCst);
        if !r.headers.contains_key("x-amz-checksum-sha256") {
            error("SHA256 checksum algorithm required", 400)
        } else {
            Response::builder()
                .header("etag", "etag")
                .body(Body::empty())
                .unwrap()
        }
    })
    .await;
    let path = server.directory.path().join("empty");
    std::fs::write(&path, []).unwrap();
    server
        .service()
        .upload("bucket", "empty", &path, &Context::default())
        .await
        .unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn isolated_s3_round_trip_small_and_multipart_files() {
    type Store = Arc<Mutex<HashMap<String, Bytes>>>;
    let objects: Store = Arc::default();
    let parts: Store = Arc::default();
    let data = objects.clone();
    let pieces = parts.clone();
    let server=Mock::start(move|r|{
        let path=r.uri.path().to_string();let query:HashMap<_,_>=url::form_urlencoded::parse(r.uri.query().unwrap_or("").as_bytes()).into_owned().collect();
        if r.method==Method::HEAD{return data.lock().unwrap().get(&path).map(|b|head(b.len() as u64,None)).unwrap_or_else(||error("NoSuchKey",404));}
        if r.method==Method::POST && query.contains_key("uploads"){return xml("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");}
        if r.method==Method::POST && query.contains_key("uploadId"){
            let pieces=pieces.lock().unwrap();let mut keys:Vec<_>=pieces.keys().collect();keys.sort_by_key(|k|k.parse::<u32>().unwrap());let joined=keys.into_iter().flat_map(|k|pieces[k].iter().copied()).collect::<Vec<_>>();data.lock().unwrap().insert(path,Bytes::from(joined));return xml("<CompleteMultipartUploadResult><ETag>etag-v1</ETag></CompleteMultipartUploadResult>");
        }
        if r.method==Method::PUT{
            if let Some(part)=query.get("partNumber"){pieces.lock().unwrap().insert(part.clone(),r.body.clone());}else{data.lock().unwrap().insert(path,r.body.clone());}
            return Response::builder().header("etag","etag-v1").body(Body::empty()).unwrap();
        }
        let data=data.lock().unwrap();let bytes=data.get(&path).unwrap();
        if let Some(range)=r.headers.get("range"){
            assert_eq!(r.headers["if-match"],"\"etag-v1\"");let (start,end)=range.to_str().unwrap().strip_prefix("bytes=").unwrap().split_once('-').unwrap();let start=start.parse::<usize>().unwrap();let end=end.parse::<usize>().unwrap();
            return Response::builder().status(206).header("content-range",format!("bytes {start}-{end}/{}",bytes.len())).body(Body::from(bytes.slice(start..=end))).unwrap();
        }
        Response::builder().body(Body::from(bytes.clone())).unwrap()
    }).await;
    let service = server.service();
    let base = server.directory.path().join("download");
    std::fs::create_dir(&base).unwrap();
    for size in [29, 101 * 1024 * 1024] {
        let source = server.directory.path().join(format!("source-{size}"));
        let mut file = tokio::fs::File::create(&source).await.unwrap();
        let block = vec![0x5a; 1024 * 1024];
        let mut remaining = size;
        while remaining > 0 {
            let length = remaining.min(block.len());
            file.write_all(&block[..length]).await.unwrap();
            remaining -= length;
        }
        drop(file);
        let key = format!("中文 space/{size}.bin");
        service
            .upload("bucket", &key, &source, &Context::default())
            .await
            .unwrap();
        let target = base.join(format!("{size}.bin"));
        service
            .download("bucket", &key, &target, &base, false, &Context::default())
            .await
            .unwrap();
        use md5::Digest;
        assert_eq!(
            md5::Md5::digest(std::fs::read(source).unwrap()),
            md5::Md5::digest(std::fs::read(target).unwrap())
        );
    }
}

#[tokio::test]
async fn task_retry_and_cancel_clear_running_work() {
    let server = Mock::start(|_| error("AccessDenied", 403)).await;
    let service = server.service();
    let manager = TaskManager::new(service.logger.clone());
    let task = manager
        .delete(
            service.connection,
            DeleteRequest {
                connection_id: "test".into(),
                bucket: "bucket".into(),
                key: Some("key".into()),
                keys: None,
            },
            config::defaults().transfer_settings,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if manager
                .list()
                .iter()
                .any(|t| t.id == task.id && t.status == "failed")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager.retry(&task.id).unwrap();
    manager.cancel(&task.id);
    manager.shutdown().await;
    manager.clear();
    assert!(manager.list().is_empty());
}

#[tokio::test]
#[ignore = "Requires an isolated loopback S3-compatible server; set OSS_BROWSER_TEST_S3_ENDPOINT"]
async fn external_s3_compatible_full_operation_chain() {
    let endpoint = std::env::var("OSS_BROWSER_TEST_S3_ENDPOINT").expect("isolated test endpoint");
    let parsed = url::Url::parse(&endpoint).unwrap();
    assert!(
        matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1")),
        "Tests must use an isolated loopback service"
    );
    let directory = tempfile::tempdir().unwrap();
    let download = directory.path().join("download");
    std::fs::create_dir(&download).unwrap();
    let service = S3Service::new(
        ConnectionConfig {
            id: "test".into(),
            profile_name: "test".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "test".into(),
            secret_access_key: Some("test".into()),
            force_path_style: true,
            ..Default::default()
        },
        Logger::new(directory.path().join("logs")),
    )
    .unwrap();
    let bucket = format!("oss-browser-test-{}", uuid::Uuid::new_v4());
    service
        .client
        .create_bucket()
        .bucket(&bucket)
        .send()
        .await
        .unwrap();
    let ctx = Context::default();
    assert!(service.test(&ctx).await.unwrap().ok);
    assert!(
        service
            .buckets(&ctx)
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == bucket)
    );
    let root = directory.path().join("中文 folder");
    std::fs::create_dir_all(root.join("empty")).unwrap();
    std::fs::write(root.join("hello.txt"), "你好，Tauri").unwrap();
    assert_eq!(
        service
            .upload_directory(&bucket, "", &root, true, &ctx)
            .await
            .unwrap()
            .stats
            .success,
        2
    );
    assert!(
        service
            .list(&bucket, "", None, 1000, "folders", &ctx)
            .await
            .unwrap()
            .objects
            .iter()
            .any(|o| o.key == "中文 folder/")
    );
    let source = "中文 folder/hello.txt";
    assert_eq!(
        service
            .metadata(&bucket, source, &ctx)
            .await
            .unwrap()
            .content_type
            .as_deref(),
        Some("text/plain")
    );
    let signed = service.url(&bucket, source).await.unwrap();
    assert!(signed.contains("X-Amz-Signature="));
    assert!(signed.contains("X-Amz-Expires=3600"));
    let request = CopyRequest {
        connection_id: "test".into(),
        source_bucket: bucket.clone(),
        target_bucket: bucket.clone(),
        source_key: source.into(),
        target_key: "copy.txt".into(),
        target_exists_policy: Some("autoRename".into()),
    };
    service.copy(&request, false, &ctx).await.unwrap();
    service.copy(&request, false, &ctx).await.unwrap();
    assert!(service.head(&bucket, "copy (1).txt", &ctx).await.is_ok());
    let moving = CopyRequest {
        source_key: "copy.txt".into(),
        target_key: "moved.txt".into(),
        ..request.clone()
    };
    assert_eq!(
        service
            .copy(&moving, true, &ctx)
            .await
            .unwrap()
            .stats
            .failed,
        0
    );
    assert!(service.head(&bucket, "copy.txt", &ctx).await.is_err());
    let target = download.join("hello.txt");
    service
        .download(&bucket, "moved.txt", &target, &download, false, &ctx)
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "你好，Tauri");
    std::fs::write(&target, "keep existing").unwrap();
    assert!(
        service
            .download(&bucket, "moved.txt", &target, &download, false, &ctx)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep existing");
    service
        .download(&bucket, "moved.txt", &target, &download, true, &ctx)
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "你好，Tauri");
    assert_eq!(
        std::fs::read_dir(download.join(".oss-browser-partials"))
            .unwrap()
            .count(),
        0
    );
    let special = "中文 folder/特殊 #+%?.txt";
    service
        .upload(&bucket, special, &root.join("hello.txt"), &ctx)
        .await
        .unwrap();
    assert_eq!(
        service
            .head(&bucket, special, &ctx)
            .await
            .unwrap()
            .content_length(),
        Some("你好，Tauri".len() as i64)
    );
    service.folder(&bucket, "merged/", &ctx).await.unwrap();
    // shortcut: pre-create empty targets for SeaweedFS 4.54; remove when its CopyObject support is fixed.
    service
        .folder(&bucket, "merged/empty/", &ctx)
        .await
        .unwrap();
    service
        .copy(
            &CopyRequest {
                target_key: "merged/hello.txt".into(),
                ..request.clone()
            },
            false,
            &ctx,
        )
        .await
        .unwrap();
    let folder_copy = CopyRequest {
        source_key: "中文 folder/".into(),
        target_key: "merged/".into(),
        ..request.clone()
    };
    let merged = service.copy(&folder_copy, false, &ctx).await.unwrap();
    assert_eq!(merged.stats.failed, 0, "{merged:?}");
    assert!(
        service
            .head(&bucket, "merged/hello (1).txt", &ctx)
            .await
            .is_ok()
    );
    assert!(
        service
            .head(&bucket, "merged/特殊 #+%?.txt", &ctx)
            .await
            .is_ok()
    );
    service
        .folder(&bucket, "moved-folder/empty/", &ctx)
        .await
        .unwrap();
    assert_eq!(
        service
            .copy(
                &CopyRequest {
                    source_key: "merged/".into(),
                    target_key: "moved-folder/".into(),
                    ..request.clone()
                },
                true,
                &ctx
            )
            .await
            .unwrap()
            .stats
            .failed,
        0
    );
    assert!(
        service
            .list(&bucket, "merged/", None, 1000, "flat", &ctx)
            .await
            .unwrap()
            .objects
            .is_empty()
    );
    let large = directory.path().join("large.bin");
    let file = tokio::fs::File::create(&large).await.unwrap();
    file.set_len(101 * 1024 * 1024).await.unwrap();
    drop(file);
    service
        .upload(&bucket, "large.bin", &large, &ctx)
        .await
        .unwrap();
    let target = download.join("large.bin");
    service
        .download(&bucket, "large.bin", &target, &download, false, &ctx)
        .await
        .unwrap();
    use md5::Digest;
    assert_eq!(
        md5::Md5::digest(std::fs::read(large).unwrap()),
        md5::Md5::digest(std::fs::read(target).unwrap())
    );
    let result = service
        .delete(
            &bucket,
            &[
                "中文 folder/".into(),
                "copy (1).txt".into(),
                "moved.txt".into(),
                "large.bin".into(),
                "moved-folder/".into(),
            ],
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(result.stats.failed, 0);
    assert!(
        service
            .list(&bucket, "", None, 1000, "flat", &ctx)
            .await
            .unwrap()
            .objects
            .is_empty()
    );
    service
        .client
        .delete_bucket()
        .bucket(bucket)
        .send()
        .await
        .unwrap();
}
