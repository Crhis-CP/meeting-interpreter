# Meeting Interpreter v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a free, open-source desktop app (macOS first, Windows, Linux) that interprets Chinese ⇄ Spanish live inside any meeting app via virtual audio devices, hosts on-site "rooms" that phones join from a browser, and keeps bilingual transcripts, zh/es summaries and audio/screen recordings — downloadable from GitHub Releases.

**Architecture:** An isomorphic TypeScript core (`src/core`: pipeline, providers, glossary, transcript, summary) runs in the Electron main process (and later in browsers). A hidden audio window does all Web Audio capture/playback/recording and streams 16 kHz PCM to main over a MessagePort. The main process also runs an HTTPS+WebSocket room server whose participant UI (`room.html`) is served to phones.

**Tech Stack:** Electron 45, electron-vite 6, Vite 8, React 19, TypeScript 6 (strict), zod 4, ws 8, Vitest 5, Playwright 1.65 (Electron), electron-builder 26, pinyin-pro, sherpa-onnx-node 2 (local ASR), microsoft-cognitiveservices-speech-sdk 1.53, qrcode, selfsigned.

**Spec:** `docs/superpowers/specs/2026-11-20-meeting-interpreter-design.md`

## Global Constraints

- Languages v1: `zh-CN` (self default) and Spanish `es-ES` (default) / `es-MX` / `es-US` / `es-419`; language data lives in one registry so `en-US` can be added by config.
- `src/core/**` must not import `electron`, `node:*`, `fs`, `ws` or DOM-only APIs; network only via injected `ProviderContext` (`fetch`, `openWebSocket`), storage only via interfaces.
- Never speak untranslated or wrong-script text into the meeting: a failed/invalid translation produces no audio.
- Our own TTS is never routed into any capture path.
- API keys only via `SecretStore` (Electron `safeStorage`); never in logs (logger redacts `sk-…`, `Bearer …`, `key=`), exports, or `meeting.json`.
- Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload exposes a typed whitelist only.
- UI copy is Chinese (zh-CN) by default with an English dictionary; strings go through `t()`.
- Records default to `<Documents>/MeetingInterpreter/<YYYY-MM-DD_HHmm>_<title>/`.
- Commits: English Conventional Commits, each with the session attribution trailer.
- Licence MIT; Apache-2.0-derived pieces (Cicada segmenter rules, prompts) credited in `NOTICE`.

## Review Focus

1. **Meeting runs 1–2 h**: transcript, WAV and MediaRecorder writes must stream to disk (no unbounded memory) and survive an app crash with everything up to the last second on disk. → Task 9 test `transcript store appends JSONL incrementally`; Task 14 test `WavFileWriter keeps a valid header after each flush`.
2. **Provider goes down mid-meeting** (WebSocket closes, 401, timeout): the direction must reconnect with backoff, surface a Chinese error in the UI, and keep the other direction running. → Task 8 test `pipeline restarts ASR session after provider close and keeps segment order`.
3. **Translation backlog** when the speaker talks faster than TTS: speech rate rises up to 1.35×, backlog > 15 s offers "skip to latest", nothing is silently dropped from the transcript. → Task 8 tests `rate grows with backlog` and `skipToLatest marks skipped segments`.
4. **Missing virtual audio device** (no BlackHole / VB-CABLE installed or unplugged mid-meeting): the device wizard says which driver to install; the session keeps running with subtitles only. → Task 16 test `matchVirtualDevices returns install hint when absent`.
5. **Glossary CSV from Excel** (UTF-8 with/without BOM, GBK not supported → clear error, quoted commas, CRLF): import works or fails with a line number. → Task 4 tests `parses BOM + CRLF + quoted commas` and `reports line of malformed row`.

---

### Task 1: Project scaffold, tooling and CI

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `typecheck`, `test`, `test:e2e`, `dist` (electron-builder), `cli`.

- [ ] Step 1: Write `tests/smoke.test.ts` asserting `1 + 1 === 2` and that `src/core` has no forbidden imports (scan files for `from 'electron'|'node:'|'fs'|'ws'`).
- [ ] Step 2: Create configs; renderer build inputs `index.html`, `overlay.html`, `audio.html`, `room.html`.
- [ ] Step 3: Run `npm run typecheck && npm test && npm run build` → all pass, `out/` contains main, preload, renderer.
- [ ] Step 4: CI workflow (ubuntu, node 22): `npm ci`, typecheck, test, build.
- [ ] Step 5: Commit `build: scaffold electron app with vite, vitest and ci`.

