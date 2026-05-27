# HANDSOFF — MIET Translator Pro

Pick up here. Read top-to-bottom before touching code.

---

## 1. What this project is

`miet-translator-pro` (github: `blessblissmari/miet-translator-pro`) is a web app +
Node CLI that translates English academic PDF/DOCX/PPTX into Russian DOCX/PPTX
preserving math formulas as native Office equations (OMML) and figures as
embedded images.

Audience: a MIET professor (Dymań) — the user is the student. The reference
"ideal" style comes from another professor (Urentsev) — clean DOCX with inline
images, OMML math, GOST formatting.

- Live web: <https://blessblissmari.github.io/miet-translator-pro/>
- CLI: `tools/cli/` (run locally with Node + Bun)

---

## 2. Recent history (newest first)

| commit  | summary |
|---------|---------|
| 66b45de | Conservative `wrapOrphanLatex`; MinerU PUT direct→proxy fallback |
| 2e02c0f | Web: vision-always, verify pass, math-audit pass, broad wrap |
| b9de12f | CLI: triple-pass verify+math audit+bareMath wrapper |
| a46997b | CLI: multi-pass vision pipeline + matplotlib redraw |
| 698da1b | Vision-only MiMo models + vision-based per-page translation |
| 4e762bf | **Switch from OpenRouter to Xiaomi MiMo** (big migration) |

Before me, project was on OpenRouter. We moved everything to Xiaomi MiMo
(`https://token-plan-sgp.xiaomimimo.com/v1`, OpenAI-compatible). No VPN needed
from Russia. Single API key with 200M credits.

---

## 3. Current state

### Working

- ✅ Web app deployed at `blessblissmari.github.io/miet-translator-pro/`
- ✅ MiMo API integration (vision + chat). Token baked into prod bundle via
  GH secret `MIMO_KEY_1` → `VITE_MIMO_KEY_1`. Teachers don't enter anything.
- ✅ CLI doc pipeline (`tools/cli/translate-docs-pandoc.mjs`):
  multi-pass vision translation, formula audit, matplotlib redraw of figures,
  pandoc → DOCX with native OMML.
- ✅ CLI slides pipeline (`tools/cli/translate-slides.mjs`).
- ✅ Sample outputs in `~/workspace/Documents/Дымань-перевод/` — 4 DOCX +
  3 PPTX, all with OMML equations + embedded figures (some matplotlib-redrawn).

### Broken / open

1. **MinerU upload (HTTP 403)**. User toggled MinerU mode in Settings.
   - Direct PUT to Alibaba OSS signed URL → CORS preflight fails (no CORS on
     bucket; `OPTIONS` returns 405).
   - Direct POST to `mineru.net/api/v4/*` → also no CORS (`OPTIONS` 405).
   - Through `corsproxy.io/?<url>` → 403 SignatureDoesNotMatch (proxy mangles
     headers / passes wrong Content-Type, signature breaks).
   - User explicitly refused a server-side relay: «нам не нужен relay».
   - GitHub issue #4145 confirms: OSS pre-signed URL requires PUT with **no**
     Content-Type and no extra headers. Curl/Python work; browser does not.
   - **State**: stuck. Realistic options:
     - (a) Convince user to allow a relay (zo.space `/api/put-proxy` is 20 LOC).
     - (b) Add a feature flag to disable MinerU entirely until a fix exists.
     - (c) Switch to MinerU's URL-submission flow (file must be public first —
       requires user-side upload to some public bucket; not great).
   - Current code: `src/lib/mineru.ts` tries direct PUT first, falls back to
     URL-encoded `corsproxy.io`. Both fail in browser. Default Settings has
     MinerU off; turning it on triggers the 403.

2. **Web formula rendering quality**. User keeps reporting raw LaTeX visible
   in final DOCX. Investigation showed two pieces:
   - The actual DOCX **does** render formulas as Office equations (OMML), it
     just *looks* like raw LaTeX when you `pandoc → markdown` round-trip.
   - But there are still cases where the model returns prose like
     `y[n] = \mathcal{H}\{x[n]\} = x[n+1] - 2x[n] + x[n-1]` with **no
     `$...$` delimiters**. `wrapOrphanLatex` in `src/lib/plannerShared.ts` is
     supposed to wrap these — current version is CONSERVATIVE (commit 66b45de)
     after I broke it with an over-aggressive version that wrapped Russian
     prose. The CLI uses `wrapBareMath` from
     `tools/cli/lib/mathSanitize.mjs` which is broader. Web should probably
     mirror the CLI's bareMath, but carefully — last attempt mangled Russian.

