// Compartilhado por stream.html e play.html.

// Servidores STUN usados para descobrir o endereço público na conexão WebRTC.
window.iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
];

// Mostra uma mensagem de erro na tela e esconde depois de 5 segundos.
let errorTimer = 0;
window.showError = (message) => {
    const el = document.getElementById('error');
    el.textContent = typeof message === 'string' ? message : JSON.stringify(message);
    el.style.display = 'block';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
        el.textContent = '';
        el.style.display = 'none';
    }, 5000);
};
