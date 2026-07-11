// Lets the top frame see and act on elements living inside same-page
// iframes. Every frame (top or nested) loads this script and passively
// answers COLLECT/EXEC requests; only the top frame actively calls
// collectAll()/requestFrame() to reach into its child iframes.
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});
  const isTop = window.top === window.self;
  const pending = new Map(); // requestId -> { resolve, timeoutId }

  function genId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__pa !== true) return;

    if (data.kind === 'COLLECT_REQUEST') {
      const lines = PA.dom.serializeLines();
      event.source?.postMessage(
        { __pa: true, kind: 'COLLECT_RESPONSE', requestId: data.requestId, lines },
        '*'
      );
      return;
    }
    if (data.kind === 'EXEC_REQUEST') {
      Promise.resolve(PA.actions.executeLocalIndexed(data.action)).then((result) => {
        event.source?.postMessage(
          { __pa: true, kind: 'EXEC_RESPONSE', requestId: data.requestId, result },
          '*'
        );
      });
      return;
    }
    if (data.kind === 'COLLECT_RESPONSE' || data.kind === 'EXEC_RESPONSE') {
      const p = pending.get(data.requestId);
      if (p) {
        pending.delete(data.requestId);
        clearTimeout(p.timeoutId);
        p.resolve(data);
      }
    }
  });

  function requestFrame(frameWindow, kind, payload, timeoutMs = 700) {
    return new Promise((resolve) => {
      const requestId = genId();
      const timeoutId = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pending.set(requestId, { resolve, timeoutId });
      frameWindow.postMessage({ __pa: true, kind, requestId, ...payload }, '*');
    });
  }

  // Aggregates this frame's own interactive elements with those of every
  // visible same-page iframe into one continuously-indexed list, plus a
  // routing table telling dispatch() where each index actually lives.
  async function collectAll() {
    const localLines = PA.dom.serializeLines();
    const lines = localLines.slice();
    const routes = localLines.map((_, i) => ({ local: true, index: i }));
    let nextIndex = localLines.length;

    const iframes = Array.from(document.querySelectorAll('iframe')).filter((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && f.contentWindow;
    });

    for (const frame of iframes) {
      const res = await requestFrame(frame.contentWindow, 'COLLECT_REQUEST', {});
      if (!res || !res.lines || !res.lines.length) continue;
      const label = frame.title || frame.name || (() => { try { return new URL(frame.src, location.href).hostname; } catch { return 'iframe'; } })();
      lines.push(`-- iframe "${label}" --`);
      for (const line of res.lines) {
        const m = line.match(/^\[(\d+)\](.*)$/);
        if (!m) continue;
        const localIndex = parseInt(m[1], 10);
        lines.push(`[${nextIndex}]${m[2]}`);
        routes[nextIndex] = { local: false, frameWindow: frame.contentWindow, index: localIndex };
        nextIndex += 1;
      }
    }
    return { lines, routes };
  }

  PA.frames = { collectAll, requestFrame, isTop };
})();
