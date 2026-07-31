const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED = 'a-streetcoder/crunchymurmur-transcription';
const OLD_REPOSITORY = 'a-streetcoder/CrunchyMurmur';
const ignored = new Set(['.git', 'build', 'dist', 'node_modules', 'target']);
const checkedExtensions = new Set([
  '.json', '.js', '.md', '.toml', '.yml', '.yaml',
]);
const stale = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
      continue;
    }
    if (!entry.isFile() || !checkedExtensions.has(path.extname(entry.name))) continue;
    const contents = fs.readFileSync(filename, 'utf8');
    const relative = path.relative(ROOT, filename);
    if (contents.includes(OLD_REPOSITORY)
        && relative !== 'README.md'
        && relative !== path.join('scripts', 'check-repository-links.js')) {
      stale.push(relative);
    }
  }
}

visit(ROOT);
if (stale.length) {
  console.error(`Stale CrunchyMurmur repository links:\n${stale.map(
    (file) => `- ${file}`,
  ).join('\n')}`);
  process.exit(1);
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
if (!rootPackage.repository.url.includes(EXPECTED)) {
  throw new Error(`Root repository metadata must target ${EXPECTED}.`);
}
console.log(`Repository links target ${EXPECTED}.`);
