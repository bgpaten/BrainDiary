# AhyarBrainVault — Personal Brain OS (Raw Brain Vault)

Vault Obsidian ini adalah **otak mentah** dari Personal Brain OS.
Di sinilah kamu menulis diary harian, catatan orang, project, tempat, kejadian,
keputusan, pola, target, dan menyimpan attachment.

Vault ini **hanya menyimpan catatan mentah & terstruktur ringan (frontmatter)**.
Pemrosesan cerdas dilakukan oleh komponen lain (lihat "Posisi dalam Sistem").

---

## Posisi dalam Sistem

```
[Obsidian Vault]  →  [Brain Engine]  →  [Supabase]  →  [React Visualizer]
 (kamu nulis di      (baca catatan,     (simpan node    (lihat peta otak
  sini — fase ini)    ekstrak entitas)   & relasi)        & quick input)
```

- **Obsidian (vault ini)** — tempat menulis diary, catatan, dan attachment.
- **Brain Engine** *(fase berikutnya)* — membaca catatan dari vault ini.
- **Supabase** *(fase berikutnya)* — menyimpan structured memory (node + relasi).
- **React** *(fase berikutnya)* — Brain Visualizer + quick input form.

> **Fase saat ini hanya menyiapkan struktur vault.** Belum ada engine, backend,
> schema Supabase, frontend, maupun logika ekstraksi AI.

---

## Struktur Folder

| Folder            | Fungsi                                                            |
|-------------------|------------------------------------------------------------------|
| `00_Diary`        | Diary harian (sumber utama). Disusun `00_Diary/YYYY/MM/YYYY-MM-DD.md`. |
| `10_People`       | Catatan orang yang sering muncul.                                |
| `20_Projects`     | Catatan project.                                                 |
| `30_Places`       | Catatan tempat.                                                  |
| `40_Events`       | Catatan kejadian penting.                                        |
| `50_Decisions`    | Catatan keputusan penting.                                       |
| `60_Patterns`     | Pola berulang, masalah berulang, kebiasaan, insight dari diary.  |
| `70_Goals`        | Target, tujuan, ambisi, milestone.                               |
| `80_Attachments`  | Foto, PDF, dokumen, screenshot, voice note, file pendukung.      |
| `_system`         | Template, prompt, log, metadata, hasil ekstraksi sementara.      |

Isi `_system`:

- `_system/templates` — template Markdown untuk tiap tipe catatan.
- `_system/prompts` — aturan untuk Brain Engine (mis. aturan ekstraksi).
- `_system/extraction-output` — staging hasil ekstraksi AI sebelum ke Supabase.
- `_system/logs` — log proses Brain Engine.

> **Penomoran folder (00, 10, 20, ...)** dipakai agar urutan rapi dan stabil,
> sekaligus memudahkan engine mengenali tipe folder.

---

## Cara Menulis Diary Harian

1. Buat file baru di `00_Diary/YYYY/MM/` dengan nama **`YYYY-MM-DD.md`**
   (contoh: `00_Diary/2026/06/2026-06-11.md`).
2. Salin isi `_system/templates/diary-template.md` ke file baru itu.
   (Disarankan pakai plugin **Templater/Core Templates** Obsidian agar otomatis.)
3. Isi frontmatter di bagian atas (minimal `date`, `mood`, `energy`).
4. Tulis bebas di bagian **Cerita Bebas**, lalu rapikan poin-poin di bagian
   bawah seperlunya. Tidak harus semua section diisi.
5. Biarkan `processed: false`. Brain Engine nanti yang mengubahnya jadi `true`.

> Tulis **apa adanya**. Vault ini mengutamakan kejujuran data mentah; Brain
> Engine yang bertugas menyusun maknanya.

---

## Aturan Wikilink `[[Nama Node]]`

Gunakan wikilink untuk menghubungkan diary ke node lain:

- Orang → `[[Nama Orang]]`  ex: `Tadi diskusi dengan [[Budi]].`
- Project → `[[Nama Project]]`  ex: `Lanjut ngerjain [[Personal Brain OS]].`
- Tempat → `[[Nama Tempat]]`
- Event → `[[Nama Event]]`
- Decision → `[[Judul Keputusan]]`
- Pattern → `[[Nama Pola]]`
- Goal → `[[Nama Target]]`

Aturan:

1. **Satu node = satu nama kanonik.** Gunakan nama yang konsisten. Variasi nama
   (alias) ditulis di field `aliases` pada catatan node tersebut.
