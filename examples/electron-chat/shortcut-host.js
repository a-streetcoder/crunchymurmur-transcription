function defaultShortcut(platform = process.platform) {
  if (platform === 'win32') return 'Control+Super';
  if (platform === 'darwin') return 'Command+Shift+Space';
  return 'Control+Shift+Space';
}

function isWindowsModifierChord(accelerator, platform = process.platform) {
  if (platform !== 'win32') return false;
  const tokens = new Set(
    String(accelerator || '')
      .split('+')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
      .map((token) => (token === 'ctrl' ? 'control' : token === 'win' || token === 'meta' ? 'super' : token)),
  );
  return tokens.size === 2 && tokens.has('control') && tokens.has('super');
}

function createShortcutHost({
  platform = process.platform,
  shortcuts,
  loadKeyboardHook = () => require('uiohook-napi'),
} = {}) {
  const shortcutRegistry = shortcuts || require('electron').globalShortcut;
  let registeredAccelerator = '';
  let hook = null;
  let controlDown = false;
  let superDown = false;
  let chordActive = false;
  let emitAction = null;

  function stop() {
    if (registeredAccelerator && !isWindowsModifierChord(registeredAccelerator, platform)) {
      shortcutRegistry.unregister(registeredAccelerator);
    }
    if (hook) {
      if (chordActive) emitAction?.('stop');
      try {
        hook.uIOhook.removeAllListeners('keydown');
        hook.uIOhook.removeAllListeners('keyup');
        hook.uIOhook.stop();
      } catch {}
    }
    registeredAccelerator = '';
    hook = null;
    controlDown = false;
    superDown = false;
    chordActive = false;
    emitAction = null;
  }

  function register(accelerator, emit) {
    stop();
    const value = String(accelerator || '').trim();
    if (!value) throw new TypeError('A recording shortcut is required.');
    emitAction = emit;
    try {
      if (isWindowsModifierChord(value, platform)) {
        const keyboard = loadKeyboardHook();
        const controlKeys = new Set([keyboard.UiohookKey.Ctrl, keyboard.UiohookKey.CtrlRight]);
        const superKeys = new Set([keyboard.UiohookKey.Meta, keyboard.UiohookKey.MetaRight]);
        keyboard.uIOhook.on('keydown', (event) => {
          if (controlKeys.has(event.keycode)) controlDown = true;
          if (superKeys.has(event.keycode)) superDown = true;
          if (controlDown && superDown && !chordActive) {
            chordActive = true;
            emit('start');
          }
        });
        keyboard.uIOhook.on('keyup', (event) => {
          if (controlKeys.has(event.keycode)) controlDown = false;
          if (superKeys.has(event.keycode)) superDown = false;
          if (chordActive && (!controlDown || !superDown)) {
            chordActive = false;
            emit('stop');
          }
        });
        keyboard.uIOhook.start();
        hook = keyboard;
      } else if (!shortcutRegistry.register(value, () => emit('toggle'))) {
        throw new Error('The selected shortcut is unavailable.');
      }
      registeredAccelerator = value;
      return value;
    } catch (error) {
      stop();
      throw error;
    }
  }

  return { register, stop };
}

module.exports = { createShortcutHost, defaultShortcut, isWindowsModifierChord };
