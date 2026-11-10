# Fork security review and disposition

AI-assisted review and implementation, 2026-11-10. This review covers the personal fork of Impeccable at upstream baseline `ebe9c265f416f7f9b83ed424ed5b9bd0d2684536`. It is a source and local-runtime review, not a penetration test of the hosted service. Local Ringer workers performed the implementation; Claude Opus 5.5 performed a separate adversarial source review. No work was delegated to other hub members.

## Findings addressed

| Concern | Fork behavior |
| --- | --- |
| Reporting defaulted on | Requires explicit user `telemetry: true`; missing, malformed or unreadable consent denies reporting. Environment and project denials win. The sender checks consent immediately before connecting. |
| Signed-in design-health uploads defaulted on | Health sync defaults off and additionally requires telemetry consent. Signing in alone does not authorize uploads. |
| Automatic version and catalog traffic | Automatic version checks honor consent. The installed wrapper disables update checks, product catalog requests and Pro dispatch. Catalog control is separate from provider image generation. |
| Vulnerable public dependencies | Rust TLS certificate validation resolves to `rustls-webpki 0.103.16` and `webpki-roots 1.0.11`. Locked npm development dependencies were updated; narrowly scoped Hono and Minimatch overrides have compatibility coverage. |
| Live-page source access | The token-protected fallback allows bounded implementation text and specific generated preview metadata. Hidden paths, secret files, outside-root symlinks and secret-target aliases are denied. Both requested and canonical paths are checked. |
| Repository-selected browser program | Committed config selects only recognized browser names. Executable overrides require a user-controlled environment setting. Windows construction avoids `cmd /c` shell interpretation. |
| Weak picker tokens and CI browser sandbox | Automatically generated question keys use 128-bit OS randomness. CI no longer implicitly disables Chromium sandboxing. |
| Silent upstream engine replacement | Source build stages the local release engine. Installed provider launchers preserve their own identity and use a fixed policy wrapper. Upstream installation/update aliases, including Loop, are blocked by that wrapper. |
| Failed install upgrade | Every transaction snapshots existing managed paths. Failure restores the immediately previous install. Original files and later user modifications have separate backups; invalid ownership manifests are refused. |

## Data and trust boundaries

The live token is available to the inspected development page. The page therefore remains a participant in the live-edit trust boundary; the source allowlist reduces what it can request but does not make an arbitrary hostile development page safe. Secrets embedded in ordinary allowed source code remain readable. File canonicalization does not eliminate same-user file replacement races or hard links.

If both reporting and health sync are enabled later, health uploads include a
remote-derived repository label, stable repository/stream identifiers, scan
timestamps, engine/ruleset versions, rule counts and finding fingerprints. The
fingerprints hash the rule, relative path and normalized snippet without a
secret salt. They are not raw source, but predictable inputs may be guessable;
that is an inference from the hash construction. The default-off fork avoids
these uploads.

The fork's reporting settings do not prevent an AI provider from receiving prompts, images or source deliberately sent to it. Provider image-generation requests remain available. Nor do these settings block arbitrary network use by an agent or inspected website. The browser extension, with its broad host permissions, is not installed by this workflow.

The compatibility bridge covers source launchers that probe `~/.impeccable/bin/impeccable`. A bundled sibling engine or explicit binary override can take precedence. The standalone managed command is `~/.local/bin/impeccable-fork`; use it to select the reviewed runtime explicitly.

macOS is the deployed and tested platform. Windows browser command construction was inspected in the source; Windows execution has not been verified.

## Test isolation on macOS

The upstream Loop update test executed a copied `/bin/sleep` inside a temporary `Impeccable Loop.app`, a likely cause of a damaged-app dialog observed during the full Rust run. The fork uses inert fixture bytes and supplies a process listing to the same canonical-path refusal check. Update refusal and crash-backup recovery remain covered without launching a dummy app. No Gatekeeper setting or quarantine attribute was changed. The fork installer does not install Loop.

The live protocol tests also use a direct HTTP stream for their fake overlay,
so closing a test tab destroys its socket. On Node 26, the original fetch-based
helper produced seven shared-sequence failures near four seconds; changing
only that SSE helper passed all 40 cases without changing timing or state
assertions. The exact fetch/socket-lifecycle mechanism remains an inference.
Claim assertions wait for server events before issuing claims.

## Reproduction and maintenance

See [FORK.md](FORK.md) for pinned toolchain bootstrap, build, install, upgrade and rollback. Keep generated tracked provider output and engine versions out of ordinary feature changes. Rebuild the checkout and reinstall after updating source. A clean advisory scan is evidence about known public advisories at the scan time, not a guarantee that every dependency is safe.

## Verified installation (2026-11-10)

| Check | Result |
| --- | --- |
| Full Rust workspace | 2,687 passed, zero failures; later Loop and source-path regressions also passed focused runs. |
| Source distribution and release engine | Passed; generated tracked provider output was left unchanged. |
| Full default Bun/Node suite | Passed: core, oracle, detector, live, framework fixtures and real Claude plugin loader. |
| Native privacy/network regressions | Eight passed; independent localhost request-count smoke also passed. |
| Locked public dependency versions | Fresh OSV query: 425 versions, zero advisory matches. |
| Actual user-home installation | Seven entrypoints passed native identity, telemetry-off and health-off checks. |
| Local Ringer integration | Worker invoked the installed engine; both provider context calls and the five-finding detector fixture passed. Upstream replacement aliases were blocked. |

The built, staged and installed engine share SHA-256
`8a5338ab5de82caf292596bda796b971b85fc0251208af34fc9bc304c3df7fd0`.
Installed provenance and managed-path ownership are under
`~/.local/share/impeccable-fork/`. No global provider hook configuration was
replaced, and no Loop app or extension was installed.

The TLS floors address [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)
and [RUSTSEC-2026-0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html).
The scan covers advisory records for locked public packages, not a proof of
absence of vulnerabilities in source or opaque published binaries.