3. **Web verify / math-audit passes** were added (commit 2e02c0f, see
   `src/lib/docPlanner.ts` lines ~205-280) but I never confirmed they actually
   fire end-to-end in the browser bundle. User says results haven't changed.
   - Quick test: load live site, open DevTools, watch network calls to
     `token-plan-sgp.xiaomimimo.com`. For each page there should be:
     pass 1 (translate) + pass 2 (verify, only if blocked) + pass 3 (audit,
     only if math gaps).

---

## 4. Architecture cheatsheet

### MiMo client (`src/lib/mimo.ts`, `tools/cli/lib/mimo.mjs`)

- Endpoint: `https://token-plan-sgp.xiaomimimo.com/v1/chat/completions`
- Models — **vision-only** kept: `mimo-v2.5` (default), `mimo-v2-omni`.
  Dropped non-vision (`mimo-v2.5-pro`, `mimo-v2-pro`) — user request.
- Reasoning model: it eats tokens for `reasoning_content`; default
  `maxTokens=8192` to leave room for actual answer. Empty-content responses
  are treated as transient and retried.
- Keys: `VITE_MIMO_KEY_1..7` env vars. Currently only `MIMO_KEY_1` is set
  (via GH secret); built-in key array filters anything `> 10` chars.

### Web pipeline (`src/lib/docPlanner.ts`)

```
extractPdf (pdfjs)            → pages[] {text, images}
  ↓
chat() with system prompt     → Russian markdown with $...$ math + figures
  ↓
verifyTranslation             → if gaps, retry once with gap list
  ↓
mathAudit                     → if missed formulas, retry once
  ↓
wrapOrphanLatex + normalizeMath + glossary + ruPolish
  ↓
parseMarkdownToBlocks         → DocBlock[]
  ↓
docxBuild (latexToOmml)       → DOCX with native equations
```

### CLI pipeline (`tools/cli/translate-docs-pandoc.mjs`)

```
pdftoppm @144 DPI             → page PNGs
pdfimages                     → embedded raster figures
  ↓
translatePagesVision          → page image → Russian MD per page
  with verify + math-audit retries
  ↓
redrawFigure (REDRAW=1)       → matplotlib regen of charts via vision
  ↓
substituteFigures + polishRu + sanitizeLatexMath + wrapBareMath
  ↓
pandoc → DOCX                 → native OMML
```

CLI is **better** than web because pandoc handles OMML conversion
natively; the web's `docx` JS library + custom `latexToOmml` is less mature.
Per the user, the WEB result is what matters most.

---

## 5. Key files (read these before editing)

- `src/lib/mimo.ts` — chat client, FREE_MODELS, key rotation
- `src/lib/docPlanner.ts` — web translation pipeline (with new verify/audit
  passes; never confirmed they fire in prod)
- `src/lib/plannerShared.ts` — `wrapOrphanLatex` (conservative now), shared
  prompts and types
- `src/lib/mineru.ts` — MinerU client (PUT to OSS broken)
- `src/components/SettingsPanel.tsx` — no model picker (removed by user
  request — only vision models exist)
- `tools/cli/lib/docPlannerVision.mjs` — CLI triple-pass logic, useful
  reference if porting more behavior to web
- `tools/cli/lib/mathSanitize.mjs` — has `wrapBareMath` (broader; web's
  `wrapOrphanLatex` is conservative variant)
- `.github/workflows/pages.yml` — CI; env vars `VITE_MIMO_KEY_1..7`

---

## 6. Secrets

| where         | name(s)                              | source                       |
|---------------|--------------------------------------|------------------------------|
| GitHub repo   | `MIMO_KEY_1`, `MINERU_TOKEN`         | set via `gh secret set`      |
| Zo env        | `mimo_token`                         | exposed by user in Zo Secrets|
| zo.space      | (none yet)                           | —                            |
| GH PAT used   | (workflow scope)                     | provided in chat; revoked-able by user |

