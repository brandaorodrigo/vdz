const video = document.getElementById('camera');
const gate = document.getElementById('gate');
const openBtn = document.getElementById('open');
const message = document.getElementById('message');

let stream = null;
let opening = false;

function stopCamera() {
    if (!stream) {
        return;
    }
    for (const track of stream.getTracks()) {
        track.stop();
    }
    stream = null;
    video.srcObject = null;
}

function showGate(text) {
    message.textContent = text;
    openBtn.disabled = false;
    openBtn.hidden = false;
    gate.hidden = false;
}

async function openCamera() {
    if (opening) {
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        showGate('este navegador não abre a câmera');
        openBtn.hidden = true;
        return;
    }
    opening = true;
    openBtn.disabled = true;
    stopCamera();
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', height: { ideal: 1080 }, width: { ideal: 1920 } } });
        const track = stream.getVideoTracks()[0];
        if (track) {
            track.addEventListener('ended', () => {
                stopCamera();
                showGate('a câmera fechou');
            });
        }
        video.srcObject = stream;
        await video.play();
        gate.hidden = true;
    } catch {
        stopCamera();
        showGate('a câmera não abriu');
    } finally {
        opening = false;
    }
}

openBtn.addEventListener('click', () => {
    openCamera();
});

window.addEventListener('pagehide', stopCamera);

openCamera();
