// The Electron preload owns window.chatDemo in Electron. This adapter supplies
// the same narrow host interface when the shared frontend runs inside Tauri.
(() => {
  if (window.chatDemo || !window.__TAURI__?.core?.invoke) return;
  const { invoke } = window.__TAURI__.core;
  const listen = window.__TAURI__.event?.listen;

  const pluginCommand = (command) => `plugin:crunchymurmur-transcribe|${command}`;
  const prepare = (provider, modelId, apiKey = '') => invoke(
    pluginCommand('prepare'),
    { options: { provider, modelId, apiKey } },
  );

  window.chatDemo = {
    bootstrap() {
      return invoke('demo_bootstrap');
    },
    installModel() {
      return invoke('install_model');
    },
    setShortcut(accelerator) {
      return invoke('set_shortcut', { accelerator });
    },
    async setGroqKey(apiKey) {
      const value = String(apiKey || '').trim();
      if (!value) {
        await invoke(pluginCommand('dispose'));
        return { configured: false };
      }
      await prepare('groq', 'whisper-large-v3-turbo', value);
      return { configured: true };
    },
    async transcribeWav(request) {
      const provider = String(request?.provider || '');
      const modelId = provider === 'groq' ? request?.groqModel : request?.modelId;
      await prepare(provider, modelId);
      const bytes = request?.wavBytes instanceof Uint8Array
        ? request.wavBytes
        : new Uint8Array(request?.wavBytes || []);
      return invoke(
        pluginCommand('transcribe_audio'),
        bytes,
        {
          headers: {
            'x-crunchymurmur-language': request?.language || 'auto',
          },
        },
      );
    },
    diagnostics() {
      return invoke(pluginCommand('diagnostics'));
    },
    onModelProgress(callback) {
      if (!listen) return () => {};
      let disposed = false;
      let unlisten;
      listen('model-progress', (event) => callback(event.payload)).then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onShortcutAction(callback) {
      if (!listen) return () => {};
      let disposed = false;
      let unlisten;
      listen('shortcut-action', (event) => callback(event.payload)).then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
})();