### Task 2: Core foundations (types, events, logging, PCM, WAV, languages)

**Files:**
- Create: `src/core/types.ts`, `src/core/events.ts`, `src/core/log.ts`, `src/core/audio/pcm.ts`, `src/core/audio/wav.ts`, `src/core/lang/languages.ts`
- Test: `tests/core/pcm.test.ts`, `tests/core/wav.test.ts`, `tests/core/log.test.ts`, `tests/core/languages.test.ts`

**Interfaces (Produces):**
- `type Direction = 'out' | 'in'`; `type LangCode = string`;
- `interface TranscriptSegment { id: string; dir: Direction | 'room'; speaker: string; seq: number; start: number; end: number; srcLang: LangCode; srcText: string; dstLang: LangCode; dstText: string | null; status: 'translating'|'done'|'failed'|'skipped'; error?: string }`
- `class Emitter<E extends Record<string, unknown>> { on<K>(k, fn): () => void; off; emit<K>(k, payload) }`
- `createLogger(scope): Logger` with `redact(s: string): string`.
- `floatToInt16(f: Float32Array): Int16Array`, `int16ToFloat(i: Int16Array): Float32Array`, `resampleLinear(input: Float32Array, from: number, to: number): Float32Array`, `rms(i: Int16Array): number` (0..1), `concatInt16(a: Int16Array[]): Int16Array`.
- `encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array`, `decodeWav(bytes: Uint8Array): { samples: Int16Array; sampleRate: number; channels: number }`, `wavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array`.
- `LANGUAGES: Record<LangCode, LanguageInfo>`; `LanguageInfo { code; base: 'zh'|'es'; nameZh; nameNative; englishName; azure: string; dashscope: string; qwenMt: string; deepl: string; openai: string; script: 'han'|'latin' }`; `otherLanguage(code): LangCode`.

- [ ] Step 1: Tests: int16↔float round trip within 1 LSB; resample 48k→16k keeps a 440 Hz tone's length (n/3) and energy (±5%); WAV encode→decode identity; `decodeWav` rejects non-RIFF; redact masks `sk-abc123xyz`, `Bearer xyz`, `api_key=…`; `otherLanguage('es-MX') === 'zh-CN'`.
- [ ] Step 2: Run → fail. Step 3: implement. Step 4: run → pass. Step 5: commit `feat: add core audio, logging and language registry`.

### Task 3: Energy segmenter (VAD)

**Files:** Create `src/core/audio/segmenter.ts`; Test `tests/core/segmenter.test.ts`

**Interfaces (Produces):** `class Segmenter extends Emitter<{ segment: { index: number; start: number; samples: Int16Array }; speechStart: { t: number }; speechEnd: { t: number } }>` with `constructor(opts?: { threshold?: number /*0.01*/, pause?: number /*0.6*/, maxLength?: number /*8*/, minSpeech?: number /*0.25*/ })`, `feed(samples: Int16Array)`, `flush()`, `get speaking(): boolean`. 16 kHz, 30 ms frames, 3×10 ms onset, 0.15 s pre-roll and tail, max-length cut at quietest frame of last 2 s (rules from Cicada `Segmenter.cs`, credited).

- [ ] Tests: silence → no segment; 1 s tone + 1 s silence → one segment ≈1.3 s starting ≈0.85 s; 12 s continuous tone → first segment ≤ 8 s; a 5 ms click inside a pause does not split nor open a segment; `flush()` closes an open segment.
- [ ] Implement, pass, commit `feat: add energy-based speech segmenter`.

### Task 4: Glossary (model, CSV, matching, hot words, corrections)

**Files:** Create `src/core/glossary/types.ts`, `csv.ts`, `match.ts`, `correct.ts`; Test `tests/core/glossary.test.ts`

