//! Policy for the token-protected `/source` fallback used by live edit.
use std::io::Read;
use std::path::Path;

const MAX_SOURCE_BYTES: u64 = 1_048_576;

pub fn allowed_source_path(path: &str) -> bool {
    let mut normalized = path.replace('\\', "/");
    while let Some(rest) = normalized.strip_prefix("./") {
        normalized = rest.to_string();
    }
    let parts: Vec<_> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|p| *p == "." || *p == ".." || p.starts_with('.'))
    {
        // Dot segments are denied except the narrowly scoped legacy generated
        // metadata checked below.
        return generated_metadata(&parts)
            && parts
                .iter()
                .all(|p| !p.starts_with('.') || *p == ".impeccable" || *p == ".impeccable-live");
    }
    if generated_metadata(&parts) {
        return true;
    }
    let file = parts.last().unwrap().to_ascii_lowercase();
    if is_sensitive_name(&file) {
        return false;
    }
    matches!(
        Path::new(&file)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "html"
                | "htm"
                | "css"
                | "scss"
                | "sass"
                | "less"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "ts"
                | "tsx"
                | "vue"
                | "svelte"
                | "astro"
                | "md"
                | "mdx"
        )
    )
}

fn generated_metadata(parts: &[&str]) -> bool {
    let generated_id = |id: &str| !id.is_empty() && !id.starts_with('.');
    for i in 0..parts.len() {
        if parts[i] == ".impeccable"
            && parts.get(i + 1) == Some(&"live")
            && parts.get(i + 2) == Some(&"previews")
        {
            let tail = &parts[i + 3..];
            if tail.len() == 2
                && generated_id(tail[0])
                && matches!(tail[1], "manifest.json" | "params.json")
            {
                return true;
            }
            if tail.len() == 3
                && generated_id(tail[0])
                && tail[1]
                    .strip_prefix('r')
                    .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                && tail[2] == "params.json"
            {
                return true;
            }
        }
        if parts[i] == "node_modules" && parts.get(i + 1) == Some(&".impeccable-live") {
            let tail = &parts[i + 2..];
            if tail.len() == 2 && generated_id(tail[0]) && matches!(tail[1], "manifest.json" | "params.json") {
                return true;
            }
            if tail.len() == 3
                && generated_id(tail[0])
                && tail[1].strip_prefix('r').is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                && tail[2] == "params.json"
            {
                return true;
            }
        }
    }
    false
}

fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.ends_with(".crt")
        || lower.ends_with(".pub")
        || ["credential", "credentials", "secret", "secrets", "token", "private-key", "private_key", "id_rsa", "id_ed25519", "known_hosts", "config.local.json"]
            .iter().any(|stem| lower == *stem || lower.strip_prefix(stem).is_some_and(|suffix| suffix.starts_with('.')))
}

