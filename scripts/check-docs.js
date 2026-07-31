const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'build', 'dist', 'node_modules', 'target']);
const failures = [];

function markdownFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(filename);
  }
  return files;
}

for (const filename of markdownFiles(ROOT)) {
  const contents = fs.readFileSync(filename, 'utf8');
  for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/i.test(target)) {
      continue;
    }
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {}
    if (!fs.existsSync(path.resolve(path.dirname(filename), decoded))) {
      failures.push(`${path.relative(ROOT, filename)} -> ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error(`Broken local documentation links:\n${failures.map(
    (failure) => `- ${failure}`,
  ).join('\n')}`);
  process.exit(1);
}
console.log('Local documentation links are valid.');

