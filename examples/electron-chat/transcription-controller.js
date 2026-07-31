const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_WAV_BYTES = 25 * 1024 * 1024;

function createTranscriptionController({
  createTranscriber,
  temporaryDirectory = os.tmpdir(),
  fileSystem = fs,
} = {}) {
  if (typeof createTranscriber !== 'function') {
    throw new TypeError('createTranscriber is required.');
  }

  let transcriber = null;
  let activeConfiguration = '';
  let operationQueue = Promise.resolve();

  async function configuredTranscriber(configuration) {
    const configurationKey = String(configuration?.key || '').trim();
    if (!configurationKey) throw new TypeError('A transcriber configuration is required.');
    if (transcriber && configurationKey === activeConfiguration) return transcriber;
    await transcriber?.dispose();
    transcriber = createTranscriber(configuration);
    activeConfiguration = configurationKey;
    const localTranscriber = transcriber;
    await localTranscriber.prepare();
    return localTranscriber;
  }

  function serialise(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    transcribeWav({
      wavBytes,
      transcriberConfiguration,
      language = 'auto',
    } = {}) {
      if (!(wavBytes instanceof Uint8Array) || wavBytes.byteLength === 0) {
        throw new TypeError('Recorded WAV audio is required.');
      }
      if (wavBytes.byteLength > MAX_WAV_BYTES) {
        throw new TypeError('Recorded WAV audio exceeds the 25 MB demo limit.');
      }
      return serialise(async () => {
        const engine = await configuredTranscriber(transcriberConfiguration);
        fileSystem.mkdirSync(temporaryDirectory, { recursive: true });
        const audioPath = path.join(
          temporaryDirectory,
          `crunchymurmur-chat-${crypto.randomUUID()}.wav`,
        );
        try {
          fileSystem.writeFileSync(audioPath, wavBytes, { mode: 0o600 });
          return await engine.transcribe({ path: audioPath }, { language });
        } finally {
          try {
            fileSystem.rmSync(audioPath, { force: true });
          } catch {}
        }
      });
    },

    async diagnostics() {
      return transcriber?.diagnostics() || {
        state: 'idle',
        modelId: null,
        modelVersion: null,
        lastLoadMs: null,
        lastInferenceMs: null,
      };
    },

    async dispose() {
      await operationQueue;
      await transcriber?.dispose();
      transcriber = null;
      activeConfiguration = '';
    },
  };
}

module.exports = { createTranscriptionController, MAX_WAV_BYTES };
