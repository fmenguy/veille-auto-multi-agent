# veille-auto-multi-agent

🇫🇷 Français · 🇬🇧 [English](#english)

<a id="francais"></a>

Pipeline de veille technologique automatisée : quatre agents Claude (Anthropic) se répartissent le travail pour transformer une liste de sources web en un article de veille en Markdown. Il tourne en local ou dans GitHub Actions, sans relecture humaine.

C'est la version générique, publiée en mai 2026, du pipeline qui écrit la [veille du vendredi sur fmenguy.fr](https://fmenguy.fr/blog/veille/). La version en production a évolué depuis et n'est pas synchronisée avec ce dépôt. Le principe est expliqué sans jargon dans [cet article](https://fmenguy.fr/blog/veille-auto-vulgarisee/), et l'architecture en détail dans [celui-ci](https://fmenguy.fr/blog/veille-auto-stack/).

## Fonctionnement

```
[Lancement manuel ou cron GitHub Actions]
        │
        ▼
[Scrape]                 pages listées dans veille-sources.json
        │
        ▼
[Scout : Sonnet]         recherche web pour trouver ce que les sources n'ont pas couvert
        │
        ▼
[Planificateur : Opus]   choix de 4 à 6 sujets, plan en JSON
        │
        ▼
[Rédacteur : Sonnet]     article en Markdown, avec tableaux, citations et schémas
        │
        ▼
[Optimiseur : Haiku]     titre, description, points clés, catégories
        │
        ▼
[output/veille-AAAA-MM-JJ.md]
```

Tout le pipeline tient dans `veille-auto.mjs` :

1. **Scrape** : chaque URL de `veille-sources.json` est récupérée avec le `fetch` de Node, débarrassée de ses balises HTML et coupée à 8 000 caractères. Une source en erreur est ignorée ; si aucune ne répond, le run s'arrête.
2. **Scout** : il reçoit les 6 000 premiers caractères du texte scrapé et utilise l'outil de recherche web d'Anthropic (`web_search_20260209`, 5 recherches au plus) pour trouver 3 à 5 informations des 7 derniers jours absentes des sources. Si la recherche côté serveur se met en pause (`pause_turn`), le script la relance, trois fois au plus. S'il échoue, le pipeline continue sans lui.
3. **Planificateur** : il lit le texte scrapé et les trouvailles du Scout, puis retient 4 à 6 sujets (titre, résumé, sources, catégorie).
4. **Rédacteur** : il écrit l'article en français à partir du plan seul. Titre « Veille tech <date> : ... », une section par sujet, au moins deux ou trois éléments visuels (tableau, citation, schéma ASCII, liste de définitions, encadré d'avertissement) et une section finale « Ce qu'il faut retenir ».
5. **Optimiseur** : il produit en JSON le titre SEO, la méta-description, 4 à 5 points clés et 2 à 4 catégories, repris dans l'en-tête YAML du fichier.

Chaque rôle a son modèle : le plus cher (Opus) ne sert qu'au tri éditorial, Haiku suffit pour les métadonnées.

| Agent | Variable | Modèle par défaut | `max_tokens` |
| :-- | :-- | :-- | :-- |
| Scout | `VEILLE_MODEL_SCOUT` | `claude-sonnet-5-5` | 16 000 |
| Planificateur | `VEILLE_MODEL_PLANNER` | `claude-opus-5-5` | 16 000 |
| Rédacteur | `VEILLE_MODEL_WRITER` | `claude-sonnet-5-5` | 16 000 |
| Optimiseur | `VEILLE_MODEL_OPTIMIZER` | `claude-haiku-5-5` | 8 000 |

Ces modèles réfléchissent toujours avant de répondre (réflexion adaptative, active par défaut), et cette réflexion consomme des tokens de sortie : d'où des plafonds `max_tokens` larges. Le planificateur demande un effort `high` (`output_config.effort`), au lieu du `medium` par défaut d'Opus 5.5 ; les autres agents gardent l'effort par défaut de leur modèle. Les plafonds sont réglés dans la constante `MAX_TOKENS` de `veille-auto.mjs`. Au-delà d'environ 16 000, le SDK exige le streaming, que le script n'utilise pas.

## Prérequis

- Node.js 22 ou plus.
- Une clé API Anthropic ([console.anthropic.com](https://console.anthropic.com/)). Le Scout a besoin que la recherche web soit disponible sur le compte, sinon il est sauté.
- Pour l'automatisation : un dépôt GitHub (fork ou copie de celui-ci).

## Installation

```bash
git clone https://github.com/fmenguy/veille-auto-multi-agent.git
cd veille-auto-multi-agent
npm install
```

## Configuration

### Sources

`veille-sources.json` contient la liste des pages à scraper. Par défaut : NVIDIA Blog, Anthropic News, OpenAI News, Hugging Face Papers et les modèles en tendance de Hugging Face.

```json
{
  "sources": [
    {
      "name": "NVIDIA Blog",
      "url": "https://blogs.nvidia.com/",
      "weight": "high",
      "topics": ["GPU", "IA", "infrastructure"]
    }
  ]
}
```

Le script ne lit que `name` et `url`. Les champs `weight`, `topics` et `note`, comme la clé `search_queries_examples`, sont informatifs.

### Variables d'environnement

| Variable | Rôle |
| :-- | :-- |
| `ANTHROPIC_API_KEY` | Clé API Anthropic. Obligatoire. |
| `VEILLE_MODEL_SCOUT`, `VEILLE_MODEL_PLANNER`, `VEILLE_MODEL_WRITER`, `VEILLE_MODEL_OPTIMIZER` | Modèle de chaque agent (valeurs par défaut dans le tableau ci-dessus). |
| `VEILLE_OUTPUT_DIR` | Dossier de sortie, `./output` par défaut. |

Le script ne charge pas de fichier `.env` tout seul. Copier `.env.example` en `.env` (ignoré par git), puis lancer avec l'option `--env-file` de Node, ou exporter les variables dans le shell.

Lecture des réponses : le script assemble le texte de tous les blocs `text` de la réponse et ignore les blocs de réflexion ou de recherche qui les précèdent. Il vérifie aussi la raison d'arrêt : une réponse tronquée (`max_tokens`), un refus du modèle (`refusal`) ou une fenêtre de contexte dépassée arrête le run avec un message explicite, au lieu de lire un JSON incomplet.

Changer de modèle : chaque variable reste surchargeable, mais deux paramètres supposent un modèle récent. L'outil `web_search_20260209` du Scout demande Opus 4.6, Sonnet 4.6 ou plus récent (pas Haiku), et l'effort demandé par le planificateur est refusé par certains modèles plus anciens (Sonnet 4.5, Haiku 4.5). Tester en `--dry-run` avant de changer.

## Utilisation

### En local

```bash
export ANTHROPIC_API_KEY=...   # ou : node --env-file=.env veille-auto.mjs --dry-run

npm run veille:dry   # tout le pipeline, affiche les métadonnées et le début de l'article, n'écrit rien
npm run veille       # écrit output/veille-AAAA-MM-JJ.md
```

Le mode `--dry-run` appelle quand même les quatre agents : il coûte autant qu'un vrai run. La date du fichier est la date UTC.

Le fichier produit commence par un en-tête YAML :

```yaml
---
title: "..."
date: 2026-05-15
description: "..."
categories:
  - "IA"
highlights:
  - "..."
generated_by: veille-auto-multi-agent
---
```

### Dans GitHub Actions

Le workflow `.github/workflows/veille-auto.yml` (« Veille tech automatisée ») n'est livré qu'en lancement manuel, ce dépôt servant de modèle.

1. Ajouter le secret `ANTHROPIC_API_KEY` : **Settings > Secrets and variables > Actions > New repository secret**.
2. Lancer le workflow depuis **Actions > Veille tech automatisée > Run workflow**. L'option `dry_run` exécute le pipeline sans rien commiter.
3. Pour un lancement automatique, décommenter le bloc `schedule` (le cron fourni tourne le vendredi à 7 h UTC) :

   ```yaml
   on:
     schedule:
       - cron: '0 7 * * 5'
     workflow_dispatch:
       ...
   ```

Le job installe Node 22, lance le script, puis commite `output/veille-AAAA-MM-JJ.md` sous l'identité `veille-bot` et pousse sur la branche courante. Si la branche distante a bougé entre-temps, il rebase et retente, trois fois au plus. Le workflow déclare lui-même `permissions: contents: write` ; aucun autre réglage n'est normalement nécessaire, sauf si l'organisation restreint les droits du `GITHUB_TOKEN`. Le dossier `output/` n'est pas ignoré par git, justement pour que le workflow puisse commiter ce fichier. Durée maximale du job : 20 minutes.

## Adapter à son site

L'écriture du fichier se fait dans `writeOutput()` et `buildFrontMatter()`, dans `veille-auto.mjs`. Exemples :

- **Astro** (collections de contenu) : écrire dans `src/content/blog/`.
- **Hugo** : écrire dans `content/posts/`.
- **Jekyll** : écrire dans `_posts/AAAA-MM-JJ-veille.md`.
- **CMS avec API** (Strapi, Contentful...) : remplacer l'écriture de fichier par un appel à l'API.

La ligne éditoriale, la langue et le ton sont dans les prompts système des fonctions `callScout`, `callPlanner`, `callWriter` et `callOptimizer`.

## Coûts

Estimation publiée en mai 2026 avec les modèles par défaut de l'époque (Opus 4.6, Sonnet 4.6, Haiku 4.5) : environ **0,25 $ par article**, soit à peu près **13 € par an** au rythme d'un article par semaine. Les modèles actuels sont moins chers au token, mais leur réflexion ajoute des tokens de sortie ; le coût n'a pas été remesuré avec eux. Chaque recherche web du Scout est facturée en plus des tokens (environ 0,01 $, 5 recherches au plus par run). Le coût réel dépend du volume de texte scrapé, des résultats de recherche et des tarifs en vigueur. Les minutes GitHub Actions d'un run hebdomadaire de ce type restent en général dans le quota gratuit.

## Limites

- **Aucune vérification des faits** : les agents écrivent à partir du texte scrapé et des résultats de recherche. Des erreurs et des hallucinations sont possibles, et rien ne les arrête avant publication.
- **Scraping basique** : `fetch` et expressions régulières. Une page rendue en JavaScript côté client revient vide ou presque, et certains sites refusent les robots (la liste par défaut signale qu'OpenAI répond parfois 403).
- **Liens approximatifs** : les liens des pages sont perdus au scrape. Un sujet tiré d'une source scrapée cite souvent la page de rubrique de cette source ; seuls les sujets trouvés par le Scout ont une URL précise.
- **Pas de mémoire d'un run à l'autre** : un sujet peut revenir d'une semaine sur l'autre.
- **Sortie JSON fragile** : si le planificateur ou l'optimiseur ne renvoie pas de JSON lisible, le run échoue. Une réponse tronquée ou refusée l'arrête aussi, avec un message qui en donne la raison.
- **Pas de relecture humaine** dans la chaîne. Pour en ajouter une, insérer une étape de validation avant le commit (une pull request plutôt qu'un push direct, par exemple).

## Structure du dépôt

```
.
├── README.md
├── LICENSE                         licence MIT
├── package.json                    dépendance @anthropic-ai/sdk et scripts npm
├── package-lock.json               versions exactes des dépendances
├── veille-auto.mjs                 le pipeline complet
├── veille-sources.json             sources scrapées
├── .env.example                    modèle de configuration locale
├── .github/
│   └── workflows/
│       └── veille-auto.yml         workflow GitHub Actions
└── output/                         articles générés (créé au premier run)
```

## Licence

MIT, voir [LICENSE](LICENSE).

## Auteur

François Menguy, [fmenguy.fr](https://fmenguy.fr).

---

<a id="english"></a>

# veille-auto-multi-agent (English)

🇫🇷 [Français](#francais) · 🇬🇧 English

An automated tech news pipeline: four Claude agents (Anthropic) split the work of turning a list of web sources into a Markdown news digest. It runs locally or in GitHub Actions, with no human review.

This is the generic version, published in May 2026, of the pipeline that writes the [Friday tech digest on fmenguy.fr](https://fmenguy.fr/blog/veille/). The production version has moved on since then and is not kept in sync with this repository. The idea is explained in plain terms in [this article](https://fmenguy.fr/blog/veille-auto-vulgarisee/) and the architecture in [this one](https://fmenguy.fr/blog/veille-auto-stack/) (both in French). The prompts and the generated articles are in French too.

## How it works

```
[Manual run or GitHub Actions cron]
        │
        ▼
[Scrape]                 pages listed in veille-sources.json
        │
        ▼
[Scout: Sonnet]          web search for what the sources missed
        │
        ▼
[Planner: Opus]          picks 4 to 6 topics, returns a JSON plan
        │
        ▼
[Writer: Sonnet]         Markdown article with tables, quotes and diagrams
        │
        ▼
[Optimizer: Haiku]       title, description, highlights, categories
        │
        ▼
[output/veille-YYYY-MM-DD.md]
```

The whole pipeline lives in `veille-auto.mjs`:

1. **Scrape**: each URL in `veille-sources.json` is fetched with Node's `fetch`, stripped of HTML tags and cut to 8,000 characters. A failing source is skipped; if none responds, the run stops.
2. **Scout**: gets the first 6,000 characters of the scraped text and uses Anthropic's web search tool (`web_search_20260209`, at most 5 searches) to find 3 to 5 items from the last 7 days that the sources don't cover. If the server-side search pauses (`pause_turn`), the script resumes it, up to three times. If it fails, the pipeline carries on without it.
3. **Planner**: reads the scraped text plus the Scout's findings and keeps 4 to 6 topics (title, summary, sources, category).
4. **Writer**: writes the article in French from the plan alone. Title "Veille tech <date> : ...", one section per topic, at least two or three visual elements (table, quote, ASCII diagram, definition list, warning box) and a closing "Ce qu'il faut retenir" (key takeaways) section.
5. **Optimizer**: returns, as JSON, the SEO title, meta description, 4 to 5 highlights and 2 to 4 categories, which go into the file's YAML header.

Each role gets its own model: the most expensive one (Opus) only handles editorial selection, and Haiku is enough for metadata.

| Agent | Variable | Default model | `max_tokens` |
| :-- | :-- | :-- | :-- |
| Scout | `VEILLE_MODEL_SCOUT` | `claude-sonnet-5-5` | 16,000 |
| Planner | `VEILLE_MODEL_PLANNER` | `claude-opus-5-5` | 16,000 |
| Writer | `VEILLE_MODEL_WRITER` | `claude-sonnet-5-5` | 16,000 |
| Optimizer | `VEILLE_MODEL_OPTIMIZER` | `claude-haiku-5-5` | 8,000 |

These models always think before answering (adaptive thinking, on by default), and thinking uses output tokens: hence the generous `max_tokens` limits. The planner asks for `high` effort (`output_config.effort`) instead of Opus 5.5's default `medium`; the other agents keep their model's default effort. The limits live in the `MAX_TOKENS` constant in `veille-auto.mjs`. Above roughly 16,000, the SDK requires streaming, which the script does not use.

## Requirements

- Node.js 22 or later.
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com/)). The Scout needs web search to be available on the account; otherwise it is skipped.
- For scheduling: a GitHub repository (a fork or a copy of this one).

## Installation

```bash
git clone https://github.com/fmenguy/veille-auto-multi-agent.git
cd veille-auto-multi-agent
npm install
```

## Configuration

### Sources

`veille-sources.json` lists the pages to scrape. Defaults: NVIDIA Blog, Anthropic News, OpenAI News, Hugging Face Papers and Hugging Face trending models.

```json
{
  "sources": [
    {
      "name": "NVIDIA Blog",
      "url": "https://blogs.nvidia.com/",
      "weight": "high",
      "topics": ["GPU", "IA", "infrastructure"]
    }
  ]
}
```

The script only reads `name` and `url`. The `weight`, `topics` and `note` fields, and the `search_queries_examples` key, are informational.

### Environment variables

| Variable | Purpose |
| :-- | :-- |
| `ANTHROPIC_API_KEY` | Anthropic API key. Required. |
| `VEILLE_MODEL_SCOUT`, `VEILLE_MODEL_PLANNER`, `VEILLE_MODEL_WRITER`, `VEILLE_MODEL_OPTIMIZER` | Model for each agent (defaults in the table above). |
| `VEILLE_OUTPUT_DIR` | Output folder, `./output` by default. |

The script does not load a `.env` file by itself. Copy `.env.example` to `.env` (ignored by git) and run with Node's `--env-file` option, or export the variables in your shell.

Reading responses: the script joins the text of every `text` block in the response and skips the thinking or search blocks that come before them. It also checks the stop reason: a truncated response (`max_tokens`), a model refusal (`refusal`) or an exceeded context window stops the run with an explicit message, instead of parsing incomplete JSON.

Switching models: every variable can still be overridden, but two parameters assume a recent model. The Scout's `web_search_20260209` tool needs Opus 4.6, Sonnet 4.6 or later (not Haiku), and the effort the planner asks for is rejected by some older models (Sonnet 4.5, Haiku 4.5). Try a `--dry-run` before switching.

## Usage

### Locally

```bash
export ANTHROPIC_API_KEY=...   # or: node --env-file=.env veille-auto.mjs --dry-run

npm run veille:dry   # full pipeline, prints the metadata and the start of the article, writes nothing
npm run veille       # writes output/veille-YYYY-MM-DD.md
```

`--dry-run` still calls all four agents, so it costs as much as a real run. The file date is the UTC date.

The output file starts with a YAML header:

```yaml
---
title: "..."
date: 2026-05-15
description: "..."
categories:
  - "IA"
highlights:
  - "..."
generated_by: veille-auto-multi-agent
---
```

### In GitHub Actions

The `.github/workflows/veille-auto.yml` workflow ("Veille tech automatisée") ships as manual-only, since this repository is meant as a template.

1. Add the `ANTHROPIC_API_KEY` secret: **Settings > Secrets and variables > Actions > New repository secret**.
2. Start the workflow from **Actions > Veille tech automatisée > Run workflow**. The `dry_run` option runs the pipeline without committing anything.
3. To run it on a schedule, uncomment the `schedule` block (the provided cron fires on Fridays at 07:00 UTC):

   ```yaml
   on:
     schedule:
       - cron: '0 7 * * 5'
     workflow_dispatch:
       ...
   ```

The job sets up Node 22, runs the script, then commits `output/veille-YYYY-MM-DD.md` as `veille-bot` and pushes to the current branch. If the remote branch moved in the meantime, it rebases and retries, up to three times. The workflow itself declares `permissions: contents: write`; no other setting should be needed unless your organization restricts `GITHUB_TOKEN` permissions. The `output/` folder is not ignored by git, precisely so that the workflow can commit that file. Job timeout: 20 minutes.

## Plugging it into your site

File output happens in `writeOutput()` and `buildFrontMatter()` in `veille-auto.mjs`. For example:

- **Astro** (content collections): write to `src/content/blog/`.
- **Hugo**: write to `content/posts/`.
- **Jekyll**: write to `_posts/YYYY-MM-DD-veille.md`.
- **Headless CMS** (Strapi, Contentful...): replace the file write with an API call.

Editorial line, language and tone are set in the system prompts of `callScout`, `callPlanner`, `callWriter` and `callOptimizer`.

## Cost

Estimate published in May 2026 with the default models of the time (Opus 4.6, Sonnet 4.6, Haiku 4.5): about **$0.25 per article**, roughly **€13 a year** at one article a week. The current models cost less per token, but their thinking adds output tokens; the cost has not been measured again with them. Each Scout web search is billed on top of tokens (about $0.01, at most 5 per run). Actual cost depends on how much text is scraped, on the search results and on current pricing. A weekly run like this one usually stays within the free GitHub Actions minutes.

## Limitations

- **No fact-checking**: the agents write from scraped text and search results. Errors and hallucinations can happen, and nothing stops them before publication.
- **Basic scraping**: `fetch` plus regular expressions. A page rendered client-side in JavaScript comes back empty or nearly so, and some sites block bots (the default list notes that OpenAI sometimes returns 403).
- **Approximate links**: links are lost during scraping. A topic taken from a scraped source often cites that source's section page; only topics found by the Scout carry a precise URL.
- **No memory between runs**: the same topic can come back the following week.
- **Brittle JSON output**: if the planner or the optimizer does not return readable JSON, the run fails. A truncated or refused response also stops it, with a message giving the reason.
- **No human review** in the chain. To add one, put a validation step before the commit (open a pull request instead of pushing directly, for instance).

## Repository layout

```
.
├── README.md
├── LICENSE                         MIT license
├── package.json                    @anthropic-ai/sdk dependency and npm scripts
├── package-lock.json               exact dependency versions
├── veille-auto.mjs                 the whole pipeline
├── veille-sources.json             scraped sources
├── .env.example                    local configuration template
├── .github/
│   └── workflows/
│       └── veille-auto.yml         GitHub Actions workflow
└── output/                         generated articles (created on first run)
```

## License

MIT, see [LICENSE](LICENSE).

## Author

François Menguy, [fmenguy.fr](https://fmenguy.fr).
