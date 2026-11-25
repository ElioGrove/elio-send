import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function harness(script, search = "", options = {}) {
  const elements = new Map();
  const requests = [];
  const sockets = [];
  const timers = new Map();
  const copied = [];
  const selectedNodes = [];
  let clock = 100_000;
  let timerId = 0;

  class Element {
    listeners = new Map();
    textContent = "";
    value = "";
    className = "";
    children = [];
    disabled = true;
    focused = false;
    classList = {
      add: (name) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), name])].join(" "); },
      remove: (name) => { this.className = this.className.split(" ").filter((item) => item && item !== name).join(" "); },
      contains: (name) => this.className.split(" ").includes(name)
    };
    addEventListener(type, callback) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(callback);
      this.listeners.set(type, listeners);
    }
    emit(type, event = {}) {
      return Promise.all((this.listeners.get(type) || []).map((callback) => callback(event)));
    }
    focus() { this.focused = true; }
    replaceChildren(...children) { this.children = children; }
  }
  class Socket extends Element {
    static OPEN = 1;
    readyState = 0;
    messages = [];
    constructor(url, protocol) {
      super();
      this.url = url;
      this.protocol = protocol;
      sockets.push(this);
    }
    async open() { this.readyState = 1; await this.emit("open"); }
    send(data) { this.messages.push(JSON.parse(data)); }
    close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
    message(payload) { return this.emit("message", { data: JSON.stringify(payload) }); }
  }
  const document = new Element();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.getElementById = get;
  document.querySelectorAll = () => [];
  document.createElement = () => new Element();
  document.createRange = () => ({
    node: null,
    selectNodeContents(node) { this.node = node; }
  });
  const setTimer = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const window = new Element();
  window.location = { protocol: "https:", host: "send.example", search };
  window.setTimeout = setTimer;
  window.setInterval = setTimer;
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);
  window.getSelection = () => ({
    removeAllRanges() { selectedNodes.length = 0; },
    addRange(range) { selectedNodes.push(range.node); }
  });
  const navigator = {
    onLine: options.onLine ?? true,
    clipboard: {
      writeText: async (text) => {
        if (options.clipboardError) {
          throw options.clipboardError;
        }
        copied.push(text);
      }
    }
  };
  const context = vm.createContext({
    document, window, WebSocket: Socket, URL, URLSearchParams, AbortController,
    Date: class extends Date { static now() { return clock; } },
    navigator,
    fetch: (url, fetchOptions) => new Promise((resolve, reject) => requests.push({ url, options: fetchOptions, resolve, reject }))
  });
  for (const file of ["common", script]) {
    vm.runInContext(readFileSync(new URL(`../public/js/${file}.js`, import.meta.url), "utf8"), context);
  }
  return {
    get, sockets, requests, timers, copied, selectedNodes, document, window, navigator,
    advance: (milliseconds) => { clock += milliseconds; },
    runTimer: async (delay) => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    runTimerMatching: async (predicate, label = "matching") => {
      const entry = [...timers].find(([, timer]) => predicate(timer));
      assert.ok(entry, `Expected a ${label} timer`);
      timers.delete(entry[0]);
      await entry[1].callback();
      return entry[1].delay;
    },
    session: async (index, sessionId) => {
      requests[index].resolve({ ok: true, json: async () => ({ sessionId, receiverToken: "r".repeat(43), qrSvg: `<svg>${sessionId}</svg>` }) });
      await new Promise(setImmediate);
    }
  };
}

test("rapid refresh cancels older requests and only connects the newest session", async () => {
  const page = harness("index");
  void page.get("refresh-btn").emit("click");
  assert.equal(page.requests[0].options.signal.aborted, true);
  await page.session(1, "new".repeat(11));
  await page.session(0, "old".repeat(11));
  assert.equal(page.sockets.length, 1);
  assert.match(page.sockets[0].url, /newnew/);
  assert.equal(page.sockets[0].protocol, `receiver.${"r".repeat(43)}`);
  assert.ok(!page.sockets[0].url.includes("r".repeat(43)));
  assert.match(decodeURIComponent(page.get("qrcode").children[0].src), /<svg>newnew/);
});

test("stale socket events cannot overwrite new data or schedule a reconnect", async () => {
  const page = harness("index");
  await page.session(0, "first".repeat(8));
  const first = page.sockets[0];
  await first.open();
  void page.get("refresh-btn").emit("click");
  await page.session(1, "second".repeat(7));
  await page.sockets[1].open();
  await first.message({ type: "text", text: "stale", expiresIn: 60 });
  await first.emit("error");
  await first.emit("close");
  assert.equal(page.get("received-text").textContent, "");
  assert.equal(page.get("connection-status").textContent, "等待手机发送");
  assert.equal(page.timers.size, 0);
});

