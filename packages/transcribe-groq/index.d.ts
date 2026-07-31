export type GroqTranscriptionErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'MODEL_INVALID'
  | 'AUDIO_INVALID'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'INFERENCE_FAILED'
  | 'INTERNAL';

export interface AudioInput {
  path: string;
}

export interface Transcript {
  text: string;
  outcome: 'speech' | 'no-speech';
  language?: string;
  inferenceMs: number;
}

export interface EngineInformation {
  engineVersion: string;
  modelId: string;
  modelVersion: string;
  loadMs: number;
  reused: boolean;
}

export interface Diagnostics {
  state: 'idle' | 'ready';
  modelId: string | null;
  modelVersion: string | null;
  lastLoadMs: number | null;
  lastInferenceMs: number | null;
}

export interface GroqTranscriberOptions {
  apiKey: string;
  model?: 'whisper-large-v3-turbo' | 'whisper-large-v3';
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

export class GroqTranscriptionError extends Error {
  code: GroqTranscriptionErrorCode | (string & {});
  recoverable: boolean;
}

export class GroqTranscriber {
  constructor(options: GroqTranscriberOptions);
  prepare(options?: { signal?: AbortSignal }): Promise<EngineInformation>;
  transcribe(
    input: AudioInput | string,
    options?: { language?: string; signal?: AbortSignal },
  ): Promise<Transcript>;
  diagnostics(): Diagnostics;
  dispose(): Promise<void>;
}

export const DEFAULT_MODEL: 'whisper-large-v3-turbo';
export const SUPPORTED_MODELS: readonly ['whisper-large-v3-turbo', 'whisper-large-v3'];
export function createGroqTranscriber(options: GroqTranscriberOptions): GroqTranscriber;
