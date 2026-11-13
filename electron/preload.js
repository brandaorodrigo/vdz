const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vdz', {
    choose: (id) => ipcRenderer.invoke('choose', id),
    offAudio: () => ipcRenderer.removeAllListeners('audio-chunk'),
    onAudio: (fn) => {
        ipcRenderer.removeAllListeners('audio-chunk');
        ipcRenderer.on('audio-chunk', (_event, payload) => fn(payload));
    },
    startAudio: () => ipcRenderer.invoke('start-audio'),
    stopAudio: () => ipcRenderer.invoke('stop-audio'),
    windows: () => ipcRenderer.invoke('windows'),
});
