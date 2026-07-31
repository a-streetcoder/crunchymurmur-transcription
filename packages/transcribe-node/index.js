const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LocalTranscriptionService,
  findWhisperServer,
  resolveWhisperRuntime,
} = require('./whisper-runtime');

const PARAKEET_LANGUAGES = new Set([
  'auto', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu',
  'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
]);
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 10 * 60 * 1000;

function parakeetSupportsLanguage(language) {
  return PARAKEET_LANGUAGES.has(String(language || 'auto').toLowerCase());
}

function usableExecutable(candidate, platform) {
  try {
    const metadata = fs.statSync(candidate);
    if (!metadata.isFile()) return false;
    if (platform !== 'win32' && (metadata.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveTranscriberExecutable({
  env = process.env,
  platform = process.platform,
  pathSeparator = path.delimiter,
  homeDirectory = os.homedir(),
} = {}) {
  const configured = String(env.CRUNCHYMURMUR_TRANSCRIBER_PATH || '').trim();
  if (configured && usableExecutable(configured, platform)) return configured;
  const executable = platform === 'win32'
    ? 'crunchymurmur-transcriber.exe'
    : 'crunchymurmur-transcriber';
  for (const directory of String(env.PATH || '').split(pathSeparator)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (usableExecutable(candidate, platform)) return candidate;
  }
  const cargoHome = String(env.CARGO_HOME || '').trim()
    || path.join(homeDirectory, '.cargo');
  const cargoRuntime = path.join(cargoHome, 'bin', executable);
  return usableExecutable(cargoRuntime, platform) ? cargoRuntime : '';
}

class TranscriptionError extends Error {
  constructor({ error, errorCode, recoverable } = {}) {
    super(error || 'Local transcription failed.');
    this.name = 'TranscriptionError';
    this.code = errorCode || 'INTERNAL';
    this.recoverable = recoverable !== false;
  }
}

function transcriptionError(errorCode, error, recoverable = true) {
  return new TranscriptionError({ errorCode, error, recoverable });
}

class OnDeviceTranscriber {
  constructor({ resolveExecutable = resolveTranscriberExecutable, spawnProcess = spawn, logger = console, loadTimeoutMs = LOAD_TIMEOUT_MS, inferenceTimeoutMs = INFERENCE_TIMEOUT_MS } = {}) {
    this.resolveExecutable = resolveExecutable;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.child = null;
    this.lines = null;
    this.pending = null;
    this.modelPath = '';
    this.startPromise = null;
    this.startModelPath = '';
    this.loadTimeoutMs = loadTimeoutMs;
    this.inferenceTimeoutMs = inferenceTimeoutMs;
    this.stats = {
      backend: 'transcribe-rs',
      ready: false,
      engineVersion: '',
      modelId: '',
      modelVersion: '',
      reused: false,
      modelPath: '',
      lastLoadMs: null,
      lastInferenceMs: null,
      lastError: '',
    };
  }

  diagnostics() {
    return { ...this.stats, executablePath: this.resolveExecutable?.() || '' };
  }

  async prepare({
    parakeetModelPath,
    requireModelProfile = false,
    trustedManifestSha256 = '',
  }, { signal } = {}) {
    const modelPath = String(parakeetModelPath || '').trim();
    if (!modelPath) {
      throw transcriptionError(
        'MODEL_NOT_FOUND',
        'Download Parakeet V3 before using this engine.',
      );
    }
    if (this.stats.ready && this.modelPath === modelPath) {
      this.stats.reused = true;
      return this.diagnostics();
    }
    while (this.startPromise) {
      if (this.startModelPath === modelPath) return this.startPromise;
      const pendingStart = this.startPromise;
      try { await pendingStart; } catch {}
      if (signal?.aborted) {
        throw transcriptionError('CANCELLED', 'Transcription cancelled.');
      }
      if (this.stats.ready && this.modelPath === modelPath) {
        this.stats.reused = true;
        return this.diagnostics();
      }
    }
    const startPromise = this.#start(
      modelPath,
      signal,
      requireModelProfile,
      trustedManifestSha256,
    );
    this.startPromise = startPromise;
    this.startModelPath = modelPath;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
        this.startModelPath = '';
      }
    }
  }

  async #start(modelPath, signal, requireModelProfile, trustedManifestSha256) {
    this.dispose();
    const executable = this.resolveExecutable?.();
    if (!executable) {
      throw transcriptionError(
        'RUNTIME_MISSING',
        'The bundled local transcription engine is missing.',
      );
    }

    const child = this.spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    child.once('error', (error) => {
      if (this.child !== child) return;
      this.#failPending(transcriptionError(
        'ENGINE_CRASHED',
        `Local transcription engine could not start: ${error.message || error}`,
      ));
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.stats.ready = false;
      this.#failPending(transcriptionError(
        'ENGINE_CRASHED',
        `Local transcription engine exited ${code}: ${stderr.trim() || 'no error output'}`,
      ));
    });

    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', (line) => {
      if (!this.pending) return;
      try {
        const response = JSON.parse(line);
        if (!response.ok) this.#failPending(new TranscriptionError(response));
        else this.#resolvePending(response);
      } catch (error) {
        this.#failPending(transcriptionError(
          'INTERNAL',
          `Invalid response from local transcription engine: ${error.message}`,
        ));
      }
    });

    let response;
    try {
      response = await this.#request({
        action: 'load',
        modelPath,
        requireProfile: Boolean(requireModelProfile),
        trustedManifestSha256,
      }, { signal, timeoutMs: this.loadTimeoutMs });
    } catch (error) {
      if (this.child === child) this.#terminateChild();
      throw error;
    }
    this.modelPath = modelPath;
    this.stats.ready = true;
    this.stats.engineVersion = String(response.engineVersion || '');
    this.stats.modelId = String(response.modelId || '');
    this.stats.modelVersion = String(response.modelVersion || '');
    this.stats.reused = response.reused === true;
    this.stats.modelPath = modelPath;
    this.stats.lastLoadMs = response.loadMs ?? null;
    this.stats.lastError = '';
    this.logger.info?.(`[native-transcription] engine=parakeet modelLoadMs=${this.stats.lastLoadMs}`);
    return this.diagnostics();
  }

  async transcribe(audioPath, settings, { signal } = {}) {
    const result = await this.transcribeDetailed(audioPath, settings, { signal });
    return result.text;
  }

  async transcribeDetailed(audioPath, settings, { signal } = {}) {
    if (!parakeetSupportsLanguage(settings?.language)) {
      throw transcriptionError(
        'LANGUAGE_UNSUPPORTED',
        'Parakeet V3 does not support the selected language. Choose Whisper for broader language support.',
      );
    }
    if (signal?.aborted) {
      throw transcriptionError('CANCELLED', 'Transcription cancelled.');
    }
    await this.prepare(settings, { signal });
    const response = await this.#request({
      action: 'transcribe',
      modelPath: this.modelPath,
      audioPath,
      requireProfile: Boolean(settings?.requireModelProfile),
      trustedManifestSha256: settings?.trustedManifestSha256 || '',
    }, { signal, timeoutMs: this.inferenceTimeoutMs });
    this.stats.lastInferenceMs = response.inferenceMs ?? null;
    this.stats.lastError = '';
    this.logger.info?.(`[native-transcription] engine=parakeet inferenceMs=${this.stats.lastInferenceMs}`);
    const text = String(response.text || '').trim();
    return {
      text,
      outcome: response.outcome === 'no-speech' || !text ? 'no-speech' : 'speech',
      inferenceMs: response.inferenceMs ?? 0,
      ...(settings?.language && settings.language !== 'auto' ? { language: settings.language } : {}),
    };
  }

  #request(message, { signal, timeoutMs } = {}) {
    if (!this.child?.stdin?.writable) {
      return this.#rejectRequest(transcriptionError(
        'ENGINE_CRASHED',
        'Local transcription engine is not running.',
      ));
    }
    if (this.pending) {
      return this.#rejectRequest(transcriptionError(
        'ENGINE_BUSY',
        'Local transcription engine is busy.',
      ));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#failPending(transcriptionError('CANCELLED', 'Transcription cancelled.'));
        this.#terminateChild();
      };
      const timer = timeoutMs ? setTimeout(() => {
        this.#failPending(transcriptionError(
          'TIMED_OUT',
          'Local transcription engine timed out.',
        ));
        this.#terminateChild();
      }, timeoutMs) : null;
      this.pending = { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.#failPending(transcriptionError(
            'ENGINE_CRASHED',
            `Local transcription engine request failed: ${error.message || error}`,
          ));
        }
      });
    }).catch((error) => {
      this.stats.lastError = error.message || String(error);
      throw error;
    });
  }

  #failPending(error) {
    if (!this.pending) return;
    const { reject, timer, cleanup } = this.pending;
    this.pending = null;
    if (timer) clearTimeout(timer);
    cleanup?.();
    reject(error);
  }

  #resolvePending(response) {
    if (!this.pending) return;
    const { resolve, timer, cleanup } = this.pending;
    this.pending = null;
    if (timer) clearTimeout(timer);
    cleanup?.();
    resolve(response);
  }

  #rejectRequest(error) {
    this.stats.lastError = error.message || String(error);
    return Promise.reject(error);
  }

  #terminateChild() {
    const child = this.child;
    this.child = null;
    this.stats.ready = false;
    this.stats.modelPath = '';
    this.modelPath = '';
    try { this.lines?.close(); } catch {}
    this.lines = null;
    try { child?.kill(); } catch {}
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.stats.ready = false;
    this.stats.modelPath = '';
    this.modelPath = '';
    this.#failPending(transcriptionError(
      'DISPOSED',
      'Local transcription engine stopped.',
      false,
    ));
    try { this.lines?.close(); } catch {}
    this.lines = null;
    try { child?.stdin?.end(`${JSON.stringify({ action: 'shutdown' })}\n`); } catch {}
    setTimeout(() => {
      try { if (child && !child.killed) child.kill(); } catch {}
    }, 1_000).unref?.();
  }
}

