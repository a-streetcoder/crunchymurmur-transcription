const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GroqTranscriptionError,
  createGroqTranscriber,
} = require('../packages/transcribe-groq');

test('Groq adapter uses BYO credentials behind the shared lifecycle', async () => {
  const requests = [];
  const transcriber = createGroqTranscriber({
    apiKey: 'test-secret',
    model: 'whisper-large-v3-turbo',
    statFile: async () => ({ isFile: () => true, size: 128 }),
    readFile: async () => Buffer.from('wav'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ text: 'Cloud transcript' });
    },
  });

  assert.equal((await transcriber.prepare()).modelId, 'whisper-large-v3-turbo');
  const transcript = await transcriber.transcribe(
    { path: 'voice.wav' },
    { language: 'it' },
  );
  assert.deepEqual({
    ...transcript,
    inferenceMs: 0,
  }, {
    text: 'Cloud transcript',
    outcome: 'speech',
    language: 'it',
    inferenceMs: 0,
  });
  assert.equal(Number.isFinite(transcript.inferenceMs), true);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(requests[0].options.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(requests[0].options.body.get('language'), 'it');
  assert.equal(JSON.stringify(transcriber.diagnostics()).includes('test-secret'), false);
  await transcriber.dispose();
  assert.equal(transcriber.diagnostics().state, 'idle');
});

test('Groq adapter maps credentials and rate limits to stable errors', async () => {
  const missing = createGroqTranscriber({ apiKey: '' });
  await assert.rejects(
    missing.prepare(),
    (error) => error instanceof GroqTranscriptionError && error.code === 'AUTH_MISSING',
  );

  const limited = createGroqTranscriber({
    apiKey: 'test-secret',
    statFile: async () => ({ isFile: () => true, size: 128 }),
    readFile: async () => Buffer.from('wav'),
    fetchImpl: async () => new Response('slow down', { status: 429 }),
  });
  await assert.rejects(
    limited.transcribe({ path: 'voice.wav' }),
    (error) => error instanceof GroqTranscriptionError && error.code === 'RATE_LIMITED',
  );
});
