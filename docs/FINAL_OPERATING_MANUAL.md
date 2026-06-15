# Personal Brain OS Final Operating Manual

## What This Is

Personal Brain OS is a local-first memory system built from Obsidian, Supabase,
React, and local Node scripts. It turns diary entries, notes, documents, and
attachments into structured brain data: raw entries, nodes, edges, files,
agent memories, reports, timeline, persona profile, evaluations, routine logs,
and backups.

The system is an assistant-facing memory layer. It is not an autonomous agent,
task planner, production backend, or cloud backup service.

## Architecture

- Obsidian Vault: human-readable source notes and generated knowledge files.
- Supabase: structured brain tables with RLS.
- Frontend: React UI for graph, review, chat, timeline, digest, evaluation,
  routine, and backup.
- Local scripts: import, processing, indexing, sync, digest, persona, eval,
  routine, backup, recovery, and final audit.

## Initial Setup

1. Copy `frontend/.env.example` to `frontend/.env`.
2. Copy `frontend/scripts/brain-worker.env.example` to
   `frontend/scripts/brain-worker.env`.
3. Fill Supabase URL, anon key, local service role key, and provider keys only
   in local env files.
4. Apply all Supabase migrations, including Phase 15 routine tables.
5. Start the frontend:

```bash
cd frontend
npm run dev
```

## Daily Writing

Write diary files in:

```text
AhyarBrainVault/00_Diary/YYYY/MM/YYYY-MM-DD.md
```

Use frontmatter with `type: diary` and `processed: false`. Do not delete diary
history. Correct it by adding notes.

## Core Commands

```bash
cd frontend
npm run obsidian:import
npm run attachments:import
npm run brain:worker
npm run brain:index
npm run obsidian:sync
npm run brain:chat -- --question "Apa yang sedang penting?"
npm run brain:digest:today
npm run brain:eval
npm run brain:routine
npm run brain:backup
npm run brain:restore:preview -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss
npm run brain:recovery -- --check
npm run brain:audit
npm run brain:release-check
```

## Frontend Modes

- Graph: inspect brain graph.
- Review: low confidence, duplicates, failed entries, merge/delete with confirm.
- Chat: ask the brain with persona/source grounding.
- Timeline: inspect events and relationships over time.
- Digest: daily/weekly/monthly summaries.
- Evaluation: memory accuracy tests and failed cases.
- Routine: daily orchestration and health check.
- Backup: local backup, manifest, restore preview, recovery check.

## Daily Routine

Run:

```bash
npm run brain:routine
```

Routine imports diary, imports attachments, processes pending entries, reindexes,
refreshes persona, syncs Obsidian, generates digest, runs lightweight eval, and
writes a summary. Status `partial` means one or more warnings need manual review.

## Backup And Restore

Run backup before risky changes:

```bash
npm run brain:backup
```

Default backup exports Supabase JSON, copies the Obsidian vault, writes a
manifest, and excludes actual `.env` secrets.

Preview restore:

```bash
npm run brain:restore:preview -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss
```

Restore requires confirmation:

```bash
npm run brain:restore -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss --confirm
```

Restore MVP is upsert-only. It does not delete existing data and does not
automatically overwrite the active Obsidian vault.

## Recovery

Run:

```bash
npm run brain:recovery -- --check
```

Optional safe frontmatter cleanup:

```bash
npm run brain:recovery -- --check --fix
```

The fix mode only applies high-confidence Obsidian frontmatter repairs and marks
diaries with missing `raw_entry_id` for reimport. It does not delete files or
Supabase rows.

## Reading Warnings

- Low eval score: review failed cases, add more diary samples, rerun eval.
- Routine partial: inspect Routine View warnings and failed step output.
- Low confidence nodes/edges: use Review View.
- Missing raw entry id in diary: reimport that diary after backup.
- Missing `brain_node_id`: inspect knowledge file frontmatter and sync mapping.

## Troubleshooting

- Supabase schema cache warning: apply migration remotely and reload schema
  cache from Supabase dashboard or SQL editor.
- Local endpoint unavailable: run `npm run dev` from `frontend`.
- Service role missing: scripts may fail or be restricted by RLS.
- Bundle secret scan fails: remove secret from `VITE_*` env/source and rebuild.
- Graph chunk warning: Cytoscape is isolated by lazy loading; some graph chunk
  size is expected.

## Hard Boundaries

Do not store service role keys in frontend source. Do not run destructive restore
without a fresh backup. Do not manually edit generated files inside auto markers.
Do not use this system as a production backend, autonomous agent, task planner,
or cloud backup replacement.

## Step 18: Identity Fidelity Engine

Identity Fidelity Engine mengubah arah Personal Brain OS menuju Personal Entity
OS dengan model identitas yang evidence-bound. Tujuannya fidelity: agent tidak
boleh menjadi lebih ideal dari pemilik diary, tidak boleh lebih buruk, dan tidak
boleh mengisi celah data dengan opini AI.

Apply migration:

```bash
supabase db push
```

Migration:

```text
supabase/migrations/20260612190000_create_identity_fidelity.sql
```

Table utama:

- `identity_facts`: klaim identitas granular dengan `evidence_refs`,
  `confidence_score`, `stability`, `strength`, `usage_scope`, dan `status`.
- `identity_snapshots`: snapshot identity model berisi summary, data coverage,
  confidence summary, warnings, dan source refs.

Build dan audit dari folder `frontend`:

```bash
npm run identity:build
npm run identity:build -- --limit 100
npm run identity:build -- --from 2026-06-01 --to 2026-06-12
npm run identity:refresh
npm run identity:snapshot
npm run identity:audit
```

Extraction membaca `raw_entries`, `agent_memories`, `brain_nodes`,
`brain_reports`, `identity_facts` existing, dan `identity_snapshots` existing.
Prioritas evidence: diary asli, memory confidence tinggi, node approved/high
confidence, digest/report, lalu Persona Profile hanya sebagai konteks tambahan.

LLM provider tidak di-hardcode. Env `IDENTITY_*` bisa fallback ke
`BRAIN_CHAT_*`, `BRAIN_DIGEST_*`, atau `LLM_*`. Jika LLM dimatikan/gagal,
script memakai deterministic fallback dari memory, node, dan report dengan
confidence lebih konservatif dan metadata `generated_by:
deterministic_fallback`.

Confidence policy:

- `>= 0.85`: kandidat core/high confidence, tetapi tetap harus punya evidence.
- `>= 0.65`: cukup kuat untuk klaim praktis di chat jika relevan.
- `< 0.65`: hanya boleh disebut sebagai kemungkinan/sinyal awal.
- Fact tanpa evidence tidak boleh disimpan sebagai klaim valid.

Brain Chat membaca `identity_facts` dan snapshot terbaru. Untuk pertanyaan
personal, strategi diri, gaya komunikasi, self-clone, atau greeting seperti
`hi`, identity facts diprioritaskan di atas Persona Profile lama. Greeting tidak
menarik diary panjang; ia memakai `communication_pattern` jika confidence cukup,
atau menjawab pendek netral jika data gaya sapaan belum cukup.

Output Obsidian:

```text
AhyarBrainVault/_system/identity/Identity Fidelity Model.md
AhyarBrainVault/_system/identity/Identity Snapshot Latest.md
```

Bagian generated dijaga marker:

