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
    .entry.confirm { background: rgba(245,158,66,0.14); color: #ffdcae; border: 1px solid rgba(245,158,66,0.35); }
    .entry.confirm .confirm-detail { color: #c9a880; font-size: 11px; margin-top: 3px; }
    .entry.confirm .confirm-buttons { display: flex; gap: 6px; margin-top: 8px; }
    .confirm-btn {
      border: none; border-radius: 6px; padding: 5px 12px; font-size: 11.5px;
      font-weight: 600; cursor: pointer;
    }
    .confirm-btn.yes { background: #f59e42; color: #201200; }
    .confirm-btn.no { background: rgba(255,255,255,0.1); color: #e7e9ee; }
    .confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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

    // Sites like Discord/Slack/Gmail install a document-level keydown
    // listener that auto-focuses their own text field whenever a keystroke
    // doesn't look like it came from a real input. Because our widget lives
    // in a shadow root, such listeners see the retargeted event.target as
    // our plain host <div>, not the actual focused <textarea> - so they
    // "helpfully" steal every keystroke. Stop these events at the shadow
    // boundary so the host page never sees them.
    for (const evtName of ['keydown', 'keyup', 'keypress', 'input']) {
      panel.addEventListener(evtName, (e) => e.stopPropagation());
      bubble.addEventListener(evtName, (e) => e.stopPropagation());
    }

    const bubbleDrag = makeDraggable(bubble, bubble, (pos) => {
      chrome.storage.local.set({ [POS_KEY_BUBBLE]: pos }).catch(() => {});
    });
    bubble.addEventListener('click', () => {
      if (bubbleDrag.wasDragged()) return;
      panel.classList.toggle('open');
    });
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

    makeDraggable(header, panel, (pos) => {
      chrome.storage.local.set({ [POS_KEY_PANEL]: pos }).catch(() => {});
    });
    restorePositions(bubble, panel);

    els = { bubble, panel, dot, log, textarea, runBtn };
  }

  const POS_KEY_BUBBLE = 'pa_bubble_pos';
  const POS_KEY_PANEL = 'pa_panel_pos';

  function clampPos(left, top, width, height) {
    return {
      left: Math.max(4, Math.min(innerWidth - width - 4, left)),
      top: Math.max(4, Math.min(innerHeight - height - 4, top)),
    };
  }

  async function restorePositions(bubble, panel) {
    try {
      const stored = await chrome.storage.local.get([POS_KEY_BUBBLE, POS_KEY_PANEL]);
      const bp = stored[POS_KEY_BUBBLE];
      if (bp) {
        const { left, top } = clampPos(bp.left, bp.top, 52, 52);
        bubble.style.left = left + 'px';
        bubble.style.top = top + 'px';
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
      }
      const pp = stored[POS_KEY_PANEL];
      if (pp) {
        const { left, top } = clampPos(pp.left, pp.top, 340, 400);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    } catch {
      // storage unavailable, keep default corner position
    }
  }

  // Drags `moveTarget` by pressing on `handle` (same element for the bubble,
  // the panel's header for the panel). Distinguishes a plain click (no
  // movement) from an actual drag so the bubble's open/close toggle still
  // works; `wasDragged()` tells the caller which one just happened.
  function makeDraggable(handle, moveTarget, onMoved) {
    let dragging = false, moved = false, startX, startY, startRect;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' && e.target !== handle) return;
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      startRect = moveTarget.getBoundingClientRect();
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const { left, top } = clampPos(startRect.left + dx, startRect.top + dy, startRect.width, startRect.height);
      moveTarget.style.left = left + 'px';
      moveTarget.style.top = top + 'px';
      moveTarget.style.right = 'auto';
      moveTarget.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (dragging && moved) {
        const rect = moveTarget.getBoundingClientRect();
        onMoved && onMoved({ left: rect.left, top: rect.top });
      }
      dragging = false;
    });
    return { wasDragged: () => moved };
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

  // Pauses the run with an inline Confirm/Cancel prompt for a sensitive
  // action (publish, pay, delete, ...) instead of executing it blindly.
  function confirmAction(label, detail) {
    ensureInit();
    open();
    return new Promise((resolve) => {
      const wrap = el('div', 'entry confirm');
      const text = el('div', '', `⚠️ Action sensible detectee : "${label}"`);
      const sub = el('div', 'confirm-detail', detail || '');
      const btnRow = el('div', 'confirm-buttons');
      const yesBtn = el('button', 'confirm-btn yes', 'Confirmer');
      const noBtn = el('button', 'confirm-btn no', 'Annuler');
      btnRow.append(yesBtn, noBtn);
      wrap.append(text, sub, btnRow);
      els.log.appendChild(wrap);
      els.log.scrollTop = els.log.scrollHeight;

      function finish(value) {
        yesBtn.disabled = true;
        noBtn.disabled = true;
        text.textContent = value ? `✓ Action autorisee : "${label}"` : `✗ Action annulee : "${label}"`;
        sub.remove();
        btnRow.remove();
        resolve(value);
      }
      yesBtn.addEventListener('click', () => finish(true));
      noBtn.addEventListener('click', () => finish(false));
    });
  }

  PA.widget = {
    ensureInit, open, log, clearLog, setStatus, setRunning,
    onRun, onStop, onHistory, onClearHistory, confirmAction, getGoal,
  };
})();