2. **Nama file node = nama di dalam wikilink.** `[[Personal Brain OS]]` merujuk
   ke `20_Projects/Personal Brain OS.md`.
3. Boleh menyebut node walau catatannya belum dibuat — Obsidian menandainya
   sebagai link kosong, dan kamu bisa membuatnya nanti.
4. **Jangan membuat wikilink untuk hal sepele** yang bukan entitas penting.

---

## Aturan Menyimpan Attachment

1. Semua attachment masuk ke `80_Attachments/`.
2. Beri nama deskriptif + tanggal, contoh: `2026-06-11-sketsa-arsitektur.png`.
3. **Selalu kaitkan attachment ke diary asalnya.** Embed di diary dengan
   `![[2026-06-11-sketsa-arsitektur.png]]` dan/atau cantumkan di frontmatter
   `attachments: ["2026-06-11-sketsa-arsitektur.png"]`.
4. Jangan menaruh attachment berserakan di folder lain — satu pintu di
   `80_Attachments` agar mudah dilacak engine.

## Attachment Importer

File di `80_Attachments` dapat diimpor ke Supabase melalui importer lokal:

```bash
cd ../frontend
npm run attachments:import
```

Importer menulis metadata ke `brain_files`, membuat `raw_entries`, lalu memakai
Brain Worker yang sudah ada untuk membuat node/edge/memory. File asli di vault
tidak diubah.

Log proses ditulis ke:

```text
_system/logs/attachment-importer-YYYY-MM-DD.md
```

Jika vision gambar dimatikan, importer tidak mengarang isi gambar. File gambar
akan diberi status perlu review sampai vision provider diaktifkan atau direview
manual.

## Obsidian Knowledge Sync

Structured brain dari Supabase dapat disinkronkan balik ke vault sebagai halaman
Markdown node:

```bash
cd ../frontend
npm run obsidian:sync -- --dry-run
npm run obsidian:sync
```

Sync membuat/memperbarui file node di folder sesuai tipe:

- `project` → `20_Projects`
- `person` → `10_People`
- `pattern` → `60_Patterns`
- `goal` → `70_Goals`
- tipe knowledge lain → `90_Knowledge/...`

Konten otomatis dibatasi marker:

```text
<!-- BRAIN_OS_AUTO_START -->
<!-- BRAIN_OS_AUTO_END -->
```

Tulis catatan manual di luar marker tersebut. Sync ulang hanya mengganti
frontmatter brain fields dan section otomatis, sehingga tulisan manual tetap
dipertahankan. Sync tidak menghapus file Obsidian.

Index dibuat di:

```text
_system/indexes/
```

Log sync ditulis ke:

```text
_system/logs/obsidian-sync-YYYY-MM-DD.md
```

## Brain Digest Reports

Timeline Intelligence + Brain Digest membuat laporan periodik dari structured
brain dan menulis hasilnya kembali ke vault.

Command manual dari folder `frontend`:

```bash
npm run brain:digest:today
npm run brain:digest:week
npm run brain:digest:month
```

Report Markdown ditulis ke:

```text
_system/reports/daily/
_system/reports/weekly/
_system/reports/monthly/
```

Isi report meliputi summary, highlights, active projects, repeated patterns,
decisions, risks, suggested next actions, memory quality warning, dan sources.

Konten otomatis memakai marker:

```text
<!-- BRAIN_DIGEST_AUTO_START -->
<!-- BRAIN_DIGEST_AUTO_END -->
```

Jika kamu menambah catatan manual di file report, tulis di luar marker tersebut.
Generate ulang hanya mengganti section otomatis dan tidak menghapus tulisan
manual.

Log digest ditulis ke:

```text
_system/logs/brain-digest-YYYY-MM-DD.md
```

## Persona Profile

Persona Layer membuat profile gaya berpikir dan komunikasi dari structured brain.
Generate dari folder `frontend`:

```bash
npm run brain:persona
```

Output ditulis ke:

```text
_system/persona/Persona Profile.md
```

Profile berisi identity summary, active projects, goals, decision patterns,
repeated patterns, communication style, risk patterns, ambition signals,
values/principles inferred, current constraints, confidence warnings, dan last
updated.

Konten otomatis memakai marker:

```text
<!-- BRAIN_PERSONA_AUTO_START -->
<!-- BRAIN_PERSONA_AUTO_END -->
```

Catatan manual aman selama ditulis di luar marker tersebut. Persona Builder tidak
mengubah node/edge dan default-nya tidak menulis memory otomatis.

