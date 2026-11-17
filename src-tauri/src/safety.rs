use crate::error::{AppError, Result};
use std::path::{Component, Path, PathBuf};

pub fn bucket(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::new("error.bucketRequired"));
    }
    if value.contains(['/', '\\']) || value.chars().any(|c| c <= '\x1f' || c == '\x7f') {
        return Err(AppError::new("error.bucketInvalid"));
    }
    Ok(value.into())
}
pub fn existing_key(value: &str, empty: bool, folder: bool) -> Result<String> {
    if value.is_empty() && !empty {
        return Err(AppError::new("error.keyRequired"));
    }
    if value.ends_with('/') && !folder {
        return Err(AppError::new("error.fileKeyTrailingSlash"));
    }
    if value.len() > 1024 {
        return Err(AppError::new("error.keyTooLong"));
    }
    Ok(value.into())
}
pub fn key(value: &str, empty: bool, folder: bool) -> Result<String> {
    let value = value.trim().replace('\\', "/");
    existing_key(&value, empty, folder)?;
    let issue = if value.starts_with('/') {
        Some("error.keyLeadingSlash")
    } else if value.contains("//") {
        Some("error.keyDuplicateSlash")
    } else if value.chars().any(|c| c <= '\x1f' || c == '\x7f') {
        Some("error.keyControlChars")
    } else if value.split('/').any(|s| s == "." || s == "..") {
        Some("error.keyDotSegment")
    } else {
        None
    };
    if let Some(issue) = issue {
        return Err(AppError::new(issue));
    }
    Ok(value)
}
pub fn prefix(value: &str) -> Result<String> {
    let value = key(value, true, true)?;
    let value = if value.is_empty() || value.ends_with('/') {
        value
    } else {
        format!("{value}/")
    };
    existing_key(&value, true, true)
}
pub fn move_target(sb: &str, sk: &str, tb: &str, tk: &str) -> Result<()> {
    if sb == tb {
        if sk == tk {
            return Err(AppError::new("error.targetSameAsSource"));
        }
        if sk.ends_with('/') && (tk.starts_with(sk) || sk.starts_with(tk)) {
            return Err(AppError::new("error.folderPrefixesOverlap"));
        }
    }
    Ok(())
}
pub fn copy_source(bucket: &str, key: &str, version: Option<&str>) -> String {
    use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
    const ENCODE: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    let encode = |value: &str| utf8_percent_encode(value, ENCODE).to_string();
    let mut result = format!(
        "{}/{}",
        encode(bucket),
        key.split('/').map(encode).collect::<Vec<_>>().join("/")
    );
    if let Some(version) = version {
        result.push_str(&format!("?versionId={}", encode(version)));
    }
    result
}
pub fn path_id(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

pub fn inside(base: &Path, path: &Path) -> Result<PathBuf> {
    let base = std::fs::canonicalize(base)?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    // Canonicalize the parent to resolve junctions/symlinks before any file is created.
    let parent = std::fs::canonicalize(
        candidate
            .parent()
            .ok_or_else(|| AppError::new("error.pathTraversalBlocked"))?,
    )?;
    if !parent.starts_with(&base)
        || candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(AppError::new("error.pathTraversalBlocked"));
    }
    let name = candidate
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("error.pathTraversalBlocked"))?;
    // Reject Windows device names, ADS streams and aliases with trailing dots/spaces.
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if name.contains([':', '\\', '/'])
        || name.ends_with(['.', ' '])
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.ends_with(|c: char| ('1'..='9').contains(&c)))
    {
        return Err(AppError::new("error.pathTraversalBlocked"));
    }
    let result = parent.join(name);
    if result.exists() {
        let actual = std::fs::canonicalize(&result)?;
        if !actual.starts_with(&base) || !actual.is_file() {
            return Err(AppError::new("error.pathTraversalBlocked"));
        }
    }
    Ok(result)
}

pub fn renamed(value: &str, index: u64) -> String {
    let folder = value.ends_with('/');
    let value = value.trim_end_matches('/');
    let (parent, name) = value
        .rsplit_once('/')
        .map(|(p, n)| (format!("{p}/"), n))
        .unwrap_or_else(|| (String::new(), value));
    if folder {
        return format!("{parent}{name} ({index})/");
    }
    let (stem, extension) = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(s, e)| (s, format!(".{e}")))
        .unwrap_or_else(|| (name, String::new()));
    format!("{parent}{stem} ({index}){extension}")
}
pub fn renamed_path(path: &Path, index: u64) -> PathBuf {
    path.with_file_name(renamed(
        &path.file_name().unwrap_or_default().to_string_lossy(),
        index,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_identity_and_validation() {
        for value in [" key\\part ", "a//b", "a/../b", "/root"] {
            assert_eq!(existing_key(value, false, true).unwrap(), value);
        }
        assert_eq!(key(" a\\b ", false, false).unwrap(), "a/b");
        for value in ["/a", "a//b", "a/../b", "a/./b", "a\x00b", "a/"] {
            assert!(key(value, false, false).is_err());
        }
        assert!(key(&"中".repeat(342), false, false).is_err());
        assert!(key("..notes", false, false).is_ok());
        assert_eq!(
            copy_source("source", " key\\with-space ", Some("version 1")),
            "source/%20key%5Cwith-space%20?versionId=version%201"
        );
        assert!(prefix(&"a".repeat(1024)).is_err());
        assert_eq!(prefix(&"a".repeat(1023)).unwrap().len(), 1024);
        assert!(move_target("a", "folder/child/", "a", "folder/").is_err());
        assert!(move_target("a", "folder/", "b", "folder/").is_ok());
    }
    #[test]
    fn download_path_boundary() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inside(dir.path(), Path::new("okay.txt")).is_ok());
        for name in ["../escape", "NUL", "x:stream", "trailing."] {
            assert!(inside(dir.path(), Path::new(name)).is_err());
        }
        assert!(move_target("a", "folder/", "a", "folder/child/").is_err());
        assert_eq!(renamed("folder.name/", 1), "folder.name (1)/");
        assert_eq!(renamed("folder/file.txt", 1), "folder/file (1).txt");
        let original = inside(dir.path(), Path::new("file.txt")).unwrap();
        let renamed = renamed_path(&original, 1);
        std::fs::write(&renamed, b"test").unwrap();
        assert!(inside(dir.path(), &renamed).is_ok());
    }
}