test("expiration uses elapsed time and removes text on returning from a suspended tab", async () => {
  const page = harness("index");
  await page.session(0, "a".repeat(43));
  await page.sockets[0].open();
  await page.sockets[0].message({ type: "text", text: "<script>literal</script>", expiresIn: 60 });
  assert.equal(page.get("received-text").textContent, "<script>literal</script>");
  page.advance(20_000);
  await page.document.emit("visibilitychange");
  assert.equal(page.get("countdown").textContent, "40秒后自动清除");
  page.advance(41_000);
  await page.document.emit("visibilitychange");
  await page.get("copy-btn").emit("click");
  assert.equal(page.get("received-text").textContent, "");
  assert.equal(page.get("copy-btn").disabled, true);
  assert.equal(page.timers.size, 0);
  assert.equal(page.copied.length, 0);
});

test("clipboard copy failure reports in #copy-message without overwriting status and selects text", async () => {
  const page = harness("index", "", { clipboardError: new Error("NotAllowedError") });
  await page.session(0, "c".repeat(43));
  await page.sockets[0].open();
  await page.sockets[0].message({ type: "text", text: "secret-code-123", expiresIn: 60 });
  await page.get("copy-btn").emit("click");

  assert.equal(page.get("connection-status").textContent, "等待手机发送");
  assert.equal(page.get("connection-status").className, "status-pill status-live");
  assert.match(page.get("copy-message").className, /alert-danger/);
  assert.ok(!page.get("copy-message").classList.contains("d-none"));
  assert.match(page.get("copy-message").textContent, /手动复制/);
  assert.equal(page.get("received-text").focused, true);
  assert.deepEqual(page.selectedNodes, [page.get("received-text")]);
});

test("keyboard repeats send once and acknowledgement preserves newly typed text", async () => {
  const page = harness("receive", `?sid=${"s".repeat(43)}`);
  const socket = page.sockets[0];
  await socket.open();
  page.get("text-input").value = "first message";
  const shortcut = { ctrlKey: true, key: "Enter" };
  await page.get("text-input").emit("keydown", shortcut);
  await page.get("text-input").emit("keydown", shortcut);
  assert.equal(socket.messages.length, 1);
  page.get("text-input").value = "next message";
  await socket.message({ type: "sent", success: true });
  assert.equal(page.get("text-input").value, "next message");
  assert.equal(page.get("send-btn").disabled, false);
  await page.get("send-btn").emit("click");
  await socket.message({ type: "sent", success: true });
  assert.equal(page.get("text-input").value, "");
  assert.equal(socket.messages.length, 2);
});

test("sender preserves leading and trailing whitespace while rejecting whitespace-only text", async () => {
  const page = harness("receive", `?sid=${"w".repeat(43)}`);
  const socket = page.sockets[0];
  await socket.open();

  page.get("text-input").value = "   \n\t  ";
  await page.get("send-btn").emit("click");
  assert.equal(socket.messages.length, 0);
  assert.match(page.get("send-message").textContent, /请输入要发送的文本/);

  const rawText = "  indented code\n  line 2  \n";
  page.get("text-input").value = rawText;
  await page.get("send-btn").emit("click");
  assert.equal(socket.messages.length, 1);
  assert.equal(socket.messages[0].text, rawText);
  await socket.message({ type: "sent", success: true });
  assert.equal(page.get("text-input").value, "");
});

test("missing acknowledgements clear pending state, detach stale socket, update status, re-enable button, and reconnect", async () => {
  const page = harness("receive", `?sid=${"s".repeat(43)}`);
  const firstSocket = page.sockets[0];
  await firstSocket.open();
  page.get("text-input").value = "pending";
  await page.get("send-btn").emit("click");
  assert.equal(page.get("send-btn").disabled, true);

  await page.runTimer(15_000);

  assert.equal(page.get("text-input").value, "pending");
  assert.equal(firstSocket.readyState, 3);
  assert.match(page.get("send-message").textContent, /未收到发送确认/);
  assert.notEqual(page.get("connection-status").textContent, "已连接");
  assert.notEqual(page.get("connection-status").className, "status-pill status-live");
  assert.equal(page.get("send-btn").disabled, false);

  const timerCountBeforeStaleClose = page.timers.size;
  await firstSocket.emit("close");
  assert.equal(page.timers.size, timerCountBeforeStaleClose);

  await page.runTimerMatching((timer) => timer.delay !== 3000, "reconnect");
  assert.equal(page.sockets.length, 2);
  await page.sockets[1].open();
  assert.equal(page.get("connection-status").textContent, "已连接");
  assert.equal(page.get("send-btn").disabled, false);
});

