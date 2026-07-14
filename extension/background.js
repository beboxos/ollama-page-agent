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
    throw err;
  }
  return res.json();
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
  if (provider === 'openai') {
    const data = await apiFetch(
      toV1Base(baseUrl),
      '/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: toOpenAiMessages(messages),
          stream: false,
          response_format: { type: 'json_object' },
          temperature: temperature ?? 0.2,
        }),
      },
      'le serveur'
    );
    return data.choices?.[0]?.message?.content ?? '';
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
  return data.message?.content ?? '';
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
        case 'CHAT': {
          const settings = await getSettings();
          const content = await chat({
            baseUrl: msg.baseUrl || settings.baseUrl,
            model: msg.model || settings.model,
            messages: msg.messages,
            temperature: settings.temperature,
            provider: settings.provider,
          });
          sendResponse({ ok: true, content });
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
