const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';
const SUPPORTED_MODELS = new Set(['whisper-large-v3-turbo', 'whisper-large-v3']);
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

class GroqTranscriptionError extends Error {
  constructor({ code, message, recoverable = true, cause } = {}) {
    super(message || 'Groq transcription failed.', { cause });
    this.name = 'TranscriptionError';
    this.code = code || 'INTERNAL';
    this.recoverable = recoverable;
  }
}

function failure(code, message, recoverable = true, cause) {
  return new GroqTranscriptionError({ code, message, recoverable, cause });
}

class GroqTranscriber {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    readFile = fs.promises.readFile,
    statFile = fs.promises.stat,
    timeoutMs = 120_000,
    maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.readFile = readFile;
    this.statFile = statFile;
    this.timeoutMs = timeoutMs;
    this.maxAudioBytes = maxAudioBytes;
    this.ready = false;
    this.activeController = null;
    this.lastInferenceMs = null;
  }

  async prepare({ signal } = {}) {
    if (signal?.aborted) throw failure('CANCELLED', 'Transcription cancelled.');
    if (!this.apiKey) {
      throw failure('AUTH_MISSING', 'A Groq API key is required.', true);
    }
    if (!SUPPORTED_MODELS.has(this.model)) {
      throw failure('MODEL_INVALID', 'The selected Groq transcription model is not supported.');
    }
    const reused = this.ready;
    this.ready = true;
    return {
      engineVersion: 'groq-audio-v1',
      modelId: this.model,
      modelVersion: 'hosted',
      loadMs: 0,
      reused,
    };
  }

  async transcribe(input, options = {}) {
    await this.prepare({ signal: options.signal });
    const audioPath = typeof input === 'string' ? input : input?.path;
    if (!String(audioPath || '').trim()) {
      throw failure('AUDIO_INVALID', 'A local audio file path is required.');
    }
    let metadata;
    try {
      metadata = await this.statFile(audioPath);
    } catch {
      throw failure('AUDIO_INVALID', 'The audio file could not be read.');
    }
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > this.maxAudioBytes) {
      throw failure(
        'AUDIO_INVALID',
        `Audio must be a non-empty file no larger than ${Math.floor(this.maxAudioBytes / 1024 / 1024)} MB.`,
      );
    }

    const controller = new AbortController();
    this.activeController?.abort();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    timeout.unref?.();
    const relayAbort = () => controller.abort('cancelled');
    options.signal?.addEventListener('abort', relayAbort, { once: true });
    const started = Date.now();
    try {
      const audio = await this.readFile(audioPath);
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(audioPath));
      form.append('model', this.model);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (options.language && options.language !== 'auto') {
        form.append('language', options.language);
      }
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw await this.#responseError(response);
      const payload = await response.json();
      const text = String(payload?.text || '').trim();
      this.lastInferenceMs = Date.now() - started;
      return {
        text,
        outcome: text ? 'speech' : 'no-speech',
        inferenceMs: this.lastInferenceMs,
        ...(options.language && options.language !== 'auto'
          ? { language: options.language }
          : {}),
      };
    } catch (error) {
      if (error instanceof GroqTranscriptionError) throw error;
      if (controller.signal.aborted) {
        if (options.signal?.aborted || controller.signal.reason === 'cancelled') {
          throw failure('CANCELLED', 'Transcription cancelled.');
        }
        throw failure('TIMED_OUT', 'Groq transcription timed out.');
      }
      throw failure('NETWORK_ERROR', 'Groq could not be reached.', true, error);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', relayAbort);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  diagnostics() {
    return {
      state: this.ready ? 'ready' : 'idle',
      modelId: this.ready ? this.model : null,
      modelVersion: this.ready ? 'hosted' : null,
      lastLoadMs: this.ready ? 0 : null,
      lastInferenceMs: this.lastInferenceMs,
    };
  }

  async dispose() {
    this.activeController?.abort('cancelled');
    this.activeController = null;
    this.ready = false;
    this.apiKey = '';
  }

  async #responseError(response) {
    if (response.status === 401 || response.status === 403) {
      return failure('AUTH_INVALID', 'The Groq API key was rejected.');
    }
    if (response.status === 413) {
      return failure('AUDIO_INVALID', 'The audio file exceeds the Groq account limit.');
    }
    if (response.status === 429) {
      return failure('RATE_LIMITED', 'Groq rate-limited the request. Try again shortly.');
    }
    return failure('INFERENCE_FAILED', `Groq transcription failed with HTTP ${response.status}.`);
  }
}

function createGroqTranscriber(options) {
  return new GroqTranscriber(options);
}

module.exports = {
  DEFAULT_MODEL,
  GroqTranscriber,
  GroqTranscriptionError,
  SUPPORTED_MODELS: [...SUPPORTED_MODELS],
  createGroqTranscriber,
};
