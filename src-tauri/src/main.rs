#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod config;
mod error;
mod i18n;
mod logger;
mod model;
mod s3;
#[cfg(test)]
mod s3_tests;
mod safety;
mod tasks;

use commands::AppState;
use std::sync::{Mutex, atomic::AtomicBool};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

fn external(app: &tauri::AppHandle, url: &url::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            app.state::<AppState>().logger.write(
                "warn",
                &i18n::t("error.operationFailed"),
                Some(&error.to_string()),
                "IPC",
            );
        }
    } else {
        app.state::<AppState>().logger.write(
            "warn",
            &i18n::tr("main.blockedUnsafeUrl", &[("url", url.to_string())]),
            None,
            "IPC",
        );
    }
}
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::dispatch])
        .setup(|app| {
            let directory = app.path().app_config_dir()?.join("tauri-v2");
            let config = config::ConfigStore::open(directory.join("config.json"))?;
            let settings = config.raw();
            i18n::set_language(&settings.appearance_settings.language);
            let logger = logger::Logger::new(directory.join("logs"));
            logger.attach(app.handle().clone());
            let tasks = tasks::TaskManager::new(logger.clone());
            tasks.attach(app.handle().clone());
            tasks.set_concurrency(settings.transfer_settings.concurrent_transfers);
            let downloads = app.path().download_dir()?;
            let state = AppState {
                config,
                logger,
                tasks,
                downloads,
                closing: AtomicBool::new(false),
                service: Mutex::new(None),
            };
            if let Err(error) = tasks::cleanup_partials(&state.download_folder()) {
                state.logger.write(
                    "warn",
                    &i18n::t("main.cleanupPartialsFailed"),
                    error.detail.as_deref(),
                    "Task",
                );
            }
            app.manage(state);
            let appearance = settings.appearance_settings;
            let mut args =
                String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            if appearance.disable_hardware_acceleration {
                args.push_str(" --disable-gpu");
            }
            if appearance.disable_gpu_shader_disk_cache {
                args.push_str(" --disable-gpu-shader-disk-cache");
            }
            let webview_data = app.path().app_local_data_dir()?.join(format!(
                "WebView2-{}-{}",
                appearance.disable_hardware_acceleration, appearance.disable_gpu_shader_disk_cache
            ));
            let navigation_app = app.handle().clone();
            let popup_app = app.handle().clone();
            let initial = if cfg!(debug_assertions) {
                "http://localhost:5173/"
            } else {
                "http://tauri.localhost/"
            };
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("OSS Browser")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1100.0, 720.0)
            .decorations(false)
            .maximized(true)
            .visible(false)
            .background_color(tauri::utils::config::Color(246, 248, 251, 255))
            .additional_browser_args(&args)
            .data_directory(webview_data)
            .on_navigation(move |url| {
                if url.as_str() == initial
                    || url.as_str() == "tauri://localhost/"
                    || url.as_str() == "tauri://localhost/index.html"
                    || url.as_str() == format!("{initial}index.html")
                {
                    true
                } else {
                    external(&navigation_app, url);
                    false
                }
            })
            .on_new_window(move |url, _| {
                external(&popup_app, &url);
                tauri::webview::NewWindowResponse::Deny
            })
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    let _ = window.show();
                    let _ = window.maximize();
                }
            })
            .build()?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                commands::request_exit(window.app_handle());
            }
            tauri::WindowEvent::Resized(_) => {
                let _ = window.emit(
                    "window:maximized-changed",
                    window.is_maximized().unwrap_or(false),
                );
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("OSS Browser initialization failed");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
            commands::request_exit(app);
        }
    });
}
