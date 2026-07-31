# `@crunchymurmur/transcribe-groq`

Optional Groq adapter for the CrunchyMurmur transcription SDK. It implements
the same `prepare`, `transcribe`, `diagnostics`, and `dispose` lifecycle as the
on-device adapters, but uploads each audio file to Groq using the host
application's API key.

```js
const { createGroqTranscriber } = require('@crunchymurmur/transcribe-groq');

const transcriber = createGroqTranscriber({
  apiKey: process.env.GROQ_API_KEY,
  model: 'whisper-large-v3-turbo',
});

const result = await transcriber.transcribe(
  { path: '/path/to/audio.wav' },
  { language: 'en' },
);
```

Keep the API key in a privileged desktop process or native credential store.
Do not expose it to an untrusted renderer. The package has no runtime
dependencies and does not persist credentials, audio, or transcripts.

The default 25 MB upload limit matches Groq's free tier. Applications using a
different account limit may set `maxAudioBytes` explicitly.
