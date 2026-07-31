const i18n = window.demoI18n;
i18n.apply();

const elements = {
  setup: document.querySelector('#setup'),
  engine: document.querySelector('#engine'),
  privacyHint: document.querySelector('#privacyHint'),
  modelField: document.querySelector('#modelField'),
  model: document.querySelector('#model'),
  modelHint: document.querySelector('#modelHint'),
  installModel: document.querySelector('#installModel'),
  modelProgress: document.querySelector('#modelProgress'),
  groqField: document.querySelector('#groqField'),
  groqKey: document.querySelector('#groqKey'),
  saveGroqKey: document.querySelector('#saveGroqKey'),
  groqKeyHint: document.querySelector('#groqKeyHint'),
  microphone: document.querySelector('#microphone'),
  refreshMicrophones: document.querySelector('#refreshMicrophones'),
  language: document.querySelector('#language'),
  shortcutDisplay: document.querySelector('#shortcutDisplay'),
  shortcutHint: document.querySelector('#shortcutHint'),
  recordShortcut: document.querySelector('#recordShortcut'),
  conversation: document.querySelector('#conversation'),
  emptyState: document.querySelector('#emptyState'),
  message: document.querySelector('#message'),
  record: document.querySelector('#record'),
  recordLabel: document.querySelector('#recordLabel'),
  send: document.querySelector('#send'),
  status: document.querySelector('#status'),
  statusText: document.querySelector('#statusText'),
};

let audioContext;
let mediaStream;
let recorderNode;
let silentGain;
let chunks = [];
let recording = false;
let maximumTimer;
let availableModels = [];
let platform = '';
let shortcut = '';
let capturingShortcut = false;
let groqConfigured = false;

const GROQ_MODELS = [
  { id: 'whisper-large-v3-turbo', engine: 'groq', name: 'Whisper Large V3 Turbo' },
  { id: 'whisper-large-v3', engine: 'groq', name: 'Whisper Large V3' },
];
const PARAKEET_LANGUAGES = new Set([
  'auto', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el',
  'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv',
  'ru', 'uk',
]);

function setStatus(key, busy = false, values) {
  elements.statusText.textContent = i18n.t(key, values);
  elements.status.classList.toggle('busy', busy);
}

function savedConfiguration() {
  try {
    return JSON.parse(localStorage.getItem('crunchymurmur-sdk-demo') || '{}');
  } catch {
    return {};
  }
}

function configuration() {
  return {
    provider: elements.engine.value,
    modelId: elements.model.value,
    microphoneId: elements.microphone.value,
    language: elements.language.value,
    shortcut,
  };
}

function persistConfiguration() {
  localStorage.setItem('crunchymurmur-sdk-demo', JSON.stringify(configuration()));
}

function addMessage(text, kind) {
  elements.emptyState.hidden = true;
  const message = document.createElement('div');
  message.className = `message ${kind}`;
  message.textContent = text;
  elements.conversation.append(message);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function sendMessage() {
  const text = elements.message.value.trim();
  if (!text) return;
  addMessage(text, 'user');
  elements.message.value = '';
  window.setTimeout(() => addMessage(i18n.t('demoReply'), 'assistant'), 260);
}

function mergeSamples(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return samples;
}

function encodeWav(samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

function modelDescription(model) {
  if (!model) return '';
  if (model.engine === 'groq') return i18n.t('groqModelHint');
  const size = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 0 })
    .format(model.bytes / 1024 / 1024);
  return i18n.t(model.engine === 'parakeet' ? 'parakeetModelHint' : 'whisperModelHint', { size });
}

function modelsForProvider(provider) {
  if (provider === 'groq') return GROQ_MODELS;
  return availableModels.filter((model) => model.engine === provider);
}

function providerIsReady(provider) {
  return provider === 'groq' ? groqConfigured : modelsForProvider(provider).length > 0;
}

function renderModels(selectedModelId = '') {
  const provider = elements.engine.value;
  const providerModels = modelsForProvider(provider);
  elements.model.replaceChildren();
  for (const model of providerModels) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    elements.model.append(option);
  }
  if (!providerModels.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = i18n.t('noModel');
    elements.model.append(option);
  }
  const selected = providerModels.find((model) => model.id === selectedModelId) || providerModels[0];
  elements.model.value = selected?.id || '';
  elements.modelHint.textContent = modelDescription(selected) || i18n.t(
    provider === 'whisper' ? 'noWhisperModel' : 'modelHint',
  );
  elements.installModel.hidden = provider !== 'parakeet' || Boolean(selected);
  elements.model.disabled = !selected;
}