Log persona ditulis ke:

```text
_system/logs/persona-builder-YYYY-MM-DD.md
```

## Brain Evaluation Reports

Brain Evaluation / Memory Accuracy Test adalah quality gate untuk mengecek apakah
Brain Chat dan Persona Layer akurat, grounded, memakai source yang benar, dan
tidak mengarang ketika memory belum cukup.

Generate test cases dan jalankan evaluation dari folder `frontend`:

```bash
cd ../frontend
npm run brain:eval:cases
npm run brain:eval
```

Hasil report ditulis ke:

```text
_system/evaluations/Latest Brain Evaluation.md
_system/evaluations/Brain Evaluation YYYY-MM-DD HH-mm.md
```

Report berisi overall score, retrieval accuracy, source accuracy, groundedness,
hallucination risk, persona mode accuracy, insufficient memory handling, failed
cases, hallucination warnings, persona mode errors, source errors, dan recommended
fixes.

Konten otomatis memakai marker:

```text
<!-- BRAIN_EVAL_AUTO_START -->
<!-- BRAIN_EVAL_AUTO_END -->
```

Catatan manual aman jika ditulis di luar marker tersebut. Evaluation tidak
mengubah node, edge, raw diary, agent memory, atau file brain lain selain report
di folder `_system/evaluations`.

---

## Aturan agar Brain Engine Mudah Membaca

1. **Selalu pakai frontmatter** sesuai template. Frontmatter adalah sumber
   metadata utama bagi engine.
2. **Jaga field `processed`.** `false` = belum diproses, `true` = sudah.
   Jangan ubah manual menjadi `true` kecuali memang sudah diproses.
3. **Konsisten penamaan node** agar entity resolution mudah.
4. **Gunakan wikilink** untuk relasi eksplisit — itu sinyal terkuat bagi engine.
5. **Tanggal format ISO** `YYYY-MM-DD` di mana pun.
6. **Diary mentah tidak boleh dihapus.** Koreksi dengan menambah catatan, bukan
   menghapus sejarah.
7. Aturan lengkap ekstraksi ada di `_system/prompts/brain-extraction-rules.md`.

---

## Disiplin Struktur

- **Jangan membuat banyak folder tambahan tanpa alasan kuat.** Struktur 10
  folder utama ini sudah cukup untuk hampir semua kebutuhan.
- Kalau ragu sebuah catatan masuk folder mana, taruh di folder tipe yang paling
  dekat dan andalkan wikilink + frontmatter untuk relasinya.
- Tujuan utama: **rapi, konsisten, dan mudah dibaca mesin.**

---

## Obsidian Vault Importer

Diary di `00_Diary/YYYY/MM/YYYY-MM-DD.md` bisa diimpor ke Supabase memakai local
importer:

```bash
cd ../frontend
npm run obsidian:import
```

Importer hanya memproses file Markdown dengan frontmatter:

```yaml
type: diary
processed: false
```

Setelah sukses, importer memperbarui frontmatter diary:

```yaml
processed: true
processing_status: done
raw_entry_id: "<uuid>"
processed_at: "<timestamp ISO>"
```

Jika gagal, importer menulis:

```yaml
processed: false
processing_status: failed
last_error: "pesan error"
last_attempted_at: "<timestamp ISO>"
```

Log proses ditulis ke:

```text
_system/logs/obsidian-importer-YYYY-MM-DD.md
```

---

## Daily Brain Routine

Daily Brain Routine adalah workflow harian lokal untuk menstabilkan Personal
Brain OS. Routine menjalankan import diary, import attachment, worker pending,
semantic reindex, persona refresh, Obsidian sync, daily digest, lightweight
evaluation, lalu membuat summary.

Jalankan dari folder frontend:

```bash
cd ../frontend
npm run brain:health
npm run brain:routine -- --dry-run
npm run brain:routine
```

Status:

- `done`: semua step utama selesai tanpa warning penting.
- `partial`: ada warning, eval gate buruk, atau satu step gagal tetapi routine
  masih menghasilkan summary.
- `failed`: routine tidak bisa menyelesaikan log dasar atau error critical.

Eval gate hanya memberi warning. Jika evaluation score rendah atau hallucination
risk tinggi, routine menandai brain belum cukup akurat untuk dipercaya penuh.
Routine tidak membuat task otomatis dan tidak menjalankan agent action.

Output otomatis ditulis ke:

```text
_system/routine/Daily Brain Routine Latest.md
_system/routine/Daily Brain Routine YYYY-MM-DD HH-mm.md
_system/logs/brain-routine-YYYY-MM-DD.md
```

Konten otomatis memakai marker:

```text
<!-- BRAIN_ROUTINE_AUTO_START -->
<!-- BRAIN_ROUTINE_AUTO_END -->
```

Catatan manual aman jika ditulis di luar marker tersebut. Fase ini belum
membuat scheduler production, calendar, email, notifikasi, task planner, atau
auto-fix node/edge.

---

## Brain Backup, Export & Recovery

Brain Backup membuat snapshot lokal Personal Brain OS: export table Supabase ke
JSON, copy vault Obsidian, snapshot config non-secret, manifest, dan log.

Jalankan dari folder frontend:

```bash
cd ../frontend
npm run brain:backup
npm run brain:backup:list
npm run brain:restore:preview -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss
npm run brain:restore -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss --confirm
npm run brain:recovery -- --check
```

Default backup tidak menyimpan `.env` aktual, service role key, atau API key.
Config yang disimpan berasal dari `.env.example` dan snapshot script package.

Output backup ada di:

```text
../backups/brain-backup-YYYY-MM-DD-HH-mm-ss/
```

Ringkasan dan log ditulis ke:

```text
_system/backups/Latest Backup.md
_system/logs/brain-backup-YYYY-MM-DD.md
_system/logs/brain-restore-YYYY-MM-DD.md
_system/logs/brain-recovery-YYYY-MM-DD.md
```

Restore MVP hanya `upsert` Supabase JSON dan tidak menghapus data existing.
Restore tanpa `--confirm` ditolak. Restore Obsidian Vault belum otomatis agar
tidak menimpa vault aktif tanpa pre-restore backup.

Recovery check hanya audit dan rekomendasi manual. Ia tidak auto-fix node, edge,
frontmatter, diary, atau graph.

---

## Final Polish & Release Hardening

Fase final menambahkan audit rilis dan cleanup recovery aman. Dari folder
frontend:

```bash
cd ../frontend
npm run brain:audit
npm run brain:release-check
npm run brain:recovery -- --check
npm run brain:recovery -- --check --fix
```

`--fix` hanya mengubah frontmatter jika aman. Untuk diary yang sudah
`processed: true` tetapi `raw_entry_id` tidak ditemukan, file ditandai:

```yaml
processed: false
processing_status: needs_reimport
recovery_note: raw_entry_id not found
```

Knowledge file tanpa `brain_node_id` hanya diisi otomatis jika nama file cocok
jelas dengan node Supabase. Jika tidak yakin, recovery tetap memberi warning dan
tidak mengubah file.

Manual final dan checklist rilis ada di:

```text
../docs/FINAL_OPERATING_MANUAL.md
../docs/RELEASE_CHECKLIST.md
```

---

## Identity Fidelity Engine

Identity Fidelity Engine adalah layer Personal Entity OS untuk menyimpan model
identitas yang terikat bukti. Persona Profile boleh dipakai sebagai konteks
tambahan, tetapi klaim identitas utama harus berasal dari `identity_facts`.

File generated vault:

```text
_system/identity/Identity Fidelity Model.md
_system/identity/Identity Snapshot Latest.md
```

Jangan edit bagian di antara marker:

```text
<!-- IDENTITY_FIDELITY_AUTO_START -->
<!-- IDENTITY_FIDELITY_AUTO_END -->
```

Manual note boleh ditulis di luar marker. Model identity berisi trait, values,
beliefs, preferences, goals, decision patterns, communication patterns,
emotional patterns, risk patterns, contradictions, boundaries, confidence
warnings, dan evidence highlights.

Cara update dari folder `frontend`:

```bash
npm run identity:build
npm run identity:audit
```

Prinsip pemakaian: agent bukan manusia asli, bukan kesadaran, dan tidak boleh
mengklaim identitas tanpa evidence. Confidence rendah berarti sinyal awal, bukan
fakta kuat. Jika data gaya komunikasi atau pola diri belum cukup, Chat harus
mengaku belum cukup data.

---

## Communication Style Model

Communication Style Model menyimpan contoh dan pola gaya bahasa pemilik diary.
Ia melengkapi Identity Fidelity: identity menyimpan klaim diri, communication
style menyimpan bentuk jawaban yang paling mirip untuk intent tertentu.

File generated vault:

