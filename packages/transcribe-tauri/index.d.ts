export type TranscriptionErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_INVALID'
  | 'MODEL_UNTRUSTED'
  | 'MODEL_NOT_PREPARED'
  | 'AUDIO_INVALID'
  | 'LANGUAGE_UNSUPPORTED'
  | 'RUNTIME_MISSING'
  | 'PROVIDER_DISABLED'
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'ENGINE_BUSY'
  | 'ENGINE_CRASHED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'DISPOSED'
  | 'INFERENCE_FAILED'
  | 'INTERNAL';

export interface PrepareOptions {
  modelDirectory: string;
  trustedManifestSha256: string;
}

export interface ProviderPrepareOptions {
  provider: 'parakeet' | 'whisper' | 'groq';
  modelId: string;
  apiKey?: string;
}

export interface EngineInformation {
  engineVersion: string;
  modelId: string;
  modelVersion: string;
  loadMs: number;
  reused: boolean;
}

export type AudioInput = {
  path: string;
  bytes?: never;
} | {
  path?: never;
  bytes: Uint8Array;
};

export interface TranscribeOptions {
  language?: string;
}

export interface Transcript {
  text: string;
  outcome: 'speech' | 'no-speech';
  language?: string;
  inferenceMs: number;
}

export interface Diagnostics {
  state: 'idle' | 'ready';
  modelId: string | null;
  modelVersion: string | null;
  lastLoadMs: number | null;
  lastInferenceMs: number | null;
}

export type InvokeCommand = (
  command: string,
  payload?: Record<string, unknown> | Uint8Array,
  options?: { headers?: Record<string, string> },
) => Promise<unknown>;

export type LocalTranscriberOptions = (PrepareOptions | ProviderPrepareOptions) & {
  invoke?: InvokeCommand;
};

export class TranscriptionError extends Error {
  code: TranscriptionErrorCode | (string & {});
  recoverable: boolean;
}

export interface LocalTranscriber {
  prepare(options?: PrepareOptions | ProviderPrepareOptions): Promise<EngineInformation>;
  transcribe(input: AudioInput, options?: TranscribeOptions): Promise<Transcript>;
  diagnostics(): Promise<Diagnostics>;
  dispose(): Promise<void>;
}

export function createTranscriber(options: LocalTranscriberOptions): LocalTranscriber;
export function prepare(
  options: PrepareOptions | ProviderPrepareOptions,
): Promise<EngineInformation>;
export function transcribe(
  input: AudioInput,
  options?: TranscribeOptions,
): Promise<Transcript>;
export function diagnostics(): Promise<Diagnostics>;
export function dispose(): Promise<void>;