function renderProvider(selectedModelId = '') {
  const provider = elements.engine.value;
  elements.groqField.hidden = provider !== 'groq';
  elements.privacyHint.textContent = i18n.t(provider === 'groq' ? 'privacyCloud' : 'privacyLocal');
  for (const option of elements.language.options) {
    option.hidden = provider === 'parakeet' && !PARAKEET_LANGUAGES.has(option.value);
  }
  if (elements.language.selectedOptions[0]?.hidden) elements.language.value = 'auto';
  renderModels(selectedModelId);
  persistConfiguration();
  setStatus(providerIsReady(provider)
    ? 'ready'
    : provider === 'groq' ? 'groqKeyRequired' : 'modelRequired');
}

async function refreshMicrophones(requestPermission = false) {
  const selected = elements.microphone.value || savedConfiguration().microphoneId || '';
  if (requestPermission) {
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
    } catch {
      setStatus('microphoneDenied');
    }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  elements.microphone.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = i18n.t('systemDefault');
  elements.microphone.append(defaultOption);
  microphones
    .filter((device) => device.deviceId !== 'default')
    .forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || i18n.t('microphoneNumber', { number: index + 1 });
      elements.microphone.append(option);
    });
  if ([...elements.microphone.options].some((option) => option.value === selected)) {
    elements.microphone.value = selected;
  }
  persistConfiguration();
}

function renderShortcut(value) {
  elements.shortcutDisplay.replaceChildren();
  String(value || '').split('+').filter(Boolean).forEach((token, index) => {
    if (index) elements.shortcutDisplay.append(document.createTextNode(' + '));
    const key = document.createElement('kbd');
    const labels = { Control: 'Ctrl', Command: '⌘', Super: platform === 'win32' ? 'Win' : 'Super' };
    key.textContent = labels[token] || token;
    elements.shortcutDisplay.append(key);
  });
}

function acceleratorKey(event) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  const keys = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home',
    End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up',
    ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return keys[event.code] || null;
}

async function applyShortcut(value) {
  try {
    shortcut = await window.chatDemo.setShortcut(value);
    renderShortcut(shortcut);
    elements.shortcutHint.textContent = shortcut === 'Control+Super'
      ? i18n.t('shortcutHoldHint')
      : i18n.t('shortcutToggleHint');
    persistConfiguration();
    const provider = elements.engine.value;
    setStatus(providerIsReady(provider)
      ? 'ready'
      : provider === 'groq' ? 'groqKeyRequired' : 'modelRequired');
    return true;
  } catch {
    elements.shortcutHint.textContent = i18n.t('shortcutUnavailable');
    setStatus('shortcutUnavailable');
    return false;
  }
}

async function startRecording() {
  if (elements.engine.value === 'groq' && !groqConfigured) {
    elements.setup.open = true;
    elements.groqKey.focus();
    setStatus('groqKeyRequired');
    return;
  }
  if (!elements.model.value) {
    elements.setup.open = true;
    setStatus('modelRequired');
    return;
  }
  try {
    const microphoneId = elements.microphone.value;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    audioContext = new AudioContext({ sampleRate: 16_000 });
    await audioContext.audioWorklet.addModule('./recorder-worklet.js');
    const source = audioContext.createMediaStreamSource(mediaStream);
    recorderNode = new AudioWorkletNode(audioContext, 'crunchymurmur-recorder');
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    recorderNode.port.onmessage = ({ data }) => chunks.push(new Float32Array(data));
    source.connect(recorderNode).connect(silentGain).connect(audioContext.destination);
    chunks = [];
    recording = true;
    elements.record.classList.add('active');
    elements.recordLabel.textContent = i18n.t('stop');
    setStatus('recording', true);
    maximumTimer = window.setTimeout(stopRecording, 60_000);
  } catch {
    mediaStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => {});
    mediaStream = null;
    audioContext = null;
    recorderNode = null;
    silentGain = null;
    chunks = [];
    recording = false;
    setStatus('microphoneDenied');
  }
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  window.clearTimeout(maximumTimer);
  elements.record.classList.remove('active');
  elements.recordLabel.textContent = i18n.t('record');
  recorderNode?.disconnect();
  silentGain?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  const sampleRate = audioContext?.sampleRate || 48_000;
  await audioContext?.close();
  const samples = mergeSamples(chunks);
  chunks = [];
  if (!samples.length) {
    setStatus('microphoneDenied');
    return;
  }
  setStatus('transcribing', true);
  try {
    const result = await window.chatDemo.transcribeWav({
      provider: elements.engine.value,
      modelId: elements.engine.value === 'groq' ? undefined : elements.model.value,
      groqModel: elements.engine.value === 'groq' ? elements.model.value : undefined,
      language: elements.language.value,
      wavBytes: encodeWav(samples, sampleRate),
    });
    if (result.outcome === 'speech') {
      const current = elements.message.value.trim();
      elements.message.value = current ? `${current} ${result.text}` : result.text;
      elements.message.focus();
    } else {
      setStatus('noSpeech');
      return;
    }
    setStatus('ready');
  } catch (error) {
    console.error('[chat-demo] transcription failed', error);
    setStatus('transcriptionFailed');
  }
}

