#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replaceLauncher } from './launcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(ROOT, 'build/fork');
const env = { ...process.env };
const bunBin = path.join(ROOT, 'build/tooling/node_modules/.bin');
env.PATH = `${bunBin}${path.delimiter}${env.PATH || ''}`;
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function main() {
  const bun = path.join(bunBin, 'bun');
  if (!fs.existsSync(bun)) throw new Error(`repository Bun is missing at ${bun}; follow the bootstrap steps in docs/FORK.md`);
  run(bun, ['run', 'build']);
  run('cargo', ['build', '--locked', '--release', '-p', 'impeccable', '--target-dir', path.join(ROOT, 'target')]);
  const artifact = path.join(ROOT, 'target/release/impeccable');
  if (!fs.existsSync(artifact)) throw new Error(`cargo artifact missing: ${artifact}`);
  const sources = [['codex', path.join(ROOT, 'dist/agents/.agents/skills/impeccable')], ['claude', path.join(ROOT, 'dist/claude-code/.claude/skills/impeccable')]];
  for (const [, source] of sources) if (!fs.existsSync(source)) throw new Error(`source-first provider output missing: ${source}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [provider, source] of sources) {
    const rel = provider === 'codex' ? '.agents/skills/impeccable' : '.claude/skills/impeccable';
    const destination = path.join(out, provider, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    replaceLauncher(destination, { skillDirPath: `__IMPECCABLE_SKILL_DIR_${provider.toUpperCase()}__`, selfPath: `__IMPECCABLE_SELF_${provider.toUpperCase()}__`, providerId: provider === 'codex' ? 'codex' : 'claude-code' });
  }
  fs.copyFileSync(artifact, path.join(out, 'engine'));
  fs.chmodSync(path.join(out, 'engine'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'scripts/fork/wrapper.sh'), path.join(out, 'wrapper'));
  fs.chmodSync(path.join(out, 'wrapper'), 0o755);
  const provenance = { schemaVersion: 1, engineSource: path.relative(ROOT, artifact), sha256: sha256(artifact), builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
  console.log(`Fork build staged at ${out} (engine sha256 ${provenance.sha256})`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`impeccable-fork build: ${error.message}`); process.exitCode = 1; }
}
