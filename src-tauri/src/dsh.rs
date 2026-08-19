use crate::{handle_dsh_crashed, handle_dsh_ready, logging::Logger, settings::Settings};
use regex::Regex;
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LINES: usize = 500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: String,
    pub url: Option<String>,
    pub logs: Vec<String>,
    pub message: String,
}

struct RuntimeData {
    phase: String,
    url: Option<String>,
    logs: VecDeque<String>,
    message: String,
}

pub struct DshRuntime {
    data: Mutex<RuntimeData>,
    generation: AtomicU64,
    child_pid: AtomicU32,
    settings: Settings,
    logger: Logger,
    resource_dir: PathBuf,
}

#[derive(Debug)]
enum LaunchKind {
    Direct,
    Cmd,
    PowerShell,
    Node,
    Npx,
}

#[derive(Debug)]
struct LaunchSpec {
    kind: LaunchKind,
    entry: PathBuf,
    node: Option<PathBuf>,
    label: String,
}

impl DshRuntime {
    pub fn new(settings: Settings, logger: Logger, resource_dir: PathBuf) -> Self {
        Self {
            data: Mutex::new(RuntimeData {
                phase: "idle".into(),
                url: None,
                logs: VecDeque::new(),
                message: String::new(),
            }),
            generation: AtomicU64::new(0),
            child_pid: AtomicU32::new(0),
            settings,
            logger,
            resource_dir,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let data = self.data.lock().expect("dsh runtime lock poisoned");
        Snapshot {
            phase: data.phase.clone(),
            url: data.url.clone(),
            logs: data.logs.iter().cloned().collect(),
            message: data.message.clone(),
        }
    }

    pub fn start(self: &std::sync::Arc<Self>, app: AppHandle) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let runtime = self.clone();
        thread::spawn(move || runtime.run(app, generation));
    }