class LocalTranscriber {
  constructor({
    modelDirectory,
    trustedManifestSha256 = '',
    allowUntrustedProfile = false,
    ...options
  } = {}) {
    this.modelDirectory = String(modelDirectory || '').trim();
    this.trustedManifestSha256 = String(trustedManifestSha256 || '').trim();
    this.allowUntrustedProfile = allowUntrustedProfile === true;
    this.adapter = new OnDeviceTranscriber(options);
  }

  async prepare({ signal } = {}) {
    this.#assertModelTrust();
    const diagnostics = await this.adapter.prepare(
      {
        parakeetModelPath: this.modelDirectory,
        requireModelProfile: true,
        trustedManifestSha256: this.trustedManifestSha256,
      },
      { signal },
    );
    return {
      engineVersion: diagnostics.engineVersion,
      modelId: diagnostics.modelId,
      modelVersion: diagnostics.modelVersion,
      loadMs: diagnostics.lastLoadMs,
      reused: diagnostics.reused,
    };
  }

  async transcribe(input, options = {}) {
    this.#assertModelTrust();
    const audioPath = typeof input === 'string' ? input : input?.path;
    if (!String(audioPath || '').trim()) {
      throw transcriptionError('AUDIO_INVALID', 'A local audio file path is required.');
    }
    return this.adapter.transcribeDetailed(
      audioPath,
      {
        parakeetModelPath: this.modelDirectory,
        requireModelProfile: true,
        trustedManifestSha256: this.trustedManifestSha256,
        language: options.language || 'auto',
      },
      { signal: options.signal },
    );
  }

