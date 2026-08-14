# readIQ — UI

A calm, mobile-first study companion built with Expo and React Native.

**This repository is the UI layer only.** Every screen, component, navigation flow,
theme and local data store is complete and runnable. The AI features (grounded
chat, OCR, transcription, quiz generation, the study podcast) are **not
implemented here** — they exist as clearly marked stubs behind stable interfaces,
ready to be wired to a provider later.

---

## What's in here

| Area | Status |
|---|---|
| Onboarding (welcome · about · first note) | Complete |
| Tabs — Home · Ask · Memory · Quiz · Deadlines | Complete |
| Add Note — paste · upload · scan · record | UI complete; extraction stubbed |
| Note detail, editor, reader, PDF reader | Complete |
| Quiz runner, results, weak topics | UI complete; question generation stubbed |
| Deadlines, calendar, reminders | Complete |
| Profile, settings, achievements | Complete |
| Light + dark theme system | Complete |
| Local persistence (SQLite + AsyncStorage) | Complete |

---

## Running it

```bash
npm install
npm start
```

Then open in Expo Go, an iOS simulator, or an Android emulator.

No environment variables and no API keys are required — nothing in this build
makes a network request to an AI provider.

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
```

---

## Project structure

```
src/
  app/          Expo Router routes (screens only — compose components, call hooks)
  components/   All UI, grouped by feature
  constants/    Theme tokens, typography, image registry
  data/         Static content (add methods, subjects, settings rows)
  hooks/        useTheme, dashboard/profile selectors, media + recorder hooks
  lib/          Local logic — db, retrieval, formatting, file parsing, AI stubs
  store/        Zustand stores
  types/        Shared TypeScript types
```

### Conventions

- Screen files stay under 150 lines; component files under 200. Logic and styling
  live in components, never in screens.
- **Never hardcode a hex colour.** Use `const colors = useTheme()` and
  `colors.X` from `src/constants/theme.ts`, so light and dark both work.
- NativeWind handles layout, spacing and flex. `StyleSheet` / inline styles handle
  colours, shadows, animations, and any component that doesn't accept `className`.
- All SQLite access goes through `src/lib/db.ts` — no raw SQL in screens.

---

## Adding the AI layer later

The AI surface is isolated. Each of these modules keeps its real exported
signature and currently throws `BtlError('not-configured')` (or no-ops), which the
UI already renders as a calm "not set up yet" state:

| Module | What to implement |
|---|---|
| `src/lib/btl.ts` | The provider client. **The only file that should read an API key.** |
| `src/lib/chat.ts` | Grounded answers from retrieved notes |
| `src/lib/quizgen.ts` | MCQ generation from a note |
| `src/lib/ocr.ts` | Image → text for the Scan flow |
| `src/lib/transcription.ts` | Audio → text for the Record flow |
| `src/lib/summarize.ts` | Short note summaries |
| `src/lib/podcast.ts` | Two-host episode scripts |
| `src/lib/embeddings.ts` | Vector embedding + storage |
| `src/lib/pdf-extract.ts` | PDF → text |

Nothing else needs to change: every store, hook and screen already calls these
and already handles their success, empty and error states.

**`src/lib/retrieval.ts` is already real** — it is local, IDF-weighted keyword
matching with no network and no AI. It returns `[]` when nothing matches, which is
what stops the app answering something it can't ground in a saved note. A semantic
path can be layered in behind the same signature.

---

## Licence

See [LICENSE](LICENSE).
