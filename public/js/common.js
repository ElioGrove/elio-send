const MAX_RECONNECT_ATTEMPTS = 10;
const TERMINAL_CLOSE_CODES = new Set([1008, 1009, 4404, 4410]);

for (const element of document.querySelectorAll("[data-current-year]")) {
    element.textContent = String(new Date().getFullYear());
}

function buildWebSocketUrl(sessionId, role) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/websocket`);
    url.searchParams.set("role", role);
    return url.href;
}

function parseMessage(data) {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function showStatus(text, state) {
    const element = document.getElementById("connection-status");
    if (!element) return;
    element.textContent = text;
    element.className = `status-pill status-${state}`;
}

function setReconnectButtonVisible(visible) {
    const button = document.getElementById("reconnect-btn");
    if (!button) return;
    if (visible) {
        button.classList.remove("d-none");
        button.disabled = false;
    } else {
        button.classList.add("d-none");
        button.disabled = true;
    }
}

function isTerminalCloseCode(code) {
    return TERMINAL_CLOSE_CODES.has(code);
}

function isBrowserOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
}

function reconnectDelay(attempts) {
    const base = Math.min(1000 * 2 ** Math.min(attempts, 5), 30_000);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(30_000, Math.round(base * jitter));
}

function terminalCloseMessage(code, role) {
    if (code === 4410) {
        return role === "receiver" ? "会话已过期，请刷新二维码" : "会话已过期，请重新扫码";
    }
    if (code === 4404) {
        return role === "receiver" ? "会话不存在，请刷新二维码" : "会话不存在，请重新扫码";
    }
    if (code === 1008) {
        return "消息频率超限，连接已断开";
    }
    if (code === 1009) {
        return "消息体积超限，连接已断开";
    }
    return "连接已断开";
}
