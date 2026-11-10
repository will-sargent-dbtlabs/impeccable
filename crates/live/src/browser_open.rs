//! Open a URL in the user's browser: the generate lane's one-shot start
//! (`live-generate --open`) hands the page to the browser itself instead of
//! spending an agent turn on it.
//!
//! Preference order (the one issue #611 settled on): `IMPECCABLE_BROWSER`,
//! then `browser` in `.impeccable/config.local.json` or
//! `.impeccable/config.json` at the app root, then `BROWSER`, then the
//! platform's default opener. Environment variables may select executable
//! paths; repository preferences must be names from a fixed browser allowlist.

use crate::util::Env;
use serde_json::Value;
use std::path::Path;
use std::process::{Command, Stdio};

/// The browser the user chose for impeccable itself: `IMPECCABLE_BROWSER`,
/// else `browser` in `.impeccable/config.local.json` / `config.json`. This
/// is the one preference that may open a window beside a harness's own
/// browser, because the user asked for exactly that.
pub fn explicit_browser(cwd: &str, env: &Env) -> Option<String> {
    let nonempty = |v: Option<&String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(b) = nonempty(env.get("IMPECCABLE_BROWSER")) {
        return Some(known_browser(&b).map(str::to_string).unwrap_or(b));
    }
    for name in ["config.local.json", "config.json"] {
        let path = Path::new(cwd).join(".impeccable").join(name);
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(b) = v.get("browser").and_then(Value::as_str).and_then(known_browser) {
            return Some(b.to_string());
        }
    }
    None
}

fn known_browser(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "safari" => Some("safari"),
        "chrome" | "google chrome" | "google-chrome" => Some("chrome"),
        "chromium" => Some("chromium"),
        "firefox" | "mozilla firefox" => Some("firefox"),
        "edge" | "microsoft edge" => Some("edge"),
        "brave" | "brave browser" => Some("brave"),
        _ => None,
    }
}

/// The configured browser, if any (see the module doc for the order): the
/// explicit choice, else the generic `BROWSER` variable.
pub fn resolve_browser(cwd: &str, env: &Env) -> Option<String> {
    explicit_browser(cwd, env).or_else(|| env.get("BROWSER").and_then(|value| user_browser_value(value)))
}

fn user_browser_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() { return None; }
    if Path::new(value).is_absolute() || value.contains('/') || value.contains('\\') {
        return Some(value.to_string());
    }
    Some(known_browser(value).map(str::to_string).unwrap_or_else(|| value.to_string()))
}

/// Launch the browser on `url` without waiting for it. Returns a short
/// description of what was launched, for the verdict.
pub fn open_url(url: &str, cwd: &str, env: &Env) -> Result<String, String> {
    let preference = resolve_browser(cwd, env);
    if cfg!(windows) {
        if let Some(browser) = preference.as_deref().and_then(known_browser) {
            if windows_browser_path(browser).is_none() {
                return Err(format!("{} is not installed in a supported Windows location; set IMPECCABLE_BROWSER to its executable path", browser));
            }
        }
    }
    let mut cmd = command_for(url, preference.as_deref());
    let description = format!("{:?}", cmd).replace('"', "");
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    impeccable_common::proc::detach(&mut cmd);
    cmd.spawn().map(|_| description).map_err(|e| format!("{}: {}", e, preference.unwrap_or_else(|| "default opener".to_string())))
}

fn command_for(url: &str, preference: Option<&str>) -> Command {
    match preference {
        Some(p) if Path::new(p).is_absolute() || p.contains('/') || p.contains('\\') => {
            let mut c = Command::new(p);
            c.arg(url);
            c
        }
        Some(p) => {
            if cfg!(target_os = "macos") {
                let mut c = Command::new("open");
                c.arg("-a").arg(mac_application(p)).arg(url);
                c
            } else if cfg!(windows) {
                // Avoid cmd /c, which would reinterpret browser text as shell syntax.
                let executable = known_browser(p).and_then(windows_browser_path).unwrap_or_else(|| Path::new(p).to_path_buf());
                let mut c = Command::new(executable);
                c.arg(url);
                c
            } else {
                let mut c = Command::new(linux_executable(p).unwrap_or(p));
                c.arg(url);
                c
            }
        }
        None => {
            if cfg!(target_os = "macos") {
                let mut c = Command::new("open");
                c.arg(url);
                c
            } else if cfg!(windows) {
                let mut c = Command::new("rundll32.exe");
                c.arg("url.dll,FileProtocolHandler").arg(url);
                c
            } else {
                let mut c = Command::new("xdg-open");
                c.arg(url);
                c
            }
        }
    }
}

fn mac_application(browser: &str) -> &str {
    match browser {
        "safari" => "Safari",
        "chrome" => "Google Chrome",
        "chromium" => "Chromium",
        "firefox" => "Firefox",
        "edge" => "Microsoft Edge",
        "brave" => "Brave Browser",
        other => other,
    }
}

fn linux_executable(browser: &str) -> Option<&'static str> {
    match browser {
        "safari" => None,
        "chrome" => Some("google-chrome"),
        "chromium" => Some("chromium"),
        "firefox" => Some("firefox"),
        "edge" => Some("microsoft-edge"),
        "brave" => Some("brave-browser"),
        _ => None,
    }
}

