use crate::{
    error::{AppError, Result},
    i18n::now,
    model::*,
    safety,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct ConfigStore {
    pub path: PathBuf,
    secure: bool,
    config: Mutex<AppConfig>,
}

pub fn defaults() -> AppConfig {
    AppConfig {
        transfer_settings: TransferSettings {
            concurrent_transfers: 3,
            multipart_concurrency: 4,
            chunk_size_mb: 8,
            retry_count: 2,
            overwrite_policy: "ask".into(),
            ..Default::default()
        },
        security_settings: SecuritySettings {
            remember_credentials_locally: true,
            require_confirmation_before_delete: true,
        },
        appearance_settings: AppearanceSettings {
            language: "system".into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::new("error.pathTraversalBlocked"))?,
    )?;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let write = || -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        commit_file(&temp, path, true)?;
        Ok(())
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn commit_file(source: &Path, target: &Path, overwrite: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            },
            core::PCWSTR,
        };
        let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(target.as_ptr()),
                if overwrite {
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
                } else {
                    MOVEFILE_WRITE_THROUGH
                },
            )
        }
        .map_err(std::io::Error::other)
    }
    #[cfg(not(windows))]
    {
        if !overwrite {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Exclusive commit requires Windows",
            ));
        }
        fs::rename(source, target)
    }
}

fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        use windows::{
            Win32::{
                Foundation::{HLOCAL, LocalFree},
                Security::Cryptography::{
                    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
                    CryptUnprotectData,
                },
            },
            core::PCWSTR,
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // DPAPI defaults to the current Windows user; never use LOCAL_MACHINE scope.
        unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    PCWSTR::null(),
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    None,
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
            .map_err(AppError::sdk)?;
            let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(result)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (bytes, encrypt);
        Err(AppError::new("error.operationFailed"))
    }
}