async function installModel() {
  elements.installModel.disabled = true;
  elements.modelProgress.hidden = false;
  setStatus('downloadingModel', true, { percent: 0 });
  try {
    const result = await window.chatDemo.installModel();
    availableModels = result.models;
    renderModels(result.selectedModelId);
    persistConfiguration();
    elements.modelProgress.hidden = true;
    setStatus('ready');
  } catch (error) {
    console.error('[chat-demo] model installation failed', error);
    setStatus('modelDownloadFailed');
    elements.modelProgress.hidden = true;
  } finally {
    elements.installModel.disabled = false;
  }
}

elements.installModel.addEventListener('click', installModel);
elements.engine.addEventListener('change', () => renderProvider());
elements.saveGroqKey.addEventListener('click', async () => {
  try {
    const result = await window.chatDemo.setGroqKey(elements.groqKey.value);
    groqConfigured = result.configured;
    elements.groqKey.value = '';
    elements.groqKeyHint.textContent = i18n.t(groqConfigured ? 'groqReady' : 'groqKeyHint');
    setStatus(groqConfigured ? 'ready' : 'groqKeyRequired');
  } catch {
    setStatus('groqKeyRequired');
  }
});
elements.refreshMicrophones.addEventListener('click', () => refreshMicrophones(true));
elements.model.addEventListener('change', () => {
  const selected = modelsForProvider(elements.engine.value)
    .find((model) => model.id === elements.model.value);
  elements.modelHint.textContent = modelDescription(selected) || i18n.t('modelHint');
  persistConfiguration();
});
elements.microphone.addEventListener('change', persistConfiguration);
elements.language.addEventListener('change', persistConfiguration);
elements.recordShortcut.addEventListener('click', () => {
  capturingShortcut = !capturingShortcut;
  elements.recordShortcut.textContent = i18n.t(capturingShortcut ? 'cancel' : 'changeShortcut');
  elements.shortcutHint.textContent = i18n.t(capturingShortcut ? 'pressShortcut' : 'shortcutHint');
  if (capturingShortcut) elements.recordShortcut.blur();
});
elements.record.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});
elements.send.addEventListener('click', sendMessage);
elements.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener('keydown', async (event) => {
  if (!capturingShortcut) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    capturingShortcut = false;
    elements.recordShortcut.textContent = i18n.t('changeShortcut');
    renderShortcut(shortcut);
    return;
  }
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push(platform === 'darwin' ? 'Command' : 'Super');
  const modifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key);
  if (modifierOnly) {
    renderShortcut(modifiers.join('+'));
    if (platform === 'win32' && modifiers.length === 2
        && modifiers.includes('Control') && modifiers.includes('Super')) {
      capturingShortcut = false;
      elements.recordShortcut.textContent = i18n.t('changeShortcut');
      await applyShortcut('Control+Super');
    }
    return;
  }
  const key = acceleratorKey(event);
  if (!key || modifiers.length === 0) {
    elements.shortcutHint.textContent = i18n.t('pressSupportedShortcut');
    return;
  }
  const candidate = [...modifiers, key].join('+');
  renderShortcut(candidate);
  capturingShortcut = false;
  elements.recordShortcut.textContent = i18n.t('changeShortcut');
  await applyShortcut(candidate);
}, true);

window.chatDemo.onModelProgress(({ bytesDone, bytesTotal }) => {
  const percent = Math.min(100, Math.round((bytesDone / bytesTotal) * 100));
  elements.modelProgress.value = percent;
  setStatus('downloadingModel', true, { percent });
});
window.chatDemo.onShortcutAction((action) => {
  if (action === 'start' && !recording) startRecording();
  if (action === 'stop' && recording) stopRecording();
  if (action === 'toggle') {
    if (recording) stopRecording();
    else startRecording();
  }
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshMicrophones(false));

async function initialise() {
  const saved = savedConfiguration();
  const bootstrap = await window.chatDemo.bootstrap();
  availableModels = bootstrap.models;
  platform = bootstrap.platform;
  groqConfigured = bootstrap.groqConfigured;
  const savedProvider = ['parakeet', 'whisper', 'groq'].includes(saved.provider)
    ? saved.provider
    : 'parakeet';
  elements.engine.value = savedProvider;
  elements.language.value = saved.language || 'auto';
  renderProvider(saved.modelId);
  elements.groqKeyHint.textContent = i18n.t(groqConfigured ? 'groqReady' : 'groqKeyHint');
  shortcut = saved.shortcut || bootstrap.defaultShortcut;
  renderShortcut(shortcut);
  await applyShortcut(shortcut);
  await refreshMicrophones(true);
  persistConfiguration();
  const providerReady = providerIsReady(savedProvider);
  elements.setup.open = !providerReady;
  setStatus(providerReady ? 'ready' : savedProvider === 'groq' ? 'groqKeyRequired' : 'modelRequired');
}

initialise().catch((error) => {
  console.error('[chat-demo] initialisation failed', error);
  elements.setup.open = true;
  setStatus('initialisationFailed');
});
