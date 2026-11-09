#!/usr/bin/env node
/**
 * veille-auto.mjs
 *
 * Pipeline de veille tech automatisée avec quatre agents Claude.
 *
 * Pipeline :
 *   1. Scrape les sources web listées dans veille-sources.json
 *   2. Recherche complémentaire par Claude Sonnet (scout, outil web_search)
 *   3. Pilotage par Claude Opus (planificateur)
 *   4. Rédaction par Claude Sonnet (corps de l'article en Markdown)
 *   5. Optimisation/highlights par Claude Haiku
 *   6. Écrit output/veille-YYYY-MM-DD.md avec front-matter YAML
 *
 * Usage :
 *   ANTHROPIC_API_KEY=sk-... node veille-auto.mjs
 *   node veille-auto.mjs --dry-run   # n'écrit rien, affiche seulement
 *
 * Environnement (toutes les vars sont optionnelles) :
 *   ANTHROPIC_API_KEY        Clé API Anthropic (REQUIS)
 *   VEILLE_OUTPUT_DIR        Dossier de sortie (défaut : ./output)
 *   VEILLE_MODEL_SCOUT       Modèle scout (défaut : claude-sonnet-5-5)
 *   VEILLE_MODEL_PLANNER     Modèle planificateur (défaut : claude-opus-5-5)
 *   VEILLE_MODEL_WRITER      Modèle rédacteur (défaut : claude-sonnet-5-5)
 *   VEILLE_MODEL_OPTIMIZER   Modèle optimiseur (défaut : claude-haiku-5-5)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');

const MODELS = {
  scout: process.env.VEILLE_MODEL_SCOUT || 'claude-sonnet-5-5',
  planner: process.env.VEILLE_MODEL_PLANNER || 'claude-opus-5-5',
  writer: process.env.VEILLE_MODEL_WRITER || 'claude-sonnet-5-5',
  optimizer: process.env.VEILLE_MODEL_OPTIMIZER || 'claude-haiku-5-5',
};

// La réflexion (thinking) des modèles récents consomme des tokens de sortie :
// ces plafonds lui laissent de la place avant la réponse. 16 000 reste sous la
// limite au-delà de laquelle le SDK impose le streaming.
const MAX_TOKENS = {
  scout: 16000,
  planner: 16000,
  writer: 16000,
  optimizer: 8000,
};

// Nombre maximal de reprises du Scout quand la boucle de recherche côté serveur
// s'interrompt (stop_reason "pause_turn").
const SCOUT_MAX_CONTINUATIONS = 3;

const OUTPUT_DIR = process.env.VEILLE_OUTPUT_DIR || path.join(__dirname, 'output');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[veille-auto] ANTHROPIC_API_KEY manquant. Exporter la variable avant de lancer.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------- helpers

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function frenchDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; veille-auto-multi-agent/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      log(`! ${url} -> HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch (err) {
    log(`! ${url} -> ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- LLM calls

/**
 * Vérifie la raison d'arrêt puis renvoie le texte de la réponse.
 * La réponse peut commencer par des blocs `thinking` (et, pour le Scout, des
 * blocs `server_tool_use` / `web_search_tool_result`) : on concatène donc le
 * texte de tous les blocs de type "text" au lieu de lire content[0].
 */
function extractText(msg, agent, maxTokens) {
  if (msg.stop_reason === 'refusal') {
    const details = msg.stop_details;
    const category = details?.category ? `, catégorie "${details.category}"` : '';
    const explanation = details?.explanation ? ` : ${details.explanation}` : '';
    throw new Error(`${agent} : le modèle a refusé la requête (stop_reason "refusal"${category})${explanation}`);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error(
      `${agent} : réponse tronquée, plafond de ${maxTokens} tokens de sortie atteint (stop_reason "max_tokens"). ` +
        "Relever la valeur dans MAX_TOKENS ou alléger l'entrée.",
    );
  }
  if (msg.stop_reason === 'model_context_window_exceeded') {
    throw new Error(`${agent} : fenêtre de contexte du modèle dépassée (stop_reason "model_context_window_exceeded").`);
  }
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) {
    throw new Error(`${agent} : aucun bloc de texte dans la réponse (stop_reason "${msg.stop_reason}").`);
  }
  return text;
}