```text
_system/communication/Communication Style Model.md
_system/communication/Communication Samples.md
```

Jangan edit bagian di antara marker:

```text
<!-- COMMUNICATION_STYLE_AUTO_START -->
<!-- COMMUNICATION_STYLE_AUTO_END -->
```

Manual note boleh ditulis di luar marker. Model ini berisi greeting style,
prompt request style, technical style, correction style, decision style, casual
style, preferred response shape, anti-style, confidence warnings, dan evidence
highlights.

Cara update dari folder `frontend`:

```bash
npm run communication:build
npm run communication:audit
```

Jika data chat sample masih sedikit, hasil gaya sapaan dan koreksi harus dibaca
sebagai sinyal awal. Brain Chat tetap memakai fallback pendek/netral untuk
sapaan ringan agar tidak terdengar seperti chatbot umum.

---

## Response Inference Engine

Response Inference Engine adalah layer yang mengubah Brain Chat dari retrieval
answer menjadi inferred owner response. Pertanyaan utamanya: jika pemilik diary
asli menerima prompt ini, kemungkinan besar dia akan menjawab apa.

Engine membaca `identity_facts`, `communication_patterns`, dan memory context
hanya jika intent membutuhkannya. Ia tidak mengubah diary, node, edge, atau
file vault. Log evaluasi disimpan di Supabase table `response_inference_logs`.

Cara pakai dari folder `frontend`:

```bash
npm run response:rules
npm run response:infer -- --question "hi"
npm run response:audit
```

Jika report Obsidian diaktifkan:

```env
RESPONSE_INFERENCE_OUTPUT_OBSIDIAN=true
```

Report ditulis ke:

```text
_system/response-inference/Response Inference Report.md
```

Jangan edit bagian di antara marker:

```text
<!-- RESPONSE_INFERENCE_AUTO_START -->
<!-- RESPONSE_INFERENCE_AUTO_END -->
```

Processing khusus:

- `hi`, `p`, `assalamu’alaikum`: dijawab pendek natural, tanpa sources atau
  missing context.
- `buatkan prompt`: langsung menghasilkan prompt siap paste.
- `menurutmu saya harus fokus apa`: memakai identity facts seperti goals,
  risk pattern, decision pattern, dan contradiction, tetapi tetap konservatif
  jika evidence belum cukup.

Step 24 belum masuk vault ini: approval workflow untuk hints/rules, trend dashboard, dan release gate.

---

## Owner Answer Calibration

Owner Answer Calibration menyimpan contoh prompt dan jawaban asli pemilik diary.
Jawaban asli menjadi ground truth untuk mengukur apakah agent sudah menjawab
dengan gaya pemilik diary, bukan hanya jawaban AI yang benar secara umum.

Cara pakai dari folder `frontend`:

```bash
npm run owner:examples -- --seed
npm run owner:calibrate
npm run owner:audit
```

Report generated vault:

```text
_system/calibration/Owner Answer Calibration Latest.md
_system/calibration/Owner Answer Examples.md
_system/calibration/Calibration Hints.md
```

Jangan edit bagian di antara marker:

```text
<!-- OWNER_CALIBRATION_AUTO_START -->
<!-- OWNER_CALIBRATION_AUTO_END -->
```

Yang boleh diedit manual adalah owner examples di Supabase/UI Calibration.
Hints dari calibration dipakai oleh Response Inference Engine sebagai signal
atau rule ringan, misalnya:

- greeting `hi` lebih cocok dijawab `Iya, ada apa?`;
- request prompt harus lebih lengkap, siap paste, step-by-step, dan punya
  acceptance criteria;
- hindari frasa terlalu AI seperti `Ada yang bisa saya bantu`.

Boundary: calibration bukan fine-tuning, tidak mengubah identity facts otomatis,
tidak mengubah communication patterns otomatis, dan tidak membuat agent action
otomatis.

Step berikutnya: drift control, approval workflow untuk hints, dan evaluasi
similarity jangka panjang.

---

## Similarity Evaluation Loop

Similarity Evaluation Loop menjalankan evaluasi berkala agar agent tidak drift
dari gaya pemilik diary. Calibration membuat examples/hints; similarity eval
mengukur apakah hasil terbaru masih mirip baseline.

Cara pakai dari folder `frontend`:

```bash
npm run similarity:run
npm run similarity:baseline -- --create --activate
npm run similarity:audit
```

Report generated vault:

```text
_system/similarity/Similarity Evaluation Latest.md
_system/similarity/Similarity Evaluation YYYY-MM-DD HH-mm.md
_system/similarity/Similarity Baseline.md
```

