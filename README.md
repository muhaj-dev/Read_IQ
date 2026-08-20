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

**Memory** — quiz misses and saved deadlines are written to HydraDB's memory
lane, kept separate from notes. Notes are what the student saved; memory is what
the app observed. When a note says the quiz is on the 22nd and a later memory
says it moved to the 24th, both surface and the newer one wins:

> **Study Plan — Week 6**
> *"The Week 4 quiz on photosynthesis is scheduled for the 22nd."*
>
> **Since you saved that:**
> **Week 4 quiz moved** — *"The Week 4 photosynthesis quiz has been moved from
> the 22nd to the 24th."*

The note still shows. The student wrote it, and it is not the app's place to
edit it out from under them — the newer claim goes underneath, labelled, and
wins the reader's eye on its own.

---

## How HydraDB is used

HydraDB is the reasoning layer, not a store the app happens to write to. Remove
it and the root-cause feature does not degrade — it ceases to exist.

| Capability | Where |
|---|---|
| Graph-native retrieval for Ask | [`src/lib/retrieval.ts`](src/lib/retrieval.ts) |
| Prerequisite traversal + root-cause ranking | [`src/lib/root-cause.ts`](src/lib/root-cause.ts) |
| Client (query, memory write) | [`src/lib/hydra.ts`](src/lib/hydra.ts) |
| Memory recall + superseding rule | [`src/lib/memory.ts`](src/lib/memory.ts) |
| Quiz misses → memory lane | [`src/store/use-quiz-store.ts`](src/store/use-quiz-store.ts) |
| Deadlines → memory lane | [`src/store/use-deadlines-store.ts`](src/store/use-deadlines-store.ts) |
| Corpus ingest + status polling | [`scripts/hydra-ingest.mjs`](scripts/hydra-ingest.mjs) |
| Live connection status in Settings | [`src/app/settings/index.tsx`](src/app/settings/index.tsx) |

**No LLM touches any of it.** HydraDB derives the entities, predicates and edges
from the notes' prose on ingest, so there is no extraction step. Answers are
extractive — retrieved passages are shown verbatim with citations, which also
means Ask cannot hallucinate.

A model does run, in six places, and none of them is this one. Groq **writes the
quiz questions** ([`quizgen.ts`](src/lib/quizgen.ts)), **transcribes recordings**
([`transcription.ts`](src/lib/transcription.ts)), **reads the words off a
photographed page** ([`ocr.ts`](src/lib/ocr.ts)), **scripts the two-host episode**
([`podcast.ts`](src/lib/podcast.ts)), **summarises a long extraction into one
line** ([`summarize.ts`](src/lib/summarize.ts)), and **answers from general
knowledge when the student asks it to** ([`beyond.ts`](src/lib/beyond.ts)) — all
through [`src/lib/groq.ts`](src/lib/groq.ts), the only module holding that key.

Every one is generation, never retrieval: four plausible options out of their
notes, words out of their audio, the words off their photograph, a gist of what
they just saved. A transcript becomes a note, and only then does HydraDB see it,
on ingest, like anything else the student saved.

Two of them are worth stating precisely, because it would be easy to assume a
model is doing more than it is.