`mimo_token` length is 51, starts with `tp-`. Already verified in prod bundle
(`grep "$mimo_token" assets/index-*.js` → present). Don't print the value.

---

## 7. CI / deploy

- `.github/workflows/pages.yml`. Push to `main` → build + e2e + deploy to
  GitHub Pages.
- `gh run watch` works; my OAuth token does NOT have `workflow` scope —
  if you need to edit `.github/workflows/*`, use the user-provided PAT.
  Currently the gh CLI is authenticated with that PAT (run
  `gh auth status` to verify).

---

## 8. Tests

- Unit tests: `bun run test` (9 files, 79 tests, all passing as of 66b45de).
- E2E: Playwright smoke tests in `e2e/smoke.spec.ts`. They run on CI.
- I had a personal harness at `~/.z/workspaces/con_*/test/run_translate.mjs`
  that drove the dev server with Playwright. The conversation workspace is
  ephemeral so it's likely gone.

---

## 9. Test inputs the user keeps using

`~/workspace/Documents/Дымань входные данные/`:

- `2018_eee5502_hw02_prob.pdf` — 2 pages, problem set, no figures (small smoke
  test)
- `2018_eee5502_hw02_soln.pdf` — 7 pages, **scanned** handwritten solution, 7
  embedded raster images that are actually full-page scans
- `AddEx_Ch3.pdf`, `AddEx_Ch4.pdf` — typeset extra exercises with small
  vector figures
- `Ch4(5).pdf`, `Ch5(1).pdf`, `Ch5(2).pdf` — landscape slide decks, 48/61/55
  pages

Same files also at `~/.z/workspaces/con_*/test/input/2 Дымань/` (conversation
workspace, may be gone).

"Ideal" reference outputs (Urentsev) in `~/.z/workspaces/con_*/test/ideal/`
when conv workspace still exists; format = inline OMML + inline matplotlib-style
figures.

---

## 10. What user wants next (latest signal)

User reports: «все равно проскакивают некрасиво оформленные формулы, рисунки
и графики он отработал ужасно. проведи полномасштабный глобальный тест.»

Translation: formulas still look bad on the website, figures look bad. They
want a comprehensive test + verification + multi-pass refinement.

User also reports MinerU 403 when enabling MinerU mode.

User refuses server-side relay. User wants direct API or nothing.

### Concrete next steps

1. **Investigate MinerU 403 properly** — open DevTools on the live site,
   reproduce the 403, log the actual request/response. The fix per MinerU
   issue #4145 is: PUT with **zero** headers and raw bytes. Browser fetch may
   auto-add `Content-Type` from the File's `.type` — try
   `body: new Uint8Array(await file.arrayBuffer())` instead of `body: file`.
   That may avoid the signature mismatch when going through corsproxy. If it
   still 403s, MinerU + browser without relay is impossible — be honest with
   the user.

2. **Verify the web pipeline actually runs all three passes**. Open the
   deployed app with a small PDF, capture network calls, confirm pass 1/2/3
   fire. If they don't (maybe a guard or env-condition is blocking them),
   fix. If they do but quality is bad, the prompt needs work.

3. **Strengthen the web prompt** in `src/lib/docPlanner.ts` —
   `DOC_TRANSLATE_PROMPT`. Add explicit examples of CORRECT wrapping:
   - WRONG: `y[n] = \mathcal{H}\{x[n]\}` (raw LaTeX in prose)
   - RIGHT: `$y[n] = \mathcal{H}\{x[n]\}$`

4. **Consider porting CLI's `wrapBareMath`** (`tools/cli/lib/mathSanitize.mjs`)
   to web `wrapOrphanLatex` — but test exhaustively with Russian to avoid the
   regression from commit 2e02c0f (which wrapped Russian words in $...$).

5. **Show the user RENDERED DOCX**, not pandoc-markdown round-trip. The
   round-trip makes correctly-rendered OMML look like raw LaTeX. User may be
   confused by that.

---

## 11. Tone / persona note

Active persona is "Ultra-Minimal Messenger" — very short responses, lowercase,
no filler, 10-code OK. Russian when user writes Russian. Keep it tight.

User communication style: blunt, sometimes frustrated. Don't over-promise.
When something fundamentally can't work in browsers (CORS limits), say so
plainly rather than burning 30 minutes failing to fix it.

---
