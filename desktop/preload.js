const { contextBridge, ipcRenderer } = require('electron');

let pcmListener = null;

ipcRenderer.on('vdz-pcm', (_event, bytes) => {
    if (pcmListener) {
        pcmListener(bytes);
    }
});

contextBridge.exposeInMainWorld('vdzDesktop', {
    arm(sourceId) {
        return ipcRenderer.sendSync('vdz-arm', sourceId);
    },
    beginAudio(sourceId) {
        return ipcRenderer.invoke('vdz-begin-audio', sourceId);
    },
    listWindows() {
        return ipcRenderer.invoke('vdz-list-windows');
    },
    onPcm(listener) {
        pcmListener = listener;
        return () => {
            if (pcmListener === listener) {
                pcmListener = null;
            }
        };
    },
    stopAudio() {
        return ipcRenderer.invoke('vdz-stop-audio');
    },
});