```text
<!-- IDENTITY_FIDELITY_AUTO_START -->
<!-- IDENTITY_FIDELITY_AUTO_END -->
```

Audit mengecek jumlah facts, core/stable facts, facts tanpa evidence,
high-confidence facts dengan evidence sedikit, contradiction aktif,
communication pattern count, warning low confidence, dan freshness snapshot.
Status audit: `healthy`, `warning`, atau `critical`.

Security dan boundary:

- Tidak ada node/edge yang diubah oleh Identity Fidelity Engine.
- Tidak ada agent action otomatis, task planner, fine-tuning, atau voice clone.
- Endpoint `/__identity-fidelity/build` hanya local dev dan hanya menerima
  `limit`, `snapshot`, dan `force`.
- Service role key dan API key tidak boleh masuk browser bundle.
- Agent bukan manusia asli dan bukan kesadaran; ia hanya model berbasis data.

Step berikutnya: Communication Style Model, Response Inference Engine, Owner
Answer Calibration, Similarity Evaluation Loop, dan Drift Control.

## Step 19: Communication Style Model

Communication Style Model membuat layer gaya bahasa yang evidence-bound. Ia
berbeda dari Identity Fidelity Engine:

- `identity_facts`: menyimpan trait, value, belief, preference, goal, dan pola
  diri.
- `communication_patterns`: menyimpan cara menjawab untuk intent tertentu:
  greeting, request prompt, teknis, koreksi, strategi, refleksi, dan santai.

Apply migration:

```bash
supabase db push
```

Migration:

```text
supabase/migrations/20260612200000_create_communication_style.sql
```

Table utama:

- `communication_samples`: contoh kalimat/instruksi/reply/refleksi yang
  diklasifikasi dengan tone, formality, length class, intent, dan confidence.
- `communication_patterns`: pola gaya komunikasi dengan examples,
  anti-examples, preferred response shape, trigger intents, evidence refs, dan
  usage rules.

Build dan audit dari folder `frontend`:

```bash
npm run communication:build
npm run communication:build -- --limit 100
npm run communication:samples
npm run communication:patterns
npm run communication:audit
```

Sumber data: `raw_entries`, `agent_memories`, `identity_facts` bertipe
`communication_pattern`, `identity_snapshots`, `brain_reports`, existing
samples/patterns, dan Persona Profile sebagai konteks tambahan. Script tidak
mengubah node/edge.

Jika LLM tersedia, extractor memakai prompt Communication Style Extractor dan
meminta JSON valid. Jika LLM disabled/gagal, deterministic fallback mendeteksi:

- `buatkan prompt` sebagai `request_prompt`;
- `lanjut`, `oke`, `next` sebagai `follow_up`;
- `revisi`, `kurang`, `ubah`, `jangan` sebagai `correction`;
- file/command/migration/endpoint sebagai `technical_instruction`;
- `hi`, `halo`, `p`, `bro`, `assalamu’alaikum` sebagai `greeting`.

Output Obsidian:

```text
AhyarBrainVault/_system/communication/Communication Style Model.md
AhyarBrainVault/_system/communication/Communication Samples.md
```

Brain Chat memakai `communication_context` untuk menentukan:

- `communication_intent`;
- `communication_pattern_ids`;
- `response_shape`;
- apakah sources/debug ditampilkan default.

Greeting tetap short-circuit: satu kalimat, tanpa sources, tanpa missing
context, dan debug tersembunyi. Prompt request memakai `prompt_request_style`
agar langsung menghasilkan prompt siap paste. Prompt teknis memakai
`technical_style` untuk step-by-step dan command/file jika relevan. Koreksi
memakai `correction_style` agar langsung revisi dan tidak defensif.

Endpoint lokal:

```text
POST /__communication-style/build
```

Input dibatasi ke `limit <= 500` dan `force` boolean. Tidak menerima path atau
command arbitrary. API key tidak boleh masuk browser bundle.

Routine harian sekarang menjalankan:

```text
brain:persona
identity:build
communication:build
obsidian:sync
```

Batasan Step 19: belum ada Response Inference Engine, owner answer calibration,
similarity evaluation loop, fine-tuning, voice clone, atau autonomous action.
Step 20 adalah Response Inference Engine.

## Step 20: Response Inference Engine

Response Inference Engine menjadi lapisan utama Brain Chat. Retrieval answer
menjawab "apa data yang relevan dari brain"; inferred owner response menjawab
"kalau pemilik diary menerima prompt ini, kemungkinan besar dia akan menjawab
apa". Prinsipnya fidelity-first, bukan intelligence-first.

Apply migration:

```bash
supabase db push
```

Migration:

```text
supabase/migrations/20260613090000_create_response_inference.sql
```

Table utama:

- `response_inference_logs`: menyimpan question, normalized question, intent,
  inference mode, response shape, identity fact ids, communication pattern ids,
  memory refs, retrieval summary, trace, answer, confidence/fidelity/
  groundedness/style score, overclaim risk, underfit risk, warnings, dan
  missing context.
- `response_inference_rules`: rule deterministik per intent, termasuk trigger
  patterns, required context, response shape, priority, dan enabled flag.

Command dari folder `frontend`:

```bash
npm run response:rules
npm run response:infer -- --question "hi"
npm run response:infer -- --question "buatkan saya prompt untuk step berikutnya"
npm run response:audit
```

Intent detection deterministic:

- `social_greeting`: `hi`, `halo`, `hai`, `p`, `bro`, `assalamu’alaikum`,
  `selamat pagi`, `selamat malam`, `ping`.
- `request_prompt`: `buatkan prompt`, `prompt untuk`, `siap paste`,
  `buat prompt`, `revisi prompt`.
- `technical_instruction`: `cara`, `error`, `command`, `file`,
  `implementasi`, `bug`, `script`, `kode`, `migration`, `supabase`,
  `frontend`, `backend`.
- `strategy_question`: `menurutmu`, `fokus apa`, `langkah terbaik`,
  `lanjut apa`, `stop atau lanjut`, `prioritas`, `strategi`.
- `correction`, `identity_question`, `contradiction_check`, dan `unknown`.

Response shape mengatur output sebelum jawaban dibuat:

- Greeting: maksimal satu kalimat, plain text, tanpa sources, basis, missing
  context, next actions, atau debug default.
- Request prompt: `writing_block`, prompt siap paste, step-by-step, acceptance
  criteria, dan asumsi eksplisit jika konteks kurang.
- Strategy: structured answer, tajam, prioritas 1-3 hal, boleh menampilkan
  basis/sources karena memakai identity facts.
- Identity: pisahkan high confidence, medium confidence, dan belum cukup data.

Pemakaian identity facts:

- Strategy memakai goals, risk patterns, decision patterns, contradictions,
  ambition, dan values.
- Identity question memakai facts dan snapshot terbaru.
- Contradiction check memakai contradiction, risk pattern, dan decision pattern.
- Fact confidence rendah tidak boleh dijadikan klaim tegas.

Pemakaian communication patterns:

- Greeting style menentukan sapaan pendek bila tersedia.
- Prompt request style menentukan format siap paste.
- Technical style menjaga jawaban step-by-step dan minim teori.
- Correction style menjaga respons langsung revisi dan tidak defensif.

Social greeting diproses khusus: tidak menjalankan retrieval berat, tidak
menyebut diary/identity facts/sources/context, dan fallback aman adalah
`Halo, kenapa?`, `Iya, kenapa?`, `Wa’alaikumussalam, ada apa?`, atau
`Iya bro, kenapa?`.