async function callScout(scrapedSummary) {
  const system = `Tu es l'agent "scout" d'une chaîne de veille tech. À partir d'un résumé des sources tech déjà scrapées, tu utilises l'outil web_search pour trouver des news complémentaires des 7 derniers jours qui n'apparaissent PAS dans les sources fournies.

Cherche des angles non couverts par les sources principales : blogs indépendants, papers récents, dépôts GitHub trendy en sécurité ou IA, analyses techniques.

Tu fais 3 à 5 recherches au maximum. Vise du concret : annonces, vulnérabilités CVE, nouveaux modèles open-source, papers majeurs, projets qui décollent.

Réponds avec un texte structuré, une trouvaille par bloc :
### [Titre court de la news]
URL : [lien]
Date : [si connue]
Résumé : 3-5 lignes factuelles. Pourquoi c'est notable. Catégorie (IA/Sécurité/GPU/Open-source).`;

  const userPrompt = `Voici un extrait des sources principales déjà scrapées aujourd'hui :

${scrapedSummary.slice(0, 6000)}

Trouve 3 à 5 sources COMPLÉMENTAIRES qui apportent une perspective différente ou des sujets non traités.`;

  const tools = [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
    },
  ];
  const messages = [{ role: 'user', content: userPrompt }];

  let msg = await client.messages.create({
    model: MODELS.scout,
    max_tokens: MAX_TOKENS.scout,
    system,
    tools,
    messages,
  });

  // La boucle de recherche côté serveur peut s'interrompre ("pause_turn") :
  // on renvoie la réponse telle quelle et le serveur reprend où il en était.
  for (let i = 0; msg.stop_reason === 'pause_turn' && i < SCOUT_MAX_CONTINUATIONS; i++) {
    messages.push({ role: 'assistant', content: msg.content });
    msg = await client.messages.create({
      model: MODELS.scout,
      max_tokens: MAX_TOKENS.scout,
      system,
      tools,
      messages,
    });
  }
  if (msg.stop_reason === 'pause_turn') {
    throw new Error(`Scout : recherche toujours en pause après ${SCOUT_MAX_CONTINUATIONS} reprises.`);
  }

  return extractText(msg, 'Scout', MAX_TOKENS.scout);
}

async function callPlanner(rawSources) {
  const system = `Tu es l'agent "planificateur" d'une chaîne de veille tech. Tu reçois du texte brut scrappé de plusieurs sources web et tu sélectionnes les 4 à 6 sujets les plus intéressants à couvrir dans un article de blog tech francophone.

Critères :
- Annonces récentes à valeur technique réelle (pas du marketing pur)
- Pas de doublons entre sources
- Sujets pertinents pour un public dev/sécurité/IA

Tu réponds en JSON strict :
{
  "topics": [
    { "title": "Titre court du sujet", "summary": "résumé en 2 lignes", "sources": ["url1"], "category": "IA|Sécurité|GPU|LLM|Agents|Open-Source" }
  ]
}`;

  const msg = await client.messages.create({
    model: MODELS.planner,
    max_tokens: MAX_TOKENS.planner,
    // Opus 5.5 réfléchit en effort "medium" par défaut : le tri éditorial
    // mérite davantage.
    output_config: { effort: 'high' },
    system,
    messages: [
      { role: 'user', content: `Sources scrapées ce jour :\n\n${rawSources}` },
    ],
  });

  const text = extractText(msg, 'Planner', MAX_TOKENS.planner);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Planner: pas de JSON valide en sortie');
  return JSON.parse(jsonMatch[0]);
}