test("bounded exponential backoff stops after 10 attempts and supports manual reconnect on both pages", async () => {
  const receiverPage = harness("index");
  await receiverPage.session(0, "b".repeat(43));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = receiverPage.sockets.at(-1);
    await current.emit("close", { code: 1006 });
    const delay = await receiverPage.runTimerMatching(() => true, `receiver reconnect ${attempt}`);
    assert.ok(delay >= 800 && delay <= 30_000, `Unexpected delay ${delay}`);
  }
  await receiverPage.sockets.at(-1).emit("close", { code: 1006 });
  assert.equal(receiverPage.timers.size, 0);
  assert.match(receiverPage.get("connection-status").textContent, /手动重连/);
  assert.ok(!receiverPage.get("reconnect-btn").classList.contains("d-none"));
  await receiverPage.get("reconnect-btn").emit("click");
  assert.equal(receiverPage.sockets.length, 12);
  assert.ok(receiverPage.get("reconnect-btn").classList.contains("d-none"));

  const senderPage = harness("receive", `?sid=${"b".repeat(43)}`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = senderPage.sockets.at(-1);
    await current.emit("close", { code: 1006 });
    const delay = await senderPage.runTimerMatching(() => true, `sender reconnect ${attempt}`);
    assert.ok(delay >= 800 && delay <= 30_000, `Unexpected delay ${delay}`);
  }
  await senderPage.sockets.at(-1).emit("close", { code: 1006 });
  assert.equal(senderPage.timers.size, 0);
  assert.match(senderPage.get("connection-status").textContent, /手动重连/);
  assert.ok(!senderPage.get("reconnect-btn").classList.contains("d-none"));
  await senderPage.get("reconnect-btn").emit("click");
  assert.equal(senderPage.sockets.length, 12);
});

test("terminal close codes 1008, 1009, 4404, 4410 stop automatic reconnects on both pages", async () => {
  for (const code of [1008, 1009, 4404, 4410]) {
    const receiverPage = harness("index");
    await receiverPage.session(0, "t".repeat(43));
    await receiverPage.sockets[0].open();
    await receiverPage.sockets[0].emit("close", { code });
    assert.equal(receiverPage.timers.size, 0, `Receiver should not reconnect on code ${code}`);
    assert.equal(receiverPage.get("connection-status").className, "status-pill status-error");
    await receiverPage.window.emit("online");
    assert.equal(receiverPage.sockets.length, 1, `Receiver online should not reconnect terminal code ${code}`);

    const senderPage = harness("receive", `?sid=${"t".repeat(43)}`);
    await senderPage.sockets[0].open();
    await senderPage.sockets[0].emit("close", { code });
    const reconnectTimers = [...senderPage.timers.values()].filter((timer) => timer.delay !== 3000);
    assert.equal(reconnectTimers.length, 0, `Sender should not reconnect on code ${code}`);
    assert.equal(senderPage.get("connection-status").className, "status-pill status-error");
    await senderPage.window.emit("online");
    assert.equal(senderPage.sockets.length, 1, `Sender online should not reconnect terminal code ${code}`);
  }
});

test("offline pauses reconnect loops and online resumes immediately", async () => {
  const receiverPage = harness("index");
  await receiverPage.session(0, "o".repeat(43));
  await receiverPage.sockets[0].open();
  await receiverPage.sockets[0].emit("close", { code: 1006 });
  assert.equal(receiverPage.timers.size, 1);

  receiverPage.navigator.onLine = false;
  await receiverPage.window.emit("offline");
  assert.equal(receiverPage.timers.size, 0);
  assert.match(receiverPage.get("connection-status").textContent, /网络已断开/);

  receiverPage.navigator.onLine = true;
  await receiverPage.window.emit("online");
  assert.equal(receiverPage.sockets.length, 2);

  const senderPage = harness("receive", `?sid=${"o".repeat(43)}`);
  await senderPage.sockets[0].open();
  await senderPage.sockets[0].emit("close", { code: 1006 });
  assert.equal(senderPage.timers.size, 1);

  senderPage.navigator.onLine = false;
  await senderPage.window.emit("offline");
  assert.equal(senderPage.timers.size, 0);
  assert.match(senderPage.get("connection-status").textContent, /网络已断开/);

  senderPage.navigator.onLine = true;
  await senderPage.window.emit("online");
  assert.equal(senderPage.sockets.length, 2);
});

test("invalid QR parameters never open a websocket or start reconnect loops", () => {
  for (const search of ["", "?sid=short", `?sid=${"%2F".repeat(32)}`]) {
    const page = harness("receive", search);
    assert.equal(page.sockets.length, 0);
    assert.equal(page.get("send-btn").disabled, true);
    assert.match(page.get("send-message").textContent, /二维码链接无效/);
  }
});

test("static HTML, headers, CSS, and favicon satisfy privacy, a11y, and dark-mode hardening", () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const receiveHtml = readFileSync(new URL("../public/receive.html", import.meta.url), "utf8");
  const headersFile = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/css/style.css", import.meta.url), "utf8");
  const favicon = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");

  assert.ok(!indexHtml.includes("umami"));
  assert.ok(!receiveHtml.includes("umami"));
  assert.ok(indexHtml.includes('id="reconnect-btn"'));
  assert.ok(receiveHtml.includes('id="reconnect-btn"'));
  assert.match(headersFile, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headersFile, /X-Frame-Options:\s*DENY/);
  assert.match(headersFile, /Referrer-Policy:\s*no-referrer/);
  assert.match(headersFile, /Strict-Transport-Security:\s*max-age=31536000;\s*includeSubDomains/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(favicon, /prefers-color-scheme:\s*dark/);
});