    pub fn restart(self: &std::sync::Arc<Self>, app: AppHandle) {
        self.logger.line("[dsh] 用户请求重启");
        self.stop();
        self.start(app);
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        if pid != 0 {
            self.set_state(None, "stopping", "正在停止 dsh…");
            kill_process_tree(pid);
        }
        self.set_state(None, "stopped", "已停止");
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn run(self: std::sync::Arc<Self>, app: AppHandle, generation: u64) {
        self.set_state(Some(&app), "resolving", "正在定位 dsh 命令…");
        let spec = match self.resolve() {
            Ok(spec) => spec,
            Err(error) => {
                self.fail(&app, &error);
                return;
            }
        };
        if !self.is_current(generation) {
            return;
        }

        let args = self.dsh_args();
        self.set_state(
            Some(&app),
            "starting",
            &format!("正在启动 dsh web…({})", spec.label),
        );
        self.push_log(
            Some(&app),
            format!("[dsh-window] 启动命令: {args:?} ({})", spec.label),
        );
        let mut child = match spawn_spec(&spec, &args) {
            Ok(child) => child,
            Err(error) => {
                self.fail(&app, &format!("无法启动 dsh 子进程: {error}"));
                return;
            }
        };
        let pid = child.id();
        self.child_pid.store(pid, Ordering::SeqCst);
        spawn_guard(pid, &self.logger);
        self.set_state(
            Some(&app),
            "waiting",
            "等待 web 服务就绪…(首次启动可能需要十几秒)",
        );

        let (tx, rx) = mpsc::channel::<(String, String)>();
        if let Some(stdout) = child.stdout.take() {
            pipe_lines(stdout, "out", tx.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            pipe_lines(stderr, "err", tx.clone());
        }
        drop(tx);

        let started = Instant::now();
        let timeout = Duration::from_secs(self.settings.startup_timeout_sec.max(10));
        let url_re = Regex::new(r"dsh web:\s+(https?://\S+)").expect("valid dsh URL regex");
        let fallback_re =
            Regex::new(r"https?://127\.0\.0\.1:\d+").expect("valid loopback URL regex");
        let mut ready = false;

        loop {
            if !self.is_current(generation) {
                let _ = child.wait();
                return;
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok((source, line)) => {
                    let decorated = format!("[{source}] {line}");
                    self.push_log(Some(&app), decorated);
                    if !ready {
                        let url = url_re
                            .captures(&line)
                            .and_then(|items| items.get(1))
                            .map(|item| item.as_str().to_owned())
                            .or_else(|| {
                                fallback_re.find(&line).map(|item| item.as_str().to_owned())
                            });
                        if let Some(url) = url {
                            ready = true;
                            {
                                let mut data = self.data.lock().expect("dsh runtime lock poisoned");
                                data.url = Some(url.clone());
                            }
                            self.set_state(Some(&app), "ready", &format!("dsh 已就绪: {url}"));
                            self.logger.line(format!("[dsh] 就绪: {url}"));
                            handle_dsh_ready(&app, &url);
                            if std::env::var_os("DSH_WINDOW_SMOKE").is_some() {
                                println!("DSH_WINDOW_SMOKE_READY {url}");
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    self.child_pid
                        .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .ok();
                    if !self.is_current(generation) {
                        return;
                    }
                    let code = status
                        .code()
                        .map_or_else(|| "signal".into(), |value| value.to_string());
                    if ready {
                        let message = format!("dsh 进程已退出(code={code})");
                        self.set_state(Some(&app), "crashed", &message);
                        handle_dsh_crashed(&app, &message);
                    } else {
                        self.fail(&app, &format!("dsh 进程在 web 服务就绪前退出(code={code})"));
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.fail(&app, &format!("无法读取 dsh 进程状态: {error}"));
                    return;
                }
            }

            if !ready && started.elapsed() >= timeout {
                kill_process_tree(pid);
                let _ = child.wait();
                self.child_pid.store(0, Ordering::SeqCst);
                self.fail(&app, &format!("等待 dsh 就绪超时({}s)", timeout.as_secs()));
                return;
            }
        }
    }

    fn dsh_args(&self) -> Vec<String> {
        let mut args = self.settings.dsh_args.clone();
        if !args.iter().any(|arg| arg == "web") {
            args.insert(0, "web".into());
        }
        if !args
            .iter()
            .any(|arg| arg == "--host" || arg.starts_with("--host="))
        {
            args.extend(["--host".into(), "127.0.0.1".into()]);
        }
        if !args
            .iter()
            .any(|arg| arg == "--port" || arg.starts_with("--port="))
        {
            args.extend(["--port".into(), "0".into()]);
        }
        args
    }

    fn resolve(&self) -> Result<LaunchSpec, String> {
        let configured = std::env::var("DSH_WINDOW_DSH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| self.settings.dsh_command.clone());
        let mut candidates = Vec::new();
        if let Some(command) = configured {
            candidates.push(PathBuf::from(command));
        } else {
            candidates.extend(find_on_path("dsh"));
            candidates.extend(scan_npx_cache());
            for entry in self.bundled_entries() {
                candidates.push(entry);
            }
        }
        for candidate in candidates {
            if let Some(spec) = self.resolve_candidate(&candidate) {
                return Ok(spec);
            }
        }
        if let Some(npx) = find_on_path("npx").into_iter().next() {
            return Ok(LaunchSpec {
                kind: LaunchKind::Npx,
                label: format!("npx 兜底 ({})", npx.display()),
                entry: npx,
                node: None,
            });
        }
        Err(
            "找不到可用的 dsh 命令。请安装依赖，或通过 settings.json / DSH_WINDOW_DSH 指定 dsh。"
                .into(),
        )
    }

    fn bundled_entries(&self) -> Vec<PathBuf> {
        let relative = Path::new("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        [self.resource_dir.join(&relative), PathBuf::from(&relative)]
            .into_iter()
            .filter(|path| path.is_file())
            .collect()
    }

    fn resolve_candidate(&self, candidate: &Path) -> Option<LaunchSpec> {
        if candidate.is_dir() {
            let entry = package_bin(candidate)?;
            return self.node_spec(entry, format!("包目录 {}", candidate.display()));
        }
        let extension = candidate
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "js" | "cjs" | "mjs" if candidate.is_file() => self.node_spec(
                candidate.to_owned(),
                format!("入口脚本 {}", candidate.display()),
            ),
            "cmd" | "bat" if candidate.is_file() => extract_js_target(candidate)
                .and_then(|entry| self.node_spec(entry, format!("shim {}", candidate.display())))
                .or_else(|| {
                    Some(LaunchSpec {
                        kind: LaunchKind::Cmd,
                        entry: candidate.to_owned(),
                        node: None,
                        label: format!("shim {}", candidate.display()),
                    })
                }),
            "ps1" if candidate.is_file() => Some(LaunchSpec {
                kind: LaunchKind::PowerShell,
                entry: candidate.to_owned(),
                node: None,
                label: format!("shim {}", candidate.display()),
            }),
            "exe" | "com" if candidate.is_file() => Some(LaunchSpec {
                kind: LaunchKind::Direct,
                entry: candidate.to_owned(),
                node: None,
                label: candidate.display().to_string(),
            }),
            _ => {
                let name = candidate.to_string_lossy();
                find_on_path(&name)
                    .into_iter()
                    .find_map(|path| self.resolve_candidate(&path))
            }
        }
    }

    fn node_spec(&self, entry: PathBuf, label: String) -> Option<LaunchSpec> {
        let node = std::env::var("DSH_WINDOW_NODE")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| find_on_path("node").into_iter().next())
            .or_else(|| {
                let bundled = self.resource_dir.join("bin").join("node.exe");
                bundled.is_file().then_some(bundled)
            })?;
        Some(LaunchSpec {
            kind: LaunchKind::Node,
            entry,
            node: Some(node),
            label,
        })
    }

    fn set_state(&self, app: Option<&AppHandle>, phase: &str, message: &str) {
        {
            let mut data = self.data.lock().expect("dsh runtime lock poisoned");
            data.phase = phase.into();
            data.message = message.into();
        }
        self.logger.line(format!("[dsh] {phase}: {message}"));
        if let Some(app) = app {
            let payload = serde_json::json!({"kind":"state", "phase":phase, "message":message});
            let _ = app.emit_to("splash", "dsh:status", payload.clone());
            let _ = app.emit_to("main", "dsh:status", payload);
        }
    }

    fn push_log(&self, app: Option<&AppHandle>, line: String) {
        {
            let mut data = self.data.lock().expect("dsh runtime lock poisoned");
            data.logs.push_back(line.clone());
            while data.logs.len() > MAX_LOG_LINES {
                data.logs.pop_front();
            }
        }
        self.logger.line(&line);
        if let Some(app) = app {
            let payload = serde_json::json!({"kind":"log", "line":line});
            let _ = app.emit_to("splash", "dsh:status", payload.clone());
            let _ = app.emit_to("main", "dsh:status", payload);
        }
    }

    fn fail(&self, app: &AppHandle, message: &str) {
        self.set_state(Some(app), "error", message);
        if std::env::var_os("DSH_WINDOW_SMOKE").is_some() {
            println!("DSH_WINDOW_SMOKE_ERROR {message}");
        }
    }
}

fn package_bin(directory: &Path) -> Option<PathBuf> {
    let manifest = fs::read_to_string(directory.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let relative = value.get("bin").and_then(|bin| {
        bin.as_str()
            .or_else(|| bin.get("dsh").and_then(|item| item.as_str()))
    })?;
    let preferred = directory.join("lib").join("bin.js");
    if preferred.is_file() {
        Some(preferred)
    } else {
        let entry = directory.join(relative);
        entry.is_file().then_some(entry)
    }
}

fn extract_js_target(shim: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(shim).ok()?;
    let regex = Regex::new(r#"[\"']([^\"'\r\n]+\.js)[\"']"#).ok()?;
    let directory = shim.parent()?;
    for captures in regex.captures_iter(&text) {
        let raw = captures.get(1)?.as_str();
        let raw = raw
            .replace("%~dp0", "")
            .replace("%dp0%", "")
            .trim_start_matches(['\\', '/'])
            .to_owned();
        let path = directory.join(raw);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn find_on_path(name: &str) -> Vec<PathBuf> {
    let tool = if cfg!(windows) { "where.exe" } else { "which" };
    let Ok(output) = hidden_command(tool).arg(name).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file() || path.is_dir())
        .collect()
}

fn scan_npx_cache() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Vec::new();
    };
    let base = local.join("npm-cache").join("_npx");
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let package = entry
            .path()
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        if package.is_dir() {
            found.push(package);
        }
    }
    found
}

fn spawn_spec(spec: &LaunchSpec, args: &[String]) -> std::io::Result<Child> {
    let mut command = match spec.kind {
        LaunchKind::Node => {
            let mut command =
                hidden_command(spec.node.as_ref().expect("node launch requires node"));
            command.arg(&spec.entry);
            command
        }
        LaunchKind::Direct => hidden_command(&spec.entry),
        LaunchKind::PowerShell => {
            let mut command = hidden_command("powershell.exe");
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
            command.arg(&spec.entry);
            command
        }
        LaunchKind::Cmd => {
            let mut command =
                hidden_command(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
            command.args(["/d", "/s", "/c"]);
            command.arg(&spec.entry);
            command
        }
        LaunchKind::Npx => {
            let extension = spec
                .entry
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat") {
                let mut command =
                    hidden_command(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
                command.args(["/d", "/s", "/c"]);
                command.arg(&spec.entry);
                command.args(["--yes", "@deepseek-ai/dsh"]);
                command
            } else {
                let mut command = hidden_command(&spec.entry);
                command.args(["--yes", "@deepseek-ai/dsh"]);
                command
            }
        }
    };
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn pipe_lines(
    reader: impl std::io::Read + Send + 'static,
    source: &str,
    tx: mpsc::Sender<(String, String)>,
) {
    let source = source.to_owned();
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = tx.send((source.clone(), line));
        }
    });
}

fn kill_process_tree(pid: u32) {
    if cfg!(windows) {
        let _ = hidden_command("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = hidden_command("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn spawn_guard(dsh_pid: u32, logger: &Logger) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    match hidden_command(executable)
        .args([
            "--dsh-guard",
            &std::process::id().to_string(),
            &dsh_pid.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => logger.line(format!("[guard] 已启动，监视 dsh pid={dsh_pid}")),
        Err(error) => logger.line(format!("[guard] 启动失败: {error}")),
    }
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_web_host_and_random_port() {
        let runtime = DshRuntime::new(
            Settings::default(),
            Logger::new(std::env::temp_dir().join("dsh-window-test.log")),
            PathBuf::new(),
        );
        assert_eq!(
            runtime.dsh_args(),
            vec!["web", "--host", "127.0.0.1", "--port", "0"]
        );
    }

    #[test]
    fn preserves_explicit_host_and_port() {
        let mut settings = Settings::default();
        settings.dsh_args = vec![
            "web".into(),
            "--host=localhost".into(),
            "--port".into(),
            "3080".into(),
        ];
        let runtime = DshRuntime::new(
            settings,
            Logger::new(std::env::temp_dir().join("dsh-window-test.log")),
            PathBuf::new(),
        );
        assert_eq!(
            runtime.dsh_args(),
            vec!["web", "--host=localhost", "--port", "3080"]
        );
    }
}
