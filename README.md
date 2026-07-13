# Ollama Page Agent

🇫🇷 [Français](#français) · 🇬🇧 [English](#english)

---

## Français

### Origine du projet

Ce projet est une réimplémentation indépendante, inspirée de **[page-agent](https://github.com/alibaba/page-agent)** d'Alibaba (package npm [`page-agent`](https://www.npmjs.com/package/page-agent), licence MIT, © SimonLuvRamen et Alibaba Group Holding Limited) — un agent JavaScript "in-page" qui pilote une interface web en langage naturel via une perception textuelle du DOM (pas de captures d'écran, pas de modèle vision). Le point de départ concret a été [ce bookmarklet de démo](https://cdn.jsdelivr.net/npm/page-agent@1.5.7/dist/iife/page-agent.demo.js), étudié pour en comprendre l'architecture (perception DOM indexée, boucle d'actions JSON, LLM "bring your own").

**Ollama Page Agent** en reprend l'idée générale — DOM sérialisé en éléments interactifs numérotés, boucle d'actions JSON exécutées dans la page — mais avec un code entièrement réécrit, sous forme d'**extension Chrome (Manifest V3)**, branché sur un **modèle Ollama local** plutôt qu'une API cloud, avec en plus : un curseur visuel animé, un widget de chat flottant, le support des iframes, un historique persistant par site, et la reprise de tâche après navigation.

Aucune ligne de code de page-agent n'a été copiée ; seule l'approche architecturale documentée publiquement a servi d'inspiration.

### Comment ça marche

Le DOM de la page est transformé en une liste texte d'éléments interactifs numérotés (`[0]`, `[1]`, ...), envoyée à un LLM local avec ton objectif en langage naturel. Le modèle répond avec une action JSON (`click`, `type`, `select`, `scroll`, `read_text`, ...), exécutée dans la page pendant qu'un curseur visuel se déplace et clique à l'écran pour que tu voies ce qui se passe.

Tout tourne en local : aucune donnée de page n'est envoyée ailleurs qu'à ton propre serveur Ollama.

### Installation

#### 1. Ollama

```
ollama pull qwen2.5:7b-instruct      # ou llama3.1:8b, mistral-nemo, etc.
```

Autorise l'extension à appeler Ollama en définissant la variable d'environnement **avant** de lancer le serveur (sinon Ollama bloque la requête en CORS) :

```
# Windows (PowerShell)
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve

# macOS / Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Si tu utilises l'appli de bureau Ollama (icône dans la zone de notification), il faut la quitter complètement puis la relancer après avoir défini la variable pour qu'elle en tienne compte.

Choisis un modèle avec de bonnes capacités d'instruction-following et de sortie JSON. Les très petits modèles (< 3B) suivent mal le format et bloquent la boucle.

#### 2. L'extension

1. Ouvre `chrome://extensions`
2. Active le **mode développeur** (en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `extension/` de ce dépôt

#### 3. Configuration

Clique sur l'icône de l'extension dans la barre d'outils (ou l'engrenage du widget flottant) :

1. Vérifie l'adresse du serveur (`http://localhost:11434` par défaut)
2. Clique **Autoriser** pour donner à l'extension la permission Chrome d'appeler cette adresse
3. Choisis un modèle dans la liste (rafraîchie automatiquement depuis `/api/tags`)
4. Enregistre

### Utilisation

Sur n'importe quelle page, une bulle 🤖 apparaît en bas à droite. Clique dessus, tape ton objectif ("remplis le formulaire de contact avec mon nom Jean Dupont", "résume-moi cet article", "trouve le lien de désabonnement et clique dessus", ...) et lance.

Le panneau affiche en temps réel les pensées du modèle et les actions exécutées, pendant que le curseur visuel se déplace sur la page. Deux boutons dans l'en-tête donnent accès à l'historique des tâches passées sur ce site (🕘) et permettent de le vider (🗑). La tâche survit à une navigation (changement de page) : elle reprend automatiquement avec sa mémoire si le modèle a cliqué un lien. Les éléments situés dans des iframes de la page sont aussi détectés et pilotables.

La bulle 🤖 et le panneau (via son en-tête) se déplacent librement par glisser-déposer si leur position par défaut te gêne — la nouvelle position est mémorisée et réappliquée sur toutes les pages.

Le widget ne s'affiche jamais à l'impression (`@media print`). Pour le désactiver complètement sur un site donné, ouvre le popup de l'extension (icône dans la barre d'outils) **sur ce site** et bascule l'interrupteur **"Actif sur ce site"** — un rafraîchissement de la page applique le changement.

### Vision (modèles multimodaux)

Si tu utilises un modèle Ollama multimodal (ex : `gemma3`, `llava`, `qwen2-vl`), tu peux activer l'option **"Vision"** dans les réglages : une capture d'écran de la zone visible est alors envoyée en complément du texte à chaque étape, pour aider le modèle à mieux comprendre des mises en page ambiguës. Ça reste purement informatif — les actions se font toujours par index `[N]`, jamais par coordonnées.

Cette option est **désactivée par défaut** : sans elle, tout fonctionne exactement comme avant (texte seul), y compris avec des modèles non multimodaux. L'activer nécessite d'autoriser la capture d'écran sur tous les sites (bouton dédié dans les réglages) — permission plus large que le strict nécessaire pour le reste de l'extension, à activer uniquement si tu comptes t'en servir.

### Confirmation avant une action sensible

Avant tout **clic** sur un élément dont le libellé contient un mot-clé jugé sensible (publier, tweeter, envoyer, répondre, payer, acheter, commander, confirmer, valider, supprimer, se désabonner, ...), l'agent s'arrête et affiche une demande de confirmation dans le panneau (boutons **Confirmer** / **Annuler**) au lieu d'exécuter le clic directement. Si tu annules, l'agent en est informé et doit trouver une autre approche ou conclure. Cette détection se fait par mots-clés sur le texte visible du bouton : elle est volontairement large (elle peut se déclencher sur un simple bandeau de cookies) plutôt que de risquer de laisser passer une vraie action irréversible (publication publique, achat, suppression).

### Structure

```
extension/
  manifest.json           # MV3, all_frames actif
  background.js            # pont vers l'API Ollama (/api/chat, /api/tags), permissions, session
  content/
    dom_serializer.js      # DOM -> texte indexe pour le LLM (+ extraction de texte principal)
    pointer.js              # curseur visuel + surlignage + ripple de clic
    widget.js                # panneau de chat flottant (shadow DOM), historique
    agent_loop.js           # boucle ReAct: prompt -> JSON action -> execution, anti-boucle
    frame_bridge.js         # fusionne/route les elements entre cadre principal et iframes
    content.js               # colle le tout, gere session + historique par site
  popup/                     # reglages (aussi utilise comme page d'options)
```

### Limites connues

- Dépend fortement de la capacité du modèle local à répondre en JSON valide et à raisonner sur des listes d'éléments ; préfère des modèles 7B+ instruct.
- Ne fonctionne pas sur `chrome://`, les pages du Web Store, ni les fichiers locaux `file://`.
- Un site avec une CSP très stricte peut bloquer certaines interactions synthétiques (rare).

### Licence

MIT — voir [LICENSE](LICENSE).

---

## English

### Origin

This project is an independent reimplementation inspired by **[page-agent](https://github.com/alibaba/page-agent)** by Alibaba (npm package [`page-agent`](https://www.npmjs.com/package/page-agent), MIT license, © SimonLuvRamen and Alibaba Group Holding Limited) — an in-page JavaScript agent that controls a web UI in natural language through text-based DOM perception (no screenshots, no vision model). The concrete starting point was [this demo bookmarklet](https://cdn.jsdelivr.net/npm/page-agent@1.5.7/dist/iife/page-agent.demo.js), studied to understand its architecture (indexed DOM perception, JSON action loop, bring-your-own LLM).

**Ollama Page Agent** reuses the general idea — DOM serialized into numbered interactive elements, a loop of JSON actions executed on the page — but with entirely rewritten code, packaged as a **Chrome extension (Manifest V3)**, wired to a **local Ollama model** instead of a cloud API, plus: an animated visual pointer, a floating chat widget, iframe support, persistent per-site history, and task resumption across navigation.

No page-agent code was copied; only the publicly documented architectural approach served as inspiration.

### How it works

The page's DOM is turned into a numbered text list of interactive elements (`[0]`, `[1]`, ...), sent to a local LLM along with your natural-language goal. The model replies with one JSON action (`click`, `type`, `select`, `scroll`, `read_text`, ...), executed on the page while a visual cursor moves and clicks on screen so you can see what's happening.

Everything runs locally: no page data is ever sent anywhere except your own Ollama server.

### Installation

#### 1. Ollama

```
ollama pull qwen2.5:7b-instruct      # or llama3.1:8b, mistral-nemo, etc.
```

Allow the extension to call Ollama by setting this environment variable **before** starting the server (otherwise Ollama rejects the request with a CORS error):

```
# Windows (PowerShell)
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve

# macOS / Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

If you use the Ollama desktop app (tray icon), fully quit it and relaunch after setting the variable so it picks it up.

Pick a model with decent instruction-following and JSON-output ability. Very small models (< 3B) struggle with the format and stall the loop.

#### 2. The extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this repo's `extension/` folder

#### 3. Configuration

Click the extension's toolbar icon (or the gear icon in the floating widget):

1. Check the server address (`http://localhost:11434` by default)
2. Click **Authorize** to grant the extension Chrome permission to call that address
3. Pick a model from the list (auto-refreshed from `/api/tags`)
4. Save

### Usage

On any page, a 🤖 bubble appears bottom-right. Click it, type your goal ("fill the contact form with my name John Doe", "summarize this article", "find the unsubscribe link and click it", ...) and launch.

The panel shows the model's reasoning and executed actions live, while the visual cursor moves across the page. Two header buttons give access to this site's task history (🕘) and let you clear it (🗑). A task survives a navigation (page change): it automatically resumes with its memory if the model clicked a link. Elements inside same-page iframes are also detected and controllable.

The 🤖 bubble and the panel (via its header) can both be freely dragged if their default corner gets in the way — the new position is remembered and reapplied on every page.

The widget never shows up when printing (`@media print`). To turn it off entirely for a given site, open the extension's toolbar popup **on that site** and flip the **"Active on this site"** switch — refresh the page for the change to take effect.

### Vision (multimodal models)

If you're running a multimodal Ollama model (e.g. `gemma3`, `llava`, `qwen2-vl`), you can enable **"Vision"** in settings: a screenshot of the visible area is then sent alongside the text on every step, to help the model make sense of ambiguous layouts. It's purely informational — actions still always go through `[N]` indices, never coordinates.

This option is **off by default**: without it, everything works exactly as before (text only), including with non-multimodal models. Turning it on requires authorizing screenshot capture on all sites (dedicated button in settings) — a broader permission than the rest of the extension strictly needs, so only grant it if you actually plan to use this feature.

### Confirmation before a sensitive action

Before any **click** on an element whose label contains a keyword considered sensitive (publish, tweet, send, reply, pay, buy, order, confirm, submit, delete, unsubscribe, ...), the agent stops and shows a confirmation prompt in the panel (**Confirm** / **Cancel** buttons) instead of executing the click directly. If you cancel, the agent is told and must find another approach or wrap up. This is a keyword-based heuristic on the button's visible text — deliberately broad (it can trigger on a plain cookie banner) rather than risk missing a real irreversible action (public post, purchase, deletion).

### Structure

```
extension/
  manifest.json           # MV3, all_frames enabled
  background.js            # bridge to the Ollama API (/api/chat, /api/tags), permissions, session
  content/
    dom_serializer.js      # DOM -> indexed text for the LLM (+ main text extraction)
    pointer.js              # visual cursor + highlight + click ripple
    widget.js                # floating chat panel (shadow DOM), history
    agent_loop.js           # ReAct loop: prompt -> JSON action -> execution, loop guard
    frame_bridge.js         # merges/routes elements between the top frame and iframes
    content.js               # wires it all together, session + per-site history
  popup/                     # settings (also used as the options page)
```

### Known limitations

- Heavily depends on the local model's ability to reply with valid JSON and reason over element lists; prefer 7B+ instruct models.
- Doesn't work on `chrome://` pages, the Web Store, or local `file://` files.
- A site with a very strict CSP may block some synthetic interactions (rare).

### License

MIT — see [LICENSE](LICENSE).