Brain Chat flow:

```text
User question
Response Inference Engine
Intent detection
Response shape selection
Identity + communication selection
Memory retrieval only if needed
Answer generation
Post-processing fidelity guard
Response JSON
```

Endpoint lokal dev:

```text
POST /__response-inference/test
```

Input hanya:

```json
{ "question": "hi" }
```

`question` maksimal 2000 karakter dan endpoint menolak pola path/command
sederhana. Output ringkas: intent, response shape, answer, dan scores.

Overclaim dan underfit dicegah lewat post-processing:

- Klaim identitas tanpa evidence diturunkan confidence atau diganti menjadi
  "data belum cukup".
- Overclaim risk tinggi membuat jawaban tidak tampil sebagai fakta keras.
- Underfit risk tinggi menandai jawaban yang masih terlalu assistant-like.
- Untuk prompt ringan, jawaban otomatis diringkas.

Output Obsidian opsional:

```text
AhyarBrainVault/_system/response-inference/Response Inference Report.md
```

Aktifkan dengan:

```env
RESPONSE_INFERENCE_OUTPUT_OBSIDIAN=true
```

Boundary:

- Engine read-only terhadap brain utama: tidak mengubah node, edge, raw entry,
  atau agent memory.
- Tidak ada agent action otomatis, task planner, fine-tuning, voice/audio clone,
  atau production backend.
- API key dan service role key tetap hanya di local env, tidak di bundle.

Step 24: approval workflow untuk hints/rules, trend dashboard, dan release gate sebelum perubahan besar dipakai Brain Chat.

## Step 21: Owner Answer Calibration

Owner Answer Calibration membuat dataset ground truth: prompt dan jawaban asli
pemilik diary. Ini diperlukan karena agent bisa benar secara fakta tetapi tetap
tidak mirip pemilik diary. Ground truth utama bukan jawaban AI terbaik, tetapi
jawaban asli pemilik diary untuk prompt yang sama.

Apply migration:

```bash
supabase db push
```

Migration:

```text
supabase/migrations/20260613110000_create_owner_answer_calibration.sql
```

Table utama:

- `owner_answer_examples`: prompt, normalized prompt, owner answer, intent,
  answer style, tone, formality, length class, source, quality score, status.
- `owner_calibration_runs`: status dan aggregate score satu proses calibration.
- `owner_calibration_results`: perbandingan owner answer vs agent answer,
  termasuk similarity/style/intent/length/tone/fidelity, too AI, overclaim,
  underfit, missing/extra elements, dan hints.
- `owner_calibration_hints`: hint yang dipakai Response Inference Engine tanpa
  mengubah identity facts atau communication patterns.

Command dari folder `frontend`:

```bash
npm run owner:examples
npm run owner:examples -- --seed
npm run owner:calibrate
npm run owner:calibrate -- --limit 25
npm run owner:calibrate -- --intent social_greeting
npm run owner:calibrate:latest
npm run owner:hints
npm run owner:audit
```

Cara menambah examples:

- Dari UI: buka tab `Calibration`, isi prompt, owner answer, intent type,
  answer style, context note, lalu klik `Add Example`.
- Dari seed: `npm run owner:examples -- --seed`.
- Seed hanya contoh awal konservatif. User tetap harus mengedit/mengganti jika
  tidak sesuai jawaban asli.

Calibration run:

1. Membaca `owner_answer_examples` active.
2. Memanggil Response Inference Engine dengan prompt yang sama.
3. Menyimpan agent answer dan actual intent.
4. Menghitung deterministic scores.
5. Jika `OWNER_CALIBRATION_USE_LLM_JUDGE=true`, memakai LLM judge tambahan.
6. Menyimpan `owner_calibration_results`.
7. Membuat/upsert `owner_calibration_hints` jika result gagal atau berisiko.
8. Menulis report Obsidian jika `OWNER_CALIBRATION_OUTPUT_OBSIDIAN=true`.

Deterministic scoring:

- `similarity_score`: token overlap, normalized text similarity, shared key
  phrases, dan penalty jika agent terlalu panjang/pendek.
- `style_match_score`: panjang, tone, format, dan apakah terlalu AI.
- `intent_match_score`: expected intent vs actual intent.
- `length_match_score`: very_short/short/medium/long.
- `tone_match_score`: direct/casual/firm/technical/reflective/neutral/mixed.
- `too_ai_score`: naik untuk frasa `Sebagai AI`, `Berdasarkan data yang
  tersedia`, `Memory yang tersedia`, `Saya dapat membantu`, `Semoga membantu`,
  atau greeting yang terlalu formal.
- `overclaim_risk`: naik jika agent menambah klaim identitas/fakta yang tidak
  ada di owner answer untuk prompt ringan.
- `underfit_risk`: naik jika agent terlalu umum, terlalu assistant-like, atau
  request prompt kurang detail.

Calibration hints:

- `greeting_reply`: preferred response untuk sapaan pendek seperti `hi` atau
  `p`.
- `prompt_structure`: request prompt harus writing block, step-by-step,
  acceptance criteria, dan batasan jelas.
- `avoid_phrase`: frasa assistant umum yang perlu dihindari.
- `length_adjustment`, `tone_adjustment`, `format_adjustment`, dan
  `strategic_response_shape` untuk patch response shape.

Response Inference Engine membaca `owner_calibration_hints` aktif/needs_review.
Hints status `rejected` atau `deprecated` tidak dipakai. Hint confidence tinggi
dapat menjadi rule keras untuk greeting; confidence rendah hanya menjadi signal.
Hint yang dipakai dicatat di `response_inference_logs.metadata.
calibration_hints_used` dan response JSON `owner_calibration_hint_ids`.

Endpoint lokal dev:

```text
POST /__owner-calibration/seed-examples
POST /__owner-calibration/add-example
POST /__owner-calibration/run
GET  /__owner-calibration/latest
```

Endpoint memvalidasi panjang input dan enum intent/style. Tidak menerima SQL,
path, atau command arbitrary. API key dan service role tetap hanya di local env.

Output Obsidian:

```text
AhyarBrainVault/_system/calibration/Owner Answer Calibration Latest.md
AhyarBrainVault/_system/calibration/Owner Answer Examples.md
AhyarBrainVault/_system/calibration/Calibration Hints.md
```

Boundary:

- Bukan fine-tuning.
- Tidak mengubah identity facts otomatis.
- Tidak mengubah communication patterns otomatis.
- Tidak membuat agent action otomatis.
- Tidak menjadi task planner atau production backend.

Step 24: approval workflow untuk hints/rules, trend dashboard, dan release gate sebelum perubahan besar dipakai Brain Chat.

## Step 22: Similarity Evaluation Loop

Similarity Evaluation Loop menjalankan evaluasi berulang untuk mengukur
kemiripan agent dengan pemilik diary dari waktu ke waktu. Owner Answer
Calibration membuat examples dan hints; Similarity Evaluation memastikan hasil
terbaru tidak regression, tidak drift, tidak makin AI-like, dan tidak overclaim
setelah update identity/communication/retrieval.

Apply migration:

```bash
supabase db push
```

Migration:

```text
supabase/migrations/20260613130000_create_similarity_evaluation.sql
```

Table utama:

