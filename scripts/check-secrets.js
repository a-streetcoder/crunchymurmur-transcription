const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'build', 'dist', 'node_modules', 'target']);
const binaryExtensions = new Set([
  '.dll', '.dylib', '.exe', '.ico', '.jpg', '.jpeg', '.node', '.onnx',
  '.pdf', '.png', '.so', '.wav', '.zip',
]);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{20,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
];
const findings = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
      continue;
    }
    if (!entry.isFile() || binaryExtensions.has(path.extname(entry.name))) continue;
    const contents = fs.readFileSync(filename, 'utf8');
    for (const [label, pattern] of patterns) {
      if (pattern.test(contents)) findings.push(`${path.relative(ROOT, filename)}: ${label}`);
    }
  }
}

visit(ROOT);
if (findings.length) {
  console.error(`Potential committed secrets:\n${findings.map(
    (finding) => `- ${finding}`,
  ).join('\n')}`);
  process.exit(1);
}
console.log('No credential patterns found in repository files.');

