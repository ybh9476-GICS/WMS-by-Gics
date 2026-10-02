const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
for (const name of readdirSync(__dirname).filter(name => /\.test\.(?:js|cjs)$/.test(name)).sort()) {
  const result = spawnSync(process.execPath, [join(__dirname, name)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
