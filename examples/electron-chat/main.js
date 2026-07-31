const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createModelHost } = require('./model-host');
const { createShortcutHost, defaultShortcut } = require('./shortcut-host');
const { createTranscriptionController, MAX_WAV_BYTES } = require('./transcription-controller');
const { resolveExecutable, resolveWhisperRuntime } = require('./runtime');

let window;
let controller;
let models;
let shortcuts;
let groqApiKey = String(process.env.GROQ_API_KEY || '').trim();
let cleanupStarted = false;
let cleanupComplete = false;

function sdk() {
  try {
    return require('@crunchymurmur/transcribe-node');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require('../../packages/transcribe-node');
  }
}

function groqSdk() {
  try {
    return require('@crunchymurmur/transcribe-groq');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require('../../packages/transcribe-groq');
  }
}

function createProviderTranscriber(configuration) {
  if (configuration.provider === 'parakeet') {
    return sdk().createLocalTranscriber({
      modelDirectory: configuration.modelDirectory,
      trustedManifestSha256: configuration.trustedManifestSha256,
      resolveExecutable,
    });
  }
  if (configuration.provider === 'whisper') {
    return sdk().createWhisperTranscriber({
      modelPath: configuration.modelPath,
      resolveRuntime: resolveWhisperRuntime,
    });
  }
  if (configuration.provider === 'groq') {
    return groqSdk().createGroqTranscriber({
      apiKey: configuration.apiKey,
      model: configuration.model,
    });
  }
  throw new TypeError('Unknown transcription provider.');
}

function transcriptionController() {
  if (!controller) {
    controller = createTranscriptionController({
      createTranscriber: createProviderTranscriber,
      temporaryDirectory: path.join(app.getPath('temp'), 'crunchymurmur-sdk-chat'),
    });
  }
  return controller;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#f7f1e5',
    title: 'CrunchyMurmur SDK Chat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('chat-demo:bootstrap', () => ({
  models: models.list(),
  platform: process.platform,
  defaultShortcut: defaultShortcut(),
  groqConfigured: Boolean(groqApiKey),
}));
ipcMain.handle('chat-demo:install-model', async (event) => {
  const profile = await models.installRecommended((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('chat-demo:model-progress', progress);
  });
  return {
    selectedModelId: profile.id,
    models: models.list(),
  };
});
ipcMain.handle('chat-demo:set-shortcut', (_event, accelerator) => (
  shortcuts.register(accelerator, (action) => {
    if (window && !window.isDestroyed()) window.webContents.send('chat-demo:shortcut-action', action);
  })
));
ipcMain.handle('chat-demo:set-groq-key', (_event, apiKey) => {
  const value = String(apiKey || '').trim();
  if (value.length > 512) throw new TypeError('The Groq API key is too long.');
  groqApiKey = value;
  return { configured: Boolean(groqApiKey) };
});
ipcMain.handle('chat-demo:transcribe', async (_event, request) => {
  const received = request?.wavBytes;
  const bytes = received instanceof Uint8Array
    ? received
    : ArrayBuffer.isView(received)
      ? new Uint8Array(received.buffer, received.byteOffset, received.byteLength)
      : received instanceof ArrayBuffer ? new Uint8Array(received) : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_WAV_BYTES) {
    throw new TypeError('Invalid recorded audio.');
  }
  const provider = String(request?.provider || '');
  let transcriberConfiguration;
  if (provider === 'groq') {
    if (!groqApiKey) throw new TypeError('A Groq API key is required.');
    const model = ['whisper-large-v3-turbo', 'whisper-large-v3'].includes(request?.groqModel)
      ? request.groqModel
      : 'whisper-large-v3-turbo';
    const keyDigest = crypto.createHash('sha256').update(groqApiKey).digest('hex');
    transcriberConfiguration = {
      key: `groq:${model}:${keyDigest}`,
      provider,
      apiKey: groqApiKey,
      model,
    };
  } else {
    const profile = models.resolve(request?.modelId);
    if (!profile || profile.engine !== provider) {
      throw new TypeError('The selected model is not installed.');
    }
    transcriberConfiguration = provider === 'parakeet'
      ? {
        key: `parakeet:${profile.id}:${profile.trustedManifestSha256}`,
        provider,
        modelDirectory: profile.directory,
        trustedManifestSha256: profile.trustedManifestSha256,
      }
      : {
        key: `whisper:${profile.id}`,
        provider,
        modelPath: profile.modelPath,
      };
  }
  return transcriptionController().transcribeWav({
    wavBytes: bytes,
    language: request?.language,
    transcriberConfiguration,
  });
});
ipcMain.handle('chat-demo:diagnostics', () => transcriptionController().diagnostics());

app.whenReady().then(() => {
  const modelsDirectory = path.join(app.getPath('userData'), 'Models');
  models = createModelHost({
    installRoot: modelsDirectory,
    roots: [
      modelsDirectory,
      process.env.CRUNCHYMURMUR_DEMO_MODEL_ROOT
        || path.join(app.getPath('appData'), 'CrunchyMurmur', 'Models'),
    ],
  });
  shortcuts = createShortcutHost();
  createWindow();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  shortcuts?.stop();
  Promise.resolve(controller?.dispose())
    .catch(() => {})
    .finally(() => {
      cleanupComplete = true;
      app.quit();
    });
});
