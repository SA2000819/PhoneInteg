const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const RX_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
const TX_CHAR_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

let txCharacteristic = null;
let rxCharacteristic = null;
let bluetoothDevice  = null;
let selfNodeId        = null;

// ─── Write queue — prevents concurrent BLE writes dropping silently ───────────
let writeQueue = Promise.resolve();

function bleWrite(text) {
    writeQueue = writeQueue.then(async () => {
        try {
            await rxCharacteristic.writeValueWithoutResponse(
                encoder.encode(text)
            );
        } catch(e) {
            console.error("BLE write failed:", e);
        }
    });
    return writeQueue;
}

const chatWindow   = document.getElementById('chatWindow');
const targetInput  = document.getElementById('targetId');
const messageInput = document.getElementById('messageInput');
const sendBtn      = document.getElementById('sendBtn');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const nodeTitle    = document.getElementById('nodeTitle');
const connectBtn   = document.getElementById('connectBtn');
const mapNodeCount = document.getElementById('mapNodeCount');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

messageInput.addEventListener('keyup', e => { if (e.key === 'Enter') sendMessage(); });

// ─── Map state ──────────────────────────────────────────────────────────────
let map        = null;
let selfMarker = null;
const nodeMarkers = {};   // { nodeId: { marker, lat, lon, lastSeen } }

const HISAR_CENTER = [29.1492, 75.7217];   // Hisar, Haryana — default center
const STALE_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes

// ─── Phone GPS state ──────────────────────────────────────────────────────────
let gpsWatchId     = null;
let lastBeaconSent = 0;
const BEACON_INTERVAL_MS = 30000; // throttle outgoing GPS beacons to 30s

// ─── Map setup ────────────────────────────────────────────────────────────────
function initMap() {
    map = L.map('map', {
        center: HISAR_CENTER,
        zoom: 13,
        zoomControl: true,
        attributionControl: true,
    });

    const offlineTiles = L.tileLayer('tiles/{z}/{x}/{y}.png', {
        minZoom: 10,
        maxZoom: 15,
        attribution: '© OpenStreetMap © CARTO',
        errorTileUrl: ''
    });

    const onlineFallback = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        minZoom: 10,
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>'
    });

    offlineTiles.addTo(map);
    offlineTiles.once('tileerror', () => {
        map.removeLayer(offlineTiles);
        onlineFallback.addTo(map);
        insertAlert("SYSTEM: Offline tiles not found — using live map.");
    });

    setInterval(refreshStaleMarkers, 60 * 1000);
}

function makeIcon(className) {
    return L.divIcon({
        className: className,
        iconSize: className.includes('self') ? [14, 14] : [12, 12],
        iconAnchor: className.includes('self') ? [7, 7] : [6, 6],
        popupAnchor: [0, -10]
    });
}

function formatLastSeen(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000)   return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
}

function popupHtml(nodeId, lat, lon, lastSeen) {
    return `
        <div class="popup-node-id">${nodeId}</div>
        <div class="popup-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
        <div class="popup-lastseen">Last seen: ${formatLastSeen(lastSeen)}</div>
    `;
}

function updateNodeOnMap(nodeId, lat, lon) {
    const now = Date.now();
    const isSelf = nodeId === selfNodeId;

    if (isSelf) {
        if (!selfMarker) {
            selfMarker = L.marker([lat, lon], { icon: makeIcon('node-marker-self'), zIndexOffset: 1000 })
                .bindPopup(popupHtml(nodeId + ' (You)', lat, lon, now))
                .addTo(map);
        } else {
            selfMarker.setLatLng([lat, lon]);
            selfMarker.setPopupContent(popupHtml(nodeId + ' (You)', lat, lon, now));
        }
        map.panTo([lat, lon], { animate: true, duration: 0.5 });

    } else {
        if (!nodeMarkers[nodeId]) {
            const marker = L.marker([lat, lon], { icon: makeIcon('node-marker-peer') })
                .bindPopup(popupHtml(nodeId, lat, lon, now))
                .addTo(map);
            nodeMarkers[nodeId] = { marker, lat, lon, lastSeen: now };
        } else {
            nodeMarkers[nodeId].marker.setLatLng([lat, lon]);
            nodeMarkers[nodeId].marker.setIcon(makeIcon('node-marker-peer'));
            nodeMarkers[nodeId].marker.setPopupContent(popupHtml(nodeId, lat, lon, now));
            nodeMarkers[nodeId].lat = lat;
            nodeMarkers[nodeId].lon = lon;
            nodeMarkers[nodeId].lastSeen = now;
        }
    }

    updateNodeCountBadge();
}

function refreshStaleMarkers() {
    const now = Date.now();
    for (const [nodeId, info] of Object.entries(nodeMarkers)) {
        const stale = (now - info.lastSeen) > STALE_THRESHOLD_MS;
        info.marker.setIcon(makeIcon(stale ? 'node-marker-stale' : 'node-marker-peer'));
        info.marker.setPopupContent(popupHtml(nodeId, info.lat, info.lon, info.lastSeen));
    }
}

function updateNodeCountBadge() {
    const total = Object.keys(nodeMarkers).length + (selfMarker ? 1 : 0);
    mapNodeCount.textContent = `${total} node${total !== 1 ? 's' : ''}`;
}