async function callWriter(plan, dateLabel) {
  const system = `Tu es l'agent "rédacteur" d'une chaîne de veille tech. Tu reçois un plan de sujets et tu rédiges un article en Markdown standard pour un blog tech francophone.

RÈGLES :
- Style direct, technique, vulgarisé. Pas de hype creuse ("révolutionnaire", "game-changer").
- Termes français quand un équivalent existe.
- Format Markdown : H1 pour le titre, H2 par sujet, paragraphes, listes à puces, liens [texte](url) pour chaque source.
- Chaque sujet : 2-3 paragraphes courts, lien source en italique en fin de section.
- Termine par un H2 "Ce qu'il faut retenir" avec 4-5 puces.
- Pas de mention d'auteur.

ENRICHIS L'ARTICLE AVEC DES ÉLÉMENTS VISUELS MARKDOWN (insère-en au moins 2-3 par article) :

1. Tableaux comparatifs (idéal pour A vs B, support de versions, avant/après) :
| Critère | Option A | Option B |
|---------|----------|----------|
| Coût    | X        | Y        |

2. Citations en blockquote pour faits marquants ou chiffres clés :
> 10x de réduction du coût d'inférence par token (NVIDIA Vera Rubin)

3. Schémas de flux en bloc code (ASCII art simple) :
\`\`\`
[Source A] → [Process] → [Sortie]
\`\`\`

4. Listes "définitions" pour distinguer vocabulaire :
- **Term A** : explication courte
- **Term B** : explication courte

5. Section de mise en garde (titre H3 explicite) :
### ⚠ Avertissement
Texte du disclaimer.

CONSIGNES ÉDITORIALES :
- Insère un visuel (tableau, blockquote chiffre, schema ASCII) par sujet majeur. Pas tous, mais au moins sur 2-3 sujets.
- Pas plus de 2 paragraphes consécutifs sans un visuel ou une liste.
- Privilégie : tableau pour comparer, blockquote pour un chiffre marquant, ASCII flow pour un process.

Tu réponds avec uniquement le Markdown brut, sans backticks de wrapping global, sans préambule.`;

  const userPrompt = `Date : ${dateLabel}

Plan des sujets :
${JSON.stringify(plan, null, 2)}

Rédige l'article Markdown complet. Le H1 doit être : "# Veille tech ${dateLabel} : [3 mots-clés punchy des thèmes dominants]".`;

  const msg = await client.messages.create({
    model: MODELS.writer,
    max_tokens: MAX_TOKENS.writer,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return extractText(msg, 'Writer', MAX_TOKENS.writer);
}

async function callOptimizer(markdownContent, plan) {
  const system = `Tu es l'agent "optimiseur" d'une chaîne de veille tech. Tu reçois un article Markdown et tu produis :
- title : titre SEO (60-100 caractères, mots-clés en début)
- description : meta description SEO (150-200 caractères, riche en mots-clés)
- highlights : liste de 4-5 points résumant l'article (1 phrase chacun, format "Sujet : valeur ajoutée")
- categories : 2-4 catégories pertinentes pour un blog tech (ex: 'IA', 'Sécurité', 'GPU', 'LLM', 'Open-Source', 'Agents')

Tu réponds en JSON strict.`;

  const userPrompt = `Article Markdown :
${markdownContent}

Plan original :
${JSON.stringify(plan, null, 2)}`;

  const msg = await client.messages.create({
    model: MODELS.optimizer,
    max_tokens: MAX_TOKENS.optimizer,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(msg, 'Optimizer', MAX_TOKENS.optimizer);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Optimizer: pas de JSON valide en sortie');
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------- output

function buildFrontMatter(meta, dateISO) {
  const yamlList = (arr) => arr.map((x) => `  - ${JSON.stringify(x)}`).join('\n');
  return `---
title: ${JSON.stringify(meta.title)}
date: ${dateISO}
description: ${JSON.stringify(meta.description)}
categories:
${yamlList(meta.categories)}
highlights:
${yamlList(meta.highlights)}
generated_by: veille-auto-multi-agent
---

`;
}

async function writeOutput(slug, dateISO, markdown, meta) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
  const frontMatter = buildFrontMatter(meta, dateISO);
  await writeFile(filePath, frontMatter + markdown, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------- pipeline

async function run() {
  log(`Démarrage veille-auto (dry-run=${DRY_RUN})`);
  const today = todayISO();
  const dateLabel = frenchDate(today);
  const slug = `veille-${today}`;

  // 1. Scrape
  const sourcesPath = path.join(__dirname, 'veille-sources.json');
  const { sources } = JSON.parse(await readFile(sourcesPath, 'utf-8'));

  log(`Scrape de ${sources.length} sources`);
  const scrapedChunks = [];
  for (const src of sources) {
    const content = await fetchText(src.url);
    if (content) {
      scrapedChunks.push(`### ${src.name} (${src.url})\n${content}\n`);
      log(`✓ ${src.name} (${content.length} car)`);
    }
  }

  if (scrapedChunks.length === 0) {
    throw new Error('Aucune source accessible, abandon.');
  }

  const rawSources = scrapedChunks.join('\n---\n');

  // 2. Scout (découverte de sources externes via web_search)
  log(`Scout : ${MODELS.scout} (web_search activé)`);
  let scoutFindings = '';
  try {
    scoutFindings = await callScout(rawSources);
    const scoutLines = scoutFindings.split('\n').filter((l) => l.startsWith('### ')).length;
    log(`Scout : ${scoutLines} trouvailles complémentaires`);
  } catch (err) {
    log(`! Scout en échec, on continue sans : ${err.message}`);
  }

  const enrichedSources = scoutFindings
    ? `${rawSources}\n\n=== SOURCES COMPLÉMENTAIRES (Scout) ===\n${scoutFindings}`
    : rawSources;

  // 3. Planificateur
  log(`Pilotage : ${MODELS.planner}`);
  const plan = await callPlanner(enrichedSources);
  log(`Plan : ${plan.topics.length} sujets retenus`);
  plan.topics.forEach((t, i) => log(`  ${i + 1}. ${t.title}`));

  // 4. Rédacteur
  log(`Rédaction : ${MODELS.writer}`);
  const markdown = await callWriter(plan, dateLabel);
  log(`Article rédigé (${markdown.length} car)`);

  // 5. Optimiseur
  log(`Optimisation : ${MODELS.optimizer}`);
  const meta = await callOptimizer(markdown, plan);
  log(`Meta : title=${meta.title?.slice(0, 60)}...`);
  log(`Meta : ${meta.highlights?.length || 0} highlights`);

  if (DRY_RUN) {
    log('--- DRY RUN, sortie sans écriture ---');
    console.log('\n=== META ===\n', JSON.stringify(meta, null, 2));
    console.log('\n=== MARKDOWN (extrait) ===\n', markdown.slice(0, 800), '...\n');
    return;
  }

  // 6. Écriture
  const filePath = await writeOutput(slug, today, markdown, meta);
  log(`✅ Écrit : ${filePath}`);
}

run().catch((err) => {
  console.error('[veille-auto] ÉCHEC :', err);
  process.exit(1);
});