Jangan edit bagian di antara marker:

```text
<!-- SIMILARITY_EVAL_AUTO_START -->
<!-- SIMILARITY_EVAL_AUTO_END -->
```

Yang diperiksa:

- apakah greeting seperti `p` tetap pendek dan tidak assistant-like;
- apakah request prompt tetap lengkap dan siap paste;
- apakah jawaban makin formal atau terlalu AI;
- apakah ada overclaim identitas/fakta;
- apakah ada regression dibanding baseline.

Boundary: similarity eval tidak fine-tuning, tidak mengubah identity facts,
tidak mengubah communication patterns, tidak mengubah owner examples, dan tidak
auto-apply hints. Hasilnya dipakai untuk review manual.

Step berikutnya: drift control aktif, approval workflow untuk hints, dan trend
dashboard fidelity.

---

## Self-Reflection Memory Evolution

Self-Reflection menjawab: setelah data baru masuk, apa yang berubah dalam
pemahaman tentang pemilik diary? Ia menghasilkan refleksi berkala
(evidence-bound), saran evolusi (proposal, bukan auto-apply), dan snapshot
evolusi entitas. Beda dengan Identity Engine (membuat facts), Brain Digest
(merangkum kejadian), dan Drift Control (menjaga jawaban saat itu).

Cara pakai dari folder `frontend`:

```bash
npm run reflection:run
npm run reflection:daily
npm run reflection:snapshot
npm run reflection:audit
```

Report generated vault:

```text
_system/reflections/Self Reflection Latest.md
_system/reflections/Self Reflection YYYY-MM-DD HH-mm.md
_system/reflections/Evolution Suggestions.md
_system/reflections/Entity Evolution Snapshot.md
```

Jangan edit bagian di antara marker:

```text
<!-- SELF_REFLECTION_AUTO_START -->
<!-- SELF_REFLECTION_AUTO_END -->
```

Evolution suggestions hanya proposal: approve/reject/ignore dari UI Reflection
hanya mengubah status, **tidak** mengubah identity facts atau communication
patterns. Tidak ada auto-apply, tidak ada delete, tidak ada fine-tuning. Entitas
tidak boleh berkembang di luar evidence owner.

---

## Drift Control / Anti-Overclaim Guard

Drift Control menjaga agar jawaban agent tidak keluar dari batas evidence dan
gaya pemilik diary sebelum tampil ke user. Ia mencegah overclaim, frasa
assistant umum, source/debug leak pada sapaan ringan, dan klaim identitas low
confidence.

Cara pakai dari folder `frontend`:

```bash
npm run drift:rules -- --seed
npm run drift:check -- --question "hi" --answer "Halo! Ada yang bisa saya bantu hari ini?"
npm run drift:audit
```

Report generated vault:

```text
_system/drift/Drift Control Latest.md
_system/drift/Drift Guard Rules.md
_system/drift/High Risk Drift Logs.md
```

Jangan edit bagian di antara marker:

```text
<!-- DRIFT_CONTROL_AUTO_START -->
<!-- DRIFT_CONTROL_AUTO_END -->
```

Contoh guard:

- draft `Halo! Ada yang bisa saya bantu hari ini?` untuk `hi` difallback ke
  jawaban pendek seperti `Iya, ada apa?`;
- klaim `kamu paling disiplin dan selalu menyelesaikan rencana` ditandai
  overclaim/unsupported jika evidence tidak cukup;
- greeting tidak boleh membawa sources atau debug.

Boundary: guard tidak mengubah identity facts, communication patterns, owner
examples, atau hints secara otomatis. Semua perbaikan konseptual tetap review
manual.

Step berikutnya: approval workflow untuk hints/rules, trend dashboard, dan
release gate.

---

## Chat Sample Importer

Folder input:

```text
85_Chat_Samples/
```

Folder ini menyimpan chat sample asli owner untuk memperkaya gaya percakapan
pendek. Diary bagus untuk memahami isi pikiran, tetapi chat sample dibutuhkan
agar agent lebih mirip owner saat merespons sapaan, jawaban pendek, koreksi,
instruksi teknis, dan pertanyaan strategi.

Format yang didukung:

```text
[2026-06-12 21:00] other: hi
[2026-06-12 21:01] owner: iya, ada apa?
```

```text
12/06/26, 21.00 - Someone: hi
12/06/26, 21.01 - Ahyar: iya, ada apa?
```