pub fn read_source(root: &Path, requested: &str) -> Result<String, u16> {
    let canonical_root = root.canonicalize().map_err(|_| 404u16)?;
    let requested_path = Path::new(requested);
    let relative_request = if requested_path.is_absolute() {
        // Accept absolute requests under either the canonical root or the
        // supplied root spelling (which may itself be a symlink).
        let supplied_root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir().map_err(|_| 404u16)?.join(root)
        };
        requested_path
            .strip_prefix(&canonical_root)
            .or_else(|_| requested_path.strip_prefix(&supplied_root))
            .map_err(|_| 403u16)?
    } else {
        requested_path
    };
    let relative_text = relative_request.to_string_lossy().replace('\\', "/");
    let normalized = relative_text.trim_start_matches("./");
    if !allowed_source_path(normalized) {
        return Err(403);
    }
    let candidate = canonical_root.join(normalized);
    let target = candidate.canonicalize().map_err(|_| 404u16)?;
    let relative = target.strip_prefix(&canonical_root).map_err(|_| 403u16)?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    if !allowed_source_path(&relative) {
        return Err(403);
    }
    let meta = std::fs::metadata(&target).map_err(|_| 404u16)?;
    if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
        return Err(403);
    }
    let file = std::fs::File::open(target).map_err(|_| 403u16)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| 403u16)?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(403);
    }
    String::from_utf8(bytes).map_err(|_| 403u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn security_reads_only_allowed_canonical_files() {
        let root =
            std::env::temp_dir().join(format!("impeccable-source-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/App.svelte"), "<h1>ok</h1>").unwrap();
        std::fs::write(root.join("secrets.json"), "secret").unwrap();
        std::fs::write(root.join(".env"), "secret").unwrap();
        std::fs::write(root.join("tokens.css"), ":root { --space: 1rem; }").unwrap();
        std::fs::write(root.join("TokenInput.tsx"), "export function TokenInput() {}").unwrap();
        std::fs::write(root.join("SecretField.vue"), "<template><input /></template>").unwrap();
        std::fs::write(root.join("CredentialsForm.jsx"), "export function CredentialsForm() {}").unwrap();
        std::fs::write(root.join("access-token.json"), "secret").unwrap();
        std::fs::write(root.join("token.css"), "secret token material").unwrap();
        std::fs::write(root.join("token.json"), "secret token material").unwrap();
        for path in [
            "node_modules/.impeccable-live/abc123/params.json",
            "node_modules/.impeccable-live/abc123/r2/params.json",
        ] {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, r#"{"controls":[]}"#).unwrap();
        }
        assert_eq!(read_source(&root, "src/App.svelte").unwrap(), "<h1>ok</h1>");
        assert_eq!(read_source(&root, "./src/App.svelte").unwrap(), "<h1>ok</h1>");
        assert_eq!(read_source(&root, "secrets.json"), Err(403));
        assert_eq!(read_source(&root, ".env"), Err(403));
        assert_eq!(read_source(&root, "access-token.json"), Err(403));
        assert_eq!(read_source(&root, "token.json"), Err(403));
        assert_eq!(read_source(&root, "token.css"), Err(403));
        for path in ["tokens.css", "TokenInput.tsx", "SecretField.vue", "CredentialsForm.jsx"] {
            assert!(read_source(&root, path).is_ok(), "ordinary UI source should be readable: {path}");
        }
        for path in [
            "node_modules/.impeccable-live/abc123/manifest.json",
            "node_modules/.impeccable-live/abc123/params.json",
            "node_modules/.impeccable-live/abc123/r2/params.json",
            "apps/web/node_modules/.impeccable-live/abc123/r0/params.json",
            ".impeccable/live/previews/abc123/params.json",
        ] { assert!(allowed_source_path(path), "{path}"); }
        for path in [
            "node_modules/.impeccable-live/.hidden/params.json",
            "node_modules/.impeccable-live/abc123/r../params.json",
            "node_modules/.impeccable-live/abc123/r2/../params.json",
        ] { assert!(!allowed_source_path(path), "{path}"); }
        assert_eq!(read_source(&root, "node_modules/.impeccable-live/abc123/params.json").unwrap(), r#"{"controls":[]}"#);
        assert_eq!(read_source(&root, "node_modules/.impeccable-live/abc123/r2/params.json").unwrap(), r#"{"controls":[]}"#);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("secrets.json"), root.join("src/leak.ts"))
                .unwrap();
            assert_eq!(read_source(&root, "src/leak.ts"), Err(403));
            let outside = root.with_extension("outside");
            std::fs::write(&outside, "outside").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("src/escape.ts")).unwrap();
            assert_eq!(read_source(&root, "src/escape.ts"), Err(403));
            let _ = std::fs::remove_file(outside);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_requests_normalize_safe_aliases_but_reject_hidden_and_traversal_paths() {
        let base = std::env::temp_dir().join(format!("impeccable-source-dot-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join(".worktrees/project");
        std::fs::create_dir_all(root.join("src/.private")).unwrap();
        std::fs::write(root.join("src/App.jsx"), "visible source").unwrap();
        std::fs::write(root.join("src/.private/Hidden.jsx"), "hidden source").unwrap();
        std::fs::write(root.join("secrets.json"), "secret").unwrap();

        assert_eq!(read_source(&root, "./src/App.jsx").unwrap(), "visible source");
        assert_eq!(read_source(&root, root.join("src/App.jsx").to_str().unwrap()).unwrap(), "visible source");
        #[cfg(unix)]
        {
            let root_alias = base.join("project-link");
            std::os::unix::fs::symlink(&root, &root_alias).unwrap();
            assert_eq!(
                read_source(&root_alias, root_alias.join("src/App.jsx").to_str().unwrap()).unwrap(),
                "visible source"
            );
        }
        for path in ["src/../src/App.jsx", "./src/.private/Hidden.jsx", "src/.private/Hidden.jsx"] {
            assert_eq!(read_source(&root, path), Err(403), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("secrets.json"), root.join("src/secret-alias.jsx")).unwrap();
            assert_eq!(read_source(&root, "src/secret-alias.jsx"), Err(403));
        }
        let outside = base.join("outside.jsx");
        std::fs::write(&outside, "outside").unwrap();
        assert_eq!(read_source(&root, outside.to_str().unwrap()), Err(403));
        let _ = std::fs::remove_dir_all(base);
    }
}
