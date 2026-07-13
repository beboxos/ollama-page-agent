const $ = (id) => document.getElementById(id);

function sendMsg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}

function originFromBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

const DISABLED_SITES_KEY = 'pa_disabled_sites';
let currentSiteOrigin = null;

async function getDisabledSites() {
  const stored = await chrome.storage.local.get(DISABLED_SITES_KEY);
  return stored[DISABLED_SITES_KEY] || [];
}

async function loadSiteToggle() {
  const hostEl = $('siteHost');
  const checkbox = $('siteEnabled');
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  let origin = null;
  let hostname = null;
  try {
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      origin = u.origin;
      hostname = u.hostname;
    }
  } catch {
    // no accessible tab URL (e.g. options page opened in its own tab)
  }

  if (!origin) {
    hostEl.textContent = 'Non disponible depuis cette page';
    checkbox.checked = false;
    checkbox.disabled = true;
    $('siteHint').textContent = "Ouvre le popup depuis l'icone de la barre d'outils, sur le site concerne.";
    return;
  }

  currentSiteOrigin = origin;
  hostEl.textContent = hostname;
  checkbox.disabled = false;
  const disabled = await getDisabledSites();
  checkbox.checked = !disabled.includes(origin);
}

$('siteEnabled').addEventListener('change', async (e) => {
  if (!currentSiteOrigin) return;
  const disabled = await getDisabledSites();
  const idx = disabled.indexOf(currentSiteOrigin);
  if (e.target.checked && idx !== -1) disabled.splice(idx, 1);
  if (!e.target.checked && idx === -1) disabled.push(currentSiteOrigin);
  await chrome.storage.local.set({ [DISABLED_SITES_KEY]: disabled });
});

async function loadSettings() {
  const { settings } = await sendMsg({ type: 'GET_SETTINGS' });
  $('baseUrl').value = settings.baseUrl;
  $('language').value = settings.language;
  $('maxSteps').value = settings.maxSteps;
  $('visionEnabled').checked = !!settings.useVision;
  $('customInstructions').value = settings.customInstructions || '';
  if (settings.model) {
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model;
    $('model').appendChild(opt);
  }
  await checkPermission();
  await refreshModels(false);
  await checkVisionPermission();
}

async function checkVisionPermission() {
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  const hint = $('visionHint');
  hint.textContent = granted
    ? "Autorisation accordee : la capture d'ecran fonctionnera sur tous les sites."
    : "Non autorise pour l'instant. Clique sur le bouton ci-dessus avant d'activer Vision.";
  hint.className = 'hint ' + (granted ? 'ok' : '');
  return granted;
}

$('visionAuthorize').addEventListener('click', async () => {
  try {
    await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (e) {
    $('visionHint').textContent = e.message;
    $('visionHint').className = 'hint err';
    return;
  }
  await checkVisionPermission();
});

$('visionEnabled').addEventListener('change', async (e) => {
  if (!e.target.checked) return;
  const granted = await checkVisionPermission();
  if (!granted) {
    e.target.checked = false;
  }
});

async function checkPermission() {
  const origin = originFromBaseUrl($('baseUrl').value.trim());
  const hint = $('permHint');
  if (!origin) {
    hint.textContent = 'Adresse invalide.';
    hint.className = 'hint err';
    return false;
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  hint.textContent = granted ? 'Autorisation accordee.' : "Clique sur 'Autoriser' pour permettre l'acces a cette adresse.";
  hint.className = 'hint ' + (granted ? 'ok' : '');
  return granted;
}

async function refreshModels(showErrors) {
  const modelHint = $('modelHint');
  const select = $('model');
  const current = select.value;
  try {
    const res = await sendMsg({ type: 'LIST_MODELS', baseUrl: $('baseUrl').value.trim() });
    if (!res.ok) throw new Error(res.error);
    select.innerHTML = '';
    if (!res.models.length) {
      modelHint.textContent = "Aucun modele installe. Fais 'ollama pull <modele>' dans un terminal.";
      modelHint.className = 'hint err';
      return;
    }
    for (const name of res.models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    if (res.models.includes(current)) select.value = current;
    modelHint.textContent = `${res.models.length} modele(s) trouve(s).`;
    modelHint.className = 'hint ok';
  } catch (e) {
    if (showErrors) {
      modelHint.textContent = e.message;
      modelHint.className = 'hint err';
    }
  }
}

$('authorize').addEventListener('click', async () => {
  const origin = originFromBaseUrl($('baseUrl').value.trim());
  if (!origin) return;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    await checkPermission();
    if (granted) refreshModels(true);
  } catch (e) {
    $('permHint').textContent = e.message;
    $('permHint').className = 'hint err';
  }
});

$('refresh').addEventListener('click', () => refreshModels(true));
$('baseUrl').addEventListener('change', () => checkPermission());

$('save').addEventListener('click', async () => {
  const settings = {
    baseUrl: $('baseUrl').value.trim().replace(/\/$/, ''),
    model: $('model').value,
    language: $('language').value,
    maxSteps: Math.max(1, Math.min(60, parseInt($('maxSteps').value, 10) || 20)),
    useVision: $('visionEnabled').checked,
    customInstructions: $('customInstructions').value.trim(),
  };
  await sendMsg({ type: 'SET_SETTINGS', settings });
  const status = $('saveStatus');
  status.textContent = 'Enregistre.';
  status.className = 'hint ok';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

loadSettings();
loadSiteToggle();
