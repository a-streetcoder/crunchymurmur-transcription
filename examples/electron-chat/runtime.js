const fs = require('node:fs');
const path = require('node:path');

function runtimeFolder() {
  const platform = process.platform === 'win32'
    ? 'win'
    : process.platform === 'darwin' ? 'mac' : 'linux';
  return `${platform}-${process.arch}`;
}

function resolveExecutable() {
  const configured = String(process.env.CRUNCHYMURMUR_TRANSCRIBER_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const executable = process.platform === 'win32'
    ? 'crunchymurmur-transcriber.exe'
    : 'crunchymurmur-transcriber';
  const repositoryRuntime = path.resolve(
    __dirname,
    '..',
    '..',
    'build',
    'transcriber-runtime',
    runtimeFolder(),
    executable,
  );
  if (fs.existsSync(repositoryRuntime)) return repositoryRuntime;
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, executable);
    if (directory && fs.existsSync(candidate)) return candidate;
  }
  const cargoRuntime = path.join(
    process.env.CARGO_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo'),
    'bin',
    executable,
  );
  return fs.existsSync(cargoRuntime) ? cargoRuntime : '';
}

function resolveWhisperRuntime() {
  const cliName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const serverName = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  const configuredCli = String(process.env.CRUNCHYMURMUR_WHISPER_CLI_PATH || '').trim();
  const configuredServer = String(process.env.CRUNCHYMURMUR_WHISPER_SERVER_PATH || '').trim();
  if (configuredCli || configuredServer) {
    return {
      cliPath: configuredCli && fs.existsSync(configuredCli) ? configuredCli : '',
      serverPath: configuredServer && fs.existsSync(configuredServer) ? configuredServer : '',
    };
  }
  const directory = path.resolve(
    __dirname,
    '..',
    '..',
    'build',
    'whisper-runtime',
    process.platform === 'darwin' ? 'mac-universal' : runtimeFolder(),
  );
  const cliPath = path.join(directory, cliName);
  const serverPath = path.join(directory, serverName);
  return {
    cliPath: fs.existsSync(cliPath) ? cliPath : '',
    serverPath: fs.existsSync(serverPath) ? serverPath : '',
    bundled: true,
  };
}

module.exports = { resolveExecutable, resolveWhisperRuntime, runtimeFolder };
