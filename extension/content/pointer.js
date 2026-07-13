// Visual feedback: a fake cursor dot that glides to the element the agent is
// about to act on, plus a highlight box and a click ripple. Lives in its own
// shadow root so host page CSS can't clobber it.
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});

  let host, shadow, pointerEl, highlightEl, lastX = innerWidth / 2, lastY = innerHeight / 2;

  function ensureInit() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'pa-pointer-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      @media print {
        :host { display: none !important; }
      }
      .cursor {
        position: fixed;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        margin-top: -9px;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 35%, #7fb0ff, #2a5cd6);
        box-shadow: 0 0 0 3px rgba(79,143,255,0.35), 0 2px 8px rgba(0,0,0,0.35);
        transition: top 420ms cubic-bezier(.22,.68,0,1.01), left 420ms cubic-bezier(.22,.68,0,1.01), transform 150ms ease, opacity 200ms ease;
        pointer-events: none;
        opacity: 0;
      }
      .cursor::after {
        content: '';
        position: absolute;
        inset: -8px;
        border-radius: 50%;
        border: 2px solid transparent;
      }
      .cursor.click {
        transform: scale(0.75);
      }
      .ripple {
        position: fixed;
        width: 12px;
        height: 12px;
        margin-left: -6px;
        margin-top: -6px;
        border-radius: 50%;
        border: 2px solid #4f8fff;
        opacity: 0.9;
        pointer-events: none;
        animation: pa-ripple 550ms ease-out forwards;
      }
      @keyframes pa-ripple {
        from { width: 12px; height: 12px; margin-left: -6px; margin-top: -6px; opacity: 0.9; }
        to   { width: 56px; height: 56px; margin-left: -28px; margin-top: -28px; opacity: 0; }
      }
      .highlight {
        position: fixed;
        border: 2px solid #ff9f43;
        background: rgba(255, 159, 67, 0.12);
        border-radius: 6px;
        pointer-events: none;
        transition: top 300ms ease, left 300ms ease, width 300ms ease, height 300ms ease, opacity 300ms ease;
        opacity: 0;
      }
    `;
    pointerEl = document.createElement('div');
    pointerEl.className = 'cursor';
    pointerEl.style.top = lastY + 'px';
    pointerEl.style.left = lastX + 'px';
    highlightEl = document.createElement('div');
    highlightEl.className = 'highlight';
    shadow.append(style, highlightEl, pointerEl);
    (document.documentElement || document.body).appendChild(host);
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function moveTo(x, y) {
    ensureInit();
    pointerEl.style.opacity = '1';
    pointerEl.style.left = x + 'px';
    pointerEl.style.top = y + 'px';
    lastX = x; lastY = y;
    await wait(440);
  }

  async function highlightRect(rect) {
    ensureInit();
    if (!rect) {
      highlightEl.style.opacity = '0';
      return;
    }
    highlightEl.style.left = rect.left + 'px';
    highlightEl.style.top = rect.top + 'px';
    highlightEl.style.width = rect.width + 'px';
    highlightEl.style.height = rect.height + 'px';
    highlightEl.style.opacity = '1';
    await wait(60);
  }

  async function ripple() {
    ensureInit();
    pointerEl.classList.add('click');
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = lastX + 'px';
    r.style.top = lastY + 'px';
    shadow.appendChild(r);
    await wait(160);
    pointerEl.classList.remove('click');
    setTimeout(() => r.remove(), 500);
  }

  // Moves the fake cursor to an element, highlights it, and (optionally)
  // shows a click ripple. Resolves once the animation has finished so the
  // caller can perform the real DOM action right after.
  async function actOn(el, { click = false } = {}) {
    if (!el || !el.isConnected) return;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' in document.documentElement.style ? 'auto' : 'auto' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    await highlightRect(rect);
    await moveTo(x, y);
    if (click) await ripple();
  }

  function clear() {
    if (highlightEl) highlightEl.style.opacity = '0';
    if (pointerEl) pointerEl.style.opacity = '0';
  }

  PA.pointer = { actOn, moveTo, ripple, clear };
})();
