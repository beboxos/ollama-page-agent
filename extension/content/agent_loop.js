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

  function systemPrompt(language, hasVision, customInstructions) {
    const visionLine = hasVision
      ? '\n- Une capture d\'ecran de la zone visible t\'est aussi fournie en complement du texte, pour t\'aider a comprendre la mise en page visuellement. Elle est purement informative : pour agir, utilise toujours les index [N] du texte, jamais des coordonnees a l\'oeil.'
      : '';
    const customBlock = customInstructions && customInstructions.trim()
      ? `\n\nInstructions personnalisees de l'utilisateur (a respecter en plus des regles ci-dessus, mais SANS jamais changer le format JSON attendu ni le schema des actions) :\n${customInstructions.trim()}`
      : '';
    return `Tu es un agent qui pilote un navigateur web pour accomplir un objectif donne par l'utilisateur, en observant une representation textuelle simplifiee de la page (elements interactifs numerotes [0], [1], ...).
Regles:
- Une seule action a la fois. Observe le resultat avant de continuer.
- Utilise "scroll" pour reveler des elements qui ne sont pas dans la liste actuelle.
- Quand il faut taper du texte PUIS valider immediatement (envoyer un message, valider un champ de recherche), utilise une seule action "type" avec "enter": true plutot que deux actions separees ("type" puis "press_key"): entre deux etapes distinctes, le focus peut deriver ailleurs sur la page et la validation echoue silencieusement.
- Utilise "read_text" pour lire le texte principal de la page (article, contenu editorial) quand l'objectif est de resumer, repondre a une question sur le contenu, ou extraire une information textuelle. Cette action renvoie tout le texte principal en un coup, inutile de scroller pour "trouver du contenu a lire".
- Utilise "ask_user" si tu as besoin d'une information que seul l'utilisateur possede (mot de passe, choix ambigu, confirmation sensible), et attends sa reponse.
- Utilise "finish" des que l'objectif est atteint, ou si tu es bloque apres plusieurs tentatives (success=false et explique pourquoi).
- Ne jamais inventer un index qui n'est pas dans la liste fournie.
- Certains elements peuvent provenir d'un iframe (marque par une ligne "-- iframe ... --" dans la liste) : ils s'utilisent exactement comme les autres, par leur numero.
- Reponds toujours dans la langue: ${language || 'fr-FR'}.${visionLine}
${ACTION_SCHEMA_DOC}${customBlock}`;
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

  // Downscales the raw capture so it stays cheap to send to the model (long
  // side capped at ~1024px, re-encoded as jpeg), and returns bare base64
  // (no "data:image/jpeg;base64," prefix) as Ollama's `images` field expects.
  function resizeImageDataUrl(dataUrl, maxDim = 1024, quality = 0.6) {
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

  async function captureScreenshotBase64() {
    const dataUrl = await captureScreenshotRaw();
    return resizeImageDataUrl(dataUrl);
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

  // Routes an action to wherever it needs to run: locally, in a same-page
  // iframe (via frame_bridge), or as a top-frame page-level action.
  async function dispatch(action, routes) {
    if (!INDEXED_TYPES.has(action.type)) return executeGlobal(action);
    const route = routes && routes[action.index];
    if (!route) return { ok: false, text: `Index ${action.index} introuvable.` };
    if (route.local) return executeLocalIndexed({ ...action, index: route.index });
    // Generous timeout: the target frame animates the pointer (highlight +
    // move + optional ripple) before executing, which alone takes ~650ms.
    const res = await PA.frames.requestFrame(
      route.frameWindow,
      'EXEC_REQUEST',
      { action: { ...action, index: route.index } },
      6000
    );
    if (!res) return { ok: false, text: `Le cadre (iframe) contenant [${action.index}] n'a pas repondu a temps.` };
    return res.result;
  }

  PA.actions = { executeLocalIndexed, executeGlobal };

  function chat(messages, settings) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'CHAT', messages, baseUrl: settings.baseUrl, model: settings.model },
        (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.ok) return reject(new Error(res?.error || 'Erreur inconnue lors de l\'appel a Ollama.'));
          resolve(res.content);
        }
      );
    });
  }

  function createController({ onThought, onActionResult, onError, onFinish, onAskUser, onConfirmAction, onStep, onPersist }) {
    let stopped = false;
    let currentGoal = '';
    let memory = '';

    async function step(settings, lastResult, stepNum, historyBlock) {
      const { lines, routes } = await PA.frames.collectAll();
      const domSnapshot = `${PA.dom.header()}\n${lines.length ? lines.join('\n') : '(aucun element interactif visible dans le viewport actuel)'}`;
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
      if (settings.useVision) {
        try {
          images = [await captureScreenshotBase64()];
        } catch (e) {
          userMsgParts.push('', `(Capture d'ecran indisponible: ${e.message})`);
        }
      }
      const userMsg = userMsgParts.join('\n');

      const userMessage = { role: 'user', content: userMsg };
      if (images) userMessage.images = images;

      const messages = [
        { role: 'system', content: systemPrompt(settings.language, settings.useVision, settings.customInstructions) },
        userMessage,
      ];

      let raw = await chat(messages, settings);
      let parsed = extractJson(raw);
      if (!parsed || !parsed.action) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: 'Ta reponse precedente n\'etait pas un JSON valide selon le schema demande. Reponds uniquement avec le JSON.',
        });
        raw = await chat(messages, settings);
        parsed = extractJson(raw);
      }
      if (!parsed || !parsed.action) {
        throw new Error('Le modele n\'a pas renvoye un JSON exploitable: ' + raw.slice(0, 200));
      }
      return { parsed, routes, lines };
    }

    const SENSITIVE_ACTION_RE = /\b(publier|poster|tweet(er)?|envoyer|soumettre|submit|send|r[ée]pondre|reply|commenter|comment|payer|paiement|pay|acheter|buy|commander|order|checkout|purchase|confirmer|confirm|valider|supprimer|effacer|delete|remove|d[ée]sabonner|unsubscribe)\b/i;

    function sensitiveLabel(lineText) {
      if (!lineText || !SENSITIVE_ACTION_RE.test(lineText)) return null;
      const quoted = lineText.match(/"([^"]*)"/);
      return quoted ? quoted[1] : lineText.replace(/^\[\d+\]\s*/, '');
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

        if (action.type === 'click') {
          const label = sensitiveLabel(lines[action.index]);
          if (label) {
            const confirmed = onConfirmAction
              ? await onConfirmAction(label, lines[action.index])
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