- `similarity_eval_runs`: satu loop evaluation, run type, baseline reference,
  aggregate scores, regression/improvement count, overall score, dan verdict.
- `similarity_eval_results`: hasil per owner example, termasuk owner answer,
  agent answer, score detail, baseline result, passed/regressed/improved,
  failure reason, missing/extra elements, recommendations, metadata.
- `similarity_baselines`: run yang dianggap cukup baik untuk jadi pembanding.

Command:

```bash
npm run similarity:run
npm run similarity:run -- --limit 50
npm run similarity:run -- --intent social_greeting
npm run similarity:run -- --run-type regression
npm run similarity:baseline -- --create
npm run similarity:baseline -- --create --activate
npm run similarity:baseline -- --list
npm run similarity:compare
npm run similarity:latest
npm run similarity:audit
```

Cara run bekerja:

1. Membaca `owner_answer_examples` active.
2. Menjalankan Response Inference Engine untuk setiap prompt.
3. Mengambil agent answer, actual intent, inference scores, calibration hints,
   identity facts, dan communication patterns yang dipakai.
4. Menghitung deterministic scores yang lebih ketat dari Step 21.
5. Jika `SIMILARITY_EVAL_USE_LLM_JUDGE=true`, menambahkan LLM judge.
6. Membandingkan dengan active baseline jika tersedia.
7. Menandai passed, failed, regressed, atau improved.
8. Menyimpan run/results dan menulis report Obsidian.

Scoring:

- `similarity_score`: token overlap, edit distance, key phrase match, dan
  penalty panjang.
- `fidelity_score`: kemiripan maksud dan gaya terhadap owner answer, dengan
  penalti tambahan fakta/topik yang tidak ada.
- `style_match_score`: casual/formal/direct/reflective/technical, phrase khas,
  format, dan anti assistant phrase.
- `intent_match_score`: expected intent vs actual intent.
- `tone_match_score`: tone owner vs tone agent.
- `length_match_score`: very_short/short/medium/long.
- `too_ai_score`: frasa assistant umum, greeting terlalu formal, atau template
  assistant.
- `overclaim_risk`: agent menambah identitas/fakta/goal/orang/project/konteks
  yang tidak ada pada owner answer.
- `underfit_risk`: jawaban terlalu generik, terlalu netral, atau tidak memakai
  gaya owner.

Pass rule:

```text
similarity_score >= SIMILARITY_EVAL_MIN_PASS_SCORE
fidelity_score >= SIMILARITY_EVAL_MIN_PASS_SCORE
too_ai_score <= SIMILARITY_EVAL_MAX_TOO_AI_SCORE
overclaim_risk <= SIMILARITY_EVAL_MAX_OVERCLAIM_RISK
underfit_risk <= SIMILARITY_EVAL_MAX_UNDERFIT_RISK
```

Verdict:

- `excellent`: overall >= 0.90 dan tidak ada critical regression.
- `good`: overall >= 0.80.
- `warning`: overall >= 0.70 atau ada regression kecil.
- `bad`: overall < 0.70.
- `blocked`: banyak regression atau overclaim tinggi.

Baseline:

```bash
npm run similarity:baseline -- --create --activate
```

Baseline mengambil latest run `done` yang overall-nya cukup. Jika `--activate`
dipakai, baseline active lama diarsipkan dan baseline baru menjadi active.
Regression dihitung per `owner_answer_example_id`: jika fidelity turun lebih
dari `SIMILARITY_EVAL_REGRESSION_THRESHOLD`, result ditandai regressed; jika
naik lebih dari threshold, result ditandai improved.

Endpoint lokal dev:

```text
POST /__similarity-eval/run
POST /__similarity-eval/create-baseline
GET  /__similarity-eval/latest
POST /__similarity-eval/compare
```

Input endpoint dibatasi ke limit maksimal 100, enum intent/run type, boolean
judge/activate, dan optional UUID baseline id. Tidak menerima SQL/path/command
arbitrary.

Output Obsidian:

```text
AhyarBrainVault/_system/similarity/Similarity Evaluation Latest.md
AhyarBrainVault/_system/similarity/Similarity Evaluation YYYY-MM-DD HH-mm.md
AhyarBrainVault/_system/similarity/Similarity Baseline.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_SIMILARITY=false
```

Jika diaktifkan, routine menjalankan:

```text
similarity:run -- --limit 25 --run-type daily
```

Boundary:

- Tidak fine-tuning.
- Tidak auto-edit identity facts.
- Tidak auto-edit communication patterns.
- Tidak auto-edit owner examples.
- Tidak auto-apply hints.
- Tidak agent action otomatis.
- Read-only terhadap core brain; hanya menulis similarity tables dan report.

Step 24: approval workflow untuk hints/rules, trend dashboard, dan release gate agar perubahan identity/communication/retrieval tidak langsung menurunkan self-clone fidelity.

## Step 23: Drift Control / Anti-Overclaim Guard

Drift Control adalah guard layer yang berjalan sebelum jawaban final tampil ke
user. Similarity Evaluation mengukur masalah setelah jawaban dibuat; Drift
Control mencegah jawaban berisiko keluar: overclaim, identity hallucination,
style drift, terlalu AI-like, terlalu formal, source/debug leak, dan penggunaan
identity facts low confidence sebagai klaim kuat.

Migration:

```text
supabase/migrations/20260613150000_create_drift_control.sql
```

Table:

- `drift_guard_rules`: rule anti-overclaim/anti-drift.
- `drift_guard_logs`: skor guard, triggered rules, actions, before/after
  answer, blocked/fallback state.
- `drift_baseline_snapshots`: baseline identity/style/similarity yang dianggap
  valid untuk guard.

Command:

```bash
npm run drift:rules -- --seed
npm run drift:check -- --question "hi" --answer "Halo! Ada yang bisa saya bantu hari ini?"
npm run drift:baseline -- --activate
npm run drift:audit
npm run drift:latest
```

Default rules:

1. `no_ai_assistant_phrases_for_greeting`
2. `no_sources_for_social_greeting`
3. `no_debug_for_social_greeting`
4. `no_identity_overclaim_without_evidence`
5. `low_confidence_identity_must_be_softened`
6. `do_not_make_owner_more_ideal`
7. `do_not_make_owner_worse_without_evidence`
8. `respect_response_shape`
9. `avoid_irrelevant_private_context`
10. `similarity_baseline_regression_warning`

Guard pipeline:

```text
Question
Response Inference Engine
Draft answer
Drift Control / Anti-Overclaim Guard
Rewrite/fallback/block if needed
Final answer to user
Log guard result
```

Risk scores:

- `overclaim_score`
- `style_drift_score`
- `too_ai_score`
- `too_formal_score`
- `unsupported_claim_score`
- `irrelevant_context_score`
- `debug_leak_score`
- `source_leak_score`
- `final_risk_score`

Risk level:

- `0.00-0.25`: safe
- `0.26-0.50`: warning
- `0.51-0.75`: high
- `0.76-1.00`: critical

Rewrite/fallback:

- Medium risk: remove assistant phrases or soften unsupported claims.
- High risk: rewrite or fallback.
- Critical risk: block/fallback if enabled.
- Social greeting fallback: `Iya, ada apa?`, `Halo, kenapa?`, atau
  `Wa’alaikumussalam, ada apa?`.
- Identity question insufficient evidence: `Data belum cukup...`.

