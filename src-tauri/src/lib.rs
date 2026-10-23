//! Tauri entry point.
//!
//! The desktop shell stays thin: the UI is the same bundle the browser could
//! load, and all data access goes through IndexedDB plus the sync HTTP API. No
//! Node process is bundled, which keeps the installer at ~1.4 MB and lets a
//! mobile build reuse the exact same assets.

use std::io::Write;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Appends a line to `enote-startup.log` next to the executable.
///
/// A packaged app has no console, so without this a blank window is
/// indistinguishable from a crash. Cheap enough to keep enabled.
fn debug_log(msg: &str) {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join("enote-startup.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("enote-startup.log"));

    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", msg);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    debug_log("=== startup ===");

    tauri::Builder::default()
        .setup(|app| {
            // The window is created in code rather than in tauri.conf.json so
            // the entry file can be `main.html`: Tauri rewrites `index.html` to
            // the bare origin, and its asset resolver serves no directory index.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("main.html".into()))
                .title("eNote")
                .inner_size(1280.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .on_page_load(|_webview, payload| {
                    debug_log(&format!(
                        "page_load url={} event={:?}",
                        payload.url(),
                        payload.event()
                    ));
                })
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running eNote");
}
