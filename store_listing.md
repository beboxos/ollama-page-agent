# Fiche Chrome Web Store — Ollama Page Agent

## Description courte (132 caracteres max)

```
Pilote n'importe quelle page web en langage naturel via un LLM local (Ollama ou compatible OpenAI). Zero cloud.
```
(112 caracteres)

## Description detaillee

```
Ollama Page Agent transforme n'importe quelle page web en interface pilotable en langage naturel — entierement via un modele de langage qui tourne sur TA machine. Aucune donnee de navigation n'est jamais envoyee a un service cloud.

COMMENT CA MARCHE
Une bulle flottante apparait sur chaque page. Donne-lui un objectif ("resume cet article", "remplis ce formulaire de contact", "trouve le lien de desabonnement et clique dessus") et regarde un curseur visuel se deplacer et agir a l'ecran pendant que le modele raisonne, etape par etape, en observant une representation textuelle de la page.

100% LOCAL
Compatible avec Ollama ou tout serveur respectant l'API OpenAI (LM Studio, vLLM, FastFlowLM, text-generation-webui...). Tu choisis ton modele, tu gardes le controle total de tes donnees.

SECURITE INTEGREE
Avant toute action jugee sensible (publier un message, payer, supprimer, s'abonner...), l'agent s'arrete et demande ta confirmation explicite au lieu d'agir seul.

FONCTIONNALITES
- Curseur visuel : vois exactement ce que l'agent fait, en temps reel
- Support des iframes (formulaires embarques, connexion...)
- Mode Vision optionnel pour les modeles multimodaux (capture d'ecran en complement du texte)
- Historique de taches persistant par site
- Instructions personnalisees : donne du ton et du caractere a l'agent
- Widget deplacable, masque a l'impression
- Reprise automatique apres une navigation

PREREQUIS
Necessite un serveur Ollama (https://ollama.com) ou un serveur compatible OpenAI installe et lance sur ta machine ou ton reseau local. L'extension ne fonctionne pas sans.

Projet open source, code source disponible sur GitHub : github.com/beboxos/ollama-page-agent
```

## Categorie suggeree
Productivite (Productivity)

## Justifications des permissions (onglet "Confidentialite" du dashboard)

### storage
Sert a sauvegarder localement (chrome.storage) les reglages de l'utilisateur (adresse du serveur, modele choisi, preferences) et l'historique des taches par site. Rien n'est transmis a un serveur distant autre que celui que l'utilisateur configure lui-meme.

### activeTab
Necessaire pour que le popup de reglages puisse identifier le site actuellement affiche (utilise pour la bascule "actif sur ce site" et pour capturer une capture d'ecran quand l'utilisateur active le mode Vision).

### host_permissions (http://localhost/*, http://127.0.0.1/*)
Permission de base necessaire pour contacter un serveur Ollama tournant en local (adresse par defaut). Aucune donnee n'est envoyee ailleurs qu'a cette adresse.

### optional_host_permissions (<all_urls>)
Demandee UNIQUEMENT si l'utilisateur active explicitement le mode "Vision" dans les reglages, et sert exclusivement a capturer une image de l'onglet actif (chrome.tabs.captureVisibleTab) pour l'envoyer au modele local choisi par l'utilisateur. Jamais demandee ni utilisee par defaut.

### content_scripts (all_frames, sur http(s)://*/*)
Necessaire pour injecter le widget flottant et permettre a l'agent de lire/interagir avec le contenu de la page (et de ses iframes) sur n'importe quel site que l'utilisateur visite et ou il choisit d'utiliser l'extension. L'utilisateur peut desactiver l'extension site par site.

## Declaration "Single Purpose" (obligatoire)
Cette extension a un seul objectif : permettre a un modele de langage tournant localement (Ollama ou un serveur compatible OpenAI choisi par l'utilisateur) d'observer et d'interagir avec le contenu de la page web active, sur demande explicite de l'utilisateur, afin d'automatiser des taches de navigation en langage naturel.

## Traitement des donnees (formulaire "Data usage")
- Aucune donnee n'est collectee par le developpeur.
- Aucune donnee n'est vendue ni partagee avec des tiers.
- Le contenu des pages visitees, les instructions de l'utilisateur et les captures d'ecran (si Vision est active) sont envoyes uniquement au serveur LLM local que l'utilisateur configure lui-meme (par defaut http://localhost:11434) — jamais a un serveur controle par le developpeur de l'extension.
- Les reglages et l'historique sont stockes uniquement en local (chrome.storage), jamais synchronises vers un serveur externe.
