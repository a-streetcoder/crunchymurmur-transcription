const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatDemo', {
  bootstrap() {
    return ipcRenderer.invoke('chat-demo:bootstrap');
  },
  installModel() {
    return ipcRenderer.invoke('chat-demo:install-model');
  },
  setShortcut(accelerator) {
    return ipcRenderer.invoke('chat-demo:set-shortcut', accelerator);
  },
  setGroqKey(apiKey) {
    return ipcRenderer.invoke('chat-demo:set-groq-key', apiKey);
  },
  transcribeWav(request) {
    return ipcRenderer.invoke('chat-demo:transcribe', request);
  },
  diagnostics() {
    return ipcRenderer.invoke('chat-demo:diagnostics');
  },
  onModelProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('chat-demo:model-progress', listener);
    return () => ipcRenderer.removeListener('chat-demo:model-progress', listener);
  },
  onShortcutAction(callback) {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('chat-demo:shortcut-action', listener);
    return () => ipcRenderer.removeListener('chat-demo:shortcut-action', listener);
  },
});