impl ConfigStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::open_secure(path, crypt(b"oss-browser-probe", true).is_ok())
    }
    fn open_secure(path: PathBuf, secure: bool) -> Result<Self> {
        let backup = path.with_extension("json.bak");
        let read = |path: &Path| parse_config(&fs::read(path)?);
        let config = if path.exists() {
            read(&path).or_else(|original| read(&backup).map_err(|_| original))?
        } else if backup.exists() {
            let config = read(&backup)?;
            atomic_write(&path, &fs::read(&backup)?)?;
            config
        } else {
            defaults()
        };
        let mut store = Self {
            path,
            secure,
            config: Mutex::new(config),
        };
        if !store.secure {
            store
                .config
                .get_mut()
                .unwrap()
                .security_settings
                .remember_credentials_locally = false;
        }
        Ok(store)
    }
    pub fn secure(&self) -> bool {
        self.secure
    }
    pub fn raw(&self) -> AppConfig {
        self.config.lock().unwrap().clone()
    }
    pub fn get(&self) -> AppConfig {
        redact(self.raw())
    }
    pub fn active(&self, id: &str) -> Result<ConnectionConfig> {
        let config = self.raw();
        if config.active_connection_id.as_deref() != Some(id) {
            return Err(AppError::new("config.selectConnectionFirst"));
        }
        let connection = config
            .connections
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::new("config.connectionMissing"))?;
        if connection
            .secret_access_key
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err(AppError::new("config.secretMissing"));
        }
        Ok(connection)
    }
    pub fn merged_secret(&self, mut connection: ConnectionConfig) -> ConnectionConfig {
        let config = self.raw();
        if let Some(existing) = config.connections.iter().find(|c| c.id == connection.id) {
            connection.secret_access_key = nonempty(connection.secret_access_key)
                .or_else(|| existing.secret_access_key.clone());
            connection.session_token =
                nonempty(connection.session_token).or_else(|| existing.session_token.clone());
        }
        connection
    }
    fn mutate(
        &self,
        persist: bool,
        f: impl FnOnce(&mut AppConfig) -> Result<()>,
    ) -> Result<AppConfig> {
        let mut current = self.config.lock().unwrap();
        let mut next = current.clone();
        f(&mut next)?;
        if persist {
            let mut stored = serde_json::to_value(&next)?;
            stored.as_object_mut().unwrap().remove("activeConnectionId");
            for (item, connection) in stored["connections"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .zip(&next.connections)
            {
                let obj = item.as_object_mut().unwrap();
                for key in ["secretAccessKey", "sessionToken", "hasSecretAccessKey"] {
                    obj.remove(key);
                }
                if self.secure && next.security_settings.remember_credentials_locally {
                    for (key, secret) in [
                        ("secretAccessKeyEncrypted", &connection.secret_access_key),
                        ("sessionTokenEncrypted", &connection.session_token),
                    ] {
                        if let Some(secret) = secret {
                            obj.insert(
                                key.into(),
                                json!(STANDARD.encode(crypt(secret.as_bytes(), true)?)),
                            );
                        }
                    }
                }
            }
            let backup_path = self.path.with_extension("json.bak");
            let backup = fs::read(&self.path)
                .ok()
                .filter(|bytes| parse_config(bytes).is_ok());
            let backup = match backup {
                Some(bytes) => Some(bytes),
                None => match fs::read(&backup_path) {
                    Ok(bytes) => {
                        parse_config(&bytes)?;
                        Some(bytes)
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                },
            };
            if let Some(bytes) = backup {
                let mut backup: Value = serde_json::from_slice(&bytes)?;
                if let Some(connections) = backup["connections"].as_array_mut() {
                    connections.retain(|c| {
                        next.connections
                            .iter()
                            .any(|n| c["id"].as_str() == Some(&n.id))
                    });
                    for connection in connections {
                        let object = connection.as_object_mut().unwrap();
                        for field in ["secretAccessKey", "sessionToken", "hasSecretAccessKey"] {
                            object.remove(field);
                        }
                        if !self.secure || !next.security_settings.remember_credentials_locally {
                            object.remove("secretAccessKeyEncrypted");
                            object.remove("sessionTokenEncrypted");
                        }
                    }
                }
                // Sanitize the recovery copy first, so a successful opt-out cannot restore credentials.
                if !self.secure || !next.security_settings.remember_credentials_locally {
                    backup["securitySettings"]["rememberCredentialsLocally"] = json!(false);
                }
                atomic_write(&backup_path, &serde_json::to_vec_pretty(&backup)?)?;
            }
            atomic_write(&self.path, &serde_json::to_vec_pretty(&stored)?)?;
        }
        *current = next.clone();
        Ok(redact(next))
    }
    pub fn save_connection(&self, mut connection: ConnectionConfig) -> Result<AppConfig> {
        validate_connection(&mut connection)?;
        connection.updated_at = now();
        self.mutate(true, |config| {
            if let Some(existing) = config
                .connections
                .iter_mut()
                .find(|c| c.id == connection.id)
            {
                connection.secret_access_key = nonempty(connection.secret_access_key)
                    .or_else(|| existing.secret_access_key.clone());
                connection.session_token =
                    nonempty(connection.session_token).or_else(|| existing.session_token.clone());
                connection.created_at = existing.created_at.clone();
                *existing = connection;
            } else {
                if connection.id.is_empty() {
                    connection.id = uuid::Uuid::new_v4().to_string();
                }
                connection.created_at = now();
                config.connections.push(connection);
            }
            Ok(())
        })
    }
    pub fn set_active(&self, id: &str) -> Result<AppConfig> {
        self.mutate(false, |config| {
            if !config.connections.iter().any(|c| c.id == id) {
                return Err(AppError::new("config.connectionMissing"));
            }
            config.active_connection_id = Some(id.into());
            Ok(())
        })
    }
    pub fn delete(&self, id: &str) -> Result<AppConfig> {
        self.mutate(true, |config| {
            if !config.connections.iter().any(|c| c.id == id) {
                return Err(AppError::new("config.connectionMissing"));
            }
            config.connections.retain(|c| c.id != id);
            if config.active_connection_id.as_deref() == Some(id) {
                config.active_connection_id = None;
            }
            Ok(())
        })
    }
    pub fn settings(&self, patch: Value) -> Result<AppConfig> {
        validate_settings(&patch)?;
        self.mutate(true, |config| {
            let mut value = serde_json::to_value(&*config)?;
            for key in [
                "compactMode",
                "transferSettings",
                "securitySettings",
                "appearanceSettings",
            ] {
                if let Some(patch) = patch.get(key) {
                    merge(&mut value[key], patch);
                }
            }
            *config = serde_json::from_value(value)?;
            if !self.secure {
                config.security_settings.remember_credentials_locally = false;
            }
            Ok(())
        })
    }
}

fn parse_config(bytes: &[u8]) -> Result<AppConfig> {
    let value: Value = serde_json::from_slice(bytes)?;
    let mut normalized = serde_json::to_value(defaults())?;
    merge(&mut normalized, &value);
    let mut config: AppConfig = serde_json::from_value(normalized)?;
    config.active_connection_id = None;
    config.transfer_settings.concurrent_transfers =
        config.transfer_settings.concurrent_transfers.clamp(1, 8);
    config.transfer_settings.multipart_concurrency =
        config.transfer_settings.multipart_concurrency.clamp(1, 16);
    config.transfer_settings.chunk_size_mb = config.transfer_settings.chunk_size_mb.clamp(5, 5120);
    config.transfer_settings.retry_count = config.transfer_settings.retry_count.min(10);
    validate_settings(&json!({
        "transferSettings": config.transfer_settings,
        "securitySettings": config.security_settings,
        "appearanceSettings": config.appearance_settings,
    }))?;
    for (connection, stored) in config
        .connections
        .iter_mut()
        .zip(value["connections"].as_array().into_iter().flatten())
    {
        connection.secret_access_key = decrypt(stored["secretAccessKeyEncrypted"].as_str());
        connection.session_token = decrypt(stored["sessionTokenEncrypted"].as_str());
        connection.has_secret_access_key = None;
        validate_connection(connection)?;
    }
    Ok(config)
}

fn nonempty(secret: Option<String>) -> Option<String> {
    secret
        .map(|s| s.trim().into())
        .filter(|s: &String| !s.is_empty())
}
fn decrypt(value: Option<&str>) -> Option<String> {
    String::from_utf8(crypt(&STANDARD.decode(value?).ok()?, false).ok()?).ok()
}
pub fn redact(mut config: AppConfig) -> AppConfig {
    for c in &mut config.connections {
        c.has_secret_access_key = Some(
            c.secret_access_key
                .as_deref()
                .is_some_and(|s| !s.is_empty()),
        );
        c.secret_access_key = None;
        c.session_token = None;
    }
    config
}
fn merge(base: &mut Value, patch: &Value) {
    if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            merge(base.entry(key).or_insert(Value::Null), value);
        }
    } else {
        *base = patch.clone();
    }
}
pub fn validate_connection(c: &mut ConnectionConfig) -> Result<()> {
    if c.profile_name.trim().is_empty()
        || c.endpoint.trim().is_empty()
        || c.access_key_id.trim().is_empty()
    {
        return Err(AppError::new("error.operationFailed"));
    }
    c.endpoint = c.endpoint.trim().into();
    c.secret_access_key = nonempty(c.secret_access_key.take());
    c.session_token = nonempty(c.session_token.take());
    let endpoint = if c.endpoint.starts_with("http://") || c.endpoint.starts_with("https://") {
        c.endpoint.clone()
    } else {
        format!("{}://{}", if c.ssl { "https" } else { "http" }, c.endpoint)
    };
    let url = url::Url::parse(&endpoint).map_err(AppError::sdk)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new("error.operationFailed"));
    }
    if c.region.trim().is_empty() {
        c.region = "us-east-1".into();
    }
    if let Some(bucket) = &c.default_bucket {
        c.default_bucket = if bucket.trim().is_empty() {
            None
        } else {
            Some(safety::bucket(bucket)?)
        };
    }
    if c.checksum_algorithm
        .as_deref()
        .is_some_and(|v| !["CRC32", "SHA256", "disabled"].contains(&v))
    {
        return Err(AppError::new("error.checksumRejected"));
    }
    Ok(())
}
fn validate_settings(patch: &Value) -> Result<()> {
    let invalid = || AppError::new("error.operationFailed");
    let object = patch.as_object().ok_or_else(invalid)?;
    if object.get("compactMode").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid());
    }
    for name in ["transferSettings", "securitySettings", "appearanceSettings"] {
        let Some(group) = object.get(name) else {
            continue;
        };
        let group = group.as_object().ok_or_else(invalid)?;
        for (key, value) in group {
            let valid = match key.as_str() {
                "concurrentTransfers" => value.as_u64().is_some_and(|n| (1..=8).contains(&n)),
                "multipartConcurrency" => value.as_u64().is_some_and(|n| (1..=16).contains(&n)),
                "chunkSizeMb" => value.as_u64().is_some_and(|n| (5..=5120).contains(&n)),
                "retryCount" => value.as_u64().is_some_and(|n| n <= 10),
                "overwritePolicy" => value
                    .as_str()
                    .is_some_and(|v| ["ask", "overwrite", "skip"].contains(&v)),
                "language" => value
                    .as_str()
                    .is_some_and(|v| ["system", "zh-CN", "en-US"].contains(&v)),
                "rememberCredentialsLocally"
                | "requireConfirmationBeforeDelete"
                | "disableHardwareAcceleration"
                | "disableGpuShaderDiskCache" => value.is_boolean(),
                "defaultDownloadFolder" => value.is_string(),
                _ => false,
            };
            if !valid {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn file_commit_does_not_replace_an_unreserved_target() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("temporary");
        let target = dir.path().join("target");
        fs::write(&source, "new").unwrap();
        fs::write(&target, "original").unwrap();
        assert!(commit_file(&source, &target, false).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(fs::read_to_string(&source).unwrap(), "new");
        commit_file(&source, &target, true).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        fs::write(&source, "exclusive").unwrap();
        let exclusive = dir.path().join("exclusive-target");
        commit_file(&source, &exclusive, false).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(exclusive).unwrap(), "exclusive");
    }
    #[test]
    fn recovery_does_not_replace_valid_backup_with_invalid_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let backup = path.with_extension("json.bak");
        fs::write(&path, br#"{"transferSettings":"broken"}"#).unwrap();
        fs::write(&backup, serde_json::to_vec(&defaults()).unwrap()).unwrap();
        let store = ConfigStore::open(path.clone()).unwrap();
        store.settings(json!({"compactMode":true})).unwrap();
        fs::write(&path, "broken again").unwrap();
        assert!(ConfigStore::open(path).is_ok());
    }
    #[test]
    fn credential_removal_also_cleans_the_recovery_backup() {
        for delete_connection in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            let store = ConfigStore::open(path.clone()).unwrap();
            store
                .save_connection(ConnectionConfig {
                    id: "test".into(),
                    profile_name: "test".into(),
                    endpoint: "localhost:9000".into(),
                    access_key_id: "test".into(),
                    secret_access_key: Some("test-secret".into()),
                    session_token: Some("test-token".into()),
                    ..Default::default()
                })
                .unwrap();
            if delete_connection {
                store.delete("test").unwrap();
            } else {
                store
                    .settings(json!({"securitySettings":{"rememberCredentialsLocally":false}}))
                    .unwrap();
            }
            for file in [&path, &path.with_extension("json.bak")] {
                let value: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
                assert!(!value.to_string().contains("Encrypted"));
            }
            fs::write(&path, "broken").unwrap();
            let recovered = ConfigStore::open(path).unwrap().raw();
            if delete_connection {
                assert!(recovered.connections.is_empty());
            } else {
                assert!(!recovered.security_settings.remember_credentials_locally);
                assert!(recovered.connections[0].secret_access_key.is_none());
            }
        }
    }
    #[test]
    fn backup_cleanup_failure_does_not_report_a_successful_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.settings(json!({"compactMode":true})).unwrap();
        fs::create_dir(path.with_extension("json.bak")).unwrap();
        assert!(
            store
                .settings(json!({"securitySettings":{"rememberCredentialsLocally":false}}))
                .is_err()
        );
        assert!(store.raw().security_settings.remember_credentials_locally);
    }
    #[test]
    fn validating_saved_connections_keeps_client_cache_identity() {
        let mut connection = ConnectionConfig {
            profile_name: "test".into(),
            endpoint: "http://localhost:9000".into(),
            access_key_id: "key".into(),
            secret_access_key: Some("secret".into()),
            region: "us-east-1".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };
        let saved = connection.clone();
        validate_connection(&mut connection).unwrap();
        validate_connection(&mut connection).unwrap();
        assert_eq!(connection, saved);
    }
    #[test]
    fn corrupt_config_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "broken").unwrap();
        assert!(ConfigStore::open(path.clone()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }
    #[test]
    fn config_secret_and_session_contract() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::open_secure(path.clone(), false).unwrap();
        let connection = ConnectionConfig {
            id: "test".into(),
            profile_name: "test".into(),
            endpoint: "localhost:9000".into(),
            access_key_id: "key".into(),
            secret_access_key: Some("secret-never-write".into()),
            ..Default::default()
        };
        store.save_connection(connection).unwrap();
        store.set_active("test").unwrap();
        assert_eq!(
            store.active("test").unwrap().secret_access_key.as_deref(),
            Some("secret-never-write")
        );
        assert!(store.get().connections[0].secret_access_key.is_none());
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("secret-never-write"));
        assert!(!text.contains("activeConnectionId"));
        assert!(
            ConfigStore::open(path)
                .unwrap()
                .get()
                .active_connection_id
                .is_none()
        );
        assert!(store.active("stale").is_err());
        assert!(
            store
                .settings(json!({"transferSettings":{"concurrentTransfers":0}}))
                .is_err()
        );
        store
            .settings(json!({"transferSettings":{"concurrentTransfers":8}}))
            .unwrap();
        assert_eq!(store.get().transfer_settings.concurrent_transfers, 8);
    }
    #[test]
    fn dpapi_round_trip() {
        if cfg!(windows) {
            let encrypted = crypt(b"secret", true).unwrap();
            assert_ne!(encrypted, b"secret");
            assert_eq!(crypt(&encrypted, false).unwrap(), b"secret");
        }
    }
    #[test]
    fn concurrent_saves_and_empty_secret_preserve_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = std::sync::Arc::new(ConfigStore::open(path.clone()).unwrap());
        let mut workers = Vec::new();
        for index in 0..8 {
            let store = store.clone();
            workers.push(std::thread::spawn(move || {
                store
                    .save_connection(ConnectionConfig {
                        id: format!("{index}"),
                        profile_name: "test".into(),
                        endpoint: "localhost:9000".into(),
                        access_key_id: "key".into(),
                        secret_access_key: Some("persisted-secret".into()),
                        ..Default::default()
                    })
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(store.get().connections.len(), 8);
        store.set_active("0").unwrap();
        let mut connection = store
            .get()
            .connections
            .into_iter()
            .find(|c| c.id == "0")
            .unwrap();
        connection.secret_access_key = Some("  ".into());
        store.save_connection(connection).unwrap();
        assert_eq!(
            store.active("0").unwrap().secret_access_key.as_deref(),
            Some("persisted-secret")
        );
        let restarted = ConfigStore::open(path).unwrap();
        assert_eq!(restarted.get().connections.len(), 8);
        assert!(restarted.get().active_connection_id.is_none());
    }
}
