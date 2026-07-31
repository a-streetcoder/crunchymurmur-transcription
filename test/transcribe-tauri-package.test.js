const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');

test('Tauri guest adapter maps the default-first API to scoped plugin commands', async () => {
  const { createTranscriber } = await import('../packages/transcribe-tauri/index.js');
  const calls = [];
  const transcriber = createTranscriber(async (command, payload) => {
    calls.push({ command, payload });
    if (command.endsWith('|prepare')) {
      return { modelId: 'parakeet-v3-int8', modelVersion: '1.0.0' };
    }
    if (command.endsWith('|transcribe')) {
      return { text: 'hello', outcome: 'speech', inferenceMs: 12 };
    }
    return null;
  });

  await transcriber.prepare({
    modelDirectory: '/models/parakeet',
    trustedManifestSha256: 'digest',
  });
  const result = await transcriber.transcribe(
    { path: '/audio/message.wav' },
    { language: 'en' },
  );
  await transcriber.dispose();

  assert.equal(result.text, 'hello');
  assert.deepEqual(calls, [
    {
      command: 'plugin:crunchymurmur-transcribe|prepare',
      payload: {
        options: {
          modelDirectory: '/models/parakeet',
          trustedManifestSha256: 'digest',
        },
      },
    },
    {
      command: 'plugin:crunchymurmur-transcribe|transcribe',
      payload: {
        input: { path: '/audio/message.wav' },
        options: { language: 'en' },
      },
    },
    {
      command: 'plugin:crunchymurmur-transcribe|dispose',
      payload: undefined,
    },
  ]);
});

test('Tauri guest adapter rejects malformed audio before invoking Rust', async () => {
  const { createTranscriber, TranscriptionError } = await import(
    '../packages/transcribe-tauri/index.js'
  );
  const transcriber = createTranscriber(async () => {
    throw new Error('invoke should not be called');
  });

  await assert.rejects(
    transcriber.transcribe({}),
    (error) => error instanceof TranscriptionError
      && error.code === 'AUDIO_INVALID',
  );

  for (const path of [42, {}, ['message.wav']]) {
    await assert.rejects(
      transcriber.transcribe({ path }),
      (error) => error instanceof TranscriptionError
        && error.code === 'AUDIO_INVALID',
    );
  }
});

test('Tauri guest adapter supports provider configuration and raw microphone audio', async () => {
  const { createTranscriber } = await import('../packages/transcribe-tauri/index.js');
  const calls = [];
  const transcriber = createTranscriber({
    provider: 'whisper',
    modelId: 'whisper:large-v3-turbo-q5_0',
    invoke: async (command, payload, options) => {
      calls.push({ command, payload, options });
      if (command.endsWith('|prepare')) {
        return { modelId: 'whisper:large-v3-turbo-q5_0', reused: false };
      }
      return { text: 'Tauri transcript', outcome: 'speech', inferenceMs: 19 };
    },
  });

  await transcriber.prepare();
  const result = await transcriber.transcribe(
    { bytes: Uint8Array.from([82, 73, 70, 70]) },
    { language: 'en' },
  );

  assert.equal(result.text, 'Tauri transcript');
  assert.deepEqual(calls[0], {
    command: 'plugin:crunchymurmur-transcribe|prepare',
    payload: {
      options: {
        provider: 'whisper',
        modelId: 'whisper:large-v3-turbo-q5_0',
        apiKey: '',
      },
    },
    options: undefined,
  });
  assert.equal(calls[1].command, 'plugin:crunchymurmur-transcribe|transcribe_audio');
  assert.deepEqual([...calls[1].payload], [82, 73, 70, 70]);
  assert.deepEqual(calls[1].options, {
    headers: { 'x-crunchymurmur-language': 'en' },
  });
});

test('Tauri demo build permits the internal transport required for raw microphone audio', () => {
  execFileSync(process.execPath, ['prepare-frontend.js'], {
    cwd: path.join(repositoryRoot, 'examples', 'tauri-chat'),
    stdio: 'pipe',
  });
  const html = fs.readFileSync(
    path.join(repositoryRoot, 'examples', 'tauri-chat', 'dist', 'index.html'),
    'utf8',
  );

  assert.match(html, /connect-src[^"]*ipc:/);
  assert.match(html, /connect-src[^"]*http:\/\/ipc\.localhost/);
});

test('provider-specific demo fields remain hidden outside their provider', () => {
  const stylesheet = fs.readFileSync(
    path.join(repositoryRoot, 'examples', 'electron-chat', 'styles.css'),
    'utf8',
  );

  assert.match(stylesheet, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test('the normal Tauri demo launch uses release optimisations', () => {
  const demoPackage = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'examples', 'tauri-chat', 'package.json'),
    'utf8',
  ));

  assert.match(demoPackage.scripts.start, /\btauri dev --release\b/);
  assert.match(demoPackage.scripts['start:debug'], /\btauri dev\b/);
  assert.doesNotMatch(demoPackage.scripts['start:debug'], /--release/);
});
