<img src="assets/icon.svg" width="64" height="64" alt="">

# gitGraph for T3Code

*A Git Graph–style commit graph served locally and shown in T3 Code's Preview panel. Works on macOS and Ubuntu.*

Visualiseur de graphe Git (façon extension « Git Graph ») pour [T3 Code](https://t3.codes) : un petit serveur
Node local, affiché dans le panneau **Preview** de T3. Il vit hors de l'application T3 et survit donc à ses mises à jour.

## Captures d'écran

> À ajouter : `docs/screenshots/graph.png`, `docs/screenshots/details.png`, `docs/screenshots/compare.png`.

## Installation

Prérequis : **Node.js ≥ 20** et **git** (≥ 2.34 recommandé).

### macOS

```sh
brew install node git            # ou nvm
git clone <url-du-depot> ~/code/gitgraph-for-t3code
cd ~/code/gitgraph-for-t3code
npm install                      # installe et compile (script prepare)
npm link                         # met `gitgraph` dans le PATH
```

### Ubuntu

Node ≥ 20 n'est pas dans les dépôts d'Ubuntu 22.04. Deux options : **nvm** (recommandé, aucun `sudo`) ou NodeSource.

```sh
sudo apt install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash   # vérifier la version sur le site de nvm
# rouvrir le terminal
nvm install 22

git clone <url-du-depot> ~/code/gitgraph-for-t3code
cd ~/code/gitgraph-for-t3code
npm install
npm link
```

Avec nvm, le préfixe npm global est dans votre `$HOME` : `npm link` fonctionne sans `sudo`. Avec un Node système, ne
lancez **pas** `sudo npm link` : définissez plutôt un préfixe utilisateur :

```sh
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
npm link
```

Vérification : `gitgraph --version` puis `gitgraph doctor`.

## Utilisation

```sh
cd /chemin/vers/un/depot
gitgraph init          # crée ou fusionne t3.json avec le script « Git Graph » (idempotent)
gitgraph               # ou : sert le graphe sans passer par T3, sur http://127.0.0.1:4777
```

| Commande | Rôle |
| --- | --- |
| `gitgraph [--repo <dir>] [--port <n>]` | sert l'interface (défaut : dépôt `.`, port 4777 ou `$GITGRAPH_PORT`) |
| `gitgraph init [--global-snippet]` | ajoute le script à `t3.json` ; avec `--global-snippet`, affiche le JSON pour les réglages T3 |
| `gitgraph doctor` | diagnostic : Node, git, port, permissions, stratégie de surveillance, PATH, `t3.json` (code 1 si échec) |
| `gitgraph --version`, `gitgraph help` | version, aide |

### Dans T3 Code

1. `gitgraph init` dans le projet (ou ajouter le script à la main, voir ci-dessous).
2. Importer le script dans T3, une fois par projet (T3 n'active pas `t3.json` automatiquement). Dans la version actuelle, les scripts s'appellent des **actions** :
   - **Réglages → Projects →** le projet → bouton **Import scripts** → menu **« Import from t3.json »** → **Git Graph** ;
   - ou, en haut d'un fil de discussion du projet, le menu du bouton **+ (Add action)** → section **« From t3.json »** → **Git Graph**.

   Ces entrées n'apparaissent que si le `t3.json` est à la racine du dossier du projet ouvert dans T3, est valide, et contient des scripts pas encore importés.
3. Lancer **Git Graph** : le graphe s'ouvre dans le panneau Preview (`autoOpenPreview`).

Un **seul serveur partagé** écoute sur `127.0.0.1:4777` pour tous les projets : un second `gitgraph` lancé depuis
un autre projet enregistre son dépôt auprès du serveur existant et reste en attente pour prendre le relais si celui-ci
s'arrête. Le sélecteur de dépôt de la barre d'outils permet de passer d'un projet à l'autre.

Script `t3.json` produit par `gitgraph init` :

```json
{
  "name": "Git Graph",
  "command": "gitgraph --repo .",
  "icon": "debug",
  "previewUrl": "http://127.0.0.1:4777",
  "autoOpenPreview": true
}
```

### Configuration globale (tous les projets)

`gitgraph init --global-snippet` affiche l'entrée à coller sous `defaultProjectScripts` dans les réglages de T3
(schéma exact, précédence et limites : [docs/t3-settings.md](docs/t3-settings.md)). Notes :

- `previewUrl` n'est honoré que par le **build desktop** de T3.
- Un projet qui a déjà ses propres scripts n'hérite pas des scripts par défaut.
- Ce dépôt ne modifie jamais les réglages de T3 : l'édition est manuelle. Chemin du fichier : `~/.t3/userdata/settings.json` sur ce Mac (nightly); sur Ubuntu, il dépend de l'installation, à vérifier.
- Le schéma change entre les nightlies de T3 : revérifier si cela cesse de fonctionner.

## Fonctionnalités

- Graphe des commits (branches, merges, tags, stashes, branches distantes), ordre et « first parent » configurables.
- Détails d'un commit : fichiers modifiés, diff.
- Comparaison de deux commits (Cmd/Ctrl + clic).
- Recherche dans les commits.
- Liste d'actions Git sur commits, branches, tags, stashes et changements non commités (menu contextuel), fetch.
- Rafraîchissement en direct (événements serveur) quand le dépôt change.

## Raccourcis clavier

| Touche | Action |
| --- | --- |
| Cmd/Ctrl + F | focus sur la recherche |
| Entrée / Maj + Entrée | résultat suivant / précédent |
| Flèches haut / bas | commit précédent / suivant |
| Entrée | ouvrir le commit sélectionné |
| Cmd/Ctrl + clic | comparer avec le commit sélectionné |
| Échap | fermer menu, boîte de dialogue ou recherche |

## Sécurité

- Écoute uniquement sur la boucle locale (`127.0.0.1`).
- Contrôle des en-têtes `Host` et `Origin` (anti DNS rebinding / CSRF).
- Jeton de session injecté dans la page et stocké dans `~/.config/gitgraph-t3/instance.json` (mode `0600`, dossier `0700`; `$XDG_CONFIG_HOME` respecté).
- git est lancé sans shell (arguments passés en tableau).

## Intégration MCP (optionnel)

Voir [docs/mcp.md](docs/mcp.md).

## Dépannage

Commencer par `gitgraph doctor`.

- **Port occupé** : un autre service utilise 4777. Changer avec `--port` / `GITGRAPH_PORT` (et mettre le même port dans `previewUrl`). Si c'est un autre `gitgraph`, c'est normal : le dépôt est enregistré auprès de lui.
- **Le Preview ne s'ouvre pas** : vérifier que le script a été importé, que `previewUrl` et `autoOpenPreview` sont présents, que T3 est le build **desktop**, et que `gitgraph` est dans le `PATH` du terminal de T3 (`which gitgraph`).
- **`gitgraph: command not found` sous Ubuntu** : le préfixe npm n'est pas dans le `PATH` (voir installation), ou ouvrir un nouveau terminal.
- **Linux, rafraîchissement lent ou erreur inotify** : l'arbre de travail est vérifié par polling toutes les 2 s (volontaire sur Linux). Si `ENOSPC` apparaît, augmenter la limite : `sudo sysctl fs.inotify.max_user_watches=524288` (persistant via `/etc/sysctl.d/`).
- **`dist` manquant** : lancer `npm install` ou `npm run build`.
- **T3 nightly a changé** : lancer `gitgraph compat --online`. Cette commande lit le bundle de T3 Code installé (`app.asar`, en lecture seule) et le schéma public `t3.json`, puis vérifie que `previewUrl` et `autoOpenPreview` sont toujours pris en charge. Au démarrage, `gitgraph` affiche aussi un avertissement s'il détecte une incompatibilité. En attendant un correctif, ouvrir `http://127.0.0.1:4777` à la main dans le Preview ou un navigateur. Pour adapter l'outil, suivre [AGENTS.md](AGENTS.md). Voir aussi [docs/t3-settings.md](docs/t3-settings.md).
- **Bundle T3 introuvable** (fréquent sous Ubuntu avec l'AppImage, montée seulement pendant que T3 tourne) : lancer la vérification avec T3 ouvert, ou indiquer le chemin avec `GITGRAPH_T3_ASAR=/chemin/vers/app.asar`.

## Développement

```sh
npm run dev:server   # API sur :4777, redémarre à chaque changement
npm run dev:web      # UI sur :5173 (hot reload), proxy vers l'API
npm run typecheck
npm test
npm run build
npm run pack:check   # contenu du paquet : bin + dist uniquement
scripts/test-linux.sh   # Ubuntu 22.04 et 24.04 dans Docker
```

La CI (`.github/workflows/ci.yml`) exécute typecheck, tests, build et un smoke test sur Ubuntu 22.04/24.04 et macOS, Node 20 et 22.

Une seconde CI (`.github/workflows/t3-compat.yml`) tourne chaque jour et échoue si le schéma public de T3 Code ne déclare plus `previewUrl` ou `autoOpenPreview`. La procédure de mise à jour, destinée aux humains comme aux agents, est décrite dans [AGENTS.md](AGENTS.md).

## Licence et crédits

[MIT](LICENSE) © 2026 Jean-Baptiste Sainte-Beuve. L'algorithme de placement du graphe est une implémentation
originale, inspirée de l'article de Pierre Vigier sur le dessin de graphes git. Aucun code de l'extension
vscode-git-graph de mhutchie n'est utilisé (sa licence interdit la redistribution d'œuvres dérivées).
