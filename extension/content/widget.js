// Floating, draggable chat panel injected into the page (shadow DOM, so
// host page styles/JS can't interfere with it or vice versa).
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});

  let host, shadow;
  let els = {};
  let running = false;
  let handlers = { run: null, stop: null, history: null, clearHistory: null };
  let pos = { x: null, y: null }; // panel top-left, null = use CSS default (bottom-right)

  const STYLE = `
    @media print {
      :host { display: none !important; }
    }
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .bubble {
      position: fixed;
      bottom: 22px;
      right: 22px;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg,#4f8fff,#2a5cd6);
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483646;
      color: #fff;
      font-size: 22px;
      user-select: none;
    }
    .bubble:hover { filter: brightness(1.08); }
    .panel {
      position: fixed;
      bottom: 86px;
      right: 22px;
      width: 340px;
      max-height: 70vh;
      background: #1c1f26;
      color: #e7e9ee;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 2147483646;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .panel.open { display: flex; }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.04);
      cursor: move;
    }
    .header .title { font-weight: 600; font-size: 13px; flex: 1; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; flex-shrink: 0; }
    .status-dot.idle { background: #6b7280; }
    .status-dot.running { background: #f5c542; animation: pulse 1s infinite ease-in-out; }
    .status-dot.error { background: #ef4444; }
    .status-dot.done { background: #22c55e; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    .icon-btn {
      background: transparent; border: none; color: #aab0bd; cursor: pointer;
      font-size: 14px; padding: 2px 4px; border-radius: 4px; line-height: 1;
    }
    .icon-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .log {
      flex: 1;
      overflow-y: auto;
      padding: 10px 12px;
      font-size: 12.5px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 90px;
    }
    .entry { padding: 6px 8px; border-radius: 8px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .entry.thought { background: rgba(255,255,255,0.05); color: #cbd2e0; }
    .entry.action { background: rgba(79,143,255,0.14); color: #cfe0ff; }
    .entry.error { background: rgba(239,68,68,0.15); color: #ffb4b4; }
    .entry.system { color: #8a90a0; font-style: italic; }
    .entry.done { background: rgba(34,197,94,0.15); color: #b6f5cc; }
    .composer {
      display: flex;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    textarea {
      flex: 1;
      resize: none;
      background: #12141a;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 8px;
      font-size: 12.5px;
      min-height: 36px;
      max-height: 120px;
    }
    textarea:focus { outline: 1px solid #4f8fff; }
    button.run {
      background: #4f8fff;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 0 14px;
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
    }
    button.run.stop { background: #ef4444; }
    button.run:disabled { opacity: 0.5; cursor: not-allowed; }
    .footer-hint { padding: 0 12px 8px; font-size: 10.5px; color: #6b7280; }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureInit() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'pa-widget-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const bubble = el('div', 'bubble', '\u{1F916}');
    const panel = el('div', 'panel');

    const header = el('div', 'header');
    const dot = el('span', 'status-dot idle');
    const title = el('span', 'title', 'Ollama Page Agent');
    const historyBtn = el('button', 'icon-btn', '🕘');
    historyBtn.title = 'Historique sur ce site';
    const clearHistoryBtn = el('button', 'icon-btn', '🗑');
    clearHistoryBtn.title = "Vider l'historique de ce site";
    const settingsBtn = el('button', 'icon-btn', '⚙');
    settingsBtn.title = 'Reglages';
    const closeBtn = el('button', 'icon-btn', '✕');
    closeBtn.title = 'Fermer';
    header.append(dot, title, historyBtn, clearHistoryBtn, settingsBtn, closeBtn);

    const log = el('div', 'log');

    const composer = el('div', 'composer');
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Que dois-je faire sur cette page ?';
    const runBtn = el('button', 'run', 'Lancer');
    composer.append(textarea, runBtn);

    const hint = el('div', 'footer-hint', 'Modele local via Ollama - rien ne quitte ta machine.');

    panel.append(header, log, composer, hint);
    shadow.append(style, bubble, panel);
    (document.documentElement || document.body).appendChild(host);

    bubble.addEventListener('click', () => panel.classList.toggle('open'));
    closeBtn.addEventListener('click', () => panel.classList.remove('open'));
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    });
    historyBtn.addEventListener('click', () => handlers.history && handlers.history());
    clearHistoryBtn.addEventListener('click', () => handlers.clearHistory && handlers.clearHistory());

    runBtn.addEventListener('click', () => {
      if (running) {
        handlers.stop && handlers.stop();
        return;
      }
      const goal = textarea.value.trim();
      if (!goal) return;
      textarea.value = '';
      handlers.run && handlers.run(goal);
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runBtn.click();
      }
    });

    makeDraggable(header, panel);

    els = { bubble, panel, dot, log, textarea, runBtn };
  }

  function makeDraggable(handle, panel) {
    let dragging = false, startX, startY, startRect;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startRect = panel.getBoundingClientRect();
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      panel.style.left = Math.max(4, startRect.left + dx) + 'px';
      panel.style.top = Math.max(4, startRect.top + dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function open() {
    ensureInit();
    els.panel.classList.add('open');
  }

  function log(role, text) {
    ensureInit();
    const entry = el('div', `entry ${role}`, text);
    els.log.appendChild(entry);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() {
    ensureInit();
    els.log.innerHTML = '';
  }

  function setStatus(status) {
    ensureInit();
    els.dot.className = `status-dot ${status}`;
  }

  function setRunning(isRunning) {
    ensureInit();
    running = isRunning;
    els.runBtn.textContent = isRunning ? 'Arreter' : 'Lancer';
    els.runBtn.classList.toggle('stop', isRunning);
    els.textarea.disabled = isRunning;
    setStatus(isRunning ? 'running' : 'idle');
  }

  function onRun(fn) { handlers.run = fn; }
  function onStop(fn) { handlers.stop = fn; }
  function onHistory(fn) { handlers.history = fn; }
  function onClearHistory(fn) { handlers.clearHistory = fn; }
  function getGoal() { return els.textarea ? els.textarea.value.trim() : ''; }

  PA.widget = { ensureInit, open, log, clearLog, setStatus, setRunning, onRun, onStop, onHistory, onClearHistory, getGoal };
})();
