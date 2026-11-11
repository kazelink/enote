use std::io::Write;

#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

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

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("eNote")
                .inner_size(1280.0, 860.0)
                .min_inner_size(380.0, 480.0)
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
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running eNote");
}
