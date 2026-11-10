# Local fork build and install

This workflow builds the checked out Rust engine and source first provider
skills, then installs user level Codex and Claude copies from this checkout.
The managed engine is compiled from this checkout; existing provider hook
manifests are preserved. Bootstrap dependencies are downloaded from their
registries, including optional published packages, but managed launchers select
only the locally compiled engine.

## First build on a clean clone

The repository-local Bun binary and `node_modules` are ignored build inputs;
a clean clone does not contain them. Use Node.js 22.18.0 or newer and npm to
bootstrap the pinned Bun version, then install the locked dependencies:

```sh
npm install --prefix build/tooling --no-audit --no-fund --ignore-scripts bun@1.4.4
npm rebuild --prefix build/tooling bun
build/tooling/node_modules/.bin/bun install --frozen-lockfile --ignore-scripts
```

The build selects `build/tooling/node_modules/.bin/bun` explicitly and gives a
bootstrap-specific error if it is missing. It runs the source-first build,
then compiles with `cargo build --locked --release -p impeccable --target-dir
<repo>/target`. The stage copies that explicit artifact, so an ambient
`CARGO_TARGET_DIR` cannot make it pick up a stale binary. `build/fork/` records
`provenance.json` with the source path, build time and SHA-256; the installer
verifies the digest and records the same provenance beside the installed engine
and in its ownership manifest.

## Build and install

From the repository root:

```sh
node scripts/fork/build.mjs
node scripts/fork/install.mjs
```

The engine installs to `~/.local/share/impeccable-fork/engine`, with a wrapper
at `~/.local/bin/impeccable-fork`. Installed skills live at
`~/.agents/skills/impeccable` and `~/.claude/skills/impeccable`. Their generated
launchers set an absolute `IMPECCABLE_SKILL_DIR`, their own absolute
`IMPECCABLE_SELF`, and `IMPECCABLE_PROVIDER_ID` (`codex` or `claude-code`)
before invoking the wrapper. This preserves each provider's
command syntax and skill references. The wrapper defaults `IMPECCABLE_SELF` to
itself for standalone use, and can find references in an installed Codex or
Claude skill copy.

A managed `~/.impeccable/bin/impeccable` compatibility launcher points existing
source-checkout launchers that probe that path at the fork wrapper. The
installer backs up and tracks this path in the same transaction as the global
skills. This bridge covers launchers using that probe; bundled sibling engines
and explicit binary overrides may still take precedence. It does not migrate
every arbitrary project installation.

`node scripts/fork/install.mjs --home /isolated/home --stage build/fork` is for
isolated tests. A real-home install accepts only a canonical stage under this
repository's `build/fork`; staged engine, wrapper and skill symlinks are
rejected. `--dry-run` validates the stage and destination preflight without
writing. The installer refuses symlinked destination parents and corrupt or
unknown ownership manifests.

## Upgrades and rollback

Before replacing any managed destination, each install snapshots its current
contents for transaction rollback. If any step fails, that transaction snapshot
restores the immediately previous working install. The original files found on
first install remain in their own backup set and are never overwritten. On an
upgrade, any managed destination whose content hash differs from the manifest
is also preserved under that backup set's `modified/` directory before it is
replaced. The manifest records those paths and hashes.

To roll back manually, first remove all fork-managed destinations listed in
`ownership.json` (the wrapper, engine, engine provenance, Codex skill, Claude skill and
`~/.impeccable/bin/impeccable`). Then restore the paths listed in `backedUp`
from `~/.local/share/impeccable-fork/backups/<backupSet>/`, and remove
`~/.local/share/impeccable-fork/ownership.json`. Keep
`~/.impeccable/config.json`; it is not managed by this installer. User-modified
managed content is saved under the same backup set's `modified/` directory.

## Runtime policy

The wrapper always selects the installed local engine and sets `IMPECCABLE_BIN`
to that path. It disables reporting, update checks, remote catalog access, and
Pro dispatch by default. For a one-process telemetry opt-in, set
`IMPECCABLE_NO_TELEMETRY=0`; user and project config denials still apply. It
blocks top-level `install`, `update`, `check`, and `link` aliases, plus
`skills install|update|check|link` and the upstream `loop install|update`
download/update commands, even when `--force` or help appears before the
verb. Safe help and provider commands such as `design install` remain
available. Rebuild locally with the commands above.

The catalog switch controls Impeccable product catalog requests. It does not
disable provider image generation: configured provider keys and
`OPENAI_BASE_URL` remain available to that feature. The fork does not block
arbitrary network access by an AI agent or a website that the agent visits.
Reporting controls govern Impeccable's own reporting; provider uploads and
image requests are separate.

## Verification

Run the full default suite with the built engine, plus the installer and native
privacy regressions included in that suite:

```sh
PATH="$PWD/build/tooling/node_modules/.bin:$PATH" IMPECCABLE_BIN="$PWD/target/release/impeccable" bun run test
```

The installed CLI command is `~/.local/bin/impeccable-fork`. Restart Codex and
Claude sessions to discover the installed skill. Use `$impeccable` in Codex and
`/impeccable` in Claude. [FORK-SECURITY.md](FORK-SECURITY.md) records the review,
validated engine identity, completed checks and remaining trust boundaries.
