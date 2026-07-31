const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createTranscriptionController } = require('../examples/electron-chat/transcription-controller');
const { CATALOGS } = require('../examples/electron-chat/i18n');
const {
  DIRECTORY_NAME,
  MODEL_FILES,
  createModelHost,
  inspectKnownProfile,
} = require('../examples/electron-chat/model-host');
const {
  createShortcutHost,
  defaultShortcut,
  isWindowsModifierChord,
} = require('../examples/electron-chat/shortcut-host');

test('chat demo sends a temporary WAV through the public SDK and removes it', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crunchymurmur-sdk-demo-'));
  const calls = [];
  const controller = createTranscriptionController({
    temporaryDirectory: temporary,
    createTranscriber(options) {
      calls.push({ type: 'create', options });
      return {
        async prepare() {
          calls.push({ type: 'prepare' });
        },
        async transcribe(input, options) {
          calls.push({
            type: 'transcribe',
            input,
            options,
            bytes: fs.readFileSync(input.path),
          });
          return {
            text: 'Hello from the SDK',
            outcome: 'speech',
            inferenceMs: 21,
          };
        },
        async dispose() {
          calls.push({ type: 'dispose' });
        },
      };
    },
  });

  const result = await controller.transcribeWav({
    wavBytes: Uint8Array.from([82, 73, 70, 70]),
    transcriberConfiguration: {
      key: 'parakeet:verified-model',
      provider: 'parakeet',
      modelDirectory: 'verified-model',
      trustedManifestSha256: 'a'.repeat(64),
    },
    language: 'en',
  });

  assert.equal(result.text, 'Hello from the SDK');
  const transcription = calls.find((call) => call.type === 'transcribe');
  assert.deepEqual([...transcription.bytes], [82, 73, 70, 70]);
  assert.equal(fs.existsSync(transcription.input.path), false);
  assert.equal(calls[0].options.modelDirectory, 'verified-model');

  await controller.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('chat demo serialises concurrent engine configuration and inference', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crunchymurmur-sdk-queue-'));
  let active = 0;
  let maximumActive = 0;
  const prepared = [];
  const controller = createTranscriptionController({
    temporaryDirectory: temporary,
    createTranscriber({ label }) {
      return {
        async prepare() {
          prepared.push(label);
        },
        async transcribe() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { text: label, outcome: 'speech', inferenceMs: 5 };
        },
        async dispose() {},
      };
    },
  });

  const request = (label, byte) => controller.transcribeWav({
    wavBytes: Uint8Array.from([byte]),
    transcriberConfiguration: { key: label, label },
  });
  const results = await Promise.all([request('model-a', 1), request('model-b', 2)]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(prepared, ['model-a', 'model-b']);
  assert.deepEqual(results.map((result) => result.text), ['model-a', 'model-b']);
  await controller.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('chat demo provides every message in each supported interface locale', () => {
  const supported = ['en', 'it', 'es', 'pt', 'fr', 'de', 'da', 'no', 'sv', 'zh', 'ko', 'ja'];
  assert.deepEqual(Object.keys(CATALOGS), supported);
  const messages = Object.keys(CATALOGS.en).sort();
  for (const locale of supported) {
    assert.deepEqual(
      Object.keys(CATALOGS[locale]).sort(),
      messages,
      `${locale} is missing a chat demo message`,
    );
    for (const key of messages) {
      assert.ok(CATALOGS[locale][key].trim(), `${locale}.${key} is empty`);
    }
  }
});

test('chat demo discovers a legacy CrunchyMurmur model and authenticates its generated profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crunchymurmur-sdk-model-'));
  const directory = path.join(root, DIRECTORY_NAME);
  fs.mkdirSync(directory);
  for (const file of MODEL_FILES) {
    const descriptor = fs.openSync(path.join(directory, file.path), 'w');
    fs.ftruncateSync(descriptor, file.bytes);
    fs.closeSync(descriptor);
  }

  const profile = inspectKnownProfile(directory);
  assert.equal(profile.id, 'parakeet-v3');
  assert.match(profile.trustedManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(directory, 'crunchymurmur-model.json')), true);

  const host = createModelHost({ roots: [root], installRoot: root });
  assert.deepEqual(host.list().map((model) => model.id), ['parakeet-v3']);
  assert.equal(Object.hasOwn(host.list()[0], 'trustedManifestSha256'), false);
  assert.equal(host.resolve('parakeet-v3').directory, fs.realpathSync(directory));
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat demo discovers Whisper models without exposing their filesystem path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crunchymurmur-sdk-whisper-'));
  const modelPath = path.join(root, 'ggml-large-v3-turbo-q5_0.bin');
  const descriptor = fs.openSync(modelPath, 'w');
  fs.ftruncateSync(descriptor, 2 * 1024 * 1024);
  fs.closeSync(descriptor);

  const host = createModelHost({ roots: [root], installRoot: root });
  const publicProfile = host.list().find((model) => model.engine === 'whisper');
  assert.equal(publicProfile.id, 'whisper:large-v3-turbo-q5_0');
  assert.equal(Object.hasOwn(publicProfile, 'modelPath'), false);
  assert.equal(host.resolve(publicProfile.id).modelPath, modelPath);

  fs.rmSync(root, { recursive: true, force: true });
});

test('chat demo exposes platform-appropriate shortcut defaults', () => {
  assert.equal(defaultShortcut('win32'), 'Control+Super');
  assert.equal(defaultShortcut('darwin'), 'Command+Shift+Space');
  assert.equal(defaultShortcut('linux'), 'Control+Shift+Space');
  assert.equal(isWindowsModifierChord('Ctrl+Win', 'win32'), true);
  assert.equal(isWindowsModifierChord('Control+Super', 'linux'), false);
});

test('Windows modifier shortcut emits hold actions and releases during cleanup', () => {
  const uIOhook = new EventEmitter();
  let started = false;
  uIOhook.start = () => { started = true; };
  uIOhook.stop = () => { started = false; };
  const keyboard = {
    uIOhook,
    UiohookKey: { Ctrl: 1, CtrlRight: 2, Meta: 3, MetaRight: 4 },
  };
  const actions = [];
  const host = createShortcutHost({
    platform: 'win32',
    shortcuts: {},
    loadKeyboardHook: () => keyboard,
  });
  host.register('Control+Super', (action) => actions.push(action));
  uIOhook.emit('keydown', { keycode: 1 });
  uIOhook.emit('keydown', { keycode: 3 });
  assert.equal(started, true);
  assert.deepEqual(actions, ['start']);
  host.stop();
  assert.equal(started, false);
  assert.deepEqual(actions, ['start', 'stop']);
});