Brain Chat response JSON includes `drift_guard` with risk level, final risk,
triggered rules, actions, blocked/fallback flags, and warnings. UI only shows a
small badge for warning/high/critical; full details are in collapsible debug.

Endpoint lokal dev:

```text
POST /__drift-control/seed-rules
POST /__drift-control/check
POST /__drift-control/create-baseline
GET  /__drift-control/latest
```

Output Obsidian:

```text
AhyarBrainVault/_system/drift/Drift Control Latest.md
AhyarBrainVault/_system/drift/Drift Guard Rules.md
AhyarBrainVault/_system/drift/High Risk Drift Logs.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_DRIFT_AUDIT=false
```

Boundary:

- Tidak fine-tuning.
- Tidak auto-edit identity facts.
- Tidak auto-edit communication patterns.
- Tidak auto-edit owner examples.
- Tidak agent action otomatis.
- Tidak menghapus logs otomatis.
- Guard hanya warning, lower confidence/risk, rewrite, fallback, block, dan log.

Step 24 (Self-Reflection Memory Evolution) menambah refleksi berkala di atas
guard ini. Lihat section berikut.

---

## Step 24: Self-Reflection Memory Evolution

Self-Reflection Memory Evolution adalah lapisan refleksi internal yang menjawab
**apa arti data baru terhadap model diri pemilik diary**, secara bertahap,
evidence-bound, dan tidak liar. Posisinya di antara layer lain:

- Identity Fidelity Engine: membuat identity facts dari data.
- Brain Digest: merangkum apa yang terjadi.
- Similarity Evaluation: mengukur kemiripan jawaban vs owner.
- Drift Control: menjaga jawaban tidak melenceng saat itu juga.
- Self-Reflection: menyimpulkan perubahan jangka panjang dengan hati-hati dan
  mengusulkan (bukan menerapkan) evolusi identity.

Migration:

```text
supabase/migrations/20260613160000_create_self_reflection_evolution.sql
```

Table:

- `self_reflection_logs`: refleksi internal per periode (observasi baru, pola
  menguat/melemah, kontradiksi, implikasi identity/komunikasi, risiko fidelity,
  ketidakpastian, evidence_refs, confidence, status).
- `identity_evolution_suggestions`: saran perubahan ke identity_facts /
  communication_patterns / calibration hints — proposal, default status
  `proposed`, tidak pernah auto-apply.
- `entity_evolution_snapshots`: snapshot evolusi entitas (identity/communication/
  reflection/drift/similarity state, open_uncertainties, active_boundaries,
  evolution_score, stability_score, fidelity_risk_score).

Command:

```bash
npm run reflection:run
npm run reflection:run -- --type manual
npm run reflection:run -- --type after_import
npm run reflection:daily
npm run reflection:weekly
npm run reflection:snapshot
npm run reflection:suggestions
npm run reflection:audit
```

Reflection pipeline:

```text
Tentukan periode (daily/weekly/manual/after_*)
Baca data baru periode + state terbaru identity/communication/similarity/drift
Bangun context (prioritas evidence: diary > owner answers > identity > komunikasi > similarity/drift > reports > memories)
LLM reflection (atau deterministic fallback)
Simpan self_reflection_logs
Turunkan identity_evolution_suggestions (proposal)
Tulis report Obsidian
Optional: entity_evolution_snapshot
```

Rules suggestions:

- Default `proposed`; approve/reject/ignore hanya mengubah status, tidak menyentuh
  identity_facts atau communication_patterns.
- `increase_confidence` hanya jika evidence_refs >=
  `SELF_REFLECTION_MIN_EVIDENCE_FOR_SUGGESTION`; kurang → `add_evidence`.
- `mark_core` hanya jika evidence kuat & berulang; `create_new` selalu proposal.
- Kontradiksi butuh evidence jelas. Tidak ada delete. `risk_score > 0.75`
  ditandai high-risk tapi tetap `proposed`.
- `SELF_REFLECTION_AUTO_APPLY=false` default; `--apply-approved` menolak apply
  sampai Step 25.

Endpoint lokal dev:

```text
POST /__self-reflection/run
POST /__self-reflection/snapshot
POST /__self-reflection/update-suggestion
GET  /__self-reflection/latest
```

Brain Chat memakai latest `self_reflection_logs` + `entity_evolution_snapshots`
sebagai konteks pendukung; identity facts tetap sumber utama. Debug Brain Chat
menambah `self_reflection_used`, `reflection_log_id`, `evolution_snapshot_id`,
`reflection_warnings`. Jika reflection menyebut uncertainty/high-risk fidelity,
Brain Chat menurunkan confidence.

Output Obsidian:

```text
AhyarBrainVault/_system/reflections/Self Reflection Latest.md
AhyarBrainVault/_system/reflections/Self Reflection YYYY-MM-DD HH-mm.md
AhyarBrainVault/_system/reflections/Evolution Suggestions.md
AhyarBrainVault/_system/reflections/Entity Evolution Snapshot.md
```

Daily Routine optional (setelah digest/eval/similarity/drift):

```env
BRAIN_ROUTINE_RUN_REFLECTION=false
```

Boundary:

- Tidak fine-tuning, tidak auto-apply, tidak menghapus data.
- Tidak auto-edit identity facts / communication patterns.
- Tidak agent action otomatis, tidak task planner.
- Entitas tidak boleh berkembang di luar evidence owner.

## Step 25 — Chat Sample Importer

Chat Sample Importer memasukkan chat asli owner sebagai evidence gaya komunikasi.
Tujuannya menjawab pertanyaan utama Personal Entity OS: jika owner asli menerima
prompt ini, kemungkinan besar dia menjawab apa? Diary membantu isi pikiran, tapi
chat sample dibutuhkan untuk gaya respons pendek seperti `hi`, `p`, `oke`,
`lanjut`, `wkwk`, koreksi, instruksi teknis, dan pertanyaan strategi.

Migration:

```text
supabase/migrations/20260613170000_create_chat_sample_importer.sql
```

Table:

- `chat_imports`: batch import, source file/hash/format, owner aliases, status,
  counts, metadata.
- `chat_messages`: pesan terstruktur, speaker role, owner flag, intent, tone,
  formality, length.
- `chat_reply_pairs`: pasangan prompt lawan bicara ke jawaban owner.
- `chat_import_reviews`: unknown speaker, duplicate, parse error, sensitive
  content, dan item lain yang perlu review.

Input folder:

```text
AhyarBrainVault/85_Chat_Samples/
```

Format MVP:

- `.txt` / `.md` plain text: `[2026-06-12 21:01] owner: iya, ada apa?`
- WhatsApp-like text: `12/06/26, 21.01 - Ahyar: iya, ada apa?`
- `.json`: array `{ timestamp, speaker, text }`
- `.csv`: header `timestamp,speaker,text`

Command:

```bash
cd frontend
npm run chats:import
npm run chats:import -- --file "../AhyarBrainVault/85_Chat_Samples/sample.txt"
npm run chats:import -- --limit 10
npm run chats:import -- --dry-run
npm run chats:pairs
npm run chats:audit
```

Owner detection:

```env
CHAT_SAMPLE_OWNER_ALIASES=Ahyar,Kukuh,Ahyar Pattani,owner,me,saya
```