```json
[{ "timestamp": "2026-06-12T21:01:00+07:00", "speaker": "owner", "text": "iya, ada apa?" }]
```

```csv
timestamp,speaker,text
2026-06-12T21:01:00+07:00,owner,"iya, ada apa?"
```

Owner aliases diatur dari `frontend/scripts/brain-worker.env`:

```env
CHAT_SAMPLE_OWNER_ALIASES=Ahyar,Kukuh,Ahyar Pattani,owner,me,saya
```

Rules penting:

- Hanya pesan owner yang menjadi `communication_samples`.
- Hanya pair `other -> owner` yang menjadi `owner_answer_examples`.
- Pesan lawan bicara hanya menjadi prompt/context.
- Chat sample bukan identity fact otomatis.
- Tidak ada fine-tuning, upload cloud, delete otomatis, atau agent action.

Report generated vault:

```text
_system/chat-samples/Chat Import Latest.md
_system/chat-samples/Chat Reply Pairs.md
_system/chat-samples/Chat Import Reviews.md
```

Jangan edit bagian di antara marker:

```text
<!-- CHAT_SAMPLE_IMPORT_AUTO_START -->
<!-- CHAT_SAMPLE_IMPORT_AUTO_END -->
```

Cara pakai dari folder `frontend`:

```bash
npm run chats:import
npm run chats:audit
npm run communication:build
npm run owner:calibrate
npm run similarity:run
```

---

## Identity Conflict & Contradiction Resolver

Resolver ini menyimpan kontradiksi owner sebagai tension, trade-off, atau pola
yang sedang berubah. Kontradiksi bukan bug dan tidak otomatis menghapus salah
satu identity fact.

Contoh:

```text
Side A: Owner ingin fokus pada MVP.
Side B: Owner sering menambah fitur/fase baru.
```

Hasilnya disimpan sebagai conflict dengan:

- side A dan side B;
- evidence tiap sisi;
- confidence tiap sisi;
- severity;
- recurrence;
- resolution status;
- chat guidance untuk Brain Chat.

Cara pakai dari folder `frontend`:

```bash
npm run conflicts:detect
npm run conflicts:audit
npm run conflicts:latest
```

Report generated vault:

```text
_system/conflicts/Identity Conflicts Latest.md
_system/conflicts/Open Identity Conflicts.md
_system/conflicts/Conflict Review Queue.md
```

Jangan edit bagian di antara marker:

```text
<!-- IDENTITY_CONFLICTS_AUTO_START -->
<!-- IDENTITY_CONFLICTS_AUTO_END -->
```

Review conflict dilakukan dari UI `Conflicts` atau CLI `npm run
conflicts:review -- --conflict-id <uuid> --decision mark_monitoring --owner-note
"..."`. Review tidak mengubah identity facts atau communication patterns.

Brain Chat memakai conflict aktif untuk prompt identity/strategy/contradiction,
tetapi tidak membawa conflict ke prompt ringan seperti `hi`.

Step 27: merge/split conflict, approval promotion ke hint/rule, dan trend
dashboard konflik.

---

## Final Self-Clone Evaluation Suite

Suite ini adalah evaluasi final untuk membaca apakah agent sudah cukup mirip
owner dalam respons nyata. Ia bukan fine-tuning dan tidak memperbaiki data
otomatis. Ia hanya menjalankan test, menyimpan hasil, dan menulis rekomendasi.

Cara pakai dari folder `frontend`:

```bash
npm run clone:cases -- --generate --suite release
npm run clone:run -- --suite release
npm run clone:readiness
npm run clone:audit
```

Report generated vault:

```text
_system/self-clone-eval/Final Self-Clone Evaluation Latest.md
_system/self-clone-eval/Self-Clone Readiness Report.md
_system/self-clone-eval/Failed Critical Cases.md
```

Jangan edit bagian di antara marker:

```text
<!-- SELF_CLONE_EVAL_AUTO_START -->
<!-- SELF_CLONE_EVAL_AUTO_END -->
```

Yang dinilai:

- similarity terhadap owner answer;
- calibration;
- communication style;
- identity fidelity;
- contradiction/conflict handling;
- drift safety;
- memory grounding;
- greeting pendek;
- prompt request;
- technical/strategy response;
- honesty saat data kurang;
- private context leakage;
- final readiness.

Readiness `stable` atau `release_candidate` berarti agent cukup aman untuk
daily use pribadi. `not_ready` atau critical failures berarti perlu memperbaiki
evidence/style/calibration/guard sebelum lanjut.

