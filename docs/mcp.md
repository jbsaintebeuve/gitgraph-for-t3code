# Serveur MCP (optionnel)

`gitgraph-mcp` expose le graphe de commits et les actions Git de gitgraph aux agents de code (Claude Code, Codex...) via le protocole MCP, en stdio. Il réutilise directement les modules serveur (pas de HTTP) : le serveur web n'a pas besoin d'être lancé, sauf pour l'interface visuelle.

Fonctionne sur macOS et Ubuntu (Node >= 20).

## Outils fournis

| Outil | Type | Rôle |
| --- | --- | --- |
| `git_graph` | lecture | Graphe ASCII compact (hash, refs, sujet, auteur, date) + en-tête : HEAD, opération en cours, état de l'arbre de travail. Paramètres : `limit` (50, max 500), `skip`, `branches`, `firstParent`. |
| `git_commit_details` | lecture | Message complet, auteur, parents, fichiers modifiés avec +/-. |
| `git_diff` | lecture | Patch d'un fichier pour un commit, `compareTo` optionnel, ou `hash: "uncommitted"` pour l'arbre de travail. Tronqué à ~40 Ko. |
| `git_compare` | lecture | Fichiers modifiés entre deux commits/refs. |
| `git_search` | lecture | Recherche par message, auteur ou préfixe de hash (50 résultats max). |
| `git_refs` | lecture | Branches (upstream, ahead/behind), remotes, tags, stashes. |
| `git_action` | **destructif** | Exécute une action validée (checkout, createBranch, merge, rebase, reset, push, stash...). Retourne `ok`, la sortie git et les conflits éventuels. |
| `git_graph_open_url` | lecture | Renvoie l'URL de l'interface (`http://127.0.0.1:<port>`, 4777 par défaut). |

Chaque outil accepte un paramètre optionnel `repo` (chemin d'un dépôt ou d'un sous-dossier). Par défaut : l'option `--repo`, sinon le répertoire courant. Les refs `refs/t3/` (checkpoints de T3 Code) ne sont jamais affichées.

Les erreurs (action invalide, dépôt inexistant, échec git) sont renvoyées comme résultat d'outil avec `isError: true`.

## Installation

Prérequis : `npm install && npm run build` dans le dépôt, puis rendre `gitgraph-mcp` disponible dans le PATH (par exemple `npm link` dans ce dépôt, à votre initiative), ou utiliser le chemin absolu `node /chemin/vers/gitgraph-for-t3code/bin/gitgraph-mcp.js`.

### Claude Code

```bash
# Portée utilisateur (tous les projets)
claude mcp add -s user gitgraph -- gitgraph-mcp
# Avec un dépôt fixe
claude mcp add -s user gitgraph -- gitgraph-mcp --repo /chemin/vers/depot
```

Ou, pour un projet, un fichier `.mcp.json` à la racine :

```json
{ "mcpServers": { "gitgraph": { "command": "gitgraph-mcp", "args": [] } } }
```

(Syntaxe vérifiée avec `claude mcp add --help` : `claude mcp add [options] <name> <commandOrUrl> [args...]`, portées `local`, `user`, `project`.)

### Codex

Dans `~/.codex/config.toml` :

```toml
[mcp_servers.gitgraph]
command = "gitgraph-mcp"
args = []
```

Alternative en ligne de commande : `codex mcp add gitgraph -- gitgraph-mcp` (voir `codex mcp add --help`).

### Remarques

- T3 Code ne gère pas les serveurs MCP : c'est la configuration propre à chaque agent (Claude Code, Codex) qui est utilisée.
- Sans `--repo`, le dépôt par défaut est le répertoire de travail de l'agent, ce qui convient aux threads T3 Code (worktree du projet).
- Pour voir le graphe visuellement, l'agent peut appeler `git_graph_open_url` puis l'outil `preview_open` de T3 Code ; l'utilisateur peut aussi lancer le script de projet « Git Graph ».
- Le serveur n'écrit jamais sur stdout en dehors du protocole MCP ; les logs vont sur stderr.

## Sécurité

- Le serveur exécute git avec les droits de l'agent (donc de l'utilisateur), dans le dépôt indiqué. Aucun secret n'est géré par l'outil.
- `git_action` est annoté `destructiveHint: true` : laissez le client demander une validation pour cet outil. La description invite en outre l'agent à obtenir la confirmation de l'utilisateur avant reset --hard, force push, suppression de branche/tag/stash, rebase.
- Les entrées sont validées (`parseAction`) et les actions sont sérialisées par dépôt, comme dans l'interface web.
- Ne pas configurer l'outil en auto-approbation pour `git_action` sur des dépôts importants.
