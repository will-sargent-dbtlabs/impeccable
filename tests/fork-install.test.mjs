import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { Minimatch } from 'minimatch';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts/fork/install.mjs');
const { replaceLauncher } = await import('../scripts/fork/launcher.mjs');
const { assertNoWorldWritableStage } = await import('../scripts/fork/install.mjs');
const temporary = [];
const require = createRequire(import.meta.url);

function packageVersion(name) {
  const entry = require.resolve(name);
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (data.name === name) return data.version;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate package manifest for ${name}`);
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-fork-'));
  temporary.push(base);
  const home = path.join(base, 'home');
  const stage = path.join(base, 'stage');
  const engine = path.join(stage, 'engine');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(engine, '#!/bin/sh\nprintf "engine:%s\\n" "$*"\nprintf "env:%s|%s|%s|%s|%s\\n" "$IMPECCABLE_BIN" "$IMPECCABLE_NO_TELEMETRY" "$IMPECCABLE_NO_UPDATE_CHECK" "$IMPECCABLE_NO_REMOTE_CATALOG" "$IMPECCABLE_PRO"\nprintf "identity:%s|%s\\n" "$IMPECCABLE_SELF" "$IMPECCABLE_SKILL_DIR"\nprintf "provider-base:%s\\n" "$OPENAI_BASE_URL"\nprintf "provider-id:%s\\n" "$IMPECCABLE_PROVIDER_ID"\n');
  fs.chmodSync(engine, 0o755);
  fs.copyFileSync(path.join(ROOT, 'scripts/fork/wrapper.sh'), path.join(stage, 'wrapper'));
  for (const rel of ['codex/.agents/skills/impeccable', 'claude/.claude/skills/impeccable']) {
    const skill = path.join(stage, rel);
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skill, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(skill, 'reference'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Fixture skill\n');
    fs.writeFileSync(path.join(skill, 'agents', 'nested.md'), 'nested\n');
    fs.writeFileSync(path.join(skill, 'scripts', 'impeccable'), '#!/bin/sh\n');
    const provider = rel.startsWith('codex') ? 'CODEX' : 'CLAUDE';
    replaceLauncher(skill, { skillDirPath: `__IMPECCABLE_SKILL_DIR_${provider}__`, selfPath: `__IMPECCABLE_SELF_${provider}__`, providerId: provider === 'CODEX' ? 'codex' : 'claude-code' });
  }
  const engineBytes = fs.readFileSync(engine);
  const { createHash } = require('node:crypto');
  fs.writeFileSync(path.join(stage, 'provenance.json'), JSON.stringify({ schemaVersion: 1, engineSource: 'fake-engine', sha256: createHash('sha256').update(engineBytes).digest('hex') }));
  return { base, home, stage };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe('fork installer', () => {
  test('security overrides retain the SDK HTTP adapter and archiver glob behavior', async () => {
    const honoVersion = packageVersion('@hono/node-server');
    const minimatchVersion = packageVersion('minimatch');
    assert.ok(Number(honoVersion.split('.')[0]) >= 2, `expected @hono/node-server 2.x+, got ${honoVersion}`);
    assert.ok(Number(minimatchVersion.split('.')[0]) >= 11, `expected minimatch 11.x+, got ${minimatchVersion}`);

    const app = new Hono();
    app.get('/health', (context) => context.json({ ok: true }));
    const server = await import('node:http').then(({ createServer }) => createServer(getRequestListener(app.fetch)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      server.close();
      await once(server, 'close');
    }

    const pattern = new Minimatch('src/**/*.mjs');
    assert.equal(pattern.match('src/lib/worker.mjs'), true);
    assert.equal(pattern.match('src/lib/worker.js'), false);
    assert.equal(pattern.match('test/src/lib/worker.mjs'), false);
  });

  test('imports the build entrypoint without running the staging build', async () => {
    const before = fs.existsSync(path.join(ROOT, 'build/fork'));
    await import('../scripts/fork/build.mjs');
    assert.equal(fs.existsSync(path.join(ROOT, 'build/fork')), before);
  });

  test('installs local engine and both skills; wrappers pin binary and private defaults', () => {
    const { home, stage } = fixture();
    const result = run(['--home', home, '--stage', stage]);
    assert.equal(result.status, 0, result.stderr);
    const wrapper = path.join(home, '.local/bin/impeccable-fork');
    const binary = path.join(home, '.local/share/impeccable-fork/engine');
    assert.ok(fs.readFileSync(wrapper, 'utf8').includes(binary));
    for (const rel of ['.agents/skills/impeccable', '.claude/skills/impeccable']) {
      const skill = path.join(home, rel);
      assert.equal(fs.existsSync(path.join(skill, 'agents/nested.md')), true);
      const launcher = fs.readFileSync(path.join(skill, 'scripts/impeccable'), 'utf8');
      assert.ok(launcher.includes(wrapper));
      assert.ok(!launcher.includes('upstream'));
      assert.ok(!launcher.includes('__IMPECCABLE_'));
      assert.ok(launcher.includes(`export IMPECCABLE_SELF='${skill}/scripts/impeccable'`));
      assert.ok(launcher.includes(`export IMPECCABLE_SKILL_DIR='${skill}'`));
    }
    const invoked = spawnSync(path.join(home, '.agents/skills/impeccable/scripts/impeccable'), ['engine-probe'], {
      encoding: 'utf8', env: { HOME: home, IMPECCABLE_NO_TELEMETRY: '', IMPECCABLE_NO_UPDATE_CHECK: '', IMPECCABLE_NO_REMOTE_CATALOG: '', IMPECCABLE_PRO: 'on', OPENAI_BASE_URL: 'http://provider.invalid' },
    });
    assert.equal(invoked.status, 0, JSON.stringify(invoked));
    assert.ok(invoked.stdout.includes(`env:${binary}|1|1|1|off`));
    const codex = path.join(home, '.agents/skills/impeccable');
    assert.ok(invoked.stdout.includes(`identity:${codex}/scripts/impeccable|${codex}`));
    assert.ok(invoked.stdout.includes('provider-id:codex'));
    assert.ok(!invoked.stdout.includes(`identity:${binary}|`));
    const installedManifest = JSON.parse(fs.readFileSync(path.join(home, '.local/share/impeccable-fork/ownership.json'), 'utf8'));
    assert.equal(installedManifest.engine.sha256, JSON.parse(fs.readFileSync(path.join(home, '.local/share/impeccable-fork/provenance.json'), 'utf8')).sha256);
    const claude = path.join(home, '.claude/skills/impeccable');
    const claudeRun = spawnSync(path.join(claude, 'scripts/impeccable'), ['engine-probe'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(claudeRun.status, 0, claudeRun.stderr);
    assert.ok(claudeRun.stdout.includes(`identity:${claude}/scripts/impeccable|${claude}`));
    assert.ok(claudeRun.stdout.includes('provider-id:claude-code'));
    const compat = spawnSync(path.join(home, '.impeccable/bin/impeccable'), ['engine-probe'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(compat.status, 0, compat.stderr);
    assert.ok(compat.stdout.includes(`identity:${wrapper}|${codex}`));
    assert.ok(compat.stdout.includes('provider-id:codex'));
    const claudeCompat = spawnSync(wrapper, ['engine-probe'], { encoding: 'utf8', env: { HOME: home, IMPECCABLE_SKILL_DIR: path.join(home, '.claude/skills/impeccable') } });
    assert.equal(claudeCompat.status, 0, claudeCompat.stderr);
    assert.ok(claudeCompat.stdout.includes('provider-id:claude-code'));
    assert.ok(invoked.stdout.includes('provider-base:http://provider.invalid'));
    const customProvider = spawnSync(wrapper, ['engine-probe'], { encoding: 'utf8', env: { HOME: home, IMPECCABLE_PROVIDER_ID: 'custom-provider' } });
    assert.equal(customProvider.status, 0, customProvider.stderr);
    assert.ok(customProvider.stdout.includes('provider-id:custom-provider'));
    const optedIn = spawnSync(wrapper, ['engine-probe'], { encoding: 'utf8', env: { HOME: home, IMPECCABLE_NO_TELEMETRY: '0' } });
    assert.equal(optedIn.status, 0);
    assert.ok(optedIn.stdout.includes(`env:${binary}|0|1|1|off`));
    assert.ok(optedIn.stdout.includes(`identity:${wrapper}|${path.join(home, '.agents/skills/impeccable')}`));
    assert.ok(optedIn.stdout.includes('provider-id:codex'));
    const help = spawnSync(wrapper, ['skills', '--help'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('engine:skills --help'));
    const safe = spawnSync(wrapper, ['design', 'install', 'a dashboard'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(safe.status, 0, safe.stderr);
    assert.ok(safe.stdout.includes('engine:design install a dashboard'));
    for (const args of [['update'], ['--force', 'update'], ['--force', 'skills', 'update'], ['--help', 'skills', 'install'], ['link'], ['skills', 'install'], ['skills', 'update'], ['skills', 'check'], ['skills', 'link'], ['skills', '--help', 'update'], ['loop', 'install'], ['loop', 'update']]) {
      const blocked = spawnSync(wrapper, args, { encoding: 'utf8', env: { HOME: home } });
      assert.equal(blocked.status, 2, `expected blocked alias: ${args.join(' ')}`);
      assert.match(blocked.stderr, /disabled/);
    }
    fs.rmSync(binary);
    const missing = spawnSync(wrapper, ['engine-probe'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /local engine missing/);
  });

  test('preserves preexisting configuration with a recoverable backup and is idempotent', () => {
    const { base, stage } = fixture();
    const home = path.join(base, "it's a home dir");
    const config = path.join(home, '.claude/settings.json');
    const forkConfig = path.join(home, '.impeccable/config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.mkdirSync(path.dirname(forkConfig), { recursive: true });
    fs.writeFileSync(config, '{"keep":true}\n');
    fs.writeFileSync(forkConfig, '{"userSetting":true}\n');
    const skill = path.join(home, '.agents/skills/impeccable');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'user-note.txt'), 'retain me\n');
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    assert.ok(fs.readFileSync(config, 'utf8').includes('keep'));
    assert.ok(fs.readFileSync(forkConfig, 'utf8').includes('userSetting'));
    const launcher = spawnSync(path.join(home, '.claude/skills/impeccable/scripts/impeccable'), ['engine-probe'], { encoding: 'utf8', env: { HOME: home } });
    assert.equal(launcher.status, 0, launcher.stderr);
    assert.ok(launcher.stdout.includes(`identity:${path.join(home, '.claude/skills/impeccable')}/scripts/impeccable|${path.join(home, '.claude/skills/impeccable')}`));
    const backupRoot = path.join(home, '.local/share/impeccable-fork/backups');
    const backupSet = fs.readdirSync(backupRoot)[0];
    assert.equal(fs.readFileSync(path.join(backupRoot, backupSet, '.agents/skills/impeccable/user-note.txt'), 'utf8'), 'retain me\n');
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    assert.ok(fs.readFileSync(config, 'utf8').includes('keep'));
    assert.ok(fs.readFileSync(forkConfig, 'utf8').includes('userSetting'));
    assert.equal(fs.readFileSync(path.join(backupRoot, backupSet, '.agents/skills/impeccable/user-note.txt'), 'utf8'), 'retain me\n');
  });

  test('refuses skill symlink escapes and missing staged engine without changing home', () => {
    const { base, home, stage } = fixture();
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, '.agents/skills/impeccable'));
    const escaped = run(['--home', home, '--stage', stage]);
    assert.notEqual(escaped.status, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.rmSync(path.join(home, '.agents/skills/impeccable'));
    fs.rmSync(path.join(stage, 'engine'));
    const missing = run(['--home', home, '--stage', stage]);
    assert.notEqual(missing.status, 0);
    assert.equal(fs.existsSync(path.join(home, '.local/bin/impeccable-fork')), false);
  });

  test('rolls back earlier replacements when a later staged skill cannot be copied', () => {
    const { home, stage } = fixture();
    const skill = path.join(home, '.agents/skills/impeccable');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'original.txt'), 'original\n');
    fs.chmodSync(path.join(stage, 'claude/.claude/skills/impeccable/scripts/impeccable'), 0);
    const result = run(['--home', home, '--stage', stage]);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(skill, 'original.txt'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(home, '.local/bin/impeccable-fork')), false);
    fs.chmodSync(path.join(stage, 'claude/.claude/skills/impeccable/scripts/impeccable'), 0o644);
  });

  test('failed upgrade restores the previous managed install and first backup set', () => {
    const { home, stage } = fixture();
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    const wrapper = path.join(home, '.local/bin/impeccable-fork');
    const previous = fs.readFileSync(wrapper, 'utf8');
    const installedEngine = path.join(home, '.local/share/impeccable-fork/engine');
    const installedProvenance = path.join(home, '.local/share/impeccable-fork/provenance.json');
    const oldEngine = fs.readFileSync(installedEngine);
    const oldProvenance = fs.readFileSync(installedProvenance, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.local/share/impeccable-fork/ownership.json'), 'utf8'));
    fs.appendFileSync(path.join(stage, 'engine'), '\n# changed engine\n');
    const { createHash } = require('node:crypto');
    fs.writeFileSync(path.join(stage, 'provenance.json'), JSON.stringify({ schemaVersion: 1, engineSource: 'new-fake-engine', sha256: createHash('sha256').update(fs.readFileSync(path.join(stage, 'engine'))).digest('hex') }));
    fs.rmSync(path.join(home, '.impeccable'), { recursive: true, force: true });
    fs.writeFileSync(path.join(home, '.impeccable'), 'not a directory');
    const failed = run(['--home', home, '--stage', stage]);
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(wrapper, 'utf8'), previous);
    assert.deepEqual(fs.readFileSync(installedEngine), oldEngine);
    assert.equal(fs.readFileSync(installedProvenance, 'utf8'), oldProvenance);
    const after = JSON.parse(fs.readFileSync(path.join(home, '.local/share/impeccable-fork/ownership.json'), 'utf8'));
    assert.equal(after.backupSet, manifest.backupSet);
  });

  test('upgrades the known legacy manifest without losing current managed files', () => {
    const { home, stage } = fixture();
    const skill = path.join(home, '.agents/skills/impeccable');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'old.txt'), 'working install\n');
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    const manifestPath = path.join(home, '.local/share/impeccable-fork/ownership.json');
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ marker: current.marker, backupSet: current.backupSet, backedUp: current.backedUp }));
    fs.appendFileSync(path.join(home, '.local/bin/impeccable-fork'), '\n# local change\n');
    const upgraded = run(['--home', home, '--stage', stage]);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const next = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(next.backupSet, current.backupSet);
    assert.ok(next.modified.some(item => item.path === '.local/bin/impeccable-fork'));
    assert.equal(fs.existsSync(path.join(home, '.agents/skills/impeccable/SKILL.md')), true);
  });

  test('preserves user-modified managed content before upgrade', () => {
    const { home, stage } = fixture();
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    const wrapper = path.join(home, '.local/bin/impeccable-fork');
    fs.appendFileSync(wrapper, '\n# user edit\n');
    assert.equal(run(['--home', home, '--stage', stage]).status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.local/share/impeccable-fork/ownership.json'), 'utf8'));
    assert.equal(manifest.modified.some(item => item.path === '.local/bin/impeccable-fork'), true);
    const backup = path.join(home, '.local/share/impeccable-fork/backups', manifest.backupSet, manifest.modified.find(item => item.path === '.local/bin/impeccable-fork').backup);
    assert.ok(fs.readFileSync(backup, 'utf8').includes('# user edit'));
  });

  test('refuses corrupt ownership manifests and symlinked parents before mutation', () => {
    const { base, home, stage } = fixture();
    const manifest = path.join(home, '.local/share/impeccable-fork/ownership.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{broken');
    assert.notEqual(run(['--home', home, '--stage', stage]).status, 0);
    assert.equal(fs.existsSync(path.join(home, '.agents/skills/impeccable')), false);
    fs.writeFileSync(manifest, JSON.stringify({ marker: 'unknown', backupSet: 'x', backedUp: [], managedHashes: {} }));
    assert.notEqual(run(['--home', home, '--stage', stage]).status, 0);
    assert.equal(fs.existsSync(path.join(home, '.agents/skills/impeccable')), false);
    fs.rmSync(manifest);
    fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    fs.mkdirSync(home, { recursive: true }); fs.symlinkSync(outside, path.join(home, '.local'));
    assert.notEqual(run(['--home', home, '--stage', stage]).status, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('pure stage permission validation rejects world-writable source paths', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-fork-permissions-'));
    temporary.push(base);
    const repo = path.join(base, 'repo');
    const stage = path.join(repo, 'build/fork');
    fs.mkdirSync(stage, { recursive: true });
    assert.doesNotThrow(() => assertNoWorldWritableStage(stage, repo));
    fs.chmodSync(path.join(repo, 'build'), 0o777);
    assert.throws(() => assertNoWorldWritableStage(stage, repo), /world-writable/);
  });

  test('preflight refuses missing generated placeholders and staged symlink files', () => {
    const { home, stage } = fixture();
    const launcher = path.join(stage, 'claude/.claude/skills/impeccable/scripts/impeccable');
    fs.writeFileSync(launcher, '#!/bin/sh\nexec wrapper "$@"\n');
    const badLauncher = run(['--home', home, '--stage', stage, '--dry-run']);
    assert.notEqual(badLauncher.status, 0);
    assert.match(badLauncher.stderr, /placeholders are missing/);
    assert.equal(fs.existsSync(path.join(home, '.local')), false);
    fs.rmSync(launcher);
    fs.symlinkSync(path.join(stage, 'engine'), launcher);
    const symlinkLauncher = run(['--home', home, '--stage', stage, '--dry-run']);
    assert.notEqual(symlinkLauncher.status, 0);
    assert.match(symlinkLauncher.stderr, /staged input contains symlink/);
    fs.rmSync(launcher);
    fs.writeFileSync(launcher, '#!/bin/sh\n');
    const provider = path.dirname(path.dirname(launcher));
    replaceLauncher(provider, { skillDirPath: '__IMPECCABLE_SKILL_DIR_CLAUDE__', selfPath: '__IMPECCABLE_SELF_CLAUDE__', providerId: 'claude-code' });
    const wrapper = path.join(stage, 'wrapper');
    fs.rmSync(wrapper);
    fs.symlinkSync(path.join(stage, 'engine'), wrapper);
    const symlinkWrapper = run(['--home', home, '--stage', stage, '--dry-run']);
    assert.notEqual(symlinkWrapper.status, 0);
    assert.match(symlinkWrapper.stderr, /staged input contains symlink/);
    fs.rmSync(wrapper);
    fs.copyFileSync(path.join(ROOT, 'scripts/fork/wrapper.sh'), wrapper);
    fs.chmodSync(wrapper, 0o755);
    const engine = path.join(stage, 'engine');
    const realEngine = path.join(stage, 'engine.real');
    fs.renameSync(engine, realEngine);
    fs.symlinkSync(realEngine, engine);
    const symlinkEngine = run(['--home', home, '--stage', stage, '--dry-run']);
    assert.notEqual(symlinkEngine.status, 0);
    assert.match(symlinkEngine.stderr, /staged input contains symlink/);
  });

  test('real-home install preflight refuses an external stage without changing the real home', () => {
    const { stage } = fixture();
    const result = run(['--stage', stage, '--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /require a stage under/);
  });

  test('dry-run validates staged files without writing destinations', () => {
    const { home, stage } = fixture();
    const result = run(['--home', home, '--stage', stage, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(home, '.local')), false);
    assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  });
});
