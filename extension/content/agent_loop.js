// The ReAct-style control loop: serialize DOM -> ask the local LLM for one
// JSON action -> animate the pointer -> execute the action -> repeat.
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});

  const ACTION_SCHEMA_DOC = `Reponds STRICTEMENT avec un unique objet JSON (pas de markdown, pas de texte autour), au format exact:
{
  "thought": "raisonnement bref sur la prochaine etape",
  "memory": "resume court de ce qu'il faut retenir pour la suite (peut rester identique)",
  "action": {
    "type": "click" | "type" | "select" | "scroll" | "press_key" | "wait" | "read_text" | "ask_user" | "finish",
    "index": 0,
    "text": "texte a saisir (pour type)",
    "enter": false,
    "value": "valeur ou libelle de l'option (pour select)",
    "direction": "down",
    "amount": "page",
    "key": "Enter",
    "ms": 800,
    "question": "question posee a l'utilisateur (pour ask_user)",
    "success": true,
    "message": "message final ou question (pour finish/ask_user)"
  }
}
N'inclus que les champs pertinents pour le type d'action choisi. "index" fait reference au numero entre crochets [N] devant chaque element interactif listé.`;

  const VISION_ACTION_SCHEMA_DOC = `
En mode Pilotage visuel uniquement, tu peux aussi utiliser :
- "click_visual" avec "x" et "y" obligatoires;
- "type_visual" avec "x", "y" et "text" obligatoires (et "enter" optionnel).
Pour ces deux actions, x et y sont des pixels CSS mesures depuis le coin superieur gauche du viewport. Ne fournis jamais "index" avec une action visuelle.`;

  function systemPrompt(language, hasVision, customInstructions, readOnly, visionControl, autoApprove, draftOnly) {
    const visionLine = hasVision
      ? '\n- Une ou plusieurs images sont DEJA jointes au message utilisateur. Analyse-les directement avant de choisir ta premiere action : ne dis jamais que tu vas appeler un module Vision, demander une capture ou attendre une image. La premiere image est la vue complete de la page ; les suivantes, si presentes, sont des agrandissements d\'images visibles dans la page (captures, pieces jointes, messages d\'erreur). Lis-les avec attention. En mode normal, travaille de facon HYBRIDE : identifie la cible avec un index [N] du DOM, puis verifie dans l\'image que son libelle, sa position et son contexte correspondent avant de cliquer. Si le DOM et l\'image se contredisent, ne clique pas : observe ou demande une precision. N\'utilise des coordonnees visuelles que dans le Mode pilotage visuel actif.'
      : '';
    const customBlock = customInstructions && customInstructions.trim()
      ? `\n\nInstructions personnalisees de l'utilisateur (a respecter en plus des regles ci-dessus, mais SANS jamais changer le format JSON attendu ni le schema des actions) :\n${customInstructions.trim()}`
      : '';
    const readOnlyLine = readOnly
      ? '\n- MODE LECTURE SEULE ACTIF : n\'execute jamais click, type, select ni press_key. Tu peux seulement observer, scroll, read_text, wait, ask_user ou finish.'
      : '';
    const visionControlLine = visionControl
      ? '\n- MODE PILOTAGE VISUEL ACTIF : la page est fournie uniquement sous forme d\'une seule image plein ecran, sans DOM exploitable. Pour cliquer ou saisir dans une interface canvas, utilise click_visual ou type_visual avec x et y en pixels CSS, mesures depuis le coin superieur gauche du viewport. Ne repete jamais les memes coordonnees apres un clic : analyse la nouvelle image et termine avec finish si le changement attendu est visible. N\'utilise pas read_text ni scroll sauf demande explicite de l\'utilisateur.'
      : '';
    const autoApproveLine = autoApprove
      ? '\n- Le mode de confirmation automatique est actif : ne demande pas confirmation avec ask_user uniquement pour cliquer ou valider, execute l\'action demandee.'
      : '';
    const draftOnlyLine = draftOnly
      ? '\n- OBJECTIF BROUILLON UNIQUEMENT : ne clique pas, ne saisis rien, ne valide rien et n\'ouvre pas le formulaire de reponse. Analyse le ticket puis utilise finish avec la reponse proposee dans "message".'
      : '';
    return `Tu es un agent qui pilote un navigateur web pour accomplir un objectif donne par l'utilisateur, en observant une representation textuelle simplifiee de la page (elements interactifs numerotes [0], [1], ...).
Regles:
- Une seule action a la fois. Observe le resultat avant de continuer.
- Utilise "scroll" pour reveler des elements qui ne sont pas dans la liste actuelle.
- Quand il faut taper du texte PUIS valider immediatement (envoyer un message, valider un champ de recherche), utilise une seule action "type" avec "enter": true plutot que deux actions separees ("type" puis "press_key"): entre deux etapes distinctes, le focus peut deriver ailleurs sur la page et la validation echoue silencieusement.
- Utilise "read_text" pour lire le texte principal de la page (article, contenu editorial) quand l'objectif est de resumer, repondre a une question sur le contenu, ou extraire une information textuelle. Cette action renvoie tout le texte principal en un coup, inutile de scroller pour "trouver du contenu a lire".
- Quand l'objectif demande seulement de suggerer, rediger ou proposer une reponse, n'ecris pas dans le formulaire et ne clique pas sur "Repondre" ou "Envoyer" : analyse d'abord la page et les images jointes, puis termine avec "finish" et la proposition dans "message". Utilise "read_text" uniquement si les images ne suffisent pas.
- Utilise "ask_user" si tu as besoin d'une information que seul l'utilisateur possede (mot de passe, choix ambigu, confirmation sensible), et attends sa reponse.
- Utilise "finish" des que l'objectif est atteint, ou si tu es bloque apres plusieurs tentatives (success=false et explique pourquoi).
- Ne jamais inventer un index qui n'est pas dans la liste fournie.
- Certains elements peuvent provenir d'un iframe (marque par une ligne "-- iframe ... --" dans la liste) : ils s'utilisent exactement comme les autres, par leur numero.
- Reponds toujours dans la langue: ${language || 'fr-FR'}.${visionLine}${readOnlyLine}${visionControlLine}${autoApproveLine}${draftOnlyLine}
${ACTION_SCHEMA_DOC}${visionControl ? VISION_ACTION_SCHEMA_DOC : ''}${customBlock}`;
  }

  function captureScreenshotRaw() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error(res?.error || "Capture d'ecran impossible."));
        resolve(res.dataUrl);
      });
    });
  }

  // Downscales the raw capture so it stays reasonable to send to the model
  // (long side capped at ~1600px, re-encoded as jpeg), and returns bare base64
  // (no "data:image/jpeg;base64," prefix) as Ollama's `images` field expects.
  function resizeImageDataUrl(dataUrl, maxDim = 1600, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.onerror = () => reject(new Error('Image de capture invalide.'));
      img.src = dataUrl;
    });
  }

  // A screenshot nested in a desktop-sized capture can be too small for a
  // vision model to read. Send one crop in addition to the full page when a
  // substantial <img> is visible. Cropping the already captured page avoids
  // cross-origin canvas and authentication issues with the image URL itself.
  async function captureVisibleImageCrop(dataUrl) {
    const candidates = Array.from(document.images)
      .map((element) => ({ rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => (
        rect.width >= 140 && rect.height >= 100 &&
        rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    const candidate = candidates[0];
    if (!candidate) return null;

    return new Promise((resolve) => {
      const screenshot = new Image();
      screenshot.onload = () => {
        const scaleX = screenshot.width / innerWidth;
        const scaleY = screenshot.height / innerHeight;
        const left = Math.max(0, candidate.rect.left);
        const top = Math.max(0, candidate.rect.top);
        const right = Math.min(innerWidth, candidate.rect.right);
        const bottom = Math.min(innerHeight, candidate.rect.bottom);
        const sourceWidth = Math.round((right - left) * scaleX);
        const sourceHeight = Math.round((bottom - top) * scaleY);
        if (sourceWidth < 80 || sourceHeight < 80) return resolve(null);
        const canvas = document.createElement('canvas');
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        canvas.getContext('2d').drawImage(
          screenshot,
          Math.round(left * scaleX), Math.round(top * scaleY), sourceWidth, sourceHeight,
          0, 0, sourceWidth, sourceHeight
        );
        resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
      };
      screenshot.onerror = () => resolve(null);
      screenshot.src = dataUrl;
    });
  }

  async function captureScreenshotImages(visualControl = false) {
    const dataUrl = await captureScreenshotRaw();
    if (visualControl) {
      // Coordinate actions need one unambiguous reference frame. Do not send
      // crops here: their coordinates do not map to the viewport.
      const maxDim = Math.max(innerWidth, innerHeight) * Math.max(1, devicePixelRatio || 1);
      return [await resizeImageDataUrl(dataUrl, maxDim, 0.88)];
    }
    const [screen, crop] = await Promise.all([
      resizeImageDataUrl(dataUrl),
      captureVisibleImageCrop(dataUrl),
    ]);
    return crop ? [screen, crop] : [screen];
  }

  function extractJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
      return null;
    }
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, Math.min(Math.max(ms || 0, 0), 8000)));
  }

  function nativeSetValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 };

  function dispatchKey(el, key) {
    const keyCode = KEY_CODES[key];
    const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Rich-text editors (Slate/Draft.js/ProseMirror - Discord, X, Gmail...)
  // keep their own internal document model in sync via native browser input
  // events. Directly overwriting textContent bypasses that model entirely:
  // the text is visible but the editor's state doesn't know about it, so
  // "send on Enter" handlers see an empty message and silently no-op.
  // execCommand('insertText') goes through the real text-insertion pipeline
  // instead, which these editors are built to listen to.
  function insertIntoContentEditable(el, text) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, text ?? '');
    if (!ok) {
      el.textContent = text ?? '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  // Remembers the last element we typed into, so a later, separate
  // "press_key Enter" can re-focus it if focus silently drifted away in the
  // meantime (a full Ollama round-trip happens between two agent steps,
  // plenty of time for a rich editor's re-render to move focus elsewhere).
  let lastTypedElement = null;

  // Actions that target a specific indexed element. Runs in whichever frame
  // (top or same-page iframe) actually owns that element's local index.
  async function executeLocalIndexed(action) {
    const { type } = action;
    if (type === 'click') {
      const el = PA.dom.getElementByIndex(action.index);
      if (!el) return { ok: false, text: `Index ${action.index} introuvable.` };
      await PA.pointer.actOn(el, { click: true });
      el.click();
      await wait(350);
      return { ok: true, text: `Clic effectue sur [${action.index}].` };
    }
    if (type === 'type') {
      const el = PA.dom.getElementByIndex(action.index);
      if (!el) return { ok: false, text: `Index ${action.index} introuvable.` };
      await PA.pointer.actOn(el);
      el.focus();
      lastTypedElement = el;
      if (el.isContentEditable) {
        insertIntoContentEditable(el, action.text);
      } else {
        nativeSetValue(el, action.text ?? '');
      }
      if (action.enter) {
        await wait(120);
        dispatchKey(el, 'Enter');
      }
      await wait(200);
      return { ok: true, text: `Texte saisi dans [${action.index}]${action.enter ? ' puis Entree' : ''}.` };
    }
    if (type === 'select') {
      const el = PA.dom.getElementByIndex(action.index);
      if (!el || el.tagName !== 'SELECT') return { ok: false, text: `Index ${action.index} n'est pas un select.` };
      await PA.pointer.actOn(el, { click: true });
      const opt = Array.from(el.options).find(
        (o) => o.value === action.value || o.textContent.trim() === String(action.value).trim()
      );
      if (!opt) return { ok: false, text: `Option "${action.value}" introuvable dans [${action.index}].` };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      return { ok: true, text: `Option "${opt.textContent.trim()}" selectionnee dans [${action.index}].` };
    }
    return { ok: false, text: `Type d'action indexee inconnu: ${type}` };
  }

  function visualTarget(action) {
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      return { error: `Coordonnees visuelles invalides: (${action.x}, ${action.y}). Utilise des pixels entre 0..${innerWidth - 1} et 0..${innerHeight - 1}.` };
    }
    const element = document.elementFromPoint(x, y);
    if (!element || element.id === 'pa-widget-host' || element.id === 'pa-pointer-host') {
      return { error: 'La cible visuelle est indisponible ou appartient a l\'extension.' };
    }
    return { x, y, element };
  }

  function hasValidVisualCoordinates(action) {
    const x = Number(action.x);
    const y = Number(action.y);
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  }

  function dispatchVisualClick(element, x, y) {
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new MouseEvent('mouseup', options));
    element.dispatchEvent(new MouseEvent('click', options));
  }

  function dispatchVisualText(element, text) {
    if (element.isContentEditable) {
      insertIntoContentEditable(element, text);
      return;
    }
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      nativeSetValue(element, text);
      return;
    }
    for (const character of String(text || '')) dispatchKey(element, character);
  }

  async function executeVisual(action) {
    const target = visualTarget(action);
    if (target.error) return { ok: false, text: target.error };
    const { x, y, element } = target;
    await PA.pointer.moveTo(x, y);
    await PA.pointer.ripple();
    element.focus?.();
    dispatchVisualClick(element, x, y);
    const label = (element.getAttribute?.('aria-label') || element.innerText || element.title || element.tagName || '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
    if (action.type === 'type_visual') {
      dispatchVisualText(element, action.text);
      if (action.enter) dispatchKey(element, 'Enter');
      await wait(200);
      return { ok: true, text: `Texte visuel saisi a (${x}, ${y})${action.enter ? ' puis Entree' : ''}${label ? ` sur "${label}"` : ''}.` };
    }
    await wait(250);
    return { ok: true, text: `Clic visuel effectue a (${x}, ${y})${label ? ` sur "${label}"` : ''}.` };
  }

  // Page-level actions with no element index: always run in the top frame.
  async function executeGlobal(action) {
    const { type } = action;
    if (type === 'scroll') {
      const amount = action.amount === 'small' ? 320 : Math.round(innerHeight * 0.85);
      const delta = action.direction === 'up' ? -amount : amount;
      const before = scrollY;
      scrollBy({ top: delta, behavior: 'smooth' });
      await wait(450);
      const moved = Math.abs(scrollY - before) > 2;
      const dirLabel = action.direction === 'up' ? 'vers le haut' : 'vers le bas';
      if (!moved) {
        const atLimit = action.direction === 'up' ? 'en haut' : 'en bas';
        return {
          ok: true,
          text: `Defilement ${dirLabel} sans effet: la page est deja tout ${atLimit} (fin de page atteinte). Inutile de continuer a scroller dans cette direction, cherche une autre approche.`,
        };
      }
      return { ok: true, text: `Defilement ${dirLabel} effectue.` };
    }
    if (type === 'press_key') {
      let target = document.activeElement || document.body;
      const looksEditable = target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      );
      let refocused = false;
      if (!looksEditable && lastTypedElement && lastTypedElement.isConnected) {
        lastTypedElement.focus();
        target = lastTypedElement;
        refocused = true;
      }
      dispatchKey(target, action.key || 'Enter');
      await wait(200);
      return {
        ok: true,
        text: `Touche "${action.key}" envoyee${refocused ? ' (focus avait derive, re-focalise sur le dernier champ saisi avant d\'envoyer la touche)' : ''}.`,
      };
    }
    if (type === 'wait') {
      await wait(action.ms || 500);
      return { ok: true, text: `Attente de ${action.ms || 500} ms.` };
    }
    if (type === 'read_text') {
      const text = PA.dom.extractMainText();
      return { ok: true, text: `Texte principal de la page:\n${text}` };
    }
    return { ok: false, text: `Type d'action inconnu: ${type}` };
  }

  const INDEXED_TYPES = new Set(['click', 'type', 'select']);
  const VISUAL_TYPES = new Set(['click_visual', 'type_visual']);

  // Routes an action to wherever it needs to run: locally, in a same-page
  // iframe (via frame_bridge), or as a top-frame page-level action.
  async function dispatch(action, routes) {
    if (VISUAL_TYPES.has(action.type)) return executeVisual(action);
    if (!INDEXED_TYPES.has(action.type)) return executeGlobal(action);
    const route = routes && routes[action.index];
    if (!route) return { ok: false, text: `Index ${action.index} introuvable.` };
    if (route.local) return executeLocalIndexed({ ...action, index: route.index });
    // Generous timeout: the target frame animates the pointer (highlight +
    // move + optional ripple) before executing, which alone takes ~650ms.
    const res = await PA.frames.requestFrame(route.frameId, { ...action, index: route.index });
    if (!res) return { ok: false, text: `Le cadre (iframe) contenant [${action.index}] n'a pas repondu a temps.` };
    return res.result;
  }

  PA.actions = { executeLocalIndexed, executeGlobal };

  function chat(messages, settings) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'CHAT', messages, baseUrl: settings.baseUrl, model: settings.model, provider: settings.provider },
        (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.ok) return reject(new Error(res?.error || 'Erreur inconnue lors de l\'appel a Ollama.'));
          resolve(res);
        }
      );
    });
  }

  function createController({ onThought, onActionResult, onError, onFinish, onAskUser, onConfirmAction, onStep, onPersist }) {
    let stopped = false;
    let currentGoal = '';
    let memory = '';

    async function step(settings, lastResult, stepNum, historyBlock) {
      const frameData = settings.visionControl ? { lines: [], routes: {} } : await PA.frames.collectAll();
      const { lines, routes } = frameData;
      const domSnapshot = settings.visionControl
        ? `Mode pilotage visuel : viewport ${innerWidth}x${innerHeight} px. Utilise uniquement les images jointes.`
        : `${PA.dom.header()}\n${lines.length ? lines.join('\n') : '(aucun element interactif visible dans le viewport actuel)'}`;
      const userMsgParts = [];
      if (historyBlock) userMsgParts.push(historyBlock, '');
      userMsgParts.push(
        `Objectif: ${currentGoal}`,
        `Etape: ${stepNum}/${settings.maxSteps}`,
        `Memoire: ${memory || '(vide)'}`,
        `Resultat de l'action precedente: ${lastResult || '(aucune action encore)'}`,
        '',
        domSnapshot,
      );
      let images;
      if ((settings.useVision || settings.visionControl) && (settings.visionControl || settings.visionFrequency !== 'first_step' || stepNum === 1)) {
        try {
          images = await captureScreenshotImages(settings.visionControl);
        } catch (e) {
          throw new Error(`Vision activee, mais la capture d'ecran a echoue: ${e.message}`);
        }
      }
      const userMsg = userMsgParts.join('\n');

      const userMessage = { role: 'user', content: userMsg };
      if (images) userMessage.images = images;

      const messages = [
        { role: 'system', content: systemPrompt(settings.language, Boolean(images), settings.customInstructions, settings.readOnly, settings.visionControl, settings.sensitiveActionMode === 'auto', isDraftOnlyGoal(currentGoal)) },
        userMessage,
      ];

      let response = await chat(messages, settings);
      if (images && response.imageCount !== images.length) {
        throw new Error('La capture a ete preparee, mais elle n\'a pas ete jointe a la requete envoyee au serveur.');
      }
      let raw = response.content;
      let parsed = extractJson(raw);
      if (!parsed || !parsed.action) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: 'Ta reponse precedente n\'etait pas un JSON valide selon le schema demande. Reponds uniquement avec le JSON.',
        });
        response = await chat(messages, settings);
        if (images && response.imageCount !== images.length) {
          throw new Error('La capture a ete preparee, mais elle n\'a pas ete jointe a la requete de correction envoyee au serveur.');
        }
        raw = response.content;
        parsed = extractJson(raw);
      }
      if (!parsed || !parsed.action) {
        throw new Error('Le modele n\'a pas renvoye un JSON exploitable: ' + raw.slice(0, 200));
      }
      return { parsed, routes, lines };
    }

    const SENSITIVE_ACTION_RE = /\b(publier|poster|tweet(er)?|envoyer|soumettre|submit|send|repondre|reply|commenter|comment|payer|paiement|pay|acheter|buy|commander|order|checkout|purchase|confirmer|confirm|valider|supprimer|effacer|delete|remove|desabonner|unsubscribe)\b/i;

    function normalizeForMatch(text) {
      return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    }

    function sensitiveLabel(lineText) {
      if (!lineText || !SENSITIVE_ACTION_RE.test(normalizeForMatch(lineText))) return null;
      const quoted = lineText.match(/"([^"]*)"/);
      return quoted ? quoted[1] : lineText.replace(/^\[\d+\]\s*/, '');
    }

    function isDraftOnlyGoal(goal) {
      const text = normalizeForMatch(goal);
      const asksForDraft = /\b(propose|suggere|redige|formule|prepare|brouillon|draft|reponse)\b/.test(text);
      const authorizesMutation = /\b(envoie|envoyer|publie|publier|poste|poster|saisis|saisir|soumet|soumettre|valide|valider|clique|cliquer)\b/.test(text);
      return asksForDraft && !authorizesMutation;
    }

    function actionSignature(action) {
      return JSON.stringify([action.type, action.index, action.direction, action.value, (action.text || '').slice(0, 30)]);
    }

    async function run(goal, settings, resumeState, historyBlock) {
      stopped = false;
      currentGoal = goal;
      memory = resumeState?.memory || '';
      let lastResult = resumeState?.lastResult || '';
      let stepNum = resumeState?.stepNum || 1;
      let lastActionSignature = null;
      let repeatCount = 0;
      let lastReadTextResult = null;
      let lastVisualActionSignature = null;
      const draftOnly = isDraftOnlyGoal(goal);

      while (!stopped && stepNum <= settings.maxSteps) {
        onStep && onStep(stepNum, settings.maxSteps);
        let parsed, routes, lines;
        try {
          ({ parsed, routes, lines } = await step(settings, lastResult, stepNum, historyBlock));
        } catch (e) {
          onError && onError(e.message || String(e));
          return;
        }
        if (stopped) return;

        if (parsed.thought) onThought && onThought(parsed.thought);
        if (parsed.memory) memory = parsed.memory;

        const action = parsed.action || {};
        if (action.type === 'finish') {
          onFinish && onFinish({ success: action.success !== false, message: action.message || '' });
          return;
        }
        if (action.type === 'ask_user') {
          const answer = await (onAskUser ? onAskUser(action.question || action.message || 'Une precision ?') : Promise.resolve(''));
          if (stopped) return;
          lastResult = `L'utilisateur repond a la question "${action.question || ''}": ${answer}`;
          stepNum += 1;
          onPersist && onPersist(getState(lastResult, stepNum));
          continue;
        }

        if (draftOnly && (INDEXED_TYPES.has(action.type) || VISUAL_TYPES.has(action.type) || action.type === 'press_key')) {
          lastResult = `Objectif de redaction detecte: ne modifie pas le ticket et ne clique pas sur le formulaire. Analyse le contexte puis utilise finish avec le brouillon de reponse.`;
          stepNum += 1;
          onPersist && onPersist(getState(lastResult, stepNum));
          continue;
        }

        if (settings.readOnly && (INDEXED_TYPES.has(action.type) || VISUAL_TYPES.has(action.type) || action.type === 'press_key')) {
          lastResult = `Mode lecture seule: l'action "${action.type}" est bloquee. Observe la page puis utilise finish pour repondre.`;
          stepNum += 1;
          onPersist && onPersist(getState(lastResult, stepNum));
          continue;
        }

        if (VISUAL_TYPES.has(action.type) && !hasValidVisualCoordinates(action)) {
          lastResult = `Action visuelle refusee: click_visual/type_visual exige x et y valides en pixels CSS; ne fournis jamais un index. Le viewport mesure ${innerWidth}x${innerHeight}.`;
          stepNum += 1;
          onPersist && onPersist(getState(lastResult, stepNum));
          continue;
        }

        const visualSignature = VISUAL_TYPES.has(action.type)
          ? `${action.type}:${action.x}:${action.y}`
          : null;
        if (visualSignature && visualSignature === lastVisualActionSignature) {
          lastResult = `Action visuelle bloquee: les coordonnees (${action.x}, ${action.y}) viennent deja d'etre utilisees. Analyse la nouvelle capture, choisis une coordonnee differente ou termine avec finish.`;
          stepNum += 1;
          onPersist && onPersist(getState(lastResult, stepNum));
          continue;
        }

        const needsSubmissionConfirmation =
          (action.type === 'type' && action.enter) ||
          (action.type === 'press_key' && (action.key || 'Enter') === 'Enter');
        if (action.type === 'click' || VISUAL_TYPES.has(action.type) || needsSubmissionConfirmation) {
          const label = action.type === 'click'
            ? sensitiveLabel(lines[action.index])
            : VISUAL_TYPES.has(action.type)
              ? `Action visuelle a (${action.x}, ${action.y})`
            : 'Valider ou envoyer le contenu saisi';
          if (label) {
            // Visual/coordinate clicks have no DOM to cross-check against
            // (that's the whole "double verification DOM + vision" idea),
            // so they always require a human's OK - never skipped by auto
            // mode or "always for this page".
            const forceConfirm = VISUAL_TYPES.has(action.type);
            const confirmed = onConfirmAction
              ? await onConfirmAction(label, lines[action.index], { force: forceConfirm })
              : true;
            if (stopped) return;
            if (!confirmed) {
              lastResult = `L'utilisateur a refuse cette action jugee sensible ("${label}"). Choisis une autre approche, utilise "ask_user" pour clarifier, ou conclus avec "finish" si tu ne peux pas continuer sans elle.`;
              stepNum += 1;
              onPersist && onPersist(getState(lastResult, stepNum));
              continue;
            }
          }
        }

        let result;
        try {
          result = await dispatch(action, routes);
        } catch (e) {
          result = { ok: false, text: 'Erreur lors de l\'execution: ' + (e.message || String(e)) };
        }
        onActionResult && onActionResult(action, result);

        if (visualSignature && result.ok) lastVisualActionSignature = visualSignature;

        const sig = actionSignature(action);
        repeatCount = sig === lastActionSignature ? repeatCount + 1 : 1;
        lastActionSignature = sig;
        lastResult = result.text;
        if (repeatCount >= 3) {
          lastResult += ` ATTENTION: tu repetes exactement la meme action depuis ${repeatCount} etapes sans progres visible. N'y reviens pas: essaie une approche differente, ou conclus avec "finish" (success=false) en expliquant le blocage.`;
        }
        if (action.type === 'read_text' && result.ok) {
          if (lastReadTextResult !== null && result.text === lastReadTextResult) {
            lastResult += ' ATTENTION: ce texte est identique a la derniere lecture, il n\'y a rien de nouveau ici. Ne relis pas encore une fois: passe a une autre action (scroll, clic) ou conclus avec "finish".';
          }
          lastReadTextResult = result.text;
        }
        stepNum += 1;
        onPersist && onPersist(getState(lastResult, stepNum));
      }
      if (!stopped) {
        onFinish && onFinish({ success: false, message: 'Nombre maximum d\'etapes atteint sans conclusion.' });
      }
    }

    function stop() {
      stopped = true;
    }

    function getState(lastResult, stepNum) {
      return { goal: currentGoal, memory, lastResult, stepNum };
    }

    return { run, stop, getState };
  }

  PA.agent = { createController };
})();
