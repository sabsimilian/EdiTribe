const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  getWavsFromFolder: (folderPath) => ipcRenderer.invoke('get-wavs-from-folder', folderPath),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openE2sAllDialog: () => ipcRenderer.invoke('open-e2s-all-dialog'),
  getE2sEmbeddedAudioDataUrl: (payload) => ipcRenderer.invoke('get-e2s-embedded-audio-data-url', payload),
  trimAudioFile: (payload) => ipcRenderer.invoke('trim-audio-file', payload),
  chooseExportDirectory: () => ipcRenderer.invoke('choose-export-directory'),
  exportE2sAll: (payload) => ipcRenderer.invoke('export-e2s-all', payload),
  saveAudioBufferAsWav: (payload) => ipcRenderer.invoke('save-audio-buffer-as-wav', payload),
  extractEmbeddedSampleToTemp: (payload) => ipcRenderer.invoke('extract-embedded-sample-to-temp', payload)
});