Step 28: Safe Entity Runtime agar agent bisa dipakai dalam boundary read-only.

---

## Safe Entity Runtime / Read-Only Autonomy Boundary

Runtime ini membuat entitas aman untuk daily use pribadi: boleh membaca memory,
identity, communication style, calibration, similarity, drift, reflection,
conflict, dan evaluation; boleh menjawab; boleh membuat proposal tindakan; tidak
boleh menjalankan tindakan eksternal.

Cara pakai dari folder `frontend`:

```bash
npm run entity:policies -- --seed
npm run entity:session -- --start --mode read_only
npm run entity:run -- --question "hi"
npm run entity:run -- --question "kirim email ke HR bahwa saya tertarik"
npm run entity:audit
```

Report generated vault:

```text
_system/runtime/Entity Runtime Latest.md
_system/runtime/Runtime Policies.md
_system/runtime/Action Proposals.md
_system/runtime/Safety Report.md
```

Jangan edit bagian di antara marker:

```text
<!-- ENTITY_RUNTIME_AUTO_START -->
<!-- ENTITY_RUNTIME_AUTO_END -->
```

Yang boleh ditulis runtime:

- runtime sessions;
- runtime events;
- action proposals;
- safety reports.

Yang diblokir:

- email/calendar/GitHub/WhatsApp/Telegram action;
- shell command;
- arbitrary file write/delete;
- auto-edit identity facts;
- auto-edit communication patterns;
- auto-edit calibration hints;
- klaim sebagai manusia asli atau punya kesadaran asli.

Approval proposal di Step 28 hanya mengubah status proposal. Aksi tetap harus
dikerjakan manual oleh owner. Eksekusi otomatis masuk fase lain.

Step 29: Long-Term Memory Consolidation.

---

## Long-Term Memory Consolidation

Long-Term Memory Consolidation menjaga memory jangka panjang agar stabil,
evidence-bound, tidak duplikatif, dan tidak memakai memory stale sebagai fakta
current. Fitur ini berbeda dari Brain Digest karena bukan hanya merangkum
periode; ia membuat long-term memory, core memory candidate, stale candidate,
duplicate candidate, conflict-linked memory, dan review queue.

Cara pakai dari folder `frontend`:

```bash
npm run memory:consolidate
npm run memory:consolidate:full
npm run memory:snapshot
npm run memory:audit
```

Report generated vault:

```text
_system/memory/Long-Term Memory Latest.md
_system/memory/Long-Term Memory Snapshot.md
_system/memory/Memory Review Queue.md
_system/memory/Memory Consolidation Report.md
```

Jangan edit bagian di antara marker:

```text
<!-- LONG_TERM_MEMORY_AUTO_START -->
<!-- LONG_TERM_MEMORY_AUTO_END -->
```

Raw diary/chat/file tidak dihapus. Auto-merge dan auto-archive default false.
Review queue hanya mengubah status review; tidak menghapus raw data, agent
memories, identity facts, atau communication patterns.

Step 30: Personal Entity OS Final Release.

---

## Final Release

Final Release mengunci Personal Entity OS untuk pemakaian harian dengan check
keamanan, build, migration, script, backup, runtime boundary, self-clone eval,
long-term memory, dan dokumentasi. Ini bukan fase action eksternal; runtime
tetap read-only/proposal-only.

Cara pakai dari folder `frontend`:

```bash
npm run release:check
npm run release:final
npm run release:notes
npm run release:audit
```

Report generated vault:

```text
_system/final-release/Final Release Latest.md
_system/final-release/Final Release Checklist.md
_system/final-release/Final Release Notes.md
_system/final-release/Final Release Blockers.md
_system/final-release/Final Release Artifacts.md
```

Jangan edit bagian di antara marker:

```text
<!-- FINAL_RELEASE_AUTO_START -->
<!-- FINAL_RELEASE_AUTO_END -->
```

Release decision yang mungkin:

- `do_not_use`
- `internal_testing_only`
- `daily_use_with_warning`
- `stable_daily_use`
- `ready_for_final_use`

Jika decision belum `stable_daily_use` atau `ready_for_final_use`, gunakan
warning dan blocker sebagai daftar kerja manual. Final Release tidak menghapus
raw diary/chat/file, tidak auto-edit identity/communication, tidak mengirim
email/calendar/GitHub/WhatsApp, dan tidak menjalankan command eksternal.