**OCR transcribes; it does not read.** The prompt forbids correcting a spelling,
expanding an abbreviation or finishing a sentence — an illegible word comes back
as `[?]` rather than a guess. A student's notes are theirs, shorthand included,
and a model that tidies them has changed what they wrote. Groq serves exactly one
multimodal model, `qwen/qwen3.6-27b`, and it is faithful enough to reproduce a
typo rather than fix it (see finding #4).

**The podcast is a script, not a voice.** Playback is the phone's own TTS via
`expo-speech`, so an episode costs one text call and then nothing — no audio is
generated, streamed or stored, and it plays offline.

The last is the one that needs stating plainly, because it is an answer with
no note behind it. **It only runs when the student asks for it by name.** Ask
answers from the notes first; if that answer stands, a quiet *"Answer from
outside your notes"* link appears underneath, and only pressing it calls a model.
What comes back lands in its own bubble, in plain prose — the system prompt
forbids the bold-heading shape that `answer-blocks.ts` renders as a note-quote
card, so a generated answer can never wear a citation's clothes.

The boundary is enforced by imports: `chat.ts`, `retrieval.ts`, `root-cause.ts`
and `memory.ts` have no path to `groq.ts`, and `groq.ts` never queries HydraDB.
Beyond-notes generation lives in its own module for exactly that reason — the
extractive path cannot reach a model even by accident. What comes back from a
quiz call is validated locally — option count, a single valid answer key, no
duplicate options, and the cited note heading resolved back to a real note — and
anything that fails is dropped rather than patched.

Settings carries a live status row for each of the two services, because they
fail separately and mean different things — Ask quietly degrades to lexical
search without HydraDB, quizzes stop entirely without Groq. HydraDB's check is a
real query rather than a ping to the host: a reachable API pointed at the wrong
collection looks perfectly healthy from the outside and returns nothing for
every question the student asks, so the row says *"Connected, but `readiq` has
no notes ingested yet"* rather than a green tick that lies.

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

## Four findings worth recording

All four were discovered against the live API, and all four changed the
implementation.

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

**3. `type: "all"` is not a superset — it is a different ranking.** The default
mixes knowledge and memory, and memories win exactly the questions they were
written about: asking `krebs cycle` returned the memory *"the student answered a
Krebs cycle question incorrectly"* at 0.743, **above every note on the Krebs
cycle**. Ask quotes what retrieval returns under a note heading, so this showed
the student the app's observation about them as a sentence they had written.
Retrieval now asks for `knowledge` only and memory is read separately.

The same probe turned up why the two lanes cannot simply be merged and re-sorted:
**relevancy scores are normalised per result set, not absolute.** The chunk
`bio-krebs-cycle` scores 0.725 under `type: "all"` and 0.913 under
`type: "knowledge"` — same chunk, same query. A memory's score in one response
therefore says nothing about its standing in another, which rules out gating
memory against the notes' scores. The gates in
[`src/lib/memory.ts`](src/lib/memory.ts) are calibrated within a memory-only
query instead: off-topic questions score every memory below 0.20, a near-miss
peaks at 0.32, and a real hit starts at 0.46.

Worth knowing operationally: ingestion is asynchronous and `indexing_status`
passes through `graph_creation` — **searchable, but edges are still forming** —
before reaching `completed`. Querying too early returns chunks with an empty
`graph_context`. The ingest script waits for `completed`.

**4. Three features were written off as needing providers. Two of them didn't.**
OCR, PDF extraction and the podcast were all filed under "needs a vision or
speech provider" — an assumption inherited from a comment, never checked. It was
wrong twice over, and each correction was worth more than the feature:

- A **PDF already contains its text**, and pdf.js was already in the app to
  render the reader. `getTextContent()` was one call away the whole time. The
  vision-model plan would have been slower, cost money per note, and been less
  accurate than reading the file's own words.
- The **podcast's audio was never missing** — playback is on-device TTS and had
  been working all along. Only the script was absent. Groq does serve a TTS model
  (`canopylabs/orpheus-v1-english`), but it 400s with `model_terms_required`, and
  it isn't needed.
- **Vision was real, and available.** `qwen/qwen3.6-27b` is the account's only
  multimodal model. Asked to transcribe a rendered test page, it returned
  `YIELDS 2 AT` — matching a deliberately broken glyph in the test font instead
  of "correcting" it to `ATP`. It reads rather than guesses, which is the whole
  requirement for someone else's notes.

Two implementation details fell out of it. The vision model wraps every reply in
a `<think>` block that has to be stripped, or a transcription opens with the
model talking to itself. And **Groq's rate limit counts `prompt + max_tokens`,
not tokens used**: on the free tier's 8000 TPM, an 8192 ceiling is rejected with
a 413 *before the model runs*. A generous ceiling is not free — see
[`podcast.ts`](src/lib/podcast.ts). The mirror-image trap is a ceiling that is
too *small*: these models reason before they answer, and that spend comes out of
the same budget, so a one-sentence summary capped at 120 tokens returns a 400
(`max completion tokens reached before generating a valid document`) rather than
a short summary.

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

EXPO_PUBLIC_GROQ_API_KEY=<your key>          # quizzes + transcription only
EXPO_PUBLIC_GROQ_BASE_URL=https://api.groq.com/openai/v1
```

The Groq key is free from [console.groq.com/keys](https://console.groq.com/keys)
and is only read by [`src/lib/groq.ts`](src/lib/groq.ts). Leave it blank and
everything else still works — Quiz goes dark, and Record falls back to a manual,
editable transcript.

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

### Verifying the memory lane

```bash
node scripts/hydra-memory.mjs                    # the exam-date case above
node scripts/hydra-memory.mjs "krebs cycle"
```

Prints both lanes separately, every gate decision with its reason, and the
answer as the student would see it. The line to watch is `ok — no memory in the
note lane`: it is the check that memory never gets quoted as a note.

### Verifying quiz generation

```bash
node scripts/groq-quiz.mjs             # 5 questions from the Biology seed notes
node scripts/groq-quiz.mjs 10 chem     # 10 from seed/chem-*.md
```

Same prompt and same validation as [`src/lib/quizgen.ts`](src/lib/quizgen.ts),
so a failure here is a failure in the app. It prints how many questions survived
validation, which is the number worth watching.

### Verifying the rest of the generation lane

```bash
node scripts/groq-generate.mjs                       # status rows + both jobs
node scripts/groq-generate.mjs "why is the sky blue" # beyond-notes only
```

Runs the two Settings status checks, an opt-in beyond-notes answer, and a
summary of the first few seed notes. The lines to watch are `shape ok` — the
generated answer contains no bold-heading line, so it cannot render as a
note-quote card — and the word count under each summary, against the prompt's
25-word brief.

### Verifying the podcast, OCR and PDF extraction

```bash
node scripts/groq-podcast.mjs          # episode from the first Biology seed note
node scripts/groq-ocr.mjs              # renders a known page, checks it round-trips
node scripts/pdf-extract.mjs           # builds a PDF, checks every line survives
```

Each ends in a real assertion rather than output to eyeball, because each guards
a specific way the feature fails quietly:

- **`groq-podcast`** prints the episode and checks the hosts alternate — two
  consecutive turns by one speaker would collide in the two-voice player — and
  that no markdown survived into text a TTS engine will read aloud.
- **`groq-ocr`** draws its own test page from a built-in bitmap font, so the
  expected text is known *exactly*. `PASS — transcribed verbatim` means the model
  reproduced it without tidying anything. Pass a real photo to transcribe it
  instead: `node scripts/groq-ocr.mjs page.jpg`.
- **`pdf-extract`** hand-authors a PDF, then runs the extractor page's own
  `pageText()` — lifted out of [`pdf-extract-doc.ts`](src/lib/pdf-extract-doc.ts),
  not copied — against the same pinned pdf.js the WebView loads. The failure it
  guards is subtle: `getTextContent()` returns positioned items with no
  separators, so naive joining yields `GlycolysisGlucose is split…`. Pass a real
  file to extract it: `node scripts/pdf-extract.mjs paper.pdf`.

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
   │       │          (knowledge graph + memory)
   │       └HTTPS──>  Groq
   │                  (quiz + podcast scripts, transcription, OCR, summaries,
   │                   opt-in answers — generation only, never retrieval)
   ├── pdf.js         PDF text extraction, in a hidden WebView (no provider)
   └── expo-speech    podcast playback, on-device (no provider)
   └── SQLite         notes, quizzes, offline cache
```

There is no backend service. HydraDB Cloud is a single authenticated endpoint
the app calls directly, and SQLite stays the local source of truth so the app
still runs — falling back to lexical retrieval — when offline.

Because there is no server, both API keys ship in the app bundle via
`EXPO_PUBLIC_`. That is acceptable for a hackathon demo; real use would put a
thin proxy in front of them.

## Scope

Built for the hackathon: graph retrieval, root-cause analysis, the memory lane,
quiz generation, quiz→memory sync, lecture transcription, Scan OCR, PDF text
extraction, the study podcast, note summaries, the opt-in beyond-notes answer,
live connection status in Settings, and the existing UI throughout.

These last three were written off early as needing providers the project did not
have. Checking rather than assuming turned out to matter, and only one of them
was true:

- **PDF text extraction needs no model at all.** A PDF written by Word or LaTeX
  carries its own text layer, and pdf.js — already in the app, rendering the PDF
  Reader — hands it back through `getTextContent()`. Extraction is that same
  library in a hidden WebView ([`pdf-extract.ts`](src/lib/pdf-extract.ts)). It
  costs nothing per note, works offline, and is *more* accurate than a vision
  model, which would be paying to re-read pixels of text already in the file.
- **The podcast needed no speech provider.** Playback was already on-device TTS
  and already worked; only the script was missing.
- **OCR genuinely needed vision**, and Groq turned out to serve it.

Still stubbed, and honestly out of scope: [`btl.ts`](src/lib/btl.ts)'s unused
request surface and [`embeddings.ts`](src/lib/embeddings.ts). Retrieval goes
through HydraDB's graph, so local vectors have nothing left to do.

## Project structure

```
src/
  app/          Expo Router routes
  components/   UI, grouped by feature
  hooks/        use-root-causes, theme, dashboard selectors
  lib/          hydra.ts · root-cause.ts · retrieval.ts · memory.ts · chat.ts ·
                groq.ts · quizgen.ts · transcription.ts · ocr.ts · podcast.ts ·
                summarize.ts · beyond.ts · pdf-extract.ts · pdfjs.ts · db.ts
  store/        Zustand stores
scripts/        hydra-ingest · hydra-probe · hydra-rootcause · hydra-memory ·
                groq-quiz · groq-generate · groq-podcast · groq-ocr ·
                pdf-extract
seed/           13-note demo corpus
```

## License

MIT — see [LICENSE](LICENSE).
