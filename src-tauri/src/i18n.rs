use serde_json::Value;
use std::sync::{
    LazyLock,
    atomic::{AtomicBool, Ordering},
};

static CHINESE: AtomicBool = AtomicBool::new(true);
static ZH: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/shared/locales/zh-CN.json"))
        .expect("Chinese catalog")
});
static EN: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/shared/locales/en-US.json"))
        .expect("English catalog")
});

pub fn set_language(preference: &str) {
    let language = if preference == "system" {
        sys_locale::get_locale().unwrap_or_default()
    } else {
        preference.into()
    };
    CHINESE.store(language.to_lowercase().starts_with("zh"), Ordering::Relaxed);
}

pub fn t(key: &str) -> String {
    let catalog = if CHINESE.load(Ordering::Relaxed) {
        &*ZH
    } else {
        &*EN
    };
    catalog
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(key)
        .into()
}

pub fn tr(key: &str, params: &[(&str, String)]) -> String {
    let mut text = t(key);
    for (name, value) in params {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