**Interfaces (Produces):**
- `interface GlossaryEntry { id: string; zh: string; es: string; aliasesZh: string[]; aliasesEs: string[]; note: string; enabled: boolean }`; `interface Glossary { id: string; name: string; enabled: boolean; entries: GlossaryEntry[] }`
- `parseGlossaryCsv(text: string): { entries: GlossaryEntry[]; errors: { line: number; message: string }[] }` (header `中文,Español,中文别名,西语别名,备注`, also accepts `zh,es,…`; aliases split on `;|；`), `glossaryToCsv(entries): string` (BOM + CRLF).
- `interface GlossaryHit { source: string; target: string; entry: GlossaryEntry }`; `findHits(text: string, from: 'zh'|'es', entries: GlossaryEntry[]): GlossaryHit[]` (zh: substring; es: case/accent-insensitive whole word).
- `hotwordsFor(base: 'zh'|'es', entries): string[]` (terms + aliases' canonical forms, dedup, ≤ 500).
- `correctText(text: string, base: 'zh'|'es', entries, opts: { pinyinFuzzy: boolean }): { text: string; edits: { from: string; to: string }[] }` — alias replacement, then (zh, ≥2 chars, toneless pinyin, ≤1 syllable difference for 2–3 char terms, ≤2 for ≥4) fuzzy replacement via `pinyin-pro`.

- [ ] Tests: BOM + CRLF + quoted comma parse; malformed row reports its line; round trip CSV; `findHits('我们的产品叫星云平台', 'zh', …)` hits 星云平台; `findHits('la plataforma nébula', 'es', …)` matches `Plataforma Nebula`; alias `心云平台→星云平台` corrected; fuzzy `新云平台→星云平台` only when `pinyinFuzzy`; no fuzzy edit for 1-char terms.
- [ ] Implement, pass, commit `feat: add glossary import, matching and correction`.

### Task 5: Committer and translation validation

**Files:** Create `src/core/pipeline/committer.ts`, `src/core/pipeline/validate.ts`; Test `tests/core/committer.test.ts`, `tests/core/validate.test.ts`

**Interfaces (Produces):**
- `class Committer { constructor(opts: { base: 'zh'|'es'; stableMs?: number /*700*/; minChars?: number /*zh 6*/; minWords?: number /*es 4*/; lowLatency?: boolean /*true*/ }); onPartial(text: string, nowMs: number): string[]; onFinal(text: string, nowMs: number): string[]; reset(): void }` — returns translation units; never emits the same source text twice; on final, emits only the part after what was already committed (longest common prefix after normalising punctuation/whitespace).
- `isValidTranslation(text: string, target: LangCode, source: string): boolean` — non-empty, not equal to source, Spanish target must not be >30 % Han characters, Chinese target must contain Han characters (allowing Latin proper nouns), strips quotes/"Translation:" prefixes via `cleanTranslation(text): string`.

- [ ] Tests: final-only commits whole text; stable partial with `，` after ≥6 chars commits prefix after 700 ms; following final commits only the remainder; partial that changes before 700 ms commits nothing; final diverging from committed prefix commits the remainder after the common prefix; `lowLatency:false` commits only on final; validation cases for zh/es.
- [ ] Implement, pass, commit `feat: add segment committer and translation validation`.

### Task 6: Provider contracts, mock providers, settings schema and presets

**Files:** Create `src/core/providers/types.ts`, `src/core/providers/mock.ts`, `src/core/providers/registry.ts`, `src/core/config/schema.ts`, `src/core/config/presets.ts`; Test `tests/core/providers-mock.test.ts`, `tests/core/config.test.ts`

**Interfaces (Produces):**
- `interface WebSocketLike { send(d: string | Uint8Array): void; close(code?: number, reason?: string): void; onopen?: () => void; onmessage?: (d: string | Uint8Array) => void; onclose?: (code: number, reason: string) => void; onerror?: (e: Error) => void; readonly readyState: number }`
- `interface ProviderContext { fetch: typeof fetch; openWebSocket(url: string, opts?: { headers?: Record<string,string>; protocols?: string[] }): WebSocketLike; log: Logger; now(): number }`
- `interface AsrSession { push(pcm: Int16Array): void; end(): Promise<void>; close(): void; on: Emitter<AsrEvents>['on'] }`, `AsrEvents = { partial: { text: string }; final: { text: string; start?: number; end?: number }; error: { error: Error; fatal: boolean }; closed: {} }`
- `interface StreamingAsr { id: string; start(o: { lang: LangCode; hotwords: string[]; sampleRate: 16000 }): Promise<AsrSession> }`
- `interface Translator { id: string; translate(r: { text: string; from: LangCode; to: LangCode; hits: GlossaryHit[]; context: { src: string; dst: string }[]; signal?: AbortSignal }): Promise<string> }`
- `interface Tts { id: string; synthesize(r: { text: string; lang: LangCode; voice?: string; rate: number; signal?: AbortSignal }): AsyncIterable<{ samples: Int16Array; sampleRate: number }>; voices(lang: LangCode): { id: string; name: string }[] }`
- `interface Llm { id: string; complete(r: { system: string; user: string; json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string> }`
- `AppSettings` zod schema (languages, per-direction `{ asr, mt, tts, voice }` provider ids, `llm`, credentials references, devices, ui, recording, glossary ids, shortcuts, room) with `defaultSettings()`; `PRESETS: Record<'free'|'dashscope'|'azure'|'openai'|'demo', Partial<AppSettings>>`; `applyPreset(s, id)`.
- `createProviders(settings: AppSettings, secrets: Secrets, ctx: ProviderContext, extra?: { systemTts?: Tts; localAsr?: StreamingAsr }): { asr(dir): StreamingAsr; mt(dir): Translator; tts(dir): Tts | null; llm(): Llm | null }`
- Mock: `MockAsr` (emits partial/final from a script when pushed audio is loud — uses Segmenter), `MockTranslator` (`[ES] …`/`[中] …`), `MockTts` (sine beeps proportional to text length), `MockLlm` (returns valid summary JSON).

- [ ] Tests: MockAsr emits scripted finals for two 1 s tone bursts; MockTts yields ≥1 chunk with duration ∝ text; `defaultSettings()` parses; every preset applies and parses; unknown provider id → clear error from `createProviders`.
- [ ] Implement, pass, commit `feat: add provider contracts, demo providers and settings presets`.

### Task 7: OpenAI-compatible LLM and LLM translator

**Files:** Create `src/core/providers/openai-compatible.ts`, `src/core/providers/llm-translator.ts`; Test `tests/core/llm.test.ts`

**Interfaces (Produces):** `class OpenAiCompatibleLlm implements Llm` (`{ baseUrl, apiKey, model, extraBody? }`, POST `/chat/completions`, `response_format: {type:'json_object'}` when `json`, retries 2× on 429/5xx with backoff, 20 s timeout, error messages in Chinese with status); `class LlmTranslator implements Translator` (prompt: interpreter persona, "output only the translation… never answer questions", glossary hits as `source → target` lines, last 3 context pairs; result through `cleanTranslation`); `LLM_PRESETS` (智谱 GLM 免费, DeepSeek, 通义千问(DashScope 兼容模式), Kimi, 豆包(方舟), OpenAI, OpenRouter, Ollama 本机, 自定义) with base URLs and default models.

- [ ] Tests (fake fetch): request body contains model/messages/glossary lines; 429 then 200 retries once; 401 → error text contains `401` and `Key`; translator strips `"…"`/`译文：`.
- [ ] Implement, pass, commit `feat: add openai-compatible llm and llm translator`.

### Task 8: Direction pipeline and playout control

**Files:** Create `src/core/pipeline/pipeline.ts`, `src/core/pipeline/rate.ts`; Test `tests/core/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 types, Task 4 `findHits/correctText/hotwordsFor`, Task 5 `Committer/isValidTranslation`, Task 6 provider interfaces.
- Produces: `class DirectionPipeline extends Emitter<{ partial: { dir; text }; segment: TranscriptSegment; audio: { segmentId: string; samples: Int16Array; sampleRate: number }; audioEnd: { segmentId: string }; status: { dir; state: 'idle'|'connecting'|'listening'|'reconnecting'|'error'; message?: string } }>` with `constructor(o: { dir: Direction | 'room'; speaker: string; srcLang; dstLang; asr; translator; tts: Tts | null; voice?: string; glossary: () => GlossaryEntry[]; pinyinFuzzy: boolean; lowLatency: boolean; clock: () => number /* seconds since meeting start */ })`, `start()`, `push(pcm: Int16Array)`, `setGate(open: boolean)` (mute / push-to-talk), `setBacklog(seconds: number)`, `skipToLatest()`, `stop(): Promise<void>`.
- `rateForBacklog(seconds: number): number` → 1.0 at ≤ 3 s, linear to 1.35 at ≥ 12 s.

Behaviour: commit units → correct → translate (ordered: translations may finish out of order but `segment`/`audio` emit in commit order) → validate → TTS stream → `audio` chunks; translation failure → segment `failed`, no audio; ASR `closed`/fatal error while running → reconnect with backoff 1 s, 2 s, 4 s … max 30 s, status `reconnecting`; gate closed → PCM dropped and on close a final flush.

- [ ] Tests: two finals translate and emit in order even when the first translation is slower; invalid translation → `failed` and no `audio`; ASR closes unexpectedly → new session started and later segments still arrive; `rateForBacklog(15) === 1.35`; `skipToLatest()` marks queued segments `skipped` and emits no further audio for them; gate closed drops audio.
- [ ] Implement, pass, commit `feat: add direction pipeline with ordering, reconnect and rate control`.

### Task 9: Transcript store and exports

**Files:** Create `src/core/session/transcript.ts`, `src/core/session/exports.ts`; Test `tests/core/transcript.test.ts`

**Interfaces (Produces):** `class Transcript { constructor(sink?: (line: string) => void); upsert(s: TranscriptSegment): void; list(): TranscriptSegment[]; static fromJsonl(text: string): Transcript }` (sink receives one JSONL line per finished/changed segment — appended to `transcript.jsonl`); `toMarkdown(segs, meta: MeetingMeta, uiLang: 'zh'|'es'): string`; `toSrt(segs, mode: 'src'|'dst'|'bilingual', offsetSec = 0): string`; `toVtt(...)`; `formatClock(sec): string` (`mm:ss` or `h:mm:ss`). `MeetingMeta { id; title; startedAt: string; endedAt?: string; selfLang; remoteLang; platform?: string; mode: 'meeting'|'room'; files: Record<string,string> }`.

- [ ] Tests: sink called per upsert with valid JSON; `fromJsonl` keeps the last version of each id; SRT timestamps `00:01:02,500`, bilingual has two lines; markdown groups by speaker with clock; segments with `dstText:null` show original only.
- [ ] Implement, pass, commit `feat: add transcript store and markdown/srt/vtt exports`.

### Task 10: Summaries (prompt, map-reduce, parsing, markdown)

**Files:** Create `src/core/session/summary.ts`; Test `tests/core/summary.test.ts`

**Interfaces (Produces):** `MeetingSummarySchema` (zod): `{ title: {zh, es}, summary: {zh, es}, topics: [{ start: number, title: {zh, es}, summary: {zh, es}, points: [{ text: {zh, es}, evidence: string[] }] }], decisions: [{ text: {zh, es}, evidence: string[] }], todos: [{ text: {zh, es}, owner: string|null, due: string|null, evidence: string[] }], terms: [{ zh: string, es: string, note: string }] }`; `type SummaryTemplate = 'general'|'business'|'project'`; `buildSummaryPrompt(segs, meta, glossary, template, part?: {index, of}): { system: string; user: string }` (lines as `[L12 03:15 我方/对方/名字] 原文 ‖ 译文`, evidence ids `L<n>`); `summarize(llm, segs, meta, glossary, template, opts?: { maxCharsPerPart?: number /*24000*/ }): Promise<MeetingSummary>` (single pass, or per-part + merge pass); `parseSummary(raw: string): MeetingSummary` (tolerates ```json fences / leading text; fills missing arrays); `summaryToMarkdown(sum, lang: 'zh'|'es'): string`.

