mod dsh;
mod logging;
mod settings;

use dsh::DshRuntime;
use logging::Logger;
use serde::Serialize;
use settings::{Settings, WindowBounds};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const APP_ID: &str = "ai.deepseek.dshwindow";
pub struct AppState {
    runtime: Arc<DshRuntime>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    logger: Logger,
    quitting: AtomicBool,
    frontend_ready: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendState {
    phase: String,
    url: Option<String>,
    logs: Vec<String>,
    message: String,
    version: String,
    theme: bool,
}

#[tauri::command]
fn get_state(app: AppHandle, state: State<'_, AppState>) -> FrontendState {
    let snapshot = state.runtime.snapshot();
    FrontendState {
        phase: snapshot.phase,
        url: snapshot.url,
        logs: snapshot.logs,
        message: snapshot.message,
        version: app.package_info().version.to_string(),
        theme: resolve_theme_dark(&app),
    }
}

#[tauri::command]
fn restart(app: AppHandle, state: State<'_, AppState>) {
    state.runtime.restart(app);
}

#[tauri::command]
fn quit(app: AppHandle) {
    graceful_quit(app);
}

#[tauri::command]
fn copy_logs(state: State<'_, AppState>) -> bool {
    let logs = state.runtime.snapshot().logs.join("\n");
    if logs.is_empty() {
        return false;
    }
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(logs))
        .is_ok()
}

#[tauri::command]
fn open_logs(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(parent) = state.logger.path().parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.logger.path());
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", state.logger.path().display()))
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    open::that(state.logger.path()).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    let next = !maximized;
    let _ = window.emit("dsh:maximized", next);
    Ok(next)
}

#[tauri::command]
fn close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn report_theme(window: WebviewWindow, dark: bool, state: State<'_, AppState>) {
    state.logger.line(format!(
        "[chrome] {} 页面主题: {}",
        window.label(),
        if dark { "dark" } else { "light" }
    ));
    let color = if dark {
        tauri::window::Color(21, 21, 23, 255)
    } else {
        tauri::window::Color(255, 255, 255, 255)
    };
    let _ = window.set_background_color(Some(color));
}

#[tauri::command]
fn frontend_ready(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) {
    if window.label() != "main" {
        return;
    }
    finish_main_window(&window, &state);
    let _ = app;
}

fn finish_main_window(window: &WebviewWindow, state: &AppState) {
    if state.frontend_ready.swap(true, Ordering::SeqCst) {
        return;
    }
    state.logger.line("[chrome] DSH 页面已渲染，完成窗口交接");
    let _ = window.show();
    let _ = window.set_focus();
    let app = window.app_handle().clone();
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.hide();
    }
    if std::env::var_os("DSH_WINDOW_SMOKE").is_some() {
        println!(
            "DSH_WINDOW_SMOKE_PAGE_LOADED {}",
            window
                .url()
                .map_or_else(|_| String::new(), |url| url.to_string())
        );
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(9));
            graceful_quit(app);
        });
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅允许打开 HTTP(S) 链接".into());
    }
    open::that(url).map_err(|error| error.to_string())
}

pub(crate) fn handle_dsh_ready(app: &AppHandle, url: &str) {
    let app = app.clone();
    let url = url.to_owned();
    let _ = app.clone().run_on_main_thread(move || {
        if let Err(error) = create_or_navigate_main(&app, &url) {
            if let Some(state) = app.try_state::<AppState>() {
                state
                    .logger
                    .line(format!("[window] 创建主窗口失败: {error}"));
            }
        }
    });
}

pub(crate) fn handle_dsh_crashed(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        state.logger.line(format!("[dsh] {message}"));
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.show();
        let _ = splash.set_focus();
    }
}

fn create_or_navigate_main(app: &AppHandle, raw_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw_url).map_err(|error| error.to_string())?;
    app.state::<AppState>()
        .frontend_ready
        .store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        window.navigate(parsed).map_err(|error| error.to_string())?;
        return Ok(());
    }

    let state = app.state::<AppState>();
    let settings = state
        .settings
        .lock()
        .expect("settings lock poisoned")
        .clone();
    let bounds = settings.window_bounds.clone();
    let allowed_origin = url::Url::parse(raw_url)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("DSH Window")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .decorations(true)
        .visible(false)
        .on_page_load(|window, payload| {
            if let Some(state) = window.app_handle().try_state::<AppState>() {
                state.logger.line(format!(
                    "[window] {} page-load {:?}: {}",
                    window.label(),
                    payload.event(),
                    payload.url()
                ));
            }
            if payload.event() == PageLoadEvent::Finished {
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(750));
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        finish_main_window(&window, &state);
                    }
                });
            }
        })
        .on_new_window(|url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if url.origin().ascii_serialization() == allowed_origin {
                true
            } else {
                if matches!(url.scheme(), "http" | "https") {
                    let _ = open::that(url.as_str());
                }
                false
            }
        });
    if let Some(bounds) = bounds {
        builder = builder
            .position(bounds.x as f64, bounds.y as f64)
            .inner_size(bounds.width as f64, bounds.height as f64);
    } else {
        builder = builder.center();
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    #[cfg(debug_assertions)]
    if settings.open_dev_tools {
        window.open_devtools();
    }
    let fallback = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(10));
        if !fallback.is_visible().unwrap_or(false) {
            let _ = fallback.show();
        }
    });
    Ok(())
}

