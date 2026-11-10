import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { findEngineBinary, ENGINE_MISSING_MESSAGE } from './lib/engine-bin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const engine = findEngineBinary();
const temporary = [];
const servers = [];

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-fork-runtime-'));
  temporary.push(base);
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { base, home, project };
}

async function mockApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function envFor({ home, project, apiUrl, extra = {} }) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    IMPECCABLE_HOME: home,
    IMPECCABLE_API_URL: apiUrl,
    IMPECCABLE_API_TIMEOUT: '1000',
    IMPECCABLE_TELEMETRY_CHANNEL: 'test',
    ...extra,
  };
}

async function run(fx, args, api, extra = {}) {
  assert.ok(engine, ENGINE_MISSING_MESSAGE);
  try {
    const result = await execFileAsync(engine, args, {
      cwd: fx.project,
      env: envFor({ ...fx, apiUrl: api.url, extra }),
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...result, status: 0 };
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw error;
    return { ...error, status: error.code === 2 ? 2 : error.code === 1 ? 1 : error.code };
  }
}

function userConfig(home) {
  return path.join(home, '.impeccable', 'config.json');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

after(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe('fork runtime privacy and network boundaries', { timeout: 20_000, skip: !engine }, () => {
  test('missing user consent suppresses a chosen ping', async () => {
    const fx = fixture();
    const api = await mockApi();
    const result = await run(fx, ['concept-seed', '--kind', 'assigned', '--scope', 'direction', '--from', 'raw-test-key'], api);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /choice ping skipped/);
    assert.deepEqual(api.requests, []);
  });

  test('explicit opt-in preserves config and sends a chosen ping to the local API', async () => {
    const fx = fixture();
    const api = await mockApi();
    writeJson(userConfig(fx.home), { keep: 'yes', theme: 'dark' });
    const optedIn = await run(fx, ['telemetry', 'on'], api);
    assert.equal(optedIn.status, 0, optedIn.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(userConfig(fx.home), 'utf8')), { keep: 'yes', theme: 'dark', telemetry: true });
    const result = await run(fx, ['concept-seed', '--kind', 'assigned', '--scope', 'direction', '--from', 'raw-test-key'], api);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /choice recorded/);
    assert.deepEqual(api.requests.map(request => request.url), ['/chosen']);
  });

  test('environment and project denials suppress chosen pings', async () => {
    for (const denial of [
      { label: 'environment', extra: { IMPECCABLE_NO_TELEMETRY: '1' } },
      { label: 'project config', projectConfig: { telemetry: false } },
    ]) {
      const fx = fixture();
      const api = await mockApi();
      writeJson(userConfig(fx.home), { telemetry: true });
      if (denial.projectConfig) writeJson(path.join(fx.project, '.impeccable/config.json'), denial.projectConfig);
      const result = await run(fx, ['concept-seed', '--kind', 'assigned', '--scope', 'direction', '--from', `raw-${denial.label}`], api, denial.extra);
      assert.equal(result.status, 0, `${denial.label}: ${result.stderr}`);
      assert.match(result.stdout, /choice ping skipped/);
      assert.deepEqual(api.requests, [], denial.label);
    }
  });

  test('corrupt user or project config suppresses chosen pings', async () => {
    for (const target of ['user', 'project']) {
      const fx = fixture();
      const api = await mockApi();
      writeJson(userConfig(fx.home), { telemetry: true });
      const corrupt = target === 'user' ? userConfig(fx.home) : path.join(fx.project, '.impeccable/config.json');
      fs.mkdirSync(path.dirname(corrupt), { recursive: true });
      fs.writeFileSync(corrupt, '{broken');
      const result = await run(fx, ['concept-seed', '--kind', 'assigned', '--scope', 'direction', '--from', `corrupt-${target}`], api);
      assert.equal(result.status, 0, `${target}: ${result.stderr}`);
      assert.match(result.stdout, /choice ping skipped/);
      assert.deepEqual(api.requests, [], target);
    }
  });

  test('telemetry on and off refuse a corrupt user config without overwriting it', async () => {
    for (const command of ['on', 'off']) {
      const fx = fixture();
      const api = await mockApi();
      const config = userConfig(fx.home);
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '{broken\n');
      const result = await run(fx, ['telemetry', command], api);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /malformed|corrupt|invalid|not valid JSON/i);
      assert.equal(fs.readFileSync(config, 'utf8'), '{broken\n');
      assert.deepEqual(api.requests, []);
    }
  });

  test('health defaults to disabled without signed-in consent', async () => {
    const fx = fixture();
    const api = await mockApi();
    const result = await run(fx, ['health', 'status'], api);
    assert.equal(result.status, 0, result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /turned off/i);
    assert.deepEqual(api.requests, []);
  });

  test('NO_REMOTE_CATALOG prevents a concept roll request and network escalation advice', async () => {
    const fx = fixture();
    const api = await mockApi();
    fs.writeFileSync(path.join(fx.project, 'PRODUCT.md'), '# Product\n\nA small local fixture product.\n');
    const result = await run(fx, ['concept-seed', '--scope', 'direction'], api, { IMPECCABLE_NO_REMOTE_CATALOG: '1' });
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /Remote catalog access is disabled by IMPECCABLE_NO_REMOTE_CATALOG/i);
    assert.match(output, /do not retry the catalog over the network/i);
    assert.doesNotMatch(output, /(?:unset|disable)\s+IMPECCABLE_NO_REMOTE_CATALOG/i);
    assert.doesNotMatch(output, /(?<!do not )retry the catalog over the network/i);
    assert.doesNotMatch(output, /enable\s+(?:network|remote catalog)/i);
    assert.deepEqual(api.requests, []);
  });

  test('native detect reports exactly five rounded border accent findings', async () => {
    const fx = fixture();
    const api = await mockApi();
    const css = path.join(ROOT, 'tests/fixtures/antipatterns/border-accent-blank-lines.css');
    fs.copyFileSync(css, path.join(fx.project, 'fixture.css'));
    const result = await run(fx, ['detect', '--json', path.join(fx.project, 'fixture.css')], api);
    assert.equal(result.status, 2, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed), 'detect --json emits a findings array');
    assert.equal(parsed.filter(item => item.antipattern === 'border-accent-on-rounded').length, 5);
    assert.deepEqual(api.requests, []);
  });
});
