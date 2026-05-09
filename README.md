# veille-auto-multi-agent

Pipeline de veille technologique automatisée, propulsé par trois agents Claude (Anthropic) qui collaborent pour produire un article de veille tech à intervalle régulier.

Inspiré et extrait d'une expérience publique : observer pendant six mois ce qui se passe quand on laisse des agents IA produire du contenu sans relecture humaine.

## Le concept en une image

```
[Cron GitHub Actions]
        │
        ▼
[Scrape sources web]   ◀── liste configurable (NVIDIA, Anthropic, OpenAI, HF, etc.)
        │
        ▼
[Planificateur : Opus]   ◀── tri éditorial, choix des 4-6 sujets pertinents
        │
        ▼
[Rédacteur : Sonnet]     ◀── écriture de l'article (Markdown ou HTML)
        │
        ▼
[Optimiseur : Haiku]     ◀── titre, méta-description, highlights, tags SEO
        │
        ▼
[Sortie : output/veille-YYYY-MM-DD.md]
```

## Pourquoi trois modèles plutôt qu'un seul

Comme dans une rédaction humaine : un rédacteur en chef, un journaliste, un secrétaire de rédaction. Chaque rôle demande des compétences différentes. Spécialiser permet à la fois d'avoir une meilleure qualité et de réduire les coûts (on n'utilise pas le modèle le plus cher pour une tâche que le moins cher gère bien).

Modèles utilisés (par défaut, configurables) :
- `claude-opus-4-6` pour le tri éditorial (planificateur)
- `claude-sonnet-4-6` pour la rédaction (writer)
- `claude-haiku-4-5` pour les métadonnées (optimizer)

## Coût estimé

Environ **0,18 $ par article** (5K tokens Opus + 7K Sonnet + 6K Haiku, output compris). À raison d'un article par semaine, ça revient à **moins de 10 € par an**.

## Mise en place

### 1. Cloner le repo

```bash
git clone https://github.com/fmenguy/veille-auto-multi-agent.git
cd veille-auto-multi-agent
npm install
```

### 2. Configurer les sources

Édite `veille-sources.json` pour ajouter ou retirer des sources web. Format :

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

### 3. Tester en local

Récupère ta clé API Anthropic ([console.anthropic.com](https://console.anthropic.com/)) :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run veille:dry      # affiche le résultat sans écrire de fichier
npm run veille          # vraie exécution, écrit dans output/
```

### 4. Automatiser via GitHub Actions

Pousse ce repo (ou un fork) sur GitHub, puis :

1. **Settings > Secrets and variables > Actions > New repository secret**
   - Name : `ANTHROPIC_API_KEY`
   - Value : ta clé Anthropic

2. **Settings > Actions > General > Workflow permissions**
   - Coche **Read and write permissions** (pour que le workflow puisse commit/push le résultat)

3. Le workflow `.github/workflows/veille-auto.yml` tourne par défaut tous les vendredis 7h UTC. Modifie la ligne `cron:` pour ajuster.

4. Tu peux aussi le lancer manuellement depuis l'onglet **Actions > Veille tech automatisée > Run workflow** (option `dry_run` disponible).

## Adapter à ton stack

Par défaut, le script écrit un fichier Markdown dans `output/veille-YYYY-MM-DD.md`. Pour intégrer dans ton blog (Astro, Hugo, Next.js, Jekyll, Hexo, etc.), modifie la fonction `writeOutput()` dans `veille-auto.mjs`. Exemples :

- **Astro / Markdown content** : sortie directe dans `src/content/blog/`
- **Hugo** : sortie dans `content/posts/` avec front-matter YAML
- **Jekyll** : sortie dans `_posts/YYYY-MM-DD-veille.md`
- **API CMS** (Strapi, Contentful, etc.) : remplacer l'écriture fichier par un POST API

## Limites assumées

- **Pas de fact-checking automatique** : les agents écrivent ce qu'ils trouvent dans le texte scrapé. Hallucinations possibles.
- **Scraping basique** : `fetch` natif + regex pour nettoyer le HTML. Les sites en JavaScript pur (rendu côté client) renverront du vide.
- **Sources hardcodées** : pas de panel admin, pas de base de données. Volontairement simple.
- **Pas de relecture humaine** dans le pipeline. Si tu veux ajouter une étape de validation, branche un webhook Slack/Discord avant publication.

## Structure du repo

```
.
├── README.md                       Ce fichier
├── package.json                    @anthropic-ai/sdk + scripts npm
├── veille-auto.mjs                 Script principal (~280 lignes)
├── veille-sources.json             Configuration des sources scrapées
├── .github/
│   └── workflows/
│       └── veille-auto.yml         Workflow GitHub Actions cron
├── .env.example                    Modèle de configuration locale
└── output/                         Articles générés (créé au premier run)
```

## Licence

MIT. Fais-en ce que tu veux, attribution appréciée.

## Crédits

Conçu et maintenu par [François Menguy](https://fmenguy.fr). Stack inspirée des bonnes pratiques d'orchestration multi-agent pour LLM (séparation des concerns, modèles spécialisés par rôle).