Jika speaker cocok alias, message menjadi `speaker_role=owner` dan
`is_owner_message=true`. Jika speaker tidak cocok, role menjadi `other`. Jika
speaker kosong/tidak jelas, role menjadi `unknown` dan masuk review. Pesan
system tidak pernah dianggap owner.

Reply pairs dibuat hanya dari urutan `other -> owner` dalam conversation yang
sama. Pair ini menjadi calibration evidence; prompt adalah pesan lawan bicara,
owner answer adalah pesan owner berikutnya.

Owner answer examples:

- Dibuat dari `chat_reply_pairs` jika `CHAT_SAMPLE_AUTO_CREATE_OWNER_EXAMPLES=true`.
- `source_type=chat_sample`.
- `status=active` jika confidence >= 0.75, selain itu `needs_review`.
- Dedup memakai normalized prompt + owner answer hash.

Communication samples:

- Dibuat hanya dari owner messages.
- `sample_type=chat_message`, `source_type=imported_chat`.
- Membawa intent/tone/formality/length classifier dari importer.
- Tidak mengubah `communication_patterns` langsung; jalankan build terpisah.

Setelah import:

```bash
npm run communication:build
npm run owner:calibrate
npm run similarity:run
```

Endpoint lokal dev:

```text
POST /__chat-samples/import
POST /__chat-samples/audit
POST /__chat-samples/pairs
GET  /__chat-samples/latest
```

Security/privacy:

- Frontend tidak menerima arbitrary path; hanya scan fixed `CHAT_SAMPLE_DIR`.
- Service role tetap hanya di script lokal, tidak masuk bundle browser.
- Tidak upload cloud, tidak fine-tuning, tidak delete otomatis.
- Chat sample adalah evidence gaya, bukan identity fact otomatis.
- Pesan orang lain tidak dipakai sebagai gaya owner.

Output Obsidian:

```text
AhyarBrainVault/_system/chat-samples/Chat Import Latest.md
AhyarBrainVault/_system/chat-samples/Chat Reply Pairs.md
AhyarBrainVault/_system/chat-samples/Chat Import Reviews.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_CHAT_IMPORT=false
```

Default false agar routine tidak berat dan tidak mengimpor chat tanpa keputusan
manual.

## Step 26 — Identity Conflict & Contradiction Resolver

Identity Conflict Resolver mendeteksi dan menyimpan konflik, kontradiksi, dan
tension dalam model identitas owner. Prinsipnya: kontradiksi manusia bukan bug.
Sistem tidak boleh menghapus salah satu sisi, memilih sisi yang “benar” tanpa
evidence kuat, atau membuat owner terlihat terlalu konsisten jika data memang
tidak konsisten.

Migration:

```text
supabase/migrations/20260613180000_create_identity_conflicts.sql
```

Table:

- `identity_conflicts`: conflict utama dengan side A, side B, evidence refs,
  confidence, severity, recurrence, resolution status, impact area, related ids,
  dan chat guidance.
- `identity_conflict_events`: event yang memperkuat, melemahkan, memberi sinyal
  resolusi, contradiction signal, manual review, atau status change.
- `identity_conflict_reviews`: review manual owner, note, decision, status baru,
  dan optional chat guidance update.

Command:

```bash
cd frontend
npm run conflicts:detect
npm run conflicts:detect -- --limit 100
npm run conflicts:detect -- --from 2026-06-01 --to 2026-06-12
npm run conflicts:review
npm run conflicts:audit
npm run conflicts:latest
```

Detection membaca:

- `identity_facts`
- `identity_snapshots`
- `self_reflection_logs`
- `identity_evolution_suggestions`
- `communication_patterns`
- `response_inference_logs`
- `owner_calibration_results`
- `similarity_eval_results`
- `drift_guard_logs`
- `brain_reports`
- `raw_entries`
- existing `identity_conflicts`

Target conflict:

- goal vs behavior: fokus MVP vs tambah fitur/fase;
- belief vs action: local-first vs API eksternal;
- value vs decision: hemat waktu vs sistem paralel;
- communication mismatch: jawaban singkat vs prompt lengkap;
- identity tension: entitas berkembang vs fidelity ketat;
- strategy conflict: cepat selesai vs roadmap melebar;
- risk pattern conflict: sadar scope creep tapi tetap menambah step;
- emotional conflict: ingin yakin tapi sering meminta validasi.

Fallback deterministic:

- Mencari keyword/pola dari identity facts, raw entries, brain reports,
  self-reflection contradictions, dan drift logs.
- Membuat conflict konservatif dengan confidence medium/rendah.
- Menandai `metadata.generated_by=deterministic_fallback`.

Dedup/upsert:

- Dedup berdasarkan `user_id`, normalized title, `conflict_type`, dan
  `impact_area`.
- Jika conflict sudah ada, evidence refs digabung, `last_seen_at` diperbarui,
  severity/recurrence bisa naik.
- Conflict lama tidak dihapus.
- Jika conflict resolved/dismissed muncul evidence baru kuat, status menjadi
  `monitoring` dan event `contradiction_signal` dibuat, bukan langsung open.

Events:

- Conflict baru membuat `new_evidence`.
- Evidence baru sisi A membuat `strengthened_side_a`.
- Evidence baru sisi B membuat `strengthened_side_b`.
- Review manual membuat `manual_review` dan `status_change`.
- Evidence baru pada conflict resolved/dismissed membuat `contradiction_signal`.

Brain Chat / Response Inference:

- Membaca active conflicts dengan status `open`, `monitoring`,
  `partially_resolved`, atau `needs_review`.
- Memakai conflict hanya untuk prompt identity, strategy, contradiction, atau
  topik yang keyword-nya relevan.
- Tidak memakai conflict untuk prompt ringan seperti `hi`.
- Output menambah:

```json
{
  "identity_conflicts_used": true,
  "identity_conflict_ids": [],
  "conflict_guidance_used": [],
  "conflict_warnings": []
}
```

Drift Guard:

- Menaikkan overclaim/style risk jika jawaban mengabaikan active high severity
  conflict yang relevan.
- Menaikkan risk jika jawaban memilih satu sisi tanpa menyebut tension.
- Menaikkan risk jika jawaban membuat owner terlihat terlalu konsisten.

Self-Reflection:

- Membaca active identity conflicts sebagai current state.
- Jika menemukan contradiction baru, reflection diarahkan untuk mengaitkannya
  dengan conflict resolver, bukan hanya menyimpannya sebagai reflection log.

Review UI:

- Sidebar `Conflicts`.
- Filter status, severity, conflict type, dan impact area.
- Detail side A/B, evidence refs, severity, recurrence, chat guidance, events,
  dan reviews.
- Actions: Mark Monitoring, Mark Resolved, Dismiss, Needs More Data, owner note.
- MVP action hanya menulis review/status; tidak mengubah identity facts atau
  communication patterns.

Endpoint lokal dev:

```text
POST /__identity-conflicts/detect
POST /__identity-conflicts/review
GET  /__identity-conflicts/latest
POST /__identity-conflicts/audit
```

Output Obsidian:

```text
AhyarBrainVault/_system/conflicts/Identity Conflicts Latest.md
AhyarBrainVault/_system/conflicts/Open Identity Conflicts.md
AhyarBrainVault/_system/conflicts/Conflict Review Queue.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_CONFLICTS=false
```

Boundary:

- Tidak auto-resolve.
- Tidak auto-edit identity facts.
- Tidak auto-edit communication patterns.
- Tidak delete conflicts otomatis.
- Tidak fine-tuning.
- Tidak agent action otomatis.

Step 27: merge/split conflict, owner-approved promotion ke hints/rules,
conflict trend dashboard, dan policy gate untuk conflict guidance yang akan
aktif di Brain Chat.

## Step 27 — Final Self-Clone Evaluation Suite

Final Self-Clone Evaluation Suite adalah evaluasi menyeluruh untuk menentukan
apakah agent sudah cukup layak disebut simulasi respons owner. Similarity
Evaluation hanya membandingkan agent answer dengan owner answer examples; Step
27 menggabungkan score lintas sistem: identity fidelity, communication style,
owner similarity, memory grounding, conflict handling, drift safety,
calibration, reflection, too-AI risk, overclaim, underfit, private leak, dan
readiness final.

Migration:

```text
supabase/migrations/20260613190000_create_self_clone_evaluation.sql
```

Table:

- `self_clone_eval_suites`: kumpulan suite baseline/daily/weekly/regression/
  release/manual.
- `self_clone_eval_cases`: test case final, expected behavior, expected answer,
  required identity/style/conflict ids, forbidden phrases/behaviors, weights.
- `self_clone_eval_runs`: satu proses evaluation dan aggregate score.
- `self_clone_eval_results`: hasil per case.
- `self_clone_readiness_reports`: laporan readiness final dan release decision.

Command:

```bash
cd frontend
npm run clone:cases -- --generate
npm run clone:cases -- --generate --suite release
npm run clone:run
npm run clone:run -- --suite release
npm run clone:run -- --case-type social_greeting
npm run clone:release
npm run clone:latest
npm run clone:readiness
npm run clone:audit
```

Case generation:

- Owner answer examples menjadi `owner_answer_similarity`.
- Chat reply pairs menjadi greeting/casual/correction/request prompt style
  cases.
- Communication patterns menjadi `style_regression`.
- Identity facts menjadi identity question coverage.
- Identity conflicts menjadi contradiction/conflict awareness cases.
- Drift rules menjadi guard cases.
- Reflection logs menjadi reflection awareness cases.
- Default insufficient-memory case menguji kejujuran saat data tidak ada.

Evaluation run:

1. Membaca active suite/cases.
2. Menjalankan Response Inference untuk setiap prompt.
3. Menilai deterministic score per dimension.
4. Optional LLM judge jika `SELF_CLONE_EVAL_USE_LLM_JUDGE=true`.
5. Menyimpan `self_clone_eval_results`.
6. Menghitung aggregate run.
7. Membuat readiness report.
8. Menulis report Obsidian.

Formula overall:

```text
0.18 identity_fidelity
+ 0.18 communication_style
+ 0.18 owner_similarity
+ 0.14 memory_grounding
+ 0.10 conflict_handling
+ 0.10 drift_safety
+ 0.07 calibration
+ 0.05 reflection
- penalty too_ai/overclaim/private_leak/critical_failures
```

Critical failure:

- greeting menampilkan source/debug;
- greeting terlalu AI-like;
- mengarang identitas;
- membuka konteks pribadi tidak relevan;
- mengklaim sebagai manusia asli atau sadar;
- memilih satu sisi konflik besar tanpa evidence;
- menjawab data yang tidak ada sebagai fakta.

Readiness level:

- `not_ready`
- `early`
- `usable_with_warning`
- `stable`
- `release_candidate`

Release decision:

- `do_not_use`
- `internal_testing_only`
- `daily_use_with_warning`
- `stable_daily_use`
- `ready_for_next_phase`

Endpoint lokal dev:

```text
POST /__self-clone-eval/generate-cases
POST /__self-clone-eval/run
GET  /__self-clone-eval/latest
POST /__self-clone-eval/audit
```

UI:

- Sidebar `Self-Clone Eval`.
- Readiness card, release decision, overall score.
- Score cards untuk identity/style/similarity/grounding/conflict/drift/
  calibration/reflection/too-AI/overclaim/private leak.
- Case list, result list, critical failures, recommendations, readiness report.

Output Obsidian:

```text
AhyarBrainVault/_system/self-clone-eval/Final Self-Clone Evaluation Latest.md
AhyarBrainVault/_system/self-clone-eval/Final Self-Clone Evaluation YYYY-MM-DD HH-mm.md
AhyarBrainVault/_system/self-clone-eval/Self-Clone Readiness Report.md
AhyarBrainVault/_system/self-clone-eval/Failed Critical Cases.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_SELF_CLONE_EVAL=false
```

Boundary:

- Tidak fine-tuning.
- Tidak auto-edit identity facts.
- Tidak auto-edit communication patterns.
- Tidak auto-edit calibration hints.
- Tidak menghapus data.
- Read-only terhadap brain utama; hanya menulis eval tables dan reports.

Step 28: Safe Entity Runtime / Read-Only Autonomy Boundary.

## Step 28 — Safe Entity Runtime

Safe Entity Runtime adalah runtime boundary untuk menjalankan entitas dalam mode
aman. Ia mengatur apa yang boleh dibaca, apa yang boleh ditulis, apa yang harus
diblokir, dan apa yang hanya boleh menjadi proposal.

Migration:

```text
supabase/migrations/20260613200000_create_safe_entity_runtime.sql
```

Tables:

- `entity_runtime_policies`
- `entity_runtime_sessions`
- `entity_runtime_events`
- `entity_action_proposals`
- `entity_runtime_safety_reports`

Command:

```bash
cd frontend
npm run entity:policies -- --seed
npm run entity:session -- --start --mode read_only
npm run entity:run -- --question "hi"
npm run entity:run -- --question "kirim email ke HR bahwa saya tertarik"
npm run entity:proposal -- --latest
npm run entity:audit
npm run entity:latest
```

Default policies:

- `read_core_brain_allowed`
- `runtime_logs_write_allowed`
- `block_identity_mutation`
- `block_communication_mutation`
- `block_external_actions`
- `proposal_only_for_actions`
- `privacy_minimization`
- `fidelity_first_runtime`
- `debug_hidden_by_default`

Runtime boleh membaca identity facts/snapshots, communication patterns,
calibration hints, similarity/drift baseline, reflection logs, identity
conflicts, self-clone readiness, brain reports, memories, nodes, dan edges.
Runtime hanya boleh menulis runtime logs, safety decisions, action proposals,
dan safety reports.

Boundary check:

- external action request diblokir;
- identity/communication mutation diblokir;
- command execution diblokir;
- arbitrary file write/delete diblokir;
- draft boleh dibuat, tetapi tidak dikirim;
- action proposal selalu membutuhkan review.

Brain Chat integration:

- prompt ringan seperti `hi` tidak menampilkan policy detail;
- prompt aksi mengembalikan safe response dan metadata `entity_runtime`;
- UI menampilkan card action blocked dan proposal id/title;
- approval proposal tidak menjalankan action.

Obsidian output:

```text
AhyarBrainVault/_system/runtime/Entity Runtime Latest.md
AhyarBrainVault/_system/runtime/Runtime Policies.md
AhyarBrainVault/_system/runtime/Action Proposals.md
AhyarBrainVault/_system/runtime/Safety Report.md
```

Daily Routine:

```env
BRAIN_ROUTINE_RUN_ENTITY_AUDIT=true
```

