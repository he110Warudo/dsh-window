use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub dsh_command: Option<String>,
    pub dsh_args: Vec<String>,
    pub startup_timeout_sec: u64,
    pub open_dev_tools: bool,
    pub close_to_tray: bool,
    pub window_bounds: Option<WindowBounds>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            dsh_command: None,
            dsh_args: Vec::new(),
            startup_timeout_sec: 90,
            open_dev_tools: false,
            close_to_tray: true,
            window_bounds: None,
        }
    }
}

pub fn load(path: &PathBuf) -> Settings {
    let Ok(text) = fs::read_to_string(path) else {
        return Settings::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Settings::default();
    };
    let defaults = Settings::default();
    Settings {
        dsh_command: value
            .get("dshCommand")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
        dsh_args: value
            .get("dshArgs")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        startup_timeout_sec: value
            .get("startupTimeoutSec")
            .and_then(|v| v.as_u64())
            .unwrap_or(defaults.startup_timeout_sec),
        open_dev_tools: value
            .get("openDevTools")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.open_dev_tools),
        close_to_tray: value
            .get("closeToTray")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.close_to_tray),
        window_bounds: value
            .get("windowBounds")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok()),
    }
}

pub fn save(path: &PathBuf, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

pub fn dsh_settings_path() -> PathBuf {
    let home = std::env::var("DSH_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".dsh")))
        .unwrap_or_else(|| PathBuf::from(".dsh"));
    home.join("settings.yaml")
}

pub fn theme_preference() -> &'static str {
    let Ok(text) = fs::read_to_string(dsh_settings_path()) else {
        return "system";
    };
    let section = Regex::new(
        r#"(?ms)(?:^|\n)[ \t]*["']?ui-theme["']?\s*:\s*([^\n]*)(?:\n((?:[ \t]+.*\n?)*))?"#,
    )
    .expect("valid theme section regex");
    let preference = Regex::new(r#"["']?preference["']?\s*:\s*["']?(light|dark|system)["']?"#)
        .expect("valid theme preference regex");
    let Some(captures) = section.captures(&text) else {
        return "system";
    };
    let haystack = format!(
        "{}\n{}",
        captures.get(1).map_or("", |item| item.as_str()),
        captures.get(2).map_or("", |item| item.as_str())
    );
    match preference
        .captures(&haystack)
        .and_then(|items| items.get(1))
        .map(|item| item.as_str())
    {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_existing_electron_settings() {
        let settings = Settings::default();
        assert_eq!(settings.startup_timeout_sec, 90);
        assert!(settings.close_to_tray);
        assert!(settings.dsh_args.is_empty());
    }
}
