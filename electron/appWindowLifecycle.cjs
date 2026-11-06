/** Hidden transfer workers are not application windows. Closing the last real
 * window must stop providers immediately so workers cannot keep the app alive. */
function createAppWindowLifecycle(onLastWindowClosed) {
  const windows = new Set();
  return {
    count: () => windows.size,
    attach(window) {
      windows.add(window);
      window.once('closed', () => {
        if (windows.delete(window) && windows.size === 0) {
          try { void Promise.resolve(onLastWindowClosed()).catch(() => {}); } catch {}
        }
      });
    },
  };
}
module.exports = { createAppWindowLifecycle };
