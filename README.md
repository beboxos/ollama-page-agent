# Ollama Page Agent

Clone maison de [page-agent](https://github.com/alibaba/page-agent) (le bookmarklet/script que tu as etudie), sous forme d'extension Chrome, branche sur un serveur **Ollama local** au lieu d'une API cloud.

Meme principe : le DOM de la page est transforme en une liste texte d'elements interactifs numerotes (`[0]`, `[1]`, ...), envoyee a un LLM avec ton objectif en langage naturel. Le modele repond avec une action JSON (`click`, `type`, `select`, `scroll`, ...), qui est executee dans la page pendant qu'un curseur visuel se deplace et clique a l'ecran pour que tu voies ce qui se passe.

Tout tourne en local : aucune donnee de page n'est envoyee ailleurs qu'a ton propre Ollama.

## Installation

### 1. Ollama

```
ollama pull qwen2.5:7b-instruct      # ou llama3.1:8b, mistral-nemo, etc.
```

Autorise l'extension a appeler Ollama en definissant la variable d'environnement **avant** de lancer le serveur (sinon Ollama bloque la requete en CORS) :

```
# Windows (PowerShell)
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve

# macOS / Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Choisis un modele avec de bonnes capacites d'instruction-following et de sortie JSON. Les tres petits modeles (<3B) suivent mal le format et bloquent la boucle.

### 2. L'extension

1. Ouvre `chrome://extensions`
2. Active le **mode developpeur** (en haut a droite)
3. Clique **Charger l'extension non empaquetee**
4. Selectionne le dossier `extension/` de ce depot

### 3. Configuration

Clique sur l'icone de l'extension dans la barre d'outils (ou l'engrenage du widget flottant) :

1. Verifie l'adresse du serveur (`http://localhost:11434` par defaut)
2. Clique **Autoriser** pour donner a l'extension la permission Chrome d'appeler cette adresse
3. Choisis un modele dans la liste (rafraichie automatiquement depuis `/api/tags`)
4. Enregistre

## Utilisation

Sur n'importe quelle page, une bulle 🤖 apparait en bas a droite. Clique dessus, tape ton objectif ("remplis le formulaire de contact avec mon nom Jean Dupont", "trouve le lien de desabonnement et clique dessus", ...) et lance.

Le panneau affiche en temps reel les pensees du modele et les actions executees, pendant que le curseur visuel se deplace sur la page. La tache survit a une navigation (changement de page) : elle reprend automatiquement avec sa memoire si le modele a clique un lien.

## Structure

```
extension/
  manifest.json          # MV3
  background.js           # pont vers l'API Ollama (/api/chat, /api/tags), permissions, session
  content/
    dom_serializer.js     # DOM -> texte indexe pour le LLM
    pointer.js             # curseur visuel + surlignage + ripple de clic
    widget.js               # panneau de chat flottant (shadow DOM)
    agent_loop.js          # boucle ReAct: prompt -> JSON action -> execution
    content.js              # colle le tout, gere la reprise de session
  popup/                    # reglages (aussi utilise comme page d'options)
```

## Limites connues

- Depend fortement de la capacite du modele local a repondre en JSON valide et a raisonner sur des listes d'elements ; prefere des modeles 7B+ instruct.
- Ne fonctionne pas dans les iframes cross-origin, ni sur `chrome://` et les pages du Web Store.
- Un site avec une CSP tres stricte peut bloquer certaines interactions synthetiques (rare).
