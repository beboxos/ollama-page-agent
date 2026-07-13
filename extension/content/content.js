// Wires the widget UI to the agent loop, handles settings + session
// persistence across page navigations (so a multi-page task can resume).
(function () {
  const PA = (window.__PA_AGENT__ = window.__PA_AGENT__ || {});
  if (PA.__contentInit) return; // avoid double-injection
  PA.__contentInit = true;

  let controller = null;
  let pendingUserReply = null; // resolver for ask_user, set while awaiting
  let autoApproveSensitive = false; // "toujours pour cette page" - resets on reload/navigation

  function sendMsg(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
    });
  }

  // Thrown/rejected whenever the extension was reloaded (chrome://extensions
  // -> reload icon) while this page's content script - injected under the
  // old instance - is still alive. Any chrome.* call from it fails this way;
  // the only real fix is refreshing the page to get a fresh content script.
  function friendlyError(msgOrErr) {
    const msg = typeof msgOrErr === 'string' ? msgOrErr : (msgOrErr?.message || String(msgOrErr));
    if (/Extension context invalidated/i.test(msg)) {
      return "L'extension a ete rechargee/mise a jour depuis l'ouverture de cette page. Rafraichis la page (F5) pour continuer a utiliser l'agent.";
    }
    return msg;
  }

  const DISABLED_SITES_KEY = 'pa_disabled_sites';

  async function isSiteDisabled() {
    const stored = await chrome.storage.local.get(DISABLED_SITES_KEY);
    const list = stored[DISABLED_SITES_KEY] || [];
    return list.includes(location.origin);
  }

  const HISTORY_MAX = 15;
  const historyKey = () => 'pa_history_' + location.origin;

  async function loadHistory() {
    const stored = await chrome.storage.local.get(historyKey());
    return stored[historyKey()] || [];
  }

  async function appendHistory(entry) {
    const list = await loadHistory();
    list.push(entry);
    while (list.length > HISTORY_MAX) list.shift();
    await chrome.storage.local.set({ [historyKey()]: list });
  }

  async function clearHistory() {
    await chrome.storage.local.remove(historyKey());
  }

  function formatHistoryForPrompt(list) {
    if (!list.length) return '';
    const recent = list.slice(-5);
    const lines = recent.map(
      (e) => `- [${e.date}] Objectif: "${e.goal}" -> ${e.success ? 'reussi' : 'echec'}: ${e.message}`
    );
    return `Historique recent de tes actions sur ce site (${location.hostname}):\n${lines.join('\n')}`;
  }

  function describeAction(action) {
    switch (action.type) {
      case 'click': return `Clic -> [${action.index}]`;
      case 'type': return `Saisie -> [${action.index}]: "${action.text}"`;
      case 'select': return `Selection -> [${action.index}]: "${action.value}"`;
      case 'scroll': return `Defilement ${action.direction || 'down'}`;
      case 'press_key': return `Touche: ${action.key}`;
      case 'wait': return `Attente ${action.ms || 0} ms`;
      case 'read_text': return 'Lecture du texte principal de la page';
      default: return action.type;
    }
  }

  async function startTask(goal, resumeState) {
    const { settings } = await sendMsg({ type: 'GET_SETTINGS' });
    if (!settings.model) {
      PA.widget.log('error', "Aucun modele Ollama configure. Ouvre les reglages (icone engrenage) pour en choisir un.");
      return;
    }

    PA.widget.open();
    PA.widget.setRunning(true);
    if (!resumeState) PA.widget.clearLog();
    PA.widget.log('system', resumeState ? 'Reprise de la tache apres navigation...' : `Objectif: ${goal}`);

    controller = PA.agent.createController({
      onStep(stepNum, max) {
        PA.widget.setStatus('running');
      },
      onThought(text) {
        PA.widget.log('thought', text);
      },
      onActionResult(action, result) {
        const preview = result.text.length > 220 ? result.text.slice(0, 220) + '… (tronque dans l\'affichage, texte complet transmis au modele)' : result.text;
        PA.widget.log('action', `${describeAction(action)}\n${result.ok ? '✓' : '⚠'} ${preview}`);
      },
      onError(message) {
        PA.widget.log('error', friendlyError(message));
        PA.widget.setRunning(false);
        PA.widget.setStatus('error');
        PA.pointer.clear();
        sendMsg({ type: 'CLEAR_SESSION' }).catch(() => {});
      },
      onFinish({ success, message }) {
        PA.widget.log(success ? 'done' : 'error', message || (success ? 'Tache terminee.' : 'Tache interrompue.'));
        PA.widget.setRunning(false);
        PA.widget.setStatus(success ? 'done' : 'error');
        PA.pointer.clear();
        sendMsg({ type: 'CLEAR_SESSION' }).catch(() => {});
        appendHistory({
          date: new Date().toLocaleString('fr-FR'),
          goal,
          success,
          message: (message || '').slice(0, 200),
        }).catch(() => {});
      },
      onAskUser(question) {
        PA.widget.log('action', `❓ ${question}`);
        PA.widget.setStatus('idle');
        return new Promise((resolve) => {
          pendingUserReply = (answer) => {
            pendingUserReply = null;
            PA.widget.log('system', `Reponse: ${answer}`);
            PA.widget.setStatus('running');
            resolve(answer);
          };
        });
      },
      onPersist(state) {
        sendMsg({ type: 'SET_SESSION', session: { running: true, goal, ...state } }).catch(() => {});
      },
      async onConfirmAction(label, detail) {
        if (settings.sensitiveActionMode === 'auto' || autoApproveSensitive) return true;
        PA.widget.setStatus('idle');
        const choice = await PA.widget.confirmAction(label, detail);
        PA.widget.setStatus('running');
        if (choice === 'always') autoApproveSensitive = true;
        return choice !== 'cancel';
      },
    });

    const historyBlock = resumeState ? '' : formatHistoryForPrompt(await loadHistory());
    controller.run(goal, settings, resumeState, historyBlock).catch((e) => {
      PA.widget.log('error', 'Erreur inattendue: ' + friendlyError(e));
      PA.widget.setRunning(false);
      PA.widget.setStatus('error');
      PA.pointer.clear();
    });
  }

  function stopTask() {
    if (controller) controller.stop();
    if (pendingUserReply) pendingUserReply('(annule par l\'utilisateur)');
    PA.widget.setRunning(false);
    PA.widget.setStatus('idle');
    PA.pointer.clear();
    PA.widget.log('system', 'Arrete par l\'utilisateur.');
    sendMsg({ type: 'CLEAR_SESSION' }).catch(() => {});
  }

  async function init() {
    if (!PA.frames.isTop) return; // iframes only run the passive frame_bridge listener
    if (await isSiteDisabled()) return; // user turned the widget off for this site

    PA.widget.ensureInit();
    PA.widget.onRun((goal) => {
      if (pendingUserReply) {
        pendingUserReply(goal);
        PA.widget.log('system', `Tu: ${goal}`);
        return;
      }
      startTask(goal).catch((e) => {
        PA.widget.log('error', friendlyError(e));
        PA.widget.setRunning(false);
        PA.widget.setStatus('error');
      });
    });
    PA.widget.onStop(stopTask);
    PA.widget.onHistory(async () => {
      try {
        PA.widget.open();
        const history = await loadHistory();
        if (!history.length) {
          PA.widget.log('system', 'Aucun historique enregistre pour ce site.');
          return;
        }
        PA.widget.log('system', `Historique (${history.length}) pour ${location.hostname}:`);
        for (const e of history) {
          PA.widget.log('system', `[${e.date}] "${e.goal}" -> ${e.success ? '✓' : '✗'} ${e.message}`);
        }
      } catch (e) {
        PA.widget.log('error', friendlyError(e));
      }
    });
    PA.widget.onClearHistory(async () => {
      try {
        if (!confirm("Vider l'historique enregistre pour ce site ?")) return;
        await clearHistory();
        PA.widget.log('system', 'Historique vide.');
      } catch (e) {
        PA.widget.log('error', friendlyError(e));
      }
    });

    try {
      const { session } = await sendMsg({ type: 'GET_SESSION' });
      if (session && session.running && session.goal) {
        await startTask(session.goal, {
          memory: session.memory,
          lastResult: session.lastResult,
          stepNum: session.stepNum,
        });
      }
    } catch {
      // background not ready / no active session, ignore
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