- [ ] Tests: prompt contains glossary terms and `L1`; long transcript (> maxChars) causes N part calls + 1 merge call on a fake LLM; fenced JSON parses; missing `todos` becomes `[]`; markdown zh has `## 待办` and es has `## Tareas`.
- [ ] Implement, pass, commit `feat: add bilingual meeting summaries`.

### Task 11: Alibaba Cloud Bailian (DashScope) providers

**Files:** Create `src/core/providers/dashscope/asr.ts`, `tts.ts`, `mt.ts`, `vocabulary.ts`, `common.ts`; Test `tests/core/dashscope.test.ts`

**Interfaces (Produces):** `DashscopeAsr implements StreamingAsr`, `DashscopeTts implements Tts`, `QwenMtTranslator implements Translator` (OpenAI-compatible endpoint with `translation_options: { source_lang, target_lang, terms }`), `ensureVocabulary(ctx, key, region, words): Promise<string | null>` (cached by hash), region `'cn' | 'intl'` → base hosts. Exact models, URLs, events and fields: spec §14 (research notes).

- [ ] Tests with a fake `openWebSocket`: run-task / continue-task JSON shape; binary audio forwarded; `result-generated` with partial vs sentence-end mapped to `partial`/`final`; `task-failed` → fatal error with message; TTS deltas decoded to Int16; qwen-mt request contains `terms`.
- [ ] Implement, pass, commit `feat: add alibaba bailian asr, tts and qwen-mt providers`.

