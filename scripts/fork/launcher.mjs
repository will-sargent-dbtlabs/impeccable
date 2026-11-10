import fs from 'node:fs';
import path from 'node:path';

export function replaceLauncher(skillDir, { skillDirPath = skillDir, selfPath = path.join(skillDirPath, 'scripts/impeccable'), providerId } = {}) {
  if (!['codex', 'claude-code'].includes(providerId)) throw new Error(`unsupported fork provider id: ${providerId}`);
  const launcher = path.join(skillDir, 'scripts/impeccable');
  if (!fs.existsSync(launcher)) throw new Error(`generated launcher missing: ${launcher}`);
  fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nexport IMPECCABLE_SKILL_DIR=${skillDirPath}\nexport IMPECCABLE_SELF=${selfPath}\nexport IMPECCABLE_PROVIDER_ID=${providerId}\nexec __IMPECCABLE_FORK_WRAPPER__ "$@"\n`);
  fs.chmodSync(launcher, 0o755);
}
