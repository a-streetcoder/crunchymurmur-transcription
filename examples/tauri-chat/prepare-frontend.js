const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '..', 'electron-chat');
const destination = path.join(__dirname, 'dist');
const files = [
  'host-adapter.js',
  'i18n.js',
  'index.html',
  'recorder-worklet.js',
  'renderer.js',
  'styles.css',
];

fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  const sourcePath = path.join(source, file);
  const destinationPath = path.join(destination, file);
  if (file !== 'index.html') {
    fs.copyFileSync(sourcePath, destinationPath);
    continue;
  }
  const html = fs.readFileSync(sourcePath, 'utf8').replace(
    "connect-src 'none'",
    'connect-src ipc: http://ipc.localhost',
  );
  fs.writeFileSync(destinationPath, html);
}

console.log('Prepared the shared SDK chat frontend for Tauri.');
