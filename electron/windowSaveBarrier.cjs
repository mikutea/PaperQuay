const { randomUUID } = require('node:crypto');

// Wait for Reader settings and protect in-memory note drafts before closing.
// Failed or unresponsive renderers leave a cancel/close-anyway choice.
function createWindowSaveBarrier({ dialog, continueClose, cancelClose, timeoutMs = 10000 }) {
  const windows = new WeakMap();

  function attach(window) {
    const state = { ready: false, allowed: false, pending: null };
    const contents = window.webContents;
    windows.set(contents, state);
    window.on('closed', () => {
      state.pending?.resolve();
      windows.delete(contents);
    });
    window.on('close', (event) => {
      if (!state.ready || state.allowed) return;
      event.preventDefault();
      if (state.pending) return;

      const requestId = randomUUID();
      const response = new Promise((resolve, reject) => {
        state.pending = { requestId, resolve, reject };
      });
      const timer = setTimeout(() => state.pending?.reject(new Error('Settings save did not respond.')), timeoutMs);
      const proceed = () => {
        if (window.isDestroyed()) return;
        state.allowed = true;
        continueClose(window);
        // Another close listener may veto; a later attempt must save again.
        setImmediate(() => { state.allowed = false; });
      };
      void response.then(proceed, async (error) => {
        if (window.isDestroyed()) return;
        const unsavedNotes = error?.code === 'UNSAVED_NOTES';
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title: unsavedNotes ? '笔记尚未保存 / Unsaved notes' : '设置尚未保存 / Settings not saved',
          message: unsavedNotes
            ? '仍有笔记编辑尚未保存。关闭会丢失这些改动。\nUnsaved note edits will be lost if you close.'
            : '未能确认阅读器设置已保存。仍然关闭吗？\nReader settings could not be saved. Close anyway?',
          detail: unsavedNotes
            ? '取消关闭后，请在笔记编辑器点击 Save 或按 Ctrl / Cmd + S 保存。\nCancel and save your notes before closing.'
            : '取消后可检查磁盘空间或文件权限，再次关闭会重试保存。\nCancel to check disk space or file permissions. Closing again will retry.',
          buttons: ['取消关闭 / Cancel', '仍然关闭 / Close anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response === 1) proceed();
        else cancelClose();
      }).catch((error) => {
        cancelClose();
        console.error('Failed to finish the settings save before closing.', error);
      }).finally(() => {
        clearTimeout(timer);
        state.pending = null;
      });
      try {
        window.webContents.send('paperquay:event', 'app:before-close', { requestId });
      } catch (error) {
        state.pending.reject(error);
      }
    });
  }

  return {
    attach,
    ready(sender) {
      const state = windows.get(sender);
      if (state) state.ready = true;
    },
    complete(sender, args) {
      const pending = windows.get(sender)?.pending;
      if (!pending || pending.requestId !== args?.requestId) return;
      if (args.error) pending.reject(args.reason === 'unsaved-notes'
        ? Object.assign(new Error('Unsaved note edits.'), { code: 'UNSAVED_NOTES' })
        : new Error('Reader settings save failed.'));
      else pending.resolve();
    },
  };
}

module.exports = { createWindowSaveBarrier };