### Task 12: Azure, OpenAI and DeepL providers

**Files:** Create `src/core/providers/azure/asr.ts`, `src/core/providers/azure/tts.ts`, `src/core/providers/openai/asr.ts`, `src/core/providers/openai/tts.ts`, `src/core/providers/deepl.ts`; Test `tests/core/azure.test.ts`, `tests/core/openai.test.ts`, `tests/core/deepl.test.ts`

**Interfaces (Produces):** `AzureAsr` (Speech SDK push stream + PhraseListGrammar; `cloud: 'global'|'china'` host mapping), `AzureTts` (REST `cognitiveservices/v1` SSML with prosody rate → raw 24 kHz PCM), `OpenAiRealtimeAsr` (transcription session over WebSocket), `OpenAiTts` (`/audio/speech` pcm 24 kHz), `DeeplTranslator` (glossary sync). Details: spec §14.

- [ ] Tests: Azure SSML escapes `&<>` and sets `<prosody rate="+20%">` for rate 1.2; Azure China host chosen for `cloud:'china'`; OpenAI session.update body shape; delta/completed events mapped; DeepL request includes `glossary_id` when hits exist.
- [ ] Implement, pass, commit `feat: add azure, openai and deepl providers`.

### Task 13: Free providers — system TTS and local offline ASR

