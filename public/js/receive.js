const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sid");
const hasValidSession = Boolean(sessionId && /^[a-zA-Z0-9_-]{22,64}$/.test(sessionId));
const textInput = document.getElementById("text-input");
const sendButton = document.getElementById("send-btn");
const reconnectButton = document.getElementById("reconnect-btn");
const sendMessage = document.getElementById("send-message");
const charCount = document.getElementById("char-count");

let socket;
let reconnectTimeout;
let reconnectAttempts = 0;
let messageTimeout;
let sending = false;
let pendingText;
let acknowledgementTimeout;
let terminalClosed = false;
let waitingForOnline = false;

sendButton.addEventListener("click", sendText);
textInput.addEventListener("input", updateCharacterCount);
textInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        sendText();
    }
});

reconnectButton?.addEventListener("click", () => {
    if (!hasValidSession) return;
    reconnectAttempts = 0;
    terminalClosed = false;
    waitingForOnline = false;
    setReconnectButtonVisible(false);
    connectSender();
});

window.addEventListener?.("offline", () => {
    if (!hasValidSession || terminalClosed) return;
    waitingForOnline = true;
    window.clearTimeout(reconnectTimeout);
    reconnectTimeout = undefined;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        sendButton.disabled = true;
    }
    showStatus("网络已断开，等待恢复", "muted");
});

window.addEventListener?.("online", () => {
    if (!hasValidSession || terminalClosed) return;
    if (!waitingForOnline && socket && socket.readyState <= WebSocket.OPEN) return;
    waitingForOnline = false;
    reconnectAttempts = 0;
    setReconnectButtonVisible(false);
    connectSender();
});

updateCharacterCount();

if (!hasValidSession) {
    showStatus("缺少会话参数", "error");
    showMessage("二维码链接无效", "danger");
} else {
    connectSender();
}

function scheduleReconnect(statusText = "连接中断，正在重连") {
    window.clearTimeout(reconnectTimeout);
    reconnectTimeout = undefined;

    if (isBrowserOffline()) {
        waitingForOnline = true;
        showStatus("网络已断开，等待恢复", "muted");
        return;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        showStatus("连接已断开，请手动重连", "error");
        setReconnectButtonVisible(true);
        return;
    }

    showStatus(statusText, "muted");
    const delay = reconnectDelay(reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimeout = window.setTimeout(connectSender, delay);
}

function connectSender() {
    window.clearTimeout(reconnectTimeout);
    reconnectTimeout = undefined;
    setReconnectButtonVisible(false);

    const oldSocket = socket;
    socket = undefined;
    if (oldSocket && oldSocket.readyState <= WebSocket.OPEN) {
        try {
            oldSocket.close(1000, "reconnect");
        } catch {
            // Ignore close errors on stale sockets.
        }
    }

    if (isBrowserOffline()) {
        waitingForOnline = true;
        sendButton.disabled = true;
        showStatus("网络已断开，等待恢复", "muted");
        return;
    }

    showStatus("正在连接", "muted");
    sendButton.disabled = true;
    const currentSocket = new WebSocket(buildWebSocketUrl(sessionId, "sender"));
    socket = currentSocket;

    currentSocket.addEventListener("open", () => {
        if (socket !== currentSocket) return;
        reconnectAttempts = 0;
        waitingForOnline = false;
        setReconnectButtonVisible(false);
        sendButton.disabled = false;
        showStatus("已连接", "live");
    });

    currentSocket.addEventListener("message", (event) => {
        if (socket !== currentSocket) return;
        const payload = parseMessage(event.data);
        if (!payload || payload.type !== "sent" || !sending) {
            return;
        }

        sending = false;
        window.clearTimeout(acknowledgementTimeout);
        acknowledgementTimeout = undefined;
        const acknowledgedText = pendingText;
        pendingText = undefined;
        sendButton.disabled = false;
        if (payload.success) {
            showMessage("发送成功", "success");
            if (textInput.value === acknowledgedText) {
                textInput.value = "";
            }
            updateCharacterCount();
        } else {
            showMessage(`发送失败：${payload.error || "未知错误"}`, "danger");
        }
    });

    currentSocket.addEventListener("close", (event) => {
        if (socket !== currentSocket) return;
        socket = undefined;
        sending = false;
        pendingText = undefined;
        window.clearTimeout(acknowledgementTimeout);
        acknowledgementTimeout = undefined;
        sendButton.disabled = true;

        const code = event?.code;
        if (isTerminalCloseCode(code)) {
            terminalClosed = true;
            window.clearTimeout(reconnectTimeout);
            reconnectTimeout = undefined;
            const message = terminalCloseMessage(code, "sender");
            showStatus(message, "error");
            showMessage(message, "danger");
            setReconnectButtonVisible(code === 1008 || code === 1009);
            return;
        }

        scheduleReconnect("连接中断，正在重连");
    });

    currentSocket.addEventListener("error", () => {
        if (socket !== currentSocket) return;
        showStatus("连接异常", "error");
    });
}

function sendText() {
    if (sending) return;
    const text = textInput.value;
    if (text.trim().length === 0) {
        showMessage("请输入要发送的文本", "warning");
        return;
    }

    if (text.length > 20_000) {
        showMessage("文本过长", "warning");
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showMessage("连接尚未就绪", "danger");
        return;
    }

    sendButton.disabled = true;
    sending = true;
    pendingText = text;
    const sendingSocket = socket;
    try {
        sendingSocket.send(JSON.stringify({ type: "text", text }));
        acknowledgementTimeout = window.setTimeout(() => {
            if (socket !== sendingSocket || !sending) return;
            sending = false;
            pendingText = undefined;
            window.clearTimeout(acknowledgementTimeout);
            acknowledgementTimeout = undefined;
            socket = undefined;
            try {
                sendingSocket.close(1000, "Acknowledgement timeout");
            } catch {
                // Ignore close errors on stale sockets.
            }
            sendButton.disabled = false;
            showMessage("未收到发送确认，请检查接收端后重试", "warning");
            scheduleReconnect("连接超时，正在重连");
        }, 15_000);
    } catch {
        sending = false;
        pendingText = undefined;
        window.clearTimeout(acknowledgementTimeout);
        acknowledgementTimeout = undefined;
        sendButton.disabled = !socket || socket.readyState !== WebSocket.OPEN;
        showMessage("发送失败，请重试", "danger");
    }
}

function showMessage(text, type) {
    sendMessage.className = `alert alert-${type} message-slot mt-3`;
    sendMessage.textContent = text;
    window.clearTimeout(messageTimeout);
    messageTimeout = window.setTimeout(() => sendMessage.classList.add("d-none"), 3000);
}

function updateCharacterCount() {
    charCount.textContent = `${textInput.value.length} / 20000`;
}
