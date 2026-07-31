const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'build', 'dist', 'node_modules', 'target']);
const files = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(filename);
    else if (entry.isFile() && filename.endsWith('.js')) files.push(filename);
  }
}

visit(ROOT);
let failed = false;
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(
      result.stderr || result.stdout || `Syntax check failed: ${filename}\n`,
    );
  }
}

if (failed) process.exit(1);
console.log(`Syntax checked ${files.length} JavaScript files.`);