**Files:** Create `src/main/providers/system-tts.ts`, `src/main/providers/local-asr/model-manager.ts`, `src/main/providers/local-asr/worker.ts` (utilityProcess entry), `src/main/providers/local-asr/client.ts`; Test `tests/main/system-tts.test.ts`, `tests/main/model-manager.test.ts`, `tests/main/local-asr.int.test.ts` (skipped unless `MI_MODELS_DIR` has models)

**Interfaces (Produces):** `SystemTts implements Tts` (macOS `say -v <voice> -r <wpm> --data-format=LEI16@22050 -o file.wav`; Windows PowerShell `System.Speech` to WAV; Linux `espeak-ng -w`); `listSystemVoices(): Promise<{ id; name; lang }[]>`; `ModelManager { status(id); download(id, onProgress); path(id) }` with models `silero-vad`, `sensevoice-zh` (zh), `whisper-small` / `whisper-base` (es) from Hugging Face with `hf-mirror.com` fallback; `LocalAsr implements StreamingAsr` (segments with Silero VAD in the worker, finals only).

- [ ] Tests: command lines per platform (voice, rate mapping 1.0→175 wpm on mac), WAV output decoded; manifest URLs; integration test transcribes `tests/fixtures/zh-hello.wav` to text containing `你好`.
- [ ] Implement, pass, commit `feat: add free system tts and offline local asr`.

### Task 14: Main-process stores and session manager

**Files:** Create `src/shared/ipc.ts`, `src/main/stores/settings-store.ts`, `secret-store.ts`, `glossary-store.ts`, `meetings-store.ts`, `src/main/session/wav-writer.ts`, `src/main/session/session-manager.ts`, `src/main/platform/node-context.ts`; Test `tests/main/stores.test.ts`, `tests/main/wav-writer.test.ts`, `tests/main/session-manager.test.ts`

**Interfaces (Produces):**
- `src/shared/ipc.ts`: channel name constants and payload types for `settings:get|set`, `secrets:set|has`, `glossary:list|save|import|export`, `meeting:start|stop|state|list|get|summarize|export|openFolder`, `devices:*`, `room:*`, events `ev:segment`, `ev:partial`, `ev:status`, `ev:levels`, `ev:meeting`.
- `WavFileWriter { constructor(path, sampleRate); write(samples: Int16Array): void; close(): Promise<void> }` (rewrites header sizes every flush).
- `SessionManager extends Emitter<…> { start(opts: { title?: string; platform?: string; record: { audio: boolean; screen: boolean } }): Promise<MeetingMeta>; pushPcm(dir: Direction, pcm: Int16Array): void; setBacklog(dir, s); setGate(dir, open); stop(): Promise<MeetingMeta>; summarize(id, template): Promise<MeetingSummary>; appendRecordingChunk(kind: 'mix'|'screen', bytes: Uint8Array, mime: string): void }` — creates folder, `meeting.json`, `transcript.jsonl`, `audio/mic.wav`, `audio/meeting.wav`, runs both pipelines, writes exports on stop.
- `createNodeContext(log): ProviderContext` (global fetch + `ws` with headers).

- [ ] Tests: settings persisted and validated (bad JSON → defaults + backup file); secrets never written in plaintext (fake safeStorage); session with demo providers on a temp dir produces `meeting.json`, `transcript.jsonl` with both directions, valid `mic.wav`, `transcript.md`, `.srt` after stop; WavFileWriter header valid after each write.
- [ ] Implement, pass, commit `feat: add main-process stores and meeting session manager`.

