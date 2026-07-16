// Routes iframe work through chrome.runtime instead of window.postMessage.
// Page scripts can forge window messages, whereas only extension contexts can
// use runtime messaging. The background worker identifies target frames by
// Chrome frameId and forwards the request to the content script in that frame.
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});
  const isTop = window.top === window.self;

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(response || null);
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PA_FRAME_SERIALIZE') {
      sendResponse({ ok: true, lines: PA.dom.serializeLines() });
      return;
    }
    if (message?.type === 'PA_FRAME_EXECUTE') {
      Promise.resolve(PA.actions.executeLocalIndexed(message.action))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
  });

  async function requestFrame(frameId, action) {
    const response = await sendMessage({ type: 'FRAME_EXECUTE', frameId, action });
    return response?.ok ? response.result : null;
  }

  // Aggregates this frame's elements with every injectable child frame. The
  // background owns frame discovery, so no page-controlled window reference is
  // trusted for collection or execution.
  async function collectAll() {
    const localLines = PA.dom.serializeLines();
    const lines = localLines.slice();
    const routes = localLines.map((_, index) => ({ local: true, index }));
    let nextIndex = localLines.length;
    const response = await sendMessage({ type: 'FRAME_COLLECT' });

    for (const frame of response?.frames || []) {
      if (!frame.lines?.length) continue;
      lines.push(`-- iframe "${frame.label || 'iframe'}" --`);
      for (const line of frame.lines) {
        const match = line.match(/^\[(\d+)\](.*)$/);
        if (!match) continue;
        lines.push(`[${nextIndex}]${match[2]}`);
        routes[nextIndex] = { local: false, frameId: frame.frameId, index: Number.parseInt(match[1], 10) };
        nextIndex += 1;
      }
    }
    return { lines, routes };
  }

  PA.frames = { collectAll, requestFrame, isTop };
})();