Security boundary:

- tidak expose service role ke bundle;
- tidak menerima arbitrary path/command dari frontend;
- tidak fine-tuning;
- tidak agent action otomatis;
- tidak auto-edit identity facts;
- tidak auto-edit communication patterns;
- tidak auto-edit calibration hints;
- tidak menghapus brain utama.

Step 29: Long-Term Memory Consolidation.

## Step 29 — Long-Term Memory Consolidation

Long-Term Memory Consolidation adalah layer yang mengubah banyak memory lama
menjadi state memory jangka panjang: core memory, recurring pattern, long-term
goal, project context, risk memory, conflict memory, stale candidate, duplicate
candidate, dan review queue.

Migration:

```text
supabase/migrations/20260613210000_create_long_term_memory_consolidation.sql
```

Tables:

- `long_term_memories`
- `memory_consolidation_runs`
- `memory_consolidation_items`
- `memory_review_queue`
- `memory_consolidation_snapshots`

Command:

```bash
cd frontend
npm run memory:consolidate
npm run memory:consolidate -- --run-type weekly
npm run memory:consolidate -- --from 2026-06-01 --to 2026-06-12
npm run memory:consolidate:full
npm run memory:snapshot
npm run memory:review
npm run memory:audit
npm run memory:latest
```

Bedanya dengan Brain Digest: digest meringkas periode; consolidation menjaga
state memory jangka panjang dan memberi review queue untuk duplicate/stale/core
candidate. Bedanya dengan Identity Fidelity: identity fidelity membuat identity
facts; consolidation menjaga semua memory agar cepat dipakai, tidak noise, dan
tetap evidence-bound.

Freshness:

- `fresh`: muncul 14 hari terakhir.
- `active`: muncul 90 hari.
- `aging`: 90 sampai stale threshold.
- `stale`: lebih lama dari `MEMORY_CONSOLIDATION_STALE_DAYS`.
- `historical`: event lama yang tetap penting sebagai konteks.

Stability:

- `temporary`
- `emerging`
- `recurring`
- `stable`
- `core`

Brain Chat integration:

- membaca `long_term_memories` aktif untuk identity/strategy/pattern questions;
- tidak memakai long-term memory untuk greeting seperti `hi`;
- memory `needs_review` tidak boleh jadi klaim tegas;
- memory `stale` harus disebut historis, bukan current fact;
- conflict-linked memory harus dijawab dengan nuansa.

Runtime integration:

- Safe Entity Runtime boleh membaca `long_term_memories`,
  `memory_consolidation_snapshots`, dan `memory_review_queue`;
- runtime tidak auto-archive, auto-merge, auto-delete, atau auto-apply review.

Drift Guard integration:

- risk naik jika stale memory dipakai sebagai fakta current;
- risk naik jika needs-review memory dipakai sebagai klaim tegas;
- risk naik jika conflict-linked memory diabaikan.

Obsidian output:

```text
AhyarBrainVault/_system/memory/Long-Term Memory Latest.md
AhyarBrainVault/_system/memory/Long-Term Memory Snapshot.md
AhyarBrainVault/_system/memory/Memory Review Queue.md
AhyarBrainVault/_system/memory/Memory Consolidation Report.md
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_MEMORY_CONSOLIDATION=false
```

Security boundary:

- raw diary/chat/file tidak dihapus;
- agent memories tidak dihapus;
- identity facts tidak diubah otomatis;
- communication patterns tidak diubah otomatis;
- auto-merge dan auto-archive default false;
- tidak fine-tuning;
- tidak agent action otomatis;
- tidak menjalankan aksi eksternal.

## Step 30 — Personal Entity OS Final Release

Final Release adalah gate akhir untuk memastikan Personal Entity OS aman,
stabil, local-first, read-only/proposal-only, tidak bocor secret, dan siap
dipakai harian jika score serta decision memadai. Ini bukan fase intelligence
baru, bukan fine-tuning, bukan production backend, dan bukan external
automation.

Migration:

```text
supabase/migrations/20260613220000_create_final_release.sql
```

Table:

- `final_release_runs`
- `final_release_checks`
- `final_release_artifacts`
- `final_release_notes`

Command:

```bash
cd frontend
npm run release:check
npm run release:check -- --type release_candidate
npm run release:final
npm run release:notes
npm run release:artifacts
npm run release:audit
npm run release:latest
```

Release check membaca:

- env examples dan provider fallback docs;
- migration files dan Supabase tables;
- RLS/policy access via table reads;
- `npm run build`;
- `node --check` untuk script utama;
- secret pattern di `dist`;
- Obsidian vault folders;
- latest backup;
- identity, communication, response inference, calibration, similarity, drift,
  reflection, chat samples, conflicts, self-clone eval, safe runtime,
  long-term memory, dan docs.

Command allowlist:

- `npm run build`
- `node --check scripts/<known-script>.mjs`

Endpoint Vite:

- `POST /__final-release/check`
- `POST /__final-release/final`
- `POST /__final-release/notes`
- `GET /__final-release/latest`
- `POST /__final-release/audit`

Endpoint tidak menerima arbitrary command/path. Payload hanya enum release type,
version string, dan boolean save.

Scoring final release memakai bobot:

```text
security: 20
database/migrations: 10
build/scripts: 10
backup/recovery: 10
identity/communication: 10
response/calibration/similarity: 10
drift/runtime safety: 10
self-clone eval: 10
long-term memory/reflection/conflicts: 5
documentation: 5
```

Release decision:

- `do_not_use`: ada critical security/runtime/data blocker.
- `internal_testing_only`: build jalan tetapi data/eval belum cukup.
- `daily_use_with_warning`: score >= 70, tidak ada critical security blocker,
  masih ada warning.
- `stable_daily_use`: score >= 85, tidak ada critical blocker, backup ada,
  runtime boundary aktif.
- `ready_for_final_use`: score >= 92, tidak ada critical blocker, self-clone
  eval stable/release candidate, similarity baik, drift aman.

Obsidian output:

```text
AhyarBrainVault/_system/final-release/Final Release Latest.md
AhyarBrainVault/_system/final-release/Final Release Checklist.md
AhyarBrainVault/_system/final-release/Final Release Notes.md
AhyarBrainVault/_system/final-release/Final Release Blockers.md
AhyarBrainVault/_system/final-release/Final Release Artifacts.md
```

Marker:

```text
<!-- FINAL_RELEASE_AUTO_START -->
<!-- FINAL_RELEASE_AUTO_END -->
```

Daily Routine optional:

```env
BRAIN_ROUTINE_RUN_RELEASE_AUDIT=false
```

Final Release UI tersedia sebagai mode `Final Release`. View menampilkan score,
readiness level, release decision, blockers, warnings, check categories,
artifacts, release notes, dan manual next steps.

Boundary yang tetap berlaku setelah release:

- tidak ada email/calendar/GitHub/WhatsApp/Telegram action;
- tidak ada arbitrary command execution;
- tidak ada data deletion;
- tidak ada auto-edit identity facts;
- tidak ada auto-edit communication patterns;
- tidak ada fine-tuning;
- agent tidak boleh diklaim sebagai manusia asli atau kesadaran asli.

Step setelah final release baru boleh membahas supervised execution dengan
capability registry, explicit approval UX, executor terpisah, simulation mode,
rollback policy, dan audit trail. Itu tidak termasuk Step 30.
