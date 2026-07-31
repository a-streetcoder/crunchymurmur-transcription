const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  OnDeviceTranscriber,
  TranscriptionError,
  createLocalTranscriber,
  createWhisperTranscriber,
  parakeetSupportsLanguage,
} = require('../packages/transcribe-node');

function fakeHelper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    child.emit('exit', null);
  };
  return child;
}

test('package exposes the desktop transcription primitives', () => {
  assert.equal(typeof OnDeviceTranscriber, 'function');
  assert.equal(typeof TranscriptionError, 'function');
  assert.equal(typeof createLocalTranscriber, 'function');
  assert.equal(typeof createWhisperTranscriber, 'function');
  assert.equal(parakeetSupportsLanguage('en'), true);
  assert.equal(parakeetSupportsLanguage('ja'), false);
});

test('Whisper adapter satisfies the shared lifecycle without exposing model paths', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crunchymurmur-whisper-sdk-'));
  const modelPath = path.join(directory, 'ggml-small.bin');
  fs.writeFileSync(modelPath, 'model');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let disposed = false;
  const service = {
    async prepare() { return true; },
    async transcribe() { return 'Whisper result'; },
    diagnostics() {
      return { lastLoadMs: 12, lastInferenceMs: 34 };
    },
    dispose() { disposed = true; },
  };
  const transcriber = createWhisperTranscriber({
    modelPath,
    resolveRuntime: () => ({ cliPath: 'whisper-cli' }),
    service,
  });

  assert.equal((await transcriber.prepare()).modelId, 'small');
  assert.deepEqual(await transcriber.transcribe(
    { path: 'message.wav' },
    { language: 'ja' },
  ), {
    text: 'Whisper result',
    outcome: 'speech',
    language: 'ja',
    inferenceMs: 34,
  });
  assert.deepEqual(transcriber.diagnostics(), {
    state: 'ready',
    modelId: 'small',
    modelVersion: 'ggml',
    lastLoadMs: 12,
    lastInferenceMs: 34,
  });
  await transcriber.dispose();
  assert.equal(disposed, true);
});

test('package preserves stable native engine errors', async () => {
  const child = fakeHelper();
  child.stdin.write = (_line, callback) => {
    callback?.();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({
        ok: false,
        error: 'The selected model is unavailable.',
        errorCode: 'MODEL_NOT_FOUND',
        recoverable: true,
      })}\n`);
    });
    return true;
  };
  const transcriber = new OnDeviceTranscriber({
    resolveExecutable: () => 'helper',
    spawnProcess: () => child,
  });

  await assert.rejects(
    transcriber.prepare({ parakeetModelPath: 'missing-model' }),
    (error) => error instanceof TranscriptionError
      && error.code === 'MODEL_NOT_FOUND'
      && error.recoverable === true,
  );
});

test('default-first package API requires an authenticated model manifest', async () => {
  const transcriber = createLocalTranscriber({
    modelDirectory: 'model',
    resolveExecutable: () => 'helper',
  });

  await assert.rejects(
    transcriber.prepare(),
    (error) => error instanceof TranscriptionError
      && error.code === 'MODEL_UNTRUSTED'
      && error.recoverable === false,
  );
});

test('default-first package API rejects malformed audio input with a stable code', async () => {
  const transcriber = createLocalTranscriber({
    modelDirectory: 'model',
    trustedManifestSha256: 'digest',
    resolveExecutable: () => 'helper',
  });

  await assert.rejects(
    transcriber.transcribe({}),
    (error) => error instanceof TranscriptionError
      && error.code === 'AUDIO_INVALID'
      && error.recoverable === true,
  );
});
