// Test double for the OS picker. Native-window checks are performed separately.
module.exports = function installPickerHarness() {
  window.pickerTest = { calls: [], saved: [], writes: 0, nextName: '', cancel: false };
  window.showSaveFilePicker = async options => {
    const state = window.pickerTest;
    state.calls.push(options);
    if (state.cancel) { state.cancel = false; throw new DOMException('Cancelled', 'AbortError'); }
    const name = state.nextName || options.suggestedName;
    state.nextName = '';
    return {
      name,
      async createWritable() {
        state.writes++;
        let bytes;
        return {
          async write(data) {
            bytes = Array.from(typeof data === 'string' ? new TextEncoder().encode(data)
              : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
          },
          async close() { state.saved.push({ name, bytes }); },
          async abort() {}
        };
      }
    };
  };
};