  diagnostics() {
    const diagnostics = this.adapter.diagnostics();
    const ready = diagnostics.ready === true;
    return {
      state: ready ? 'ready' : 'idle',
      modelId: ready ? diagnostics.modelId || null : null,
      modelVersion: ready ? diagnostics.modelVersion || null : null,
      lastLoadMs: diagnostics.lastLoadMs,
      lastInferenceMs: diagnostics.lastInferenceMs,
    };
  }

  async dispose() {
    this.adapter.dispose();
  }

  #assertModelTrust() {
    if (this.trustedManifestSha256 || this.allowUntrustedProfile) return;
    throw new TranscriptionError({
      error: 'An authenticated Model Profile manifest digest is required.',
      errorCode: 'MODEL_UNTRUSTED',
      recoverable: false,
    });
  }
}

class WhisperTranscriber {
  constructor({
    modelPath,
    whisperCliPath = '',
    resolveRuntime = resolveWhisperRuntime,
    service,
    logger = console,
    ...serviceOptions
  } = {}) {
    this.modelPath = String(modelPath || '').trim();
    this.whisperCliPath = String(whisperCliPath || '').trim();
    this.resolveRuntime = resolveRuntime;
    this.logger = logger;
    this.service = service || new LocalTranscriptionService({
      ...serviceOptions,
      logger,
      resolveRuntime,
    });
    this.prepared = false;
    this.lastLoadMs = null;
    this.lastInferenceMs = null;
  }