fn show_current_window<R: Runtime>(app: &AppHandle<R>) {
    let window = app
        .get_webview_window("main")
        .filter(|window| window.is_visible().unwrap_or(false))
        .or_else(|| app.get_webview_window("splash"))
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn save_window_bounds(window: &tauri::Window, state: &AppState) {
    if window.label() != "main" || window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(PhysicalPosition { x, y }) = window.outer_position() else {
        return;
    };
    let Ok(PhysicalSize { width, height }) = window.inner_size() else {
        return;
    };
    let mut settings = state.settings.lock().expect("settings lock poisoned");
    settings.window_bounds = Some(WindowBounds {
        x,
        y,
        width,
        height,
    });
    if let Err(error) = settings::save(&state.settings_path, &settings) {
        state.logger.line(format!("保存设置失败: {error}"));
    }
}

fn graceful_quit(app: AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        app.exit(0);
        return;
    };
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.logger.line("应用退出，正在停止 dsh…");
    let runtime = state.runtime.clone();
    let logger = state.logger.clone();
    thread::spawn(move || {
        runtime.stop();
        logger.line("dsh 已停止，退出。");
        app.exit(0);
    });
}

fn resolve_theme_dark(app: &AppHandle) -> bool {
    match settings::theme_preference() {
        "dark" => true,
        "light" => false,
        _ => app
            .get_webview_window("main")
            .or_else(|| app.get_webview_window("splash"))
            .and_then(|window| window.theme().ok())
            .is_some_and(|theme| theme == Theme::Dark),
    }
}

fn watch_theme(app: AppHandle) {
    thread::spawn(move || {
        let mut last = resolve_theme_dark(&app);
        loop {
            thread::sleep(Duration::from_secs(1));
            if app.try_state::<AppState>().is_none() {
                return;
            }
            let current = resolve_theme_dark(&app);
            if current != last {
                last = current;
                let _ = app.emit_to("splash", "dsh:theme", current);
            }
        }
    });
}

fn app_data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-window")
}

fn normalize_resource_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重新启动 dsh", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &separator, &exit])?;
    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .expect("application icon missing")
                .clone(),
        )
        .tooltip("DSH Window")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_current_window(app),
            "restart" => {
                let state = app.state::<AppState>();
                state.runtime.restart(app.clone());
            }
            "exit" => graceful_quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_current_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_current_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_state,
            restart,
            quit,
            copy_logs,
            open_logs,
            minimize,
            toggle_maximize,
            close,
            get_maximized,
            start_dragging,
            report_theme,
            frontend_ready,
            open_external
        ])
        .setup(|app| {
            let data_dir = app_data_dir();
            let settings_path = data_dir.join("settings.json");
            let settings = settings::load(&settings_path);
            let logger = Logger::new(data_dir.join("dsh-window.log"));
            let resource_dir = normalize_resource_path(app.path().resource_dir()?);
            let runtime = Arc::new(DshRuntime::new(
                settings.clone(),
                logger.clone(),
                resource_dir,
            ));
            app.manage(AppState {
                runtime: runtime.clone(),
                settings: Mutex::new(settings),
                settings_path,
                logger: logger.clone(),
                quitting: AtomicBool::new(false),
                frontend_ready: AtomicBool::new(false),
            });
            logger.line(format!(
                "dsh-window v{} 启动（Tauri）",
                app.package_info().version
            ));
            logger.line(format!("应用标识: {APP_ID}"));
            build_tray(app.handle())?;
            if let Some(splash) = app.get_webview_window("splash") {
                let _ = splash.show();
                let _ = splash.set_focus();
            }
            watch_theme(app.handle().clone());
            runtime.start(app.handle().clone());
            if std::env::var_os("DSH_WINDOW_SMOKE").is_some() {
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(60));
                    println!("DSH_WINDOW_SMOKE_TIMEOUT");
                    graceful_quit(handle);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<AppState>();
                save_window_bounds(window, &state);
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                let close_to_tray = state
                    .settings
                    .lock()
                    .expect("settings lock poisoned")
                    .close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    graceful_quit(window.app_handle().clone());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 DSH Window 失败");
}

pub fn run_guard_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--dsh-guard") {
        return false;
    }
    let parent = args.get(2).and_then(|value| value.parse::<u32>().ok());
    let dsh = args.get(3).and_then(|value| value.parse::<u32>().ok());
    let (Some(parent), Some(dsh)) = (parent, dsh) else {
        return true;
    };
    loop {
        thread::sleep(Duration::from_secs(1));
        if !process_alive(dsh) {
            return true;
        }
        if !process_alive(parent) {
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill")
                .args(["/pid", &dsh.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            #[cfg(not(windows))]
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &dsh.to_string()])
                .status();
            return true;
        }
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}
