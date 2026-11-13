let iceServersPromise;

function getIceServers() {
    if (!iceServersPromise) {
        iceServersPromise = fetch('/api/ice')
            .then((r) => {
                if (!r.ok) {
                    throw new Error(String(r.status));
                }
                return r.json();
            })
            .then((cfg) => cfg.iceServers)
            .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
    }
    return iceServersPromise;
}