fn windows_browser_path(browser: &str) -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    let program_files = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter().filter_map(|key| std::env::var_os(key).map(std::path::PathBuf::from)).collect::<Vec<_>>();
    let mut candidates = Vec::new();
    match browser {
        "chrome" => {
            if let Some(local) = &local { candidates.push(local.join("Google/Chrome/Application/chrome.exe")); }
            for root in &program_files { candidates.push(root.join("Google/Chrome/Application/chrome.exe")); }
        }
        "chromium" => {
            if let Some(local) = &local { candidates.push(local.join("Chromium/Application/chrome.exe")); }
            for root in &program_files { candidates.push(root.join("Chromium/Application/chrome.exe")); }
        }
        "firefox" => {
            for root in &program_files { candidates.push(root.join("Mozilla Firefox/firefox.exe")); }
        }
        "edge" => {
            if let Some(local) = &local { candidates.push(local.join("Microsoft/Edge/Application/msedge.exe")); }
            for root in &program_files { candidates.push(root.join("Microsoft/Edge/Application/msedge.exe")); }
        }
        "brave" => {
            if let Some(local) = &local { candidates.push(local.join("BraveSoftware/Brave-Browser/Application/brave.exe")); }
            for root in &program_files { candidates.push(root.join("BraveSoftware/Brave-Browser/Application/brave.exe")); }
        }
        _ => return None,
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_env_var_wins_then_the_config_then_browser() {
        let dir = std::env::temp_dir().join(format!("impeccable-browser-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".impeccable")).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        assert_eq!(resolve_browser(&cwd, &env(&[])), None);
        assert_eq!(resolve_browser(&cwd, &env(&[("BROWSER", "firefox")])), Some("firefox".into()));
        std::fs::write(dir.join(".impeccable/config.json"), r#"{"browser":"Safari"}"#).unwrap();
        assert_eq!(resolve_browser(&cwd, &env(&[("BROWSER", "firefox")])), Some("safari".into()));
        std::fs::write(dir.join(".impeccable/config.local.json"), r#"{"browser":"/tmp/my-opener"}"#).unwrap();
        assert_eq!(resolve_browser(&cwd, &env(&[])), Some("safari".into()));
        assert_eq!(resolve_browser(&cwd, &env(&[("IMPECCABLE_BROWSER", " chrome ")])), Some("chrome".into()));
        // BROWSER is a fallback for the opener, never the user's explicit choice.
        std::fs::remove_file(dir.join(".impeccable/config.local.json")).unwrap();
        std::fs::remove_file(dir.join(".impeccable/config.json")).unwrap();
        assert_eq!(explicit_browser(&cwd, &env(&[("BROWSER", "firefox")])), None);
        assert_eq!(explicit_browser(&cwd, &env(&[("IMPECCABLE_BROWSER", "chrome")])), Some("chrome".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn security_repository_browser_values_are_allowlisted_and_env_paths_remain_explicit() {
        let dir = std::env::temp_dir().join(format!("impeccable-browser-security-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".impeccable")).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join(".impeccable/config.local.json"), r#"{"browser":"/tmp/evil"}"#).unwrap();
        assert_eq!(explicit_browser(&cwd, &env(&[])), None);
        std::fs::write(dir.join(".impeccable/config.local.json"), r#"{"browser":"Google Chrome"}"#).unwrap();
        assert_eq!(explicit_browser(&cwd, &env(&[])), Some("chrome".into()));
        assert_eq!(resolve_browser(&cwd, &env(&[("IMPECCABLE_BROWSER", "/tmp/user-browser")])), Some("/tmp/user-browser".into()));
        std::fs::remove_file(dir.join(".impeccable/config.local.json")).unwrap();
        assert_eq!(resolve_browser(&cwd, &env(&[("BROWSER", "/tmp/user-browser")])), Some("/tmp/user-browser".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn security_known_browser_names_map_to_fixed_platform_executables() {
        assert_eq!(known_browser("chrome"), Some("chrome"));
        assert_eq!(known_browser("edge"), Some("edge"));
        assert_eq!(known_browser("chrome & calc"), None);
        assert_eq!(linux_executable("firefox"), Some("firefox"));
    }

    #[test]
    fn a_path_runs_with_the_url_as_its_argument() {
        let c = command_for("http://127.0.0.1:5173/", Some("/tmp/opener.sh"));
        let shown = format!("{:?}", c);
        assert!(shown.starts_with("\"/tmp/opener.sh\""), "{shown}");
        assert!(shown.contains("http://127.0.0.1:5173/"), "{shown}");
    }

    #[test]
    fn a_same_named_project_file_does_not_override_a_known_browser() {
        let file = std::env::current_dir().unwrap().join("chrome");
        let _ = std::fs::remove_file(&file);
        std::fs::write(&file, "not an executable browser").unwrap();
        let command = command_for("http://127.0.0.1:5173/", Some("chrome"));
        let shown = format!("{:?}", command);
        std::fs::remove_file(&file).unwrap();
        if cfg!(target_os = "macos") {
            assert!(shown.starts_with("\"open\" \"-a\" \"Google Chrome\""), "{shown}");
        }
    }

    #[test]
    fn unknown_user_browser_names_remain_direct_executables() {
        assert_eq!(resolve_browser(".", &env(&[("BROWSER", "wslview")])), Some("wslview".into()));
        let shown = format!("{:?}", command_for("http://127.0.0.1:5173/", Some("wslview")));
        assert!(shown.contains("wslview") && !shown.contains("cmd"), "{shown}");
    }
}
