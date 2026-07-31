const COMMAND_PREFIX = 'plugin:crunchymurmur-transcribe';

async function defaultInvoke(command, payload, options) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, payload, options);
}

export class TranscriptionError extends Error {
  constructor({ code = 'INTERNAL', message = 'Local transcription failed.', recoverable = true } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.recoverable = recoverable;
  }

  static from(error) {
    if (error instanceof TranscriptionError) return error;
    if (error && typeof error === 'object') {
      return new TranscriptionError(error);
    }
    return new TranscriptionError({ message: String(error || 'Local transcription failed.') });
  }
}

export function createTranscriber(configuration = {}) {
  const legacyInvoke = typeof configuration === 'function' ? configuration : null;
  const invokeCommand = legacyInvoke || configuration.invoke || defaultInvoke;
  let configuredPreparation = legacyInvoke ? null : configuration.provider
    ? {
      provider: configuration.provider,
      modelId: configuration.modelId,
      apiKey: configuration.apiKey || '',
    }
    : {
      modelDirectory: configuration.modelDirectory,
      trustedManifestSha256: configuration.trustedManifestSha256,
    };
  const call = async (command, payload, invokeOptions) => {
    try {
      return await invokeCommand(`${COMMAND_PREFIX}|${command}`, payload, invokeOptions);
    } catch (error) {
      throw TranscriptionError.from(error);
    }
  };

  return {
    prepare(options = configuredPreparation) {
      return call('prepare', { options });
    },
    transcribe(input, options = {}) {
      if (input?.bytes instanceof Uint8Array && input.bytes.byteLength > 0) {
        return call(
          'transcribe_audio',
          input.bytes,
          {
            headers: {
              'x-crunchymurmur-language': options.language || 'auto',
            },
          },
        );
      }
      if (typeof input?.path !== 'string' || !input.path.trim()) {
        return Promise.reject(new TranscriptionError({
          code: 'AUDIO_INVALID',
          message: 'A local audio file path is required.',
          recoverable: true,
        }));
      }
      return call('transcribe', { input, options });
    },
    diagnostics() {
      return call('diagnostics');
    },
    dispose() {
      const result = call('dispose');
      if (configuredPreparation && 'apiKey' in configuredPreparation) {
        configuredPreparation.apiKey = '';
      }
      return result;
    },
  };
}

const transcriber = createTranscriber();

export const prepare = transcriber.prepare;
export const transcribe = transcriber.transcribe;
export const diagnostics = transcriber.diagnostics;
export const dispose = transcriber.dispose;
