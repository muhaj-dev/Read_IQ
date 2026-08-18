# readIQ

A study companion that knows *why* you're stuck, not just *what* you got wrong.

Built on [HydraDB](https://hydradb.com) for **Hack Hydra** (Aug 12–20, 2026) —
Track 3, Memory + Context Retrieval.

---

## The problem

Every study app can tell a student *"you're weak on the Calvin cycle."* That is
the symptom, and it is the less useful half of the sentence.

The useful half is *why*. A student failing the Krebs cycle and ATP synthesis
usually has not failed two biology topics — they have one gap, often in a
different subject, that everything else was built on. Finding it means asking a
question no similarity search can answer:

> What do these failures have in **common, upstream**?

Vector search finds text that *resembles* the question. It has no notion of
*depends on*, so it cannot walk from a symptom to a cause. That relationship is
the entire product, which is why readIQ is built on a graph.

## What it does

**Ask** — answers strictly from the student's own notes, retrieving through the
concept graph rather than by keyword. A question about the Calvin cycle can pull
in the electron transport chain because the notes say one depends on the other,
even though the question never named it.

**Weak Topics → Root Cause** — the centrepiece. Given the topics a quiz flagged,
readIQ walks prerequisite edges backwards and reports what they share:

> **redox reactions** — sits underneath 2 of your weak topics (krebs cycle, atp
> synthesis)
>
> *"Understanding the Krebs cycle requires understanding redox reactions,
> because every electron carrier it fills is reduced in a redox reaction."*

The student was failing biology. The cause was chemistry, and no quiz had ever
tested it. Every claim carries the sentence from their own notes that justifies
it, so it can be checked rather than trusted.

**Memory** — quiz misses and changed facts are written to HydraDB's memory lane,
kept separate from notes. Notes are what the student saved; memory is what the
app observed. When a note says the exam is on the 22nd and a later memory says
it moved to the 24th, both surface and the newer one wins.

---

## How HydraDB is used

HydraDB is the reasoning layer, not a store the app happens to write to. Remove
it and the root-cause feature does not degrade — it ceases to exist.

| Capability | Where |
|---|---|
| Graph-native retrieval for Ask | [`src/lib/retrieval.ts`](src/lib/retrieval.ts) |
| Prerequisite traversal + root-cause ranking | [`src/lib/root-cause.ts`](src/lib/root-cause.ts) |
| Client (query, memory write) | [`src/lib/hydra.ts`](src/lib/hydra.ts) |
| Quiz misses → memory lane | [`src/store/use-quiz-store.ts`](src/store/use-quiz-store.ts) |
| Corpus ingest + status polling | [`scripts/hydra-ingest.mjs`](scripts/hydra-ingest.mjs) |

**No LLM is used anywhere in this project.** HydraDB derives the entities,
predicates and edges from the notes' prose on ingest, so there is no extraction
step and no model API key. Answers are extractive — retrieved passages are shown
verbatim with citations, which also means the app cannot hallucinate.

### The traversal

`graph_context: true` returns typed triples alongside the matching chunks:

```
source:   { entity_id, name, namespace: "concepts", type: "CONCEPT" }
relation: { canonical_predicate, raw_predicate, context, timestamp }
target:   { entity_id, name, ... }
```

Root-cause analysis ([`src/lib/root-cause.ts`](src/lib/root-cause.ts)):

1. Query HydraDB for each failed topic's dependency neighbourhood.
2. **Expand the frontier once** — `graph_context` is scoped to the question
   asked, so a single round only sees prerequisites named in those topics' own
   notes.
3. Keep only **learning-prerequisite** predicates, and orient each edge upstream.
4. Walk backwards from every failed topic; rank shared ancestors by how many
   failures they explain, breaking ties toward the more foundational one.
5. Attach each edge's `context` sentence as evidence.

---

## Two findings worth recording

Both were discovered against the live API, and both changed the implementation.

**1. Entity resolution is exact-string.** `electron transport chain` resolved to
a single `entity_id` across all 13 notes because it was written identically
every time. `redox` was not, and produced four separate nodes — `redox
reaction`, `redox reactions`, `redox process`, `redox chemistry` — including a
singular/plural split. The dependency ladder broke exactly at that join and the
root cause dropped out of the results entirely. **A graph built from prose is
only as connected as the writing is consistent.** Normalising the corpus
vocabulary was the highest-impact fix in the project.

**2. Material-flow and learning-prerequisite edges must not compose.** `krebs
cycle —produces→ atp` and `atp —required by→ calvin cycle` are both true.
Chained, they assert "study the Krebs cycle to understand the Calvin cycle,"
which is false — and it ranked first until the predicate sets were split. Only
conceptual prerequisites are traversed; `produces` and `builds` are shown as
explanation but never composed.

Worth knowing operationally: ingestion is asynchronous and `indexing_status`
passes through `graph_creation` — **searchable, but edges are still forming** —
before reaching `completed`. Querying too early returns chunks with an empty
`graph_context`. The ingest script waits for `completed`.

---

## Running it

Requires Node 18+ and a free [HydraDB](https://dashboard.hydradb.com) account.

```bash
npm install
cp .env.example .env      # then fill in your API key
```

`.env`:

```
EXPO_PUBLIC_HYDRA_API_KEY=<your key>
EXPO_PUBLIC_HYDRA_BASE_URL=https://api.hydradb.com
EXPO_PUBLIC_HYDRA_DATABASE=readiq
EXPO_PUBLIC_HYDRA_COLLECTION=readiq
```

Create a database named `readiq` in the dashboard, then load the corpus:

```bash
node scripts/hydra-ingest.mjs          # ingests seed/, polls until completed
```

This takes a few minutes. The script blocks until every source reports
`completed`, because querying earlier returns an empty graph.

```bash
npm start                              # Expo Go, iOS simulator, or Android emulator
```

### Verifying the graph directly

```bash
node scripts/hydra-probe.mjs "What do I need to understand before the Calvin cycle?"
node scripts/hydra-rootcause.mjs "calvin cycle" "krebs cycle" "atp synthesis"
```

`hydra-rootcause.mjs` runs the same algorithm as the app screen, without needing
a simulator.

---

## Seed corpus

[`seed/`](seed/) holds 13 linked notes across Biology and Chemistry, written to
contain a real prerequisite ladder that spans subjects:

```
valence electrons  ─┐
electronegativity  ─┴→ redox reactions → electron transport chain → proton gradient → atp synthesis
                                                ↘ krebs cycle

enzyme kinetics → rubisco → calvin cycle
```

Edit a note and re-run `node scripts/hydra-ingest.mjs seed/<file>.md` to replace
that source. The ingest sends stable ids, so re-running upserts rather than
duplicating.

---

## Architecture

```
Expo app ──HTTPS──> HydraDB Cloud
   │                  (knowledge graph + memory)
   └── SQLite         notes, quizzes, offline cache
```

There is no backend service. HydraDB Cloud is a single authenticated endpoint
the app calls directly, and SQLite stays the local source of truth so the app
still runs — falling back to lexical retrieval — when offline.

Because there is no server, the API key ships in the app bundle via
`EXPO_PUBLIC_`. That is acceptable for a hackathon demo; real use would put a
thin proxy in front of it.

## Scope

Built for the hackathon: graph retrieval, root-cause analysis, the memory lane,
quiz→memory sync, and the existing UI throughout.

Deliberately out of scope and still stubbed: OCR, audio transcription, and the
study podcast ([`src/lib/ocr.ts`](src/lib/ocr.ts),
[`src/lib/transcription.ts`](src/lib/transcription.ts),
[`src/lib/podcast.ts`](src/lib/podcast.ts)). They require a media provider, touch
HydraDB nowhere, and were cut to keep the graph work deep rather than the
feature list wide.

## Project structure

```
src/
  app/          Expo Router routes
  components/   UI, grouped by feature
  hooks/        use-root-causes, theme, dashboard selectors
  lib/          hydra.ts · root-cause.ts · retrieval.ts · db.ts
  store/        Zustand stores
scripts/        hydra-ingest · hydra-probe · hydra-rootcause
seed/           13-note demo corpus
```

## License

MIT — see [LICENSE](LICENSE).
