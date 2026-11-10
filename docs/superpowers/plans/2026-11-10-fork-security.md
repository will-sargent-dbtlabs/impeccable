# Impeccable fork security implementation plan

> Agentic workers: execute through Ringer. The user approved the preceding security review and requested the fixes, a build and working local provider/tooling integration. Do not create upstream issues/PRs, publish releases or bump manifest versions.

**Coordination:** Hub #175 is claimed by alfred; work stays in local Ringer workers, with no delegation to other hub team members. Fork remote: will-sargent-dbtlabs/impeccable; upstream retained separately.

**Goal:** Build and run our fork with reporting opt-in, hardened local services, patched dependencies and reproducible Codex/Claude/Ringer integration.

**Architecture:** Retain the existing Rust engine and generated provider builds. Centralize consent in the existing telemetry policy; use a fork-local deployment wrapper with a fixed local binary and product-network safeguards. Keep provider image generation separate from reporting.

**Tech stack:** Rust workspace, Bun/Node build, local Codex and Claude providers, Ringer verified workers.

**Spec:** The user's accepted review, /private/tmp/impeccable-security-review-20261110/review.md. Decisions below are implementation choices made to satisfy that approved scope.

## Global constraints

- User-level explicit consent only; environment/project denials always win. Missing, invalid and unreadable consent is off.
- Health sync additionally requires its own opt-in. No user/global config may be overwritten wholesale.
- Locally built engine, no silent upstream replacement. Persistent executables must originate in this repository, never temporary directories.
- Separate worker file ownership; shared target directory to avoid redundant multi-GB worktrees. No generated provider edits by hand.
- Preserve provider image-generation capabilities; product-network restrictions must be documented precisely.

## Review focus

- Corrupt consent and GUI agents lacking terminal environment: fresh installation must remain private.
- Browser config from untrusted repositories: data must not become an executable path.
- Source-route dotfiles, secret JSON, symlink escapes and forged paths: no project-secret disclosure.
- Rebuild/install drift: local provider skills must keep selecting the local engine after a build.
- Existing tests assumed reporting on: update deliberate opt-in test setup, never weaken request-count assertions or overwrite oracle vectors.

## Tasks

### 1. Consent policy and reporting gates

Files: crates/context/src/{telemetry,concept_seed,serve_question,context_cli}.rs; crates/account/src/health.rs; matching existing crate tests.
- [x] Add regressions that fail under the current default-on and malformed-config behavior; retain red-test evidence.
- [x] Require telemetry:true in the user config, keep all denials overriding, make on save true, and add a last-mile send guard.
- [x] Default health sync off; require both consents and update relevant tests' explicit opt-in setup.
- [x] Honor telemetry-off for automatic version checks; make product catalog opt-out distinct and explicit through a no-remote-catalog environment switch so local installs can avoid catalog API/images without breaking provider image generation. Avoid instructions to override that switch on network failure.
- [x] Run focused tests, save report and test evidence for orchestration review.

### 2. Local browser/service hardening

Files: crates/live/src/{browser_open,live_server}.rs and matching tests; crates/browser/src/lib.rs.
- [x] Add failing tests for repository-selected executable paths, sensitive source-file access, symlinks and CI sandbox behavior.
- [x] Allow repository browser preferences only as recognized browser names; executable overrides remain user environment only. Avoid Windows shell interpretation of untrusted text.
- [x] Restrict /source to required implementation files and narrowly justified metadata; deny dotfiles, secret/credential names and unrelated files after canonicalization. Serve plain text with nosniff/no-store and a bounded response.
- [x] Keep Chrome sandbox enabled under CI unless explicitly opted out.
- [x] Run targeted tests and document intentional compatibility changes.

### 3. Dependencies and local build toolchain

Files: Cargo.lock, bun.lock, Cargo.toml, crates/context/Cargo.toml, package.json only as necessary for dependency floors/constraints. No manifest-version bumps.
- [x] Ensure repository-local Bun tooling is available (build/tooling) and record its version.
- [x] Raise runtime TLS floors rustls-webpki >=0.103.16 and webpki-roots >=1.0.10 and resolve locks.
- [x] Refresh public npm development dependencies to clear advisory matches where compatible; document any unresolved match rather than blindly forcing incompatible overrides.
- [x] Verify dependency graph and OSV matches, report any residual reachability question honestly.

### 4. Fork build/install and provider tooling integration

Files: scripts/fork/*, tests/fork*.test.mjs, docs/FORK.md, README.md and runtime/privacy docs as needed.
- [x] Add reproducible local build/install scripts with a stable repository-owned engine and generated skill staging; no upstream engine download or global hook mutations.
- [x] Install local user-level Codex/Claude skills with backups for existing files and an idempotent manifest. Point provider launchers to a fixed local wrapper so GUI agents do not require ambient IMPECCABLE_BIN.
- [x] Wrapper selects the reviewed local engine, disables reporting/version checks and catalog API by default, supports approved provider image generation and rejects silent upstream updates.
- [x] Add installation and runtime smoke coverage in isolated homes, including privacy status and engine provenance.
- [x] Document exact commands, opt-in semantics, network boundaries, upgrades and rollback.

### 5. Integration and independent review

- [x] Run affected Rust tests and changed-crate suite; rebuild release engine; run Bun/Node suite and distribution build. Review intentional oracle deltas by hand, never regenerate frozen call vectors.
- [x] Run a fresh independent Opus 5.5 adversarial review through Ringer; fix confirmed findings and reverify.
- [x] Install from repository-owned artifacts with privacy off; prove local Codex/Claude launcher behavior and a Ringer model task invoking the local engine.
- [x] Record final validation, residual limitations and how to run it. Keep generated harness churn out of source commits unless required for the local build-system change.

## Validation progress

- Full Rust workspace: 2,687 passed, 0 failed (717 seconds); the subsequent Loop fixture and source normalization regressions passed focused checks.
- Final native release build and eight privacy/network runtime tests pass. Installer and wrapper checks include rollback, provenance, full update/Loop aliases, provider identity and real-home stage refusal.
- Two catalog-guidance goldens were decoded and reviewed; only the escalation paragraph changed. Vite text-oracle port-status wording is case-scoped because the local gateway owns fixture port 8080. The complete oracle replay now passes.
- The default suite exposed seven failures in the fetch-based fake SSE client. A full-file A/B retained the original POST helper and assertions, replaced SSE teardown with direct socket destruction, and passed 40/40 tests. The final complete default suite passed. The actual user-home install and local Ringer smoke passed seven launchers, both provider contexts, detector findings and update gates.

- Final independent smoke, wrapper policy and fresh OSV425 scan all passed. Actual installed engine hash equals both repository release and stage. See docs/FORK-SECURITY.md for the result table and limits. No manifest versions, frozen call vectors, tracked bundles or generated harness output were changed.