// ─── Phone GPS ────────────────────────────────────────────────────────────────
function startPhoneGPS() {
    if (!navigator.geolocation) {
        insertAlert("SYSTEM: Geolocation not supported on this device.");
        return;
    }
    insertAlert("SYSTEM: Requesting GPS permission...");

    gpsWatchId = navigator.geolocation.watchPosition(
        onGPSSuccess,
        onGPSError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
}

function stopPhoneGPS() {
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
}

function onGPSSuccess(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const acc = Math.round(position.coords.accuracy);

    if (selfNodeId) updateNodeOnMap(selfNodeId, lat, lon);

    const now = Date.now();
    if (rxCharacteristic && selfNodeId && (now - lastBeaconSent > BEACON_INTERVAL_MS)) {
        lastBeaconSent = now;
        sendGPSBeacon(lat, lon);
        insertAlert(`📍 Position broadcast: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${acc}m)`);
    }
}

function onGPSError(err) {
    const reasons = {
        1: "Permission denied — enable Location in browser settings.",
        2: "Position unavailable — move to open sky.",
        3: "GPS timeout — retrying..."
    };
    insertAlert("GPS: " + (reasons[err.code] || err.message));
}

async function sendGPSBeacon(lat, lon) {
    try {
        await bleWrite(`GPSPOS:${lat.toFixed(6)},${lon.toFixed(6)}`);
    } catch(e) {
        console.error("GPS beacon send failed:", e);
    }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function insertAlert(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<span>${text}</span>`;
    chatWindow.appendChild(el);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function insertBubble(direction, sender, text) {
    const el = document.createElement('div');
    el.className = `msg-row ${direction}`;
    const senderTag = direction === 'received' ? `<span class="sender-id">${sender}</span>` : '';
    el.innerHTML = `<div class="bubble">${senderTag}${text}</div>`;
    chatWindow.appendChild(el);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function setConnected(online) {
    statusDot.className  = online ? 'status-dot online' : 'status-dot';
    statusText.innerText = online ? 'Secure Link Active' : 'Disconnected';
    targetInput.disabled  = !online;
    messageInput.disabled = !online;
    sendBtn.disabled      = !online;
    connectBtn.disabled   = online;
    connectBtn.innerText  = online ? 'Online' : 'Connect';
}

// ─── BLE Connect ──────────────────────────────────────────────────────────────
async function connectBluetooth() {
    try {
        insertAlert('Scanning for Tactical_LoRa_Node…');

        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'Tactical_LoRa_Node' }],
            optionalServices: [SERVICE_UUID]
        });

        bluetoothDevice.addEventListener('gattserverdisconnected', () => {
            stopPhoneGPS();
            setConnected(false);
            insertAlert('SYSTEM: Connection lost. Click Connect to reconnect.');
        });

        insertAlert('Hardware found. Linking services…');
        const server  = await bluetoothDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);

        rxCharacteristic = await service.getCharacteristic(RX_CHAR_UUID);
        txCharacteristic = await service.getCharacteristic(TX_CHAR_UUID);

        await txCharacteristic.startNotifications();
        txCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingData);

        setConnected(true);
        insertAlert('SYSTEM: Secure Radio Link Established.');

        // Send PING immediately — the firmware replies the moment it receives the write.
        await bleWrite('PING');
        // Start phone GPS shortly after — gives the PING response time to set selfNodeId
        setTimeout(startPhoneGPS, 1000);

    } catch (err) {
        insertAlert('SYSTEM ERROR: ' + err.message);
    }
}

// ─── Incoming data handler ────────────────────────────────────────────────────
function handleIncomingData(event) {
    const raw = decoder.decode(event.target.value);

    // 1. Node ID response from PING
    if (raw.startsWith('INFO:Your Node ID is ')) {
        const id = raw.slice('INFO:Your Node ID is '.length);
        selfNodeId = id;
        nodeTitle.innerText = `Node [ ${id} ]`;
        document.getElementById('nodeIdValue').innerText = id;
        document.getElementById('nodeIdBanner').style.display = 'flex';
        insertAlert(`Node ID confirmed: ${id}`);
        return;
    }

    // 2. GPS beacon relayed from another node: "BEACON:ALPH,29.149200,75.721700"
    if (raw.startsWith('BEACON:')) {
        const parts = raw.slice('BEACON:'.length).split(',');
        if (parts.length === 3) {
            const [nodeId, latStr, lonStr] = parts;
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);
            if (!isNaN(lat) && !isNaN(lon)) {
                updateNodeOnMap(nodeId.trim(), lat, lon);
                insertAlert(`📍 Position update: ${nodeId.trim()} @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
            }
        }
        return;
    }

    // 3. Echo of own GPS position: "SELFPOS:29.149200,75.721700"
    if (raw.startsWith('SELFPOS:')) {
        const parts = raw.slice('SELFPOS:'.length).split(',');
        if (parts.length === 2 && selfNodeId) {
            const lat = parseFloat(parts[0]);
            const lon = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lon)) updateNodeOnMap(selfNodeId, lat, lon);
        }
        return;
    }

    // 4. Chat message: "ALPH:Hello there"
    const sep = raw.indexOf(':');
    if (sep !== -1) {
        insertBubble('received', raw.slice(0, sep), raw.slice(sep + 1));
    } else {
        insertAlert(raw);
    }
}

// ─── Send message ─────────────────────────────────────────────────────────────
async function sendMessage() {
    const target  = targetInput.value.trim().toUpperCase();
    const message = messageInput.value;

    if (target.length === 4 && message.length > 0) {
        try {
            await bleWrite(`${target}:${message}`);
            insertBubble('sent', 'You', message);
            messageInput.value = '';
        } catch (err) {
            insertAlert('Transmission Fault: ' + err.message);
        }
    }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
initMap();
