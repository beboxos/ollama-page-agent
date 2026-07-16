// Service worker: bridges the content script to a local Ollama server.
// Kept separate from the content script because content scripts run inside
// the page's CSP/CORS jail; the background worker does not.

const DEFAULT_SETTINGS = {
  provider: 'ollama', // 'ollama' | 'openai' (any OpenAI-compatible server: LM Studio, FastFlowLM, vLLM, ...)
  baseUrl: 'http://localhost:11434',
  model: '',
  language: 'fr-FR',
  maxSteps: 20,
  temperature: 0.2,
  useVision: false,
  customInstructions: '',
  sensitiveActionMode: 'ask', // 'ask' | 'auto'
  readOnly: false,
  visionFrequency: 'each_step', // 'each_step' | 'first_step'
  visionControl: false, // screenshot-only context + coordinate actions (beta)
  historyRetention: 'manual', // 'off' | '1' | '7' | 'manual'
};

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

function originFromBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function hasHostPermission(baseUrl) {
  const origin = originFromBaseUrl(baseUrl);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function apiFetch(baseUrl, path, options, serverLabel) {
  const allowed = await hasHostPermission(baseUrl);
  if (!allowed) {
    const err = new Error(
      `Permission manquante pour ${baseUrl}. Ouvre les options de l'extension et autorise cette adresse.`
    );
    err.code = 'NO_PERMISSION';
    throw err;
  }
  let res;
  try {
    res = await fetch(baseUrl.replace(/\/$/, '') + path, options);
  } catch (e) {
    const err = new Error(
      `Impossible de joindre ${serverLabel} sur ${baseUrl}. Verifie qu'il tourne et qu'il autorise les requetes venant d'une extension Chrome (CORS).`
    );
    err.code = 'NETWORK_ERROR';
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${serverLabel} a repondu ${res.status}: ${text.slice(0, 300)}`);
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function getAllFrames(tabId) {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError) return resolve([]);
      resolve(frames || []);
    });
  });
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response || null);
    });
  });
}

function frameLabel(url) {
  try { return new URL(url).hostname; } catch { return 'iframe'; }
}

// Normalizes to ".../v1" regardless of whether the user already typed the
// "/v1" suffix themselves.
function toV1Base(baseUrl) {
  return baseUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1';
}

async function listModels(baseUrl, provider) {
  if (provider === 'openai') {
    const data = await apiFetch(toV1Base(baseUrl), '/models', { method: 'GET' }, 'le serveur');
    return (data.data || []).map((m) => m.id);
  }
  const data = await apiFetch(baseUrl, '/api/tags', { method: 'GET' }, 'Ollama');
  return (data.models || []).map((m) => m.name);
}

// Reshapes Ollama-style messages ({role, content, images: [base64,...]}) into
// OpenAI's content-array format ({role, content: [{type:'text',...},
// {type:'image_url',...}]}) - the two APIs disagree on how images attach to
// a message. Messages without images pass through as plain strings.
function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (!m.images || !m.images.length) {
      const { images, ...rest } = m;
      return rest;
    }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } })),
      ],
    };
  });
}

async function chat({ baseUrl, model, messages, temperature, provider }) {
  const imageCount = messages.reduce((count, message) => count + (message.images?.length || 0), 0);
  // Metadata only: never log a screenshot, but make vision requests diagnosable
  // from the extension service-worker console.
  console.info('[Ollama Page Agent] chat request', { provider, model, messageCount: messages.length, imageCount });
  if (provider === 'openai') {
    const payload = {
      model,
      messages: toOpenAiMessages(messages),
      stream: false,
      response_format: { type: 'json_object' },
      temperature: temperature ?? 0.2,
    };
    let data;
    try {
      data = await apiFetch(
        toV1Base(baseUrl), '/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        'le serveur'
      );
    } catch (error) {
      // A few otherwise-compatible local servers do not implement the
      // optional response_format field. The agent still validates JSON itself.
      if (error.code !== 'HTTP_ERROR' || ![400, 404, 422].includes(error.status)) throw error;
      delete payload.response_format;
      console.info('[Ollama Page Agent] retrying without response_format');
      data = await apiFetch(
        toV1Base(baseUrl), '/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        'le serveur'
      );
    }
    return { content: data.choices?.[0]?.message?.content ?? '', imageCount };
  }
  const data = await apiFetch(
    baseUrl,
    '/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: temperature ?? 0.2 },
      }),
    },
    'Ollama'
  );
  return { content: data.message?.content ?? '', imageCount };
}

async function captureScreenshot(tab) {
  if (!tab) {
    const err = new Error("Pas d'onglet associe a cette demande.");
    throw err;
  }
  const allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (!allowed) {
    const err = new Error(
      "Permission manquante pour capturer l'ecran. Active 'Vision' dans les reglages et autorise sur tous les sites."
    );
    err.code = 'NO_PERMISSION';
    throw err;
  }
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
}

async function getSession(tabId) {
  const key = `session_${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function setSession(tabId, session) {
  const key = `session_${tabId}`;
  await chrome.storage.session.set({ [key]: session });
}

async function clearSession(tabId) {
  const key = `session_${tabId}`;
  await chrome.storage.session.remove(key);
}

async function clearAllHistory() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith('pa_history_'));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const tabId = sender.tab?.id;
      switch (msg?.type) {
        case 'GET_SESSION': {
          sendResponse({ ok: true, session: tabId != null ? await getSession(tabId) : null });
          break;
        }
        case 'SET_SESSION': {
          if (tabId != null) await setSession(tabId, msg.session);
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_SESSION': {
          if (tabId != null) await clearSession(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_ALL_HISTORY': {
          const count = await clearAllHistory();
          sendResponse({ ok: true, count });
          break;
        }
        case 'GET_SETTINGS': {
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        case 'SET_SETTINGS': {
          const next = await setSettings(msg.settings || {});
          sendResponse({ ok: true, settings: next });
          break;
        }
        case 'LIST_MODELS': {
          const settings = await getSettings();
          const baseUrl = msg.baseUrl || settings.baseUrl;
          const provider = msg.provider || settings.provider;
          const models = await listModels(baseUrl, provider);
          sendResponse({ ok: true, models });
          break;
        }
        case 'OPEN_OPTIONS': {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case 'CAPTURE_SCREENSHOT': {
          const dataUrl = await captureScreenshot(sender.tab);
          sendResponse({ ok: true, dataUrl });
          break;
        }
        case 'FRAME_COLLECT': {
          // Only the top-frame controller may enumerate iframe content.
          if (tabId == null || sender.frameId !== 0) {
            sendResponse({ ok: false, error: 'Requete iframe non autorisee.' });
            break;
          }
          const frames = (await getAllFrames(tabId)).filter((frame) => frame.frameId !== 0);
          const snapshots = await Promise.all(frames.map(async (frame) => {
            const response = await sendToFrame(tabId, frame.frameId, { type: 'PA_FRAME_SERIALIZE' });
            return response?.ok ? { frameId: frame.frameId, label: frameLabel(frame.url), lines: response.lines } : null;
          }));
          sendResponse({ ok: true, frames: snapshots.filter(Boolean) });
          break;
        }
        case 'FRAME_EXECUTE': {
          if (tabId == null || sender.frameId !== 0 || !Number.isInteger(msg.frameId) || msg.frameId === 0) {
            sendResponse({ ok: false, error: 'Execution iframe non autorisee.' });
            break;
          }
          const frames = await getAllFrames(tabId);
          if (!frames.some((frame) => frame.frameId === msg.frameId)) {
            sendResponse({ ok: false, error: 'Iframe cible introuvable.' });
            break;
          }
          const response = await sendToFrame(tabId, msg.frameId, { type: 'PA_FRAME_EXECUTE', action: msg.action });
          sendResponse(response || { ok: false, error: "L'iframe n'a pas repondu." });
          break;
        }
        case 'CHAT': {
          const settings = await getSettings();
          const content = await chat({
            baseUrl: msg.baseUrl || settings.baseUrl,
            model: msg.model || settings.model,
            messages: msg.messages,
            temperature: settings.temperature,
            provider: msg.provider || settings.provider,
          });
          sendResponse({ ok: true, content: content.content, imageCount: content.imageCount });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg?.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), code: e.code });
    }
  })();
  return true; // keep the message channel open for the async response
});