  async prepare({ signal } = {}) {
    const runtime = this.#assertConfiguration();
    const reused = this.prepared;
    const started = Date.now();
    try {
      await this.service.prepare({
        whisperCliPath: this.whisperCliPath,
        modelPath: this.modelPath,
      }, { signal });
    } catch (error) {
      if (!runtime.cliPath) throw this.#mapError(error);
      this.logger.warn?.(`[whisper-transcription] warm server unavailable; CLI fallback remains ready: ${error.message || error}`);
    }
    this.prepared = true;
    const diagnostics = this.service.diagnostics();
    this.lastLoadMs = diagnostics.lastLoadMs ?? (Date.now() - started);
    return {
      engineVersion: 'whisper.cpp',
      modelId: this.#modelId(),
      modelVersion: 'ggml',
      loadMs: this.lastLoadMs,
      reused,
    };
  }

  async transcribe(input, options = {}) {
    const audioPath = typeof input === 'string' ? input : input?.path;
    if (!String(audioPath || '').trim()) {
      throw transcriptionError('AUDIO_INVALID', 'A local audio file path is required.');
    }
    await this.prepare({ signal: options.signal });
    try {
      const text = String(await this.service.transcribe(
        audioPath,
        {
          whisperCliPath: this.whisperCliPath,
          modelPath: this.modelPath,
          language: options.language || 'auto',
        },
        { signal: options.signal },
      ) || '').trim();
      this.lastInferenceMs = this.service.diagnostics().lastInferenceMs ?? 0;
      return {
        text,
        outcome: text ? 'speech' : 'no-speech',
        inferenceMs: this.lastInferenceMs,
        ...(options.language && options.language !== 'auto'
          ? { language: options.language }
          : {}),
      };
    } catch (error) {
      throw this.#mapError(error);
    }
  }

  diagnostics() {
    return {
      state: this.prepared ? 'ready' : 'idle',
      modelId: this.prepared ? this.#modelId() : null,
      modelVersion: this.prepared ? 'ggml' : null,
      lastLoadMs: this.lastLoadMs,
      lastInferenceMs: this.lastInferenceMs,
    };
  }

  async dispose() {
    this.service.dispose();
    this.prepared = false;
  }

  #assertConfiguration() {
    try {
      if (!fs.statSync(this.modelPath).isFile()) throw new Error('not a file');
    } catch {
      throw transcriptionError('MODEL_NOT_FOUND', 'A local Whisper GGML model is required.');
    }
    const discovered = this.resolveRuntime?.() || {};
    const runtime = this.whisperCliPath
      ? {
        cliPath: this.whisperCliPath,
        serverPath: findWhisperServer(this.whisperCliPath),
      }
      : discovered;
    if (!runtime.cliPath && !runtime.serverPath) {
      throw transcriptionError('RUNTIME_MISSING', 'The whisper.cpp runtime is missing.');
    }
    return runtime;
  }

  #modelId() {
    return path.basename(this.modelPath).replace(/^ggml-/, '').replace(/\.bin$/i, '') || 'whisper';
  }

  #mapError(error) {
    if (error instanceof TranscriptionError) return error;
    if (error?.name === 'AbortError' || /cancel/i.test(String(error?.message || ''))) {
      return transcriptionError('CANCELLED', 'Transcription cancelled.');
    }
    if (/timed out/i.test(String(error?.message || ''))) {
      return transcriptionError('TIMED_OUT', 'Local Whisper transcription timed out.');
    }
    return transcriptionError(
      'INFERENCE_FAILED',
      `Local Whisper transcription failed: ${error?.message || error}`,
    );
  }
}

function createLocalTranscriber(options) {
  return new LocalTranscriber(options);
}

function createWhisperTranscriber(options) {
  return new WhisperTranscriber(options);
}

module.exports = {
  createLocalTranscriber,
  createWhisperTranscriber,
  LocalTranscriber,
  WhisperTranscriber,
  NativeTranscriptionError: TranscriptionError,
  NativeTranscriptionService: OnDeviceTranscriber,
  OnDeviceTranscriber,
  TranscriptionError,
  parakeetSupportsLanguage,
  resolveTranscriberExecutable,
  resolveWhisperRuntime,
};
