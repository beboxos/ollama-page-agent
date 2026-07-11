// Builds a compact, LLM-friendly text snapshot of the page's interactive
// elements, each tagged with a stable numeric index the model can refer to.
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="combobox"]',
    '[role="option"]', '[contenteditable="true"]', '[contenteditable=""]',
    '[tabindex]:not([tabindex="-1"])', '[onclick]',
  ].join(',');

  const MAX_ELEMENTS = 140;
  const MAX_TEXT_LEN = 60;

  let indexMap = []; // index -> Element

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
      return false; // outside current viewport (agent scrolls to reveal more)
    }
    return true;
  }

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return cleanText(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
      if (t) return cleanText(t);
    }
    const findLabel = () => {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return cleanText(lbl.innerText);
      }
      const parentLabel = el.closest('label');
      return parentLabel ? cleanText(parentLabel.innerText) : '';
    };
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return findLabel() || cleanText(el.placeholder || el.name || '');
    }
    if (el.tagName === 'SELECT') {
      return findLabel() || cleanText(el.name || '');
    }
    if (el.tagName === 'IMG') return cleanText(el.alt);
    return cleanText(el.innerText || el.value || el.title || '');
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const parts = [tag];
    const type = el.getAttribute('type');
    if (type) parts.push(`type=${type}`);
    const role = el.getAttribute('role');
    if (role) parts.push(`role=${role}`);
    if (el.disabled) parts.push('disabled');
    if (el.getAttribute('aria-expanded') != null) parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if ((tag === 'input' || tag === 'textarea') && el.value) {
      parts.push(`value="${cleanText(el.value)}"`);
    }
    if (tag === 'select') {
      const selected = el.options?.[el.selectedIndex];
      if (selected) parts.push(`selected="${cleanText(selected.textContent)}"`);
    }
    const name = accessibleName(el);
    const attrStr = parts.join(' ');
    return name ? `<${attrStr}> "${name}"` : `<${attrStr}>`;
  }

  function distanceFromViewportCenter(rect) {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const ex = rect.left + rect.width / 2, ey = rect.top + rect.height / 2;
    return Math.hypot(ex - cx, ey - cy);
  }

  function collect() {
    const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const visible = candidates.filter(isVisible);
    visible.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 4) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    const limited = visible.length > MAX_ELEMENTS
      ? visible
          .map((el) => ({ el, d: distanceFromViewportCenter(el.getBoundingClientRect()) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, MAX_ELEMENTS)
          .map((x) => x.el)
      : visible;
    // restore reading order after distance-based trimming
    limited.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 4) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    indexMap = limited;
    return limited;
  }

  function serializeLines() {
    const elements = collect();
    return elements.map((el, i) => `[${i}] ${describeElement(el)}`);
  }

  function header() {
    const scrollInfo = `scroll_y=${Math.round(scrollY)} page_height=${Math.round(document.documentElement.scrollHeight)} viewport_height=${innerHeight}`;
    return `URL: ${location.href}\nTitre: ${document.title}\n${scrollInfo}\nElements interactifs visibles:`;
  }

  function serialize() {
    const lines = serializeLines();
    const body = lines.length ? lines.join('\n') : '(aucun element interactif visible dans le viewport actuel)';
    return `${header()}\n${body}`;
  }

  function getElementByIndex(i) {
    return indexMap[i];
  }

  const MAIN_TEXT_MAX = 3000;

  function extractMainText() {
    let root = null;
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 200) { root = el; break; }
    }
    if (!root) root = document.body;
    let text = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > MAIN_TEXT_MAX) text = text.slice(0, MAIN_TEXT_MAX) + '\n... [texte tronque]';
    return text || '(aucun texte lisible trouve sur cette page)';
  }

  PA.dom = { serialize, serializeLines, header, getElementByIndex, collect, extractMainText };
})();
