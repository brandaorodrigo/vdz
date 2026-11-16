const { contextBridge, ipcRenderer } = require('electron');

// Ponte entre a página (renderer) e o processo principal.
// Com contextIsolation ligado, a página não acessa Node nem ipcRenderer direto;
// só o objeto `window.vdz` exposto aqui.
contextBridge.exposeInMainWorld('vdz', {
    // Seleciona a janela (id do desktopCapturer) que será capturada.
    // O processo principal guarda essa fonte para o próximo getDisplayMedia.
    choose: (id) => ipcRenderer.invoke('choose', id),

    // Para de receber trechos de áudio, sem encerrar a captura.
    offAudio: () => ipcRenderer.removeAllListeners('audio-chunk'),

    // Inscreve um único callback para os trechos de áudio.
    // O processo principal envia { channels, samples } no canal 'audio-chunk'.
    // Troca o listener anterior para não acumular handlers.
    onAudio: (fn) => {
        ipcRenderer.removeAllListeners('audio-chunk');
        ipcRenderer.on('audio-chunk', (_event, payload) => fn(payload));
    },

    // Inicia a captura do áudio da janela escolhida.
    // Resolve com { channels, sampleRate } ou null se não houver janela válida.
    startAudio: () => ipcRenderer.invoke('start-audio'),

    // Encerra o processo de captura de áudio.
    stopAudio: () => ipcRenderer.invoke('stop-audio'),

    // Lista as janelas capturáveis como { id, name }, sem a própria janela do app.
    windows: () => ipcRenderer.invoke('windows'),
});
