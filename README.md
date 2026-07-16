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

1. Choisis le **Fournisseur** : *Ollama* (par défaut) ou *Compatible OpenAI* (LM Studio, [FastFlowLM](https://github.com/FastFlowLM/FastFlowLM), vLLM, text-generation-webui, ou tout serveur exposant une API `/v1/chat/completions`)
2. Vérifie l'adresse du serveur (`http://localhost:11434` par défaut pour Ollama ; pour un serveur compatible OpenAI, avec ou sans `/v1` à la fin, les deux fonctionnent)
3. Clique **Autoriser** pour donner à l'extension la permission Chrome d'appeler cette adresse
4. Choisis un modèle dans la liste (rafraîchie automatiquement)
5. Enregistre

Le mode *Compatible OpenAI* fonctionne avec n'importe quel serveur respectant ce format d'API standard — testé notamment avec [FastFlowLM](https://github.com/FastFlowLM/FastFlowLM) (inférence NPU sous Windows). Si un serveur local refuse le champ optionnel `response_format`, l'extension relance automatiquement la requête sans ce champ et conserve sa validation JSON locale.

### Utilisation

Sur n'importe quelle page, une bulle 🤖 apparaît en bas à droite. Clique dessus, tape ton objectif ("remplis le formulaire de contact avec mon nom Jean Dupont", "résume-moi cet article", "trouve le lien de désabonnement et clique dessus", ...) et lance.

Le panneau affiche en temps réel les pensées du modèle et les actions exécutées, pendant que le curseur visuel se déplace sur la page. Deux boutons dans l'en-tête donnent accès à l'historique des tâches passées sur ce site (🕘) et permettent de le vider (🗑). La tâche survit à une navigation (changement de page) : elle reprend automatiquement avec sa mémoire si le modèle a cliqué un lien. Les éléments situés dans des iframes de la page sont aussi détectés et pilotables.

La bulle 🤖 et le panneau (via son en-tête) se déplacent librement par glisser-déposer si leur position par défaut te gêne — la nouvelle position est mémorisée et réappliquée sur toutes les pages.

Le widget ne s'affiche jamais à l'impression (`@media print`). Pour le désactiver complètement sur un site donné, ouvre le popup de l'extension (icône dans la barre d'outils) **sur ce site** et bascule l'interrupteur **"Actif sur ce site"** — un rafraîchissement de la page applique le changement.

### Vision (modèles multimodaux)

Avec **Vision**, l'extension envoie une capture de la zone visible en complément du DOM. C'est un mode **hybride** : le modèle repère d'abord l'élément par son index `[N]`, puis utilise l'image pour vérifier son libellé, son emplacement et son contexte avant d'agir. Il ne doit pas cliquer si le DOM et l'image se contredisent. Une image importante intégrée à la page peut aussi être envoyée sous la forme d'un agrandissement séparé, afin de rester lisible par le modèle.

La fréquence est réglable : capture à chaque étape (plus fiable) ou seulement à la première étape (plus rapide et plus sobre). Les captures ne sont pas enregistrées par l'extension : elles existent en mémoire pendant l'appel puis sont envoyées uniquement au serveur configuré.

#### Pilotage visuel (bêta)

Le réglage **Pilotage visuel** est destiné aux interfaces canvas ou sans DOM exploitable, par exemple certains clients de prise en main à distance dans le navigateur. Dans ce mode, seul un écran complet sert de référence (sans DOM, historique ni recadrage qui brouillerait les coordonnées) et le modèle peut proposer `click_visual` ou `type_visual` avec des coordonnées `x` / `y` dans le viewport.

Ce mode est moins fiable que le DOM : les clics visuels sont sensibles à la résolution, à la mise en page et aux estimations du modèle. L'extension bloque les coordonnées invalides et les répétitions immédiates du même clic. Certains clients Web ignorent par ailleurs les événements synthétiques du navigateur : teste toujours sur une action sans risque. Le **mode lecture seule** bloque volontairement toute action visuelle.

### Mode lecture seule et confirmation avant une action sensible

Le réglage **Mode lecture seule** autorise l'observation, le défilement, la lecture et les réponses, mais bloque techniquement les clics, saisies, sélections, touches clavier et actions visuelles. Il est adapté aux audits, résumés et propositions de réponse.

Même sans activer ce réglage, une demande qui consiste uniquement à *proposer*, *rédiger*, *formuler* ou *préparer* une réponse est traitée comme un objectif de brouillon : l'extension bloque les clics et saisies tant que l'objectif ne demande pas explicitement d'envoyer, publier, valider ou cliquer.

Avant tout **clic** sur un élément dont le libellé contient un mot-clé jugé sensible (publier, tweeter, envoyer, répondre, payer, acheter, commander, confirmer, valider, supprimer, se désabonner, ...), ou avant une validation par touche Entrée après saisie, l'agent affiche une demande de confirmation (**Confirmer** / **Toujours (cette page)** / **Annuler**). Si tu annules, l'agent en est informé et doit trouver une autre approche ou conclure.

**Toujours (cette page)** arrête de redemander pour le reste de la page en cours (remis à zéro au prochain chargement de page). Dans les réglages, le mode **"Confirmation avant une action sensible"** peut aussi être basculé sur **"Ne jamais demander (auto)"** pour désactiver complètement ce garde-fou — à réserver à un usage encadré, puisque ça retire la protection contre les actions irréversibles.

### Historique et confidentialité

L'historique local par site est réglable : désactivé, 1 jour, 7 jours ou conservation manuelle. Un bouton des réglages efface tous les historiques de tâches. Les paramètres et l'historique restent dans `chrome.storage.local` ; les captures Vision ne sont jamais ajoutées à cet historique.

### Instructions personnalisées

Le champ **"Instructions personnalisées"** des réglages permet d'ajouter tes propres consignes (ton, style, choses à éviter...), par ex. *"tutoie-moi"*, *"réponds avec humour"*, *"évite de cliquer sur les liens sponsorisés"*. Elles sont ajoutées à la suite du prompt système existant, sans jamais le remplacer — le format JSON strict et le schéma des actions restent garantis, donc ça ne peut pas casser le fonctionnement de l'agent, seulement influencer son style/comportement.

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
    frame_bridge.js         # route les iframes via chrome.runtime/frameId (pas de postMessage de page)
    content.js               # colle le tout, gere session + historique par site
  popup/                     # reglages (aussi utilise comme page d'options)
```

### Limites connues

- Dépend fortement de la capacité du modèle local à répondre en JSON valide et à raisonner sur des listes d'éléments ; préfère des modèles 7B+ instruct.
- Ne fonctionne pas sur `chrome://`, les pages du Web Store, ni les fichiers locaux `file://`.
- Un site avec une CSP très stricte peut bloquer certaines interactions synthétiques (rare).
- Le pilotage visuel bêta est moins précis que les index DOM et peut être ignoré par les applications qui exigent des événements utilisateur de confiance.

### Tests

Sans dépendance externe : `npm test`. Les tests vérifient notamment la conversion d'images vers le format `image_url` OpenAI et le repli sans `response_format`.

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

1. Pick the **Provider**: *Ollama* (default) or *OpenAI-compatible* (LM Studio, [FastFlowLM](https://github.com/FastFlowLM/FastFlowLM), vLLM, text-generation-webui, or any server exposing a `/v1/chat/completions` API)
2. Check the server address (`http://localhost:11434` by default for Ollama; for an OpenAI-compatible server, with or without a trailing `/v1`, both work)
3. Click **Authorize** to grant the extension Chrome permission to call that address
4. Pick a model from the list (auto-refreshed)
5. Save

The *OpenAI-compatible* mode works with any server following that standard API shape — tested with [FastFlowLM](https://github.com/FastFlowLM/FastFlowLM) (Windows NPU inference) among others. If a local server rejects the optional `response_format` field, the extension automatically retries without it while keeping local JSON validation.

### Usage

On any page, a 🤖 bubble appears bottom-right. Click it, type your goal ("fill the contact form with my name John Doe", "summarize this article", "find the unsubscribe link and click it", ...) and launch.

The panel shows the model's reasoning and executed actions live, while the visual cursor moves across the page. Two header buttons give access to this site's task history (🕘) and let you clear it (🗑). A task survives a navigation (page change): it automatically resumes with its memory if the model clicked a link. Elements inside same-page iframes are also detected and controllable.

The 🤖 bubble and the panel (via its header) can both be freely dragged if their default corner gets in the way — the new position is remembered and reapplied on every page.

The widget never shows up when printing (`@media print`). To turn it off entirely for a given site, open the extension's toolbar popup **on that site** and flip the **"Active on this site"** switch — refresh the page for the change to take effect.

### Vision (multimodal models)

**Vision** sends a screenshot alongside the DOM. It is a **hybrid** mode: the model first identifies an element through its `[N]` index, then checks its label, position and context in the image before acting. It must not click when the DOM and image disagree. An important image embedded in the page can also be sent as a separate enlargement so it remains readable.

You can capture at every step (more reliable) or only at the first step (faster and lighter). Screenshots are not written to disk or extension storage: they are held in memory for the request and sent only to the configured server.

#### Visual control (beta)

**Visual control** targets canvas or DOM-less interfaces, such as some browser-based remote-control clients. It uses one full-screen image as the sole reference (without DOM, history or coordinate-confusing crops) and lets the model propose `click_visual` or `type_visual` actions with viewport `x` / `y` coordinates.

This is less reliable than DOM control. Invalid coordinates and immediate repeats of the same visual click are blocked. Some web clients ignore synthetic browser events, so test only harmless actions first. **Read-only mode** deliberately blocks every visual action.

### Read-only mode and confirmation before a sensitive action

**Read-only mode** allows observation, scrolling, reading and answers, but technically blocks clicks, typing, selections, keyboard keys and visual actions. It is intended for audits, summaries and response drafts.

Even without read-only mode, a goal that only asks to *suggest*, *draft*, *formulate* or *prepare* a reply is treated as a draft-only goal: the extension blocks clicks and typing unless the goal explicitly asks to send, publish, submit, validate or click.

Before any **click** whose label contains a sensitive keyword (publish, tweet, send, reply, pay, buy, order, confirm, submit, delete, unsubscribe, ...) — or before pressing Enter after typing — the agent shows a confirmation prompt (**Confirm** / **Always (this page)** / **Cancel**).

**Always (this page)** stops asking for the rest of the current page (reset on the next page load). In settings, the **"Confirmation before a sensitive action"** mode can also be switched to **"Never ask (auto)"** to disable this safeguard entirely — reserve that for a supervised setup, since it removes the protection against irreversible actions.

### Custom instructions

The **"Custom instructions"** field in settings lets you add your own preferences (tone, style, things to avoid...), e.g. *"address me casually"*, *"answer with humor"*, *"avoid clicking sponsored links"*. They're appended after the existing system prompt, never replacing it — the strict JSON format and action schema stay guaranteed, so this can only influence the agent's style/behavior, not break how it functions.

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
    frame_bridge.js         # routes iframe work through chrome.runtime/frameId (not page postMessage)
    content.js               # wires it all together, session + per-site history
  popup/                     # settings (also used as the options page)
```

### Known limitations

- Heavily depends on the local model's ability to reply with valid JSON and reason over element lists; prefer 7B+ instruct models.
- Doesn't work on `chrome://` pages, the Web Store, or local `file://` files.
- A site with a very strict CSP may block some synthetic interactions (rare).
- Visual-control beta is less precise than DOM indices and can be ignored by applications requiring trusted user events.

### Tests

No external dependency: run `npm test`. Tests cover OpenAI `image_url` conversion and the retry path without `response_format`.

### License

MIT — see [LICENSE](LICENSE).