### Task 15: Audio window (capture, routing, playback, recording)

**Files:** Create `src/renderer/audio.html`, `src/renderer/src/audio/engine.ts`, `src/renderer/src/audio/pcm-worklet.ts`, `src/renderer/src/audio/devices.ts`, `src/renderer/src/audio/recorder.ts`, `src/renderer/src/audio/main.ts`, `src/preload/audio.ts`, `src/main/audio-bridge.ts`; Test `tests/renderer/devices.test.ts`

**Interfaces (Produces):** `matchVirtualDevices(devices: MediaDeviceInfo[]): { virtualMicOut?: string; meetingIn?: string; hint?: { os; driver: 'blackhole'|'vb-cable'|'pulse'; url: string } }`; `AudioEngine { start(cfg: AudioConfig); stop(); playTts(dir, segmentId, samples, rate); levels(): {micDb, meetingDb}; startRecording(opts: { screenSourceId?: string }); stopRecording() }`. Routing per spec §6: one AudioContext, `MediaStreamAudioDestinationNode` → `<audio>` with `setSinkId` for virtual mic and headphones; ducking original to `duckLevel` (default 0.25) while incoming TTS plays; 20 ms worklet frames batched to 100 ms → MessagePort; backlog reported every 250 ms; MediaRecorder timeslice 1000 ms (`video/mp4` if supported else `video/webm;codecs=vp9,opus`; audio-only `audio/webm;codecs=opus`).

- [ ] Tests: device matcher for VB-CABLE/BlackHole/Linux labels; hint when absent (Review Focus 4).
- [ ] Implement; manual check in e2e (Task 19). Commit `feat: add audio window with capture, routing and recording`.

### Task 16: Main UI

**Files:** Create `src/renderer/src/App.tsx`, `src/renderer/src/i18n.ts`, `src/renderer/src/api.ts`, `src/renderer/src/styles.css`, pages `Meeting.tsx`, `Setup.tsx` (devices + platform guides), `Providers.tsx`, `Glossary.tsx`, `History.tsx`, `MeetingDetail.tsx`, `Room.tsx`, `Settings.tsx`, `Onboarding.tsx`, components `Level.tsx`, `SegmentList.tsx`, `ProviderTest.tsx`; content `src/renderer/src/content/platforms.ts` (Teams, 飞书, 腾讯会议, Zoom, 钉钉, 企业微信, Google Meet/Webex — steps in Chinese)

- [ ] Implement pages wired to `window.api`; onboarding picks preset (default 免费); provider test button calls `providers:test` (TTS → ASR → MT round trip) and shows per-step result.
- [ ] Typecheck + build pass; screenshot check via e2e. Commit `feat: add main window ui`.

### Task 17: Overlay, tray, shortcuts

**Files:** Create `src/renderer/overlay.html`, `src/renderer/src/overlay/main.tsx`, `src/main/windows.ts`, `src/main/tray.ts`, `src/main/shortcuts.ts`

- [ ] Overlay: transparent, frameless, always-on-top, `setContentProtection(true)` unless disabled, click-through toggle, last 2 lines per direction. Tray menu: 开始/结束会议, 出/入方向开关, 显示字幕, 打开主窗口, 退出. Shortcuts per spec §11, configurable.
- [ ] Commit `feat: add subtitle overlay, tray and global shortcuts`.

### Task 18: On-site room (desktop host + phone web client)

**Files:** Create `src/core/room/protocol.ts`, `src/main/room/room-server.ts`, `src/main/room/cert.ts`, `src/main/room/tunnel.ts`, `src/renderer/room.html`, `src/renderer/src/room/main.tsx`, `src/renderer/src/room/RoomClient.tsx`; Test `tests/core/room-protocol.test.ts`, `tests/main/room-server.test.ts`

