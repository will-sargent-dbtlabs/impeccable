#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = 'impeccable-fork-managed-v1';
const MANAGED = ['.local/bin/impeccable-fork', '.local/share/impeccable-fork/engine', '.local/share/impeccable-fork/provenance.json', '.agents/skills/impeccable', '.claude/skills/impeccable', '.impeccable/bin/impeccable'];
function parseArgs(argv) {
  const options = { home: os.homedir(), stage: path.join(ROOT, 'build/fork'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--home' || arg === '--stage') { const value = argv[++i]; if (!value) throw new Error(`${arg} requires a path`); options[arg === '--home' ? 'home' : 'stage'] = path.resolve(value); }
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}
function help() { console.log('Usage: node scripts/fork/install.mjs [--home DIR] [--stage DIR] [--dry-run]'); }
export function assertNoWorldWritableStage(stage, repositoryRoot) {
  const root = fs.realpathSync(stage);
  const repo = fs.realpathSync(repositoryRoot);
  if (root !== repo && !root.startsWith(`${repo}${path.sep}`)) throw new Error('stage is outside the repository');
  let current = root;
  while (current === repo || current.startsWith(`${repo}${path.sep}`)) {
    if (fs.lstatSync(current).mode & 0o002) throw new Error(`real-home install stage path is world-writable: ${current}`);
    if (current === repo) break;
    current = path.dirname(current);
  }
  const visit = dir => {
    const stat = fs.lstatSync(dir);
    if (stat.mode & 0o002) throw new Error(`real-home install stage contains a world-writable source: ${dir}`);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) visit(path.join(dir, entry.name));
  };
  visit(root);
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function assertNoSymlinkPath(home, relative) {
  const rel = path.relative(home, path.join(home, relative));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`target escapes home: ${relative}`);
  let current = home;
  for (const part of rel.split(path.sep)) { current = path.join(current, part); try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink in install path: ${current}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function assertNoStagedSymlinks(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`staged input contains symlink: ${root}`);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const full = path.join(root, entry.name); if (entry.isSymbolicLink()) throw new Error(`staged input contains symlink: ${full}`); if (entry.isDirectory()) assertNoStagedSymlinks(full); }
}
function copyReplacing(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.impeccable-fork-new-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, dereference: false, verbatimSymlinks: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);
}
function hashPath(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return createHash('sha256').update(`link:${fs.readlinkSync(target)}`).digest('hex');
  if (stat.isFile()) return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const hash = createHash('sha256');
  for (const name of fs.readdirSync(target).sort()) { hash.update(name); hash.update(hashPath(path.join(target, name))); }
  return hash.digest('hex');
}
function validManifest(manifest) {
  const allowedKeys = new Set(['marker', 'backupSet', 'backedUp', 'managedHashes', 'modified', 'engine']);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !allowedKeys.has(key)) || manifest.marker !== MARKER || typeof manifest.backupSet !== 'string' || !Array.isArray(manifest.backedUp)) throw new Error('ownership manifest is corrupt or has unknown format; refusing install. Inspect .local/share/impeccable-fork/ownership.json and restore it from backups before retrying.');
  const managedHashes = Object.prototype.hasOwnProperty.call(manifest, 'managedHashes') ? manifest.managedHashes : {};
  if (!managedHashes || typeof managedHashes !== 'object' || Array.isArray(managedHashes)) throw new Error('ownership manifest is corrupt or has unknown format; refusing install. Inspect .local/share/impeccable-fork/ownership.json and restore it from backups before retrying.');
  for (const rel of manifest.backedUp) if (!MANAGED.includes(rel)) throw new Error(`ownership manifest contains unknown backup path: ${rel}`);
  for (const [rel, digest] of Object.entries(managedHashes)) if (!MANAGED.includes(rel) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`ownership manifest contains unknown managed entry: ${rel}`);
  return { ...manifest, managedHashes };
}
function bindFixedPaths(home, relative) {
  const target = path.join(home, relative);
  if (relative === '.local/bin/impeccable-fork') {
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('"__IMPECCABLE_FORK_ENGINE__"', quote(path.join(home, '.local/share/impeccable-fork/engine'))), { mode: 0o755 }); fs.chmodSync(target, 0o755);
  } else if (relative === '.agents/skills/impeccable' || relative === '.claude/skills/impeccable') {
    const provider = relative.startsWith('.agents') ? 'CODEX' : 'CLAUDE';
    const skill = path.join(home, relative);
    const launcher = path.join(skill, 'scripts/impeccable');
    const vars = { [`__IMPECCABLE_SKILL_DIR_${provider}__`]: skill, [`__IMPECCABLE_SELF_${provider}__`]: launcher, '__IMPECCABLE_FORK_WRAPPER__': path.join(home, '.local/bin/impeccable-fork') };
    let content = fs.readFileSync(launcher, 'utf8');
    for (const [placeholder, value] of Object.entries(vars)) content = content.replaceAll(placeholder, quote(value));
    if (/__IMPECCABLE_(?:SKILL_DIR|SELF|FORK_WRAPPER)/.test(content)) throw new Error(`unresolved launcher placeholder: ${relative}`);
    fs.writeFileSync(launcher, content, { mode: 0o755 }); fs.chmodSync(launcher, 0o755);
  } else if (relative === '.impeccable/bin/impeccable') {
    fs.writeFileSync(target, `#!/bin/sh\nexec ${quote(path.join(home, '.local/bin/impeccable-fork'))} "$@"\n`, { mode: 0o755 }); fs.chmodSync(target, 0o755);
  }
}
function main() {
  const options = parseArgs(process.argv.slice(2)); if (options.help) return help();
  const { home, stage } = options;
  const realHome = fs.realpathSync(os.homedir());
  if (fs.existsSync(home) && fs.realpathSync(home) === realHome) {
    const allowedPath = path.join(ROOT, 'build/fork');
    const allowed = fs.existsSync(allowedPath) ? fs.realpathSync(allowedPath) : path.resolve(allowedPath);
    const canonicalStage = fs.realpathSync(stage);
    const tmp = path.resolve(os.tmpdir());
    if (canonicalStage !== allowed && !canonicalStage.startsWith(`${allowed}${path.sep}`)) throw new Error('real-home installs require a stage under this repository’s build/fork; temporary or external stages are refused');
    if ([tmp, '/tmp', '/private/tmp', '/var/tmp'].some(root => canonicalStage === root || canonicalStage.startsWith(`${root}${path.sep}`))) throw new Error('real-home install stage cannot come from a temporary directory');
    assertNoWorldWritableStage(canonicalStage, ROOT);
  }
  const source = { wrapper: path.join(stage, 'wrapper'), engine: path.join(stage, 'engine'), codex: path.join(stage, 'codex/.agents/skills/impeccable'), claude: path.join(stage, 'claude/.claude/skills/impeccable') };
  for (const [name, file] of Object.entries(source)) if (!fs.existsSync(file)) throw new Error(`required staged ${name} missing: ${file}`);
  for (const file of Object.values(source)) assertNoStagedSymlinks(file);
  if (!fs.lstatSync(source.engine).isFile() || !(fs.statSync(source.engine).mode & 0o111)) throw new Error('staged engine must be an executable file');
  if (!fs.lstatSync(source.wrapper).isFile()) throw new Error('staged wrapper must be a regular file');
  const codexLauncher = fs.readFileSync(path.join(source.codex, 'scripts/impeccable'), 'utf8');
  const claudeLauncher = fs.readFileSync(path.join(source.claude, 'scripts/impeccable'), 'utf8');
  const stagedWrapperText = fs.readFileSync(source.wrapper, 'utf8');
  const provenancePath = path.join(stage, 'provenance.json');
  if (!stagedWrapperText.includes('__IMPECCABLE_FORK_ENGINE__')) throw new Error('staged wrapper engine placeholder is missing');
  if (!codexLauncher.includes('__IMPECCABLE_SKILL_DIR_CODEX__') || !codexLauncher.includes('__IMPECCABLE_SELF_CODEX__') || !claudeLauncher.includes('__IMPECCABLE_SKILL_DIR_CLAUDE__') || !claudeLauncher.includes('__IMPECCABLE_SELF_CLAUDE__') || !codexLauncher.includes('__IMPECCABLE_FORK_WRAPPER__') || !claudeLauncher.includes('__IMPECCABLE_FORK_WRAPPER__')) throw new Error('staged provider launcher placeholders are missing');
  if (!fs.existsSync(provenancePath)) throw new Error('staged engine provenance.json missing');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const actualHash = createHash('sha256').update(fs.readFileSync(source.engine)).digest('hex');
  if (provenance.sha256 !== actualHash || typeof provenance.engineSource !== 'string') throw new Error('staged engine provenance does not match engine bytes');
  const map = new Map([['.local/bin/impeccable-fork', source.wrapper], ['.local/share/impeccable-fork/engine', source.engine], ['.local/share/impeccable-fork/provenance.json', provenancePath], ['.agents/skills/impeccable', source.codex], ['.claude/skills/impeccable', source.claude], ['.impeccable/bin/impeccable', null]]);
  const manifestRel = '.local/share/impeccable-fork/ownership.json';
  for (const rel of [...MANAGED, manifestRel]) assertNoSymlinkPath(home, rel);
  const manifestPath = path.join(home, manifestRel);
  let prior = null;
  try { prior = validManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (options.dryRun) { console.log(`Would install local fork engine, compatibility launcher, and Codex/Claude skills under ${home}`); return; }
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const backupSet = prior?.backupSet || stamp;
  const backupRoot = path.join(home, '.local/share/impeccable-fork/backups', backupSet);
  const transactionRoot = path.join(home, '.local/share/impeccable-fork/transactions', stamp);
  const originals = prior?.backedUp || [];
  const backedUp = [...originals];
  const snapshot = [];
  const modified = [];
  const installed = [];
  try {
    fs.mkdirSync(transactionRoot, { recursive: true });
    for (const rel of MANAGED) {
      const target = path.join(home, rel);
      if (!fs.existsSync(target)) continue;
      copyReplacing(target, path.join(transactionRoot, rel)); snapshot.push(rel);
      if (!prior) { copyReplacing(target, path.join(backupRoot, rel)); backedUp.push(rel); }
      else if (!prior.managedHashes[rel] || hashPath(target) !== prior.managedHashes[rel]) {
        const save = path.join(backupRoot, 'modified', stamp, rel); copyReplacing(target, save); modified.push({ path: rel, backup: path.relative(backupRoot, save), sha256: hashPath(target) });
      }
    }
    for (const rel of MANAGED) {
      const target = path.join(home, rel);
      if (rel === '.impeccable/bin/impeccable') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ''); }
      else copyReplacing(map.get(rel), target);
      installed.push(rel); bindFixedPaths(home, rel);
    }
    const managedHashes = Object.fromEntries(MANAGED.map(rel => [rel, hashPath(path.join(home, rel))]));
    const manifest = { marker: MARKER, backupSet, backedUp, managedHashes, modified, engine: provenance };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmpManifest = `${manifestPath}.tmp-${process.pid}`; fs.writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmpManifest, manifestPath);
  } catch (error) {
    for (const rel of installed.reverse()) fs.rmSync(path.join(home, rel), { recursive: true, force: true });
    for (const rel of snapshot.reverse()) copyReplacing(path.join(transactionRoot, rel), path.join(home, rel));
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  try { fs.rmSync(transactionRoot, { recursive: true, force: true }); } catch (error) { console.error(`impeccable-fork install: install succeeded but transaction snapshot cleanup failed: ${error.message}`); }
  console.log(`Installed local fork engine, compatibility launcher, and Codex/Claude skills under ${home}`);
  console.log(`Engine sha256 ${provenance.sha256}; originals backed up under ${backupRoot}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`impeccable-fork install: ${error.message}`); process.exitCode = 1; }
}