**Interfaces (Produces):**
- Protocol: client→server JSON `{t:'join', name, lang}`, `{t:'talk', on: boolean}`, binary audio frames `[0x01][Int16 PCM 16 kHz]`; server→client JSON `{t:'welcome', id, room}`, `{t:'peers', peers}`, `{t:'partial', from, text}`, `{t:'segment', seg}`, binary TTS frames `[0x02][u32 segIdLen][segId][u32 rate][Int16 PCM]`, `{t:'audioEnd', segmentId}`; `encodeAudioFrame`, `decodeFrame`.
- `RoomServer { start(o: { port?: number /*47800*/ }): Promise<{ urls: string[]; token: string }>; stop(); participants(); on('segment'|'peers', …) }` — HTTPS (self-signed cert with LAN IP SANs, cached in userData) + `ws`, serves `out/renderer/room.html` and assets, one `DirectionPipeline` per speaking participant (src = their lang, dst = other), TTS broadcast to participants whose language is dst; room token in URL required to join.
- `TunnelManager { start(localUrl): Promise<string /* https://….trycloudflare.com */>; stop() }` (downloads `cloudflared` on demand, verifies size, parses URL from stderr).

- [ ] Tests: frame encode/decode round trip; server with demo providers: two ws clients (zh, es) join, zh client sends tone frames while talk on → es client receives a `segment` and TTS binary frames, zh client receives `segment` without TTS; join without token rejected.
- [ ] Implement web client (join screen: name + 中文/Español; big hold-to-talk button + "持续" toggle; subtitles in own language with original small; plays TTS via Web Audio; wake lock; reconnect). Commit `feat: add on-site interpretation rooms for phones`.

### Task 19: End-to-end tests

**Files:** Create `playwright.config.ts`, `e2e/app.spec.ts`, `e2e/room.spec.ts`, `tests/fixtures/*.wav` (generated by `scripts/make-fixtures.ts`)

- [ ] `app.spec.ts`: launch Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<tone wav>`, demo preset, start meeting, expect ≥1 segment row for 我方 within 15 s, stop, expect `transcript.md` in the meeting folder; screenshot main window.
- [ ] `room.spec.ts`: start room via IPC, open `room.html` URL in two Chromium pages (ignoreHTTPSErrors, fake mic), join as 中文 and Español, hold talk on one, expect subtitle on the other.
- [ ] Run `xvfb-run -a npm run test:e2e` → pass. Commit `test: add electron and room end-to-end tests`.

### Task 20: CLI

**Files:** Create `src/cli/index.ts`

- [ ] Commands: `translate-file <in.wav> --from zh-CN --to es-ES --preset <id> --out out.wav --transcript t.md` (runs one DirectionPipeline on file audio in real time ×N speed) and `check --preset <id>` (provider round trip). Keys from env (`DASHSCOPE_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `OPENAI_API_KEY`, `LLM_API_KEY`, `DEEPL_API_KEY`).
- [ ] `npm run cli -- translate-file tests/fixtures/tones.wav --preset demo --out /tmp/x.wav` exits 0. Commit `feat: add command-line tool for file interpretation and provider checks`.

### Task 21: Packaging and GitHub Releases

**Files:** Create `electron-builder.yml`, `build/icon.png` (+ generated `.icns`/`.ico`), `build/entitlements.mac.plist`, `.github/workflows/release.yml`, `scripts/make-icons.ts`

- [ ] mac: `dmg` + `zip` for `arm64` and `x64`, `identity: '-'` ad-hoc, `extendInfo` `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `NSAudioCaptureUsageDescription`; win: `nsis` x64 (per-user, no admin); linux: `AppImage`. `asarUnpack` sherpa native files. Release workflow on tag `v*`: build matrix (macos-latest arm64, macos-15-intel x64, windows-latest, ubuntu-latest) → upload artifacts → create GitHub Release with all files + `checksums.txt`.
- [ ] `npm run dist -- --linux AppImage` works locally; push tag `v0.1.0`; verify release assets via GitHub API. Commit `build: package installers and publish releases`.

### Task 22: Documentation

**Files:** Modify `README.md`; Create `README.en.md`, `docs/guide/install.md`, `docs/guide/virtual-audio.md`, `docs/guide/meeting-apps.md`, `docs/guide/providers.md`, `docs/guide/room.md`, `docs/guide/glossary.md`, `docs/guide/faq.md`, `NOTICE`, `CHANGELOG.md`

- [ ] Chinese-first README: what it does, download from Releases, first-open on mac (Privacy & Security → 仍要打开 / `xattr -cr`), 3-minute setup, free preset, rooms, privacy, roadmap, development. Commit `docs: add user guides`.

### Task 23 (stretch): Standalone phone web app

**Files:** Create `src/renderer/src/room/standalone/*`, `.github/workflows/pages.yml`

- [ ] Face-to-face mode on one phone (browser SpeechRecognition where available, speechSynthesis, translation via user-provided OpenAI-compatible key), deployed to GitHub Pages. Commit `feat: add standalone face-to-face web app`.
