# Personal Brain OS — Frontend + Local Brain Tools

Brain Visualizer + Quick Diary Input. Satu halaman React yang:

- **membaca** graph dari Supabase (`brain_nodes`, `brain_edges`, `brain_clusters`) dan menampilkannya sebagai network graph, dan
- **menulis** cerita harian mentah ke `raw_entries` (tanpa membuat node/edge).

Stack: **Vite + React + TypeScript**, graph dengan **react-cytoscapejs + cytoscape**.

---

## 1. Install Dependency

```bash
cd frontend
npm install
```

## 2. Isi Env Supabase

```bash
cp .env.example .env
```

Isi `.env`:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

> Ambil dari **Supabase Dashboard → Project Settings → API**.
> Gunakan **anon public key**, **BUKAN** `service_role`. RLS yang melindungi data;
> service role key tidak boleh ada di frontend.

Opsional (mengembangkan tampilan tanpa Supabase):

```
VITE_USE_DEV_FALLBACK=true
```

Mode ini memakai data dummy lokal di `src/lib/devFallbackData.ts` (jelas terpisah,
bukan default). Matikan untuk memakai data Supabase asli.

## 3. Menjalankan Frontend

```bash
npm run dev
```

Buka `http://localhost:5173`. Perintah lain:

- `npm run build` — typecheck + build produksi.
- `npm run preview` — preview hasil build.
- `npm run typecheck` — cek tipe TypeScript saja.

## 4. Memastikan Seed Data Terlihat

Graph dibaca lewat RLS (`auth.uid() = user_id`), jadi **kamu harus login sebagai
user yang memiliki data**:

1. Pastikan migration + `seed.sql` (Fase 3) sudah dijalankan di Supabase.
2. Buat user di **Supabase Dashboard → Authentication → Users**.
3. **Ganti** `user_id` placeholder pada `seed.sql`
   (`00000000-0000-0000-0000-000000000001`) dengan **id user tersebut**, lalu jalankan ulang seed.
4. Jalankan frontend, login dengan email/password user itu.
5. Graph akan menampilkan node & edge milikmu.

Jika belum login → muncul **"Login diperlukan untuk membaca brain data"**.
Jika login tapi data kosong → muncul empty state yang menjelaskan kemungkinan RLS/seed.

## 5. Quick Input dan Brain Engine Lokal

Quick Diary Input menulis catatan mentah ke `raw_entries` dengan:

| Field               | Nilai          |
|---------------------|----------------|
| `source_type`       | `text`         |
| `source_origin`     | `react_input`  |
| `title`             | `Quick Diary YYYY-MM-DD` |
| `content`           | isi textarea   |
| `happened_at`       | waktu sekarang |
| `processed`         | `false`        |
| `processing_status` | `pending`      |
| `user_id`           | id user login  |

Setelah insert, frontend bisa memicu Local Brain Worker bila:

```env
VITE_BRAIN_ENGINE_TRIGGER=local_worker
```

Frontend memanggil endpoint dev lokal `/__brain-worker/process`, lalu Vite
menjalankan `npm run brain:worker` untuk entry yang baru dibuat.

## 6. Obsidian Graph UI

Kontrol graph berada di sidebar collapsible: filter type, filter cluster,
refresh, fullscreen, logout, process pending/failed, dan Import Obsidian.
Node graph ditampilkan sebagai circle dengan warna gelap per type/cluster.

## 7. Brain Quality Control

Fase 7 menambahkan **Brain Quality Control** sebelum agent chat dibuat. Tujuannya
menjaga graph tetap bersih: node duplicate tidak menumpuk, edge salah bisa
dihapus, dan item confidence rendah tidak langsung dianggap sebagai memory utama.

Cara membuka:

1. Jalankan `npm run dev`.
2. Login dengan user Supabase yang memiliki data.
3. Klik `Review Brain` di sidebar.
4. Klik `Quality Refresh` untuk membaca ulang node, edge, raw entry, dan job gagal.

Review View berisi:

- `Possible Duplicates` untuk kandidat node mirip.
- `Low Confidence Nodes` untuk `confidence_score < 0.7`.
- `Low Confidence Edges` untuk `confidence_score < 0.7`.
- `Failed Entries` untuk `raw_entries` `needs_review`/`failed` dan `extraction_jobs` gagal.

Duplicate detection ada di `src/lib/brainQuality.ts`. MVP ini tidak memakai
embedding; deteksi dilakukan dengan type yang sama, canonical/name/alias yang
dinormalisasi, match exact setelah lowercase dan hapus karakter non-alphanumeric,
includes match, token overlap, dan jarak karakter sederhana. Contoh `NusaOps`,
`Nusa Ops`, `nusaops`, dan `NUSAOPS` akan masuk kandidat duplicate.

Action yang tersedia:

- Node: approve, edit name/canonical/aliases/summary/description/type/cluster/score,
  ignore, delete, dan merge.
- Edge: approve, edit relation type/summary/weight/confidence, ignore, dan delete.
- Failed entry/job: retry lewat worker lokal yang sudah ada.

Status review disimpan di kolom `metadata`, bukan migration baru:

```json
{
  "review_status": "approved",
  "reviewed_at": "timestamp",
  "review_note": "Canonical node confirmed by user."
}
```

Status yang dipakai: `pending_review`, `approved`, `ignored`, `merged`, dan
`deleted`.

Merge node tidak dilakukan langsung oleh browser. Browser memanggil endpoint Vite
lokal:

```text
POST /__brain-quality/merge-node
POST /__brain-quality/delete-node
POST /__brain-quality/delete-edge
```

Endpoint ini hanya ada saat `npm run dev`, tidak ada pada build production, dan
hanya menjalankan script tetap:

```bash
npm run brain:quality
```

Script `scripts/brain-quality.mjs` memvalidasi `user_id`, memindahkan edge dari
source node ke target node, menghindari duplicate edge, menghapus self-loop hasil
merge yang tidak disengaja, menggabungkan alias, menggabungkan summary/description
secara sederhana, menjumlahkan `frequency_score`, mengambil `importance_score`
tertinggi, mengambil `last_seen_at` terbaru, lalu menghapus source node.

Log quality action ditulis ke:

```text
AhyarBrainVault/_system/logs/brain-quality-YYYY-MM-DD.md
```

Isi log berupa waktu, action, id node/edge, before/after, source/target merge,
dan error jika ada.

Security:

- Frontend tetap hanya memakai `VITE_SUPABASE_ANON_KEY`.
- `SUPABASE_SERVICE_ROLE_KEY` hanya boleh berada di env lokal script/server.
- Endpoint quality tidak menerima shell command bebas.
- Operasi merge/delete memvalidasi data berdasarkan `user_id` aktif.

Testing manual:

1. Buat node `NusaOps` dan `Nusa Ops` dengan type sama.
2. Buka `Review Brain`; pastikan muncul di `Possible Duplicates`.
3. Klik `Merge into NusaOps`.
4. Pastikan node duplicate hilang, alias target bertambah, edge source pindah,
   tidak ada duplicate edge, dan graph refresh.
5. Buat node dengan `confidence_score = 0.5`; pastikan tampil di
   `Low Confidence Nodes`.
6. Approve node; pastikan `metadata.review_status = approved`.
7. Delete edge salah; pastikan edge hilang dari graph.
8. Jalankan `npm run build`.
9. Cek bundle production tidak memuat service role key.

## 8. Brain Chat MVP

Fase 8 menambahkan **Brain Chat MVP**: agent reader read-only yang menjawab
berdasarkan structured brain, bukan chatbot umum. Data yang dibaca:

- `agent_memories`
- `brain_nodes`
- `brain_edges`
- `raw_entries`
- `brain_clusters`

Cara membuka:

1. Jalankan `npm run dev`.
2. Login seperti biasa.
3. Klik tab `Chat` di sidebar.
4. Tulis pertanyaan, lalu klik `Ask Brain`.

Endpoint lokal:

```text
POST /__brain-chat/ask
```

Endpoint ini hanya ada di Vite dev server lokal. Endpoint menerima `question`
dan opsi limit terbatas, lalu menjalankan script tetap:

```bash
npm run brain:chat
```

Tidak ada command arbitrary, path custom, atau shell args bebas dari browser.
Question kosong ditolak dan panjang question dibatasi 2000 karakter.

Input contoh:

```json
{
  "question": "Apa project yang paling penting sekarang?",
  "options": {
    "includeRawEntries": true,
    "maxNodes": 12,
    "maxEdges": 20
  }
}
```

Output berisi `answer`, `confidence`, `basis`, `sources`, `missing_context`,
`suggested_next_actions`, dan `debug` retrieval count.

Retrieval MVP:

1. Query dinormalisasi lowercase, trim, dan punctuation sederhana dihapus.
2. Script membaca kandidat dari memory, node, edge, raw entry, dan cluster.
3. Scoring sederhana:
   - exact canonical/name match `+50`
   - alias match `+40`
   - content/token match `+20`
   - summary/description match `+15`
   - relation type match `+10`
- `importance_score / 10`
   - `frequency_score` capped sampai `+10`
   - `confidence_score * 10`
   - recency bonus sampai `+10`
   - `review_status = approved` bonus `+10`
   - ignored/deleted/merged dipenalti besar
4. Top nodes dipakai untuk mengambil edge terhubung.
5. `source_entry_id` dari node/edge/memory dipakai untuk menarik raw entry terkait.
6. Script menyusun `context_pack`, lalu memanggil LLM.

Context pack berbentuk:

```json
{
  "query": "pertanyaan user",
  "relevant_memories": [],
  "relevant_nodes": [],
  "relevant_edges": [],
  "relevant_raw_entries": [],
  "warnings": [],
  "limits": {
    "nodes": 12,
    "edges": 20,
    "raw_entries": 5,
    "agent_memories": 10
  }
}
```

LLM provider:

- `BRAIN_CHAT_PROVIDER=claude-code|anthropic|openai|ollama`
- Jika `BRAIN_CHAT_*` kosong, script reuse konfigurasi `LLM_*`,
  `ANTHROPIC_*`, atau `OLLAMA_*` yang sudah dipakai worker.
- Service role/API key tetap hanya dibaca script lokal, bukan browser.

Jika tidak ada memory relevan, agent menjawab:

```text
Memory yang tersedia belum cukup untuk menjawab ini. Tambahkan diary atau review graph terlebih dahulu.
```

Jika LLM gagal atau output bukan JSON valid, script tetap mengembalikan fallback
answer berbasis retrieval lokal dan sources yang ditemukan.

Brain Chat tidak melakukan:

- tulis/update/delete `brain_nodes`, `brain_edges`, `raw_entries`, atau memory;
- merge node;
- proses diary;
- ubah file Obsidian;
- upload/parser file;
- embedding/vector search;
- fine-tuning;
- agent action otomatis.

Testing manual:

1. Jalankan `npm run dev`.
2. Pastikan graph punya data.
3. Buka `Chat`.
4. Tanya `Apa itu Personal Brain OS?`.
5. Tanya `Apa pola buruk yang sering muncul?`.
6. Tanya `Apa hubungan Obsidian dengan Personal Brain OS?`.
7. Tanya hal yang tidak ada datanya; pastikan agent tidak mengarang.
8. Pastikan sources tampil.
9. Jalankan `npm run build`.
10. Cek bundle production tidak memuat service role key.

## 9. Attachment & File Ingestion MVP

Fase 9 menambahkan importer attachment local-first. Importer hanya mengubah file
menjadi teks/deskripsi dan memasukkannya ke `raw_entries`; pemrosesan node/edge
tetap dilakukan oleh `brain-worker.mjs`.

Lokasi default:

```text
AhyarBrainVault/80_Attachments
```

Format yang didukung:

- `.md`, `.txt`
- `.pdf`
- `.docx`
- `.png`, `.jpg`, `.jpeg`, `.webp`

Konfigurasi lokal di `scripts/brain-worker.env`:

```env
ATTACHMENT_IMPORT_DIR=80_Attachments
ATTACHMENT_IMPORT_LIMIT=5
ATTACHMENT_MAX_FILE_SIZE_MB=20
ATTACHMENT_VISION_ENABLED=false
ATTACHMENT_PDF_ENABLED=true
ATTACHMENT_DOCX_ENABLED=true
ATTACHMENT_IMAGE_ENABLED=true
```

Import manual:

```bash
cd frontend
npm run attachments:import
```

Watch mode:

```bash
npm run attachments:import:watch
```

Watch mode polling folder attachment setiap 30 detik. File failed tidak diretry
terus-menerus; importer memakai cooldown minimal 5 menit.

Frontend dev server menampilkan tombol `Import Attachments` jika:

```env
VITE_ATTACHMENT_IMPORTER_ENABLED=true
```

Tombol itu memanggil endpoint lokal:

```text
POST /__attachments/import
```

Endpoint hanya menjalankan script tetap:

```bash
npm run attachments:import -- --limit 5
```

Tidak ada path custom, command arbitrary, atau shell args bebas dari browser.

Cara kerja:

1. Importer scan recursive `80_Attachments`.
2. File hidden, ekstensi tidak didukung, dan file terlalu besar dilewati.
3. Kandidat diprioritaskan dari file terbaru dan dibatasi `ATTACHMENT_IMPORT_LIMIT`.
4. Importer hitung `sha256`.
5. Dedup dicek lewat `brain_files`: `user_id`, `obsidian_path`, `file_name`,
   `file_size`, dan `metadata.checksum`.
6. Markdown/TXT dibaca langsung; frontmatter Markdown dihapus.
7. PDF memakai command lokal `pdftotext` jika tersedia, lalu fallback parser PDF
   sederhana untuk PDF text-based.
8. DOCX memakai command lokal `unzip -p file.docx word/document.xml`.
9. Image tanpa vision tidak dikarang; raw entry dibuat `needs_review`.
10. Image dengan `ATTACHMENT_VISION_ENABLED=true` memakai provider vision
    `openai` atau `anthropic`.
11. Metadata file ditulis ke `brain_files`.
12. Hasil ekstraksi/deskripsi ditulis ke `raw_entries`.
13. Entry `pending` diproses oleh existing Brain Worker:

```bash
npm run brain:worker -- --limit 1 --raw-entry-id <raw_entry_id>
```

Catatan schema:

- Fase 9 menambahkan migration kecil:
  `supabase/migrations/20260612093000_allow_attachment_source_origin.sql`.
- Migration ini mengizinkan `raw_entries.source_origin = attachment` dan
  `brain_files.source_origin = obsidian_attachment`.
- Jika migration belum diterapkan, script fallback ke `source_origin = upload`
  dan menyimpan detail fase ini di `metadata.source_origin_detail`.

Log import:

```text
AhyarBrainVault/_system/logs/attachment-importer-YYYY-MM-DD.md
```

Testing manual:

1. Buat `AhyarBrainVault/80_Attachments/test-brain-note.txt`.
2. Isi file dengan kalimat tentang Personal Brain OS dan attachment importer.
3. Jalankan `npm run attachments:import`.
4. Cek `brain_files`: ada row file baru, `metadata.checksum`, dan status.
5. Cek `raw_entries`: ada row baru untuk file itu.
6. Jalankan ulang import; file yang sama harus skipped.
7. Coba PDF kecil dan DOCX kecil.
8. Coba gambar kecil; jika vision disabled, status harus `needs_review` tanpa
   mengarang isi gambar.
9. Klik `Import Attachments` dari frontend.
10. Jalankan `npm run build`.

## 10. Semantic Memory Index

Fase 10 menambahkan vector search agar Brain Chat bisa mencari memory berdasarkan
makna, bukan hanya keyword. Retrieval keyword/graph lama tetap dipakai; semantic
retrieval hanya menjadi peningkatan dan selalu punya fallback.

Migration:

```text
supabase/migrations/20260612103000_add_semantic_memory_index.sql
```

Migration ini:

- menjalankan `create extension if not exists vector`;
- menambahkan kolom `embedding vector(1536)` ke `brain_nodes`, `brain_edges`,
  `agent_memories`, dan `raw_entries`;
- menambahkan `embedding_model`, `embedding_provider`, `embedded_at`, dan
  `embedding_text_hash`;
- membuat index `ivfflat` cosine;
- membuat RPC `match_semantic_memory`.

Default dimensi embedding adalah `1536`. Jika provider memakai dimensi lain,
buat migration baru yang mengubah tipe kolom vector; jangan mencampur dimensi
berbeda dalam kolom yang sama.

Konfigurasi lokal di `scripts/brain-worker.env`:

```env
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
EMBEDDING_DIMENSIONS=1536
BRAIN_INDEX_LIMIT=25
BRAIN_INDEX_FORCE=false
```

Provider yang didukung:

- `openai` untuk OpenAI-compatible `/v1/embeddings`;
- `ollama` untuk local `/api/embeddings`;
- `disabled` untuk mematikan semantic retrieval dan memakai keyword fallback.

API key hanya dibaca script lokal dan endpoint Vite lokal. Jangan menaruh
embedding key di env frontend browser.

Index manual:

```bash
cd frontend
npm run brain:index
npm run brain:index -- --limit 50
npm run brain:index -- --table brain_nodes
npm run brain:index -- --force --limit 10
```

Watch mode:

```bash
npm run brain:index:watch
```

Watch mode polling setiap 60 detik dan memakai limit default. Indexer
memprioritaskan item tanpa embedding, menghitung hash teks, lalu skip item yang
hash/model/provider-nya belum berubah. `--force` memaksa reindex.

Teks embedding:

- `brain_nodes`: type, name, canonical, aliases, summary, description, cluster,
  importance, frequency, confidence, review status.
- `brain_edges`: relation, summary, from/to node name, weight, confidence,
  review status.
- `agent_memories`: memory type, content, importance, stability, sensitivity.
- `raw_entries`: title, content terbatas, source origin/type, happened date,
  processing status.

Log indexer:

```text
AhyarBrainVault/_system/logs/brain-indexer-YYYY-MM-DD.md
```

Endpoint lokal:

```text
POST /__brain-indexer/index
POST /__brain-indexer/search
```

`/index` hanya menjalankan:

```bash
npm run brain:index -- --limit 25
```

`/search` menerima query, limit, dan daftar table terbatas. Tidak ada arbitrary
SQL, path, atau shell command dari browser.

Frontend menampilkan tombol `Reindex Brain` jika:

```env
VITE_BRAIN_INDEXER_ENABLED=true
```

Brain Chat memakai retrieval gabungan:

1. keyword + graph traversal lama tetap berjalan;
2. semantic query embedding dibuat jika provider aktif;
3. RPC `match_semantic_memory` mengambil hit semantic;
4. hit semantic diberi bonus score dan digabung dengan score keyword, importance,
   frequency, confidence, review status, dan recency;
5. context pack menambahkan:

```json
{
  "retrieval_methods": ["keyword", "semantic", "graph"],
  "semantic_enabled": true,
  "semantic_warnings": []
}
```

Jika embedding provider gagal, RPC belum ada, atau pgvector belum aktif, Brain
Chat tetap menjawab dengan keyword retrieval dan menampilkan warning di debug.

Testing manual:

1. Jalankan migration `20260612103000_add_semantic_memory_index.sql`.
2. Isi env embedding.
3. Jalankan `npm run brain:index`.
4. Cek beberapa row di `brain_nodes`, `brain_edges`, `agent_memories`, dan
   `raw_entries` punya `embedding`.
5. Jalankan `npm run dev`.
6. Klik `Reindex Brain`.
7. Buka Chat dan tanya pertanyaan semantik seperti `Apa masalah saya yang sering muncul?`.
8. Matikan `EMBEDDING_PROVIDER` atau buat provider gagal; Chat harus tetap jalan.
9. Jalankan `npm run build`.
10. Cek bundle production tidak memuat service role atau API key embedding.

## 11. Obsidian Knowledge Sync

Fase 11 menambahkan **Obsidian Knowledge Sync**: sinkronisasi deterministic dari
Supabase structured brain kembali ke Obsidian Vault. Tujuannya agar node dan
relasi yang sudah direview/terstruktur bisa dibaca sebagai halaman Markdown,
dengan backlink dan index rapi.

Script:

```bash
npm run obsidian:sync
npm run obsidian:sync:watch
```

Dry-run:

```bash
npm run obsidian:sync -- --dry-run
```

Filter:

```bash
npm run obsidian:sync -- --type project
npm run obsidian:sync -- --node-id <uuid>
npm run obsidian:sync -- --indexes-only
```

Konfigurasi di `scripts/brain-worker.env`:

```env
OBSIDIAN_SYNC_ENABLED=true
OBSIDIAN_SYNC_LIMIT=100
OBSIDIAN_SYNC_DRY_RUN=false
OBSIDIAN_SYNC_WRITE_INDEXES=true
OBSIDIAN_SYNC_INCLUDE_LOW_CONFIDENCE=true
```

Frontend menampilkan tombol `Sync Obsidian` jika:

```env
VITE_OBSIDIAN_SYNC_ENABLED=true
```

Tombol memanggil endpoint lokal:

```text
POST /__obsidian-sync/run
```

Endpoint hanya menerima opsi terbatas `dryRun`, `indexesOnly`, dan `limit`
maksimum 500. Endpoint tidak menerima path, command, atau shell args bebas.

Folder mapping:

| Node type | Folder |
|---|---|
| `person` | `10_People` |
| `project` | `20_Projects` |
| `place` | `30_Places` |
| `event` | `40_Events` |
| `decision` | `50_Decisions` |
| `pattern` | `60_Patterns` |
| `goal` | `70_Goals` |
| `organization` | `90_Knowledge/Organizations` |
| `tool` | `90_Knowledge/Tools` |
| `topic` | `90_Knowledge/Topics` |
| `document` | `90_Knowledge/Documents` |
| `emotion` | `90_Knowledge/Emotions` |

File node memakai `canonical_name` sebagai basis filename, disanitasi untuk
filesystem, dan menyimpan `brain_node_id` di frontmatter. Jika filename bentrok,
script menambahkan suffix type atau id pendek.

Bagian otomatis dibatasi marker:

```text
<!-- BRAIN_OS_AUTO_START -->
...
<!-- BRAIN_OS_AUTO_END -->
```

Sync ulang hanya mengganti frontmatter brain fields dan isi di dalam marker ini.
Tulisan manual di luar marker dipertahankan. Script tidak menghapus file Obsidian.

Wikilink dibuat dari `brain_edges`:

- outgoing: `relation_type → [[Target]]`
- incoming: `relation_type ← [[Source]]`

Jika target node belum punya file, node itu dibuat pada sync yang sama dan link
mengarah ke file target.

Index dibuat di:

```text
AhyarBrainVault/_system/indexes/
```

Index yang dibuat:

- `All Brain Nodes.md`
- `Projects.md`
- `People.md`
- `Patterns.md`
- `Goals.md`
- `Recent Changes.md`

Log sync:

```text
AhyarBrainVault/_system/logs/obsidian-sync-YYYY-MM-DD.md
```

Testing manual:

1. Jalankan `npm run obsidian:sync -- --dry-run`.
2. Jalankan `npm run obsidian:sync`.
3. Buka Obsidian dan cek folder node sesuai type.
4. Tambahkan tulisan manual di luar auto section.
5. Jalankan sync ulang; tulisan manual harus tetap ada.
6. Cek wikilink di section relasi.
7. Cek index di `_system/indexes`.
8. Klik `Sync Obsidian` dari frontend.
9. Jalankan `npm run build`.

## 12. Yang Akan Dikerjakan di Fase Berikutnya

- ❌ Sync dua arah node/edge kembali ke catatan Obsidian.
- ❌ Production backend untuk quality control / brain chat / attachment import.
- ❌ Chat history table / persistent conversation memory.
- ❌ Agent tools/action otomatis.
- ❌ Agent multi-role.
- ❌ OCR lokal untuk gambar tanpa vision provider.
- ❌ Parser audio/video.
- ❌ Semantic duplicate merge otomatis.
- ❌ Hybrid reranker/model ranking.
- ❌ Delete/rename file Obsidian otomatis.
- ❌ Two-way conflict resolution.

## 13. Local Brain Worker

Quick input bisa memproses entry lokal lewat:

```bash
npm run brain:worker
npm run brain:worker:watch
```

Konfigurasi lokal ada di:

```text
scripts/brain-worker.env
```

File ini tidak boleh di-commit karena berisi service role key dan/atau API key.

## 14. Obsidian Vault Importer

Importer membaca diary Markdown dari vault Obsidian, memasukkannya ke
`raw_entries`, lalu memanggil `brain-worker.mjs` untuk extraction.

Konfigurasi di `scripts/brain-worker.env`:

```env
OBSIDIAN_VAULT_PATH=../AhyarBrainVault
OBSIDIAN_DIARY_DIR=00_Diary
OBSIDIAN_IMPORT_LIMIT=5
```

Jika relative path membingungkan, pakai absolut:

```env
OBSIDIAN_VAULT_PATH=/home/bgpaten/Documents/AIAgent/BrainDiary/AhyarBrainVault
```

Import manual:

```bash
cd frontend
npm run obsidian:import
```

Watch mode sederhana memakai polling:

```bash
npm run obsidian:import:watch
```

Frontend dev server juga punya tombol `Import Obsidian` di sidebar jika:

```env
VITE_OBSIDIAN_IMPORTER_ENABLED=true
```

Tombol itu memanggil endpoint lokal tetap:

```text
POST /__obsidian-importer/import
```

Endpoint ini hanya ada di Vite dev server lokal dan hanya menjalankan script
tetap `npm run obsidian:import -- --limit 5`; tidak menerima command arbitrary.

Importer hanya memproses file `.md` recursive di `00_Diary` dengan frontmatter:

```yaml
type: diary
processed: false
```

Jika `processed` tidak ada, importer menganggap `false` dan menulis warning ke
log. Jika file sudah `processed: true`, file dilewati.

Setelah sukses, frontmatter diperbarui:

```yaml
processed: true
processing_status: done
raw_entry_id: "<uuid>"
processed_at: "<timestamp ISO>"
```

Jika gagal:

```yaml
processed: false
processing_status: failed
last_error: "pesan error"
last_attempted_at: "<timestamp ISO>"
```

Log import ditulis ke:

```text
AhyarBrainVault/_system/logs/obsidian-importer-YYYY-MM-DD.md
```

Dedup dilakukan dengan:

- `user_id`
- `source_origin = obsidian`
- `obsidian_path`

Jika raw entry untuk path yang sama sudah ada, importer tidak insert ulang dan
akan memakai `raw_entry_id` yang sudah ada.

---

## Struktur File

```
frontend/
├── .env.example
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── scripts/
│   ├── brain-worker.mjs              # raw_entries -> nodes/edges/memories
│   ├── brain-quality.mjs             # merge/delete quality operations
│   ├── brain-chat.mjs                # Brain Chat reader script
│   ├── brain-indexer.mjs             # semantic embedding indexer/search
│   ├── brain-digest.mjs              # timeline intelligence + report generator
│   ├── persona-builder.mjs           # persona profile builder read-only
│   ├── obsidian-importer.mjs         # diary importer
│   ├── obsidian-sync.mjs             # Supabase nodes/edges -> Obsidian pages
│   └── attachment-importer.mjs       # attachment/file importer
└── src/
    ├── main.tsx
    ├── App.tsx                       # orchestrator: auth, fetch, state, layout
    ├── index.css                     # dark mode, layout
    ├── components/
    │   ├── BrainVisualizer.tsx       # cytoscape graph + stylesheet + layout cose
    │   ├── BrainNodeDetailPanel.tsx  # detail node saat diklik
    │   ├── BrainQualityReview.tsx    # review duplicate/low-confidence/failed items
    │   ├── BrainChat.tsx             # Brain Chat MVP read-only
    │   ├── BrainTimeline.tsx         # timeline raw entries + active nodes
    │   ├── BrainDigest.tsx           # daily/weekly/monthly digest UI
    │   ├── BrainToolbar.tsx          # filter type + cluster + refresh
    │   ├── QuickDiaryInput.tsx       # form → insert raw_entries
    │   ├── EmptyBrainState.tsx       # empty/loading/error/config state
    │   └── LoginRequired.tsx         # login minimal (RLS butuh session)
    ├── lib/
    │   ├── supabase.ts               # client (anon key)
    │   ├── brainQuality.ts           # duplicate detection + review helper
    │   ├── brainChat.ts              # client POST /__brain-chat/ask
    │   ├── personaRouter.ts          # heuristic auto mode router
    │   ├── personaPrompt.ts          # persona prompt rules
    │   ├── brainGraphMapper.ts       # brain_nodes/edges → elemen cytoscape
    │   └── devFallbackData.ts        # data dummy dev (terpisah, opsional)
    └── types/
        ├── brain.ts                  # tipe domain
        └── react-cytoscapejs.d.ts    # deklarasi tipe lib graph
```

## Aturan Visual Graph

- Ukuran node ← `frequency_score` (sering muncul → lebih besar).
- Ketebalan border node ← `importance_score` (penting → menonjol).
- Opacity node ← `confidence_score` (rendah → redup; `<0.7` border putus-putus).
- Node `pending_review` diberi border kuning.
- Lebar edge ← `weight`.
- Label node ← `name`; label edge ← `relation_type`.
- Bentuk node berbeda per `type`.
- Warna node ← `color_key` cluster (fallback warna per type).
- Layout awal: **cose** (force-directed).

## 12. Timeline Intelligence + Brain Digest

Fase 12 menambahkan **Timeline View** dan **Digest View** untuk membaca perubahan
brain dari waktu ke waktu. Fitur ini bersifat analitis: tidak mengubah
`brain_nodes`, `brain_edges`, diary, atau memory tanpa approval.

Migration baru:

```bash
supabase db push
```

Migration `20260612113000_create_brain_reports.sql` membuat table
`brain_reports` dengan RLS `auth.uid() = user_id`. Report disimpan terpisah dari
`agent_memories` agar ringkasan periodik tidak bercampur dengan memory operasional.

Konfigurasi lokal ada di `scripts/brain-worker.env`:

```env
BRAIN_DIGEST_PROVIDER=claude-code
BRAIN_DIGEST_MODEL=model-name
BRAIN_DIGEST_API_KEY=
BRAIN_DIGEST_BASE_URL=
BRAIN_DIGEST_OUTPUT_OBSIDIAN=true
BRAIN_DIGEST_LIMIT_RAW_ENTRIES=50
BRAIN_DIGEST_LIMIT_NODES=50
BRAIN_DIGEST_LIMIT_EDGES=100
BRAIN_DIGEST_LIMIT_MEMORIES=50
```

Jika provider kosong, digest reuse `BRAIN_CHAT_*` atau `LLM_*`. Set
`BRAIN_DIGEST_PROVIDER=disabled` untuk fallback deterministic tanpa LLM.

Command manual:

```bash
npm run brain:digest -- --type daily
npm run brain:digest:today
npm run brain:digest:week
npm run brain:digest:month
npm run brain:digest -- --type custom --from 2026-06-01 --to 2026-06-12
npm run brain:digest:watch
```

Script `scripts/brain-digest.mjs` membaca:

- `raw_entries`
- `brain_nodes`
- `brain_edges`
- `agent_memories`
- `extraction_jobs`
- `brain_clusters`

Lalu menyusun context periode, memanggil LLM model-agnostic bila tersedia,
menyimpan JSON structured report ke `brain_reports`, menulis Markdown ke
`AhyarBrainVault/_system/reports/`, dan menulis log ke:

```text
AhyarBrainVault/_system/logs/brain-digest-YYYY-MM-DD.md
```

Output Obsidian memakai marker aman:

```text
<!-- BRAIN_DIGEST_AUTO_START -->
<!-- BRAIN_DIGEST_AUTO_END -->
```

Jika file report sudah ada, hanya section otomatis yang diganti. Tulisan manual di
luar marker tetap aman.

Endpoint lokal:

```text
POST /__brain-digest/generate
```

Input dibatasi pada `type`, `from`, `to`, dan `force`; endpoint tidak menerima
command/path arbitrary dan hanya tersedia di Vite dev server lokal.

Frontend:

- `Timeline` menampilkan raw entries, event, decision, goal, pattern, dan project
  aktif berdasarkan tanggal dengan filter today / 7 days / 30 days.
- `Digest` menampilkan report terbaru, filter daily/weekly/monthly, tombol
  Generate Today, Generate This Week, dan Generate This Month.
- Digest menampilkan summary, highlights, active projects, repeated patterns,
  decisions, risks, suggested next actions, memory quality warning, dan sources.

Testing manual:

1. Jalankan migration.
2. Jalankan `npm run brain:digest:today`.
3. Pastikan row masuk ke `brain_reports`.
4. Pastikan file Markdown muncul di `_system/reports/daily`.
5. Jalankan `npm run brain:digest:week`.
6. Jalankan `npm run dev`, buka `Digest`, klik Generate This Week.
7. Buka `Timeline`, cek item muncul sesuai periode.
8. Jalankan `npm run build`.

Batasan fase ini:

- Tidak ada agent action otomatis.
- Tidak ada edit otomatis node/edge.
- Tidak ada backend production.
- Tidak ada calendar/email/mobile/notifikasi.
- Brain Chat tetap berjalan dengan retrieval yang sudah ada.

## 13. Persona Layer + Self-Clone Chat

Fase 13 menambahkan **Persona Layer** di atas Brain Chat. Tujuannya bukan membuat
chatbot umum, tetapi membuat agent reader yang bisa memilih gaya respons otomatis
berdasarkan niat pertanyaan dan persona profile dari brain data.

Prinsip:

- Tidak ada dropdown mode chat.
- User tidak memilih mode manual.
- Brain Chat menentukan mode otomatis dari prompt dan context.
- Agent tetap read-only: tidak mengubah `brain_nodes`, `brain_edges`, diary, atau
  report.
- Agent tidak boleh mengaku sebagai user asli.
- Inferensi harus ditandai sebagai inferensi.

Command persona:

```bash
npm run brain:persona
npm run brain:persona:refresh
```

Script `scripts/persona-builder.mjs` membaca:

- `agent_memories`
- `brain_nodes` tipe `goal`, `pattern`, `decision`, `project`, `emotion`
- `brain_reports`
- `raw_entries` terbaru

Lalu membuat persona profile di:

```text
AhyarBrainVault/_system/persona/Persona Profile.md
```

File memakai marker aman:

```text
<!-- BRAIN_PERSONA_AUTO_START -->
<!-- BRAIN_PERSONA_AUTO_END -->
```

Tulisan manual di luar marker tidak ditimpa. Log builder ditulis ke:

```text
AhyarBrainVault/_system/logs/persona-builder-YYYY-MM-DD.md
```

Env lokal:

```env
PERSONA_BUILDER_ENABLED=true
PERSONA_PROFILE_OUTPUT_OBSIDIAN=true
PERSONA_PROFILE_MIN_ENTRIES=5
PERSONA_PROFILE_MAX_RAW_ENTRIES=50
PERSONA_PROFILE_MAX_MEMORIES=100
PERSONA_PROFILE_MAX_REPORTS=10
PERSONA_PROFILE_WRITE_MEMORY=false
```

Default `PERSONA_PROFILE_WRITE_MEMORY=false`, jadi builder tidak menulis memory
otomatis. Ini menjaga fase ini tetap read-only terhadap brain graph dan tidak
membuat memory edit otomatis.

Mode internal otomatis:

- `factual_brain_reader` untuk pertanyaan faktual.
- `self_clone_reflection` untuk refleksi diri.
- `strategic_mirror` untuk strategi, fokus, dan eksekusi.
- `diary_owner_voice` untuk jawaban dengan gaya yang mirip voice memory.
- `contradiction_detector` untuk kontradiksi, pola buruk, dan romantisasi.
- `planning_guard` untuk menahan scope creep atau roadmap/fitur baru tanpa bukti.
- `unknown_or_insufficient_memory` saat context tidak cukup.

Routing MVP ada di `src/lib/personaRouter.ts` dan versi runtime-nya dipakai oleh
`scripts/brain-chat.mjs`. Logic-nya heuristic lokal: normalize prompt, cek keyword
intent, cek jumlah context source, lalu memberi `mode`, `reason`, dan `confidence`.

Prompt rules ada di `src/lib/personaPrompt.ts` dan juga direplikasi di runtime
Brain Chat. Prompt menambahkan grounding rules, style instruction dari persona
profile, dan aturan mode-specific.

Brain Chat response sekarang berisi metadata:

```json
{
  "persona_mode": "strategic_mirror",
  "persona_reason": "Pertanyaan meminta evaluasi strategi dan fokus eksekusi.",
  "persona_confidence": 0.87,
  "style_warnings": [],
  "debug": {
    "persona_profile_used": true
  }
}
```

UI Chat:

- Menampilkan badge kecil `Auto Mode: Strategic Mirror`.
- Menampilkan reason/confidence lewat title dan debug line.
- Menampilkan warning jika persona profile belum tersedia.
- Menyediakan tombol `Refresh Persona`.
- Tidak ada dropdown mode.

Endpoint lokal:

```text
POST /__brain-persona/refresh
```

Endpoint hanya menerima `{ "force": boolean }`, hanya berjalan di Vite dev
server, dan hanya menjalankan script tetap `npm run brain:persona` atau
`npm run brain:persona:refresh`.

Testing manual:

```bash
cd frontend
npm run brain:persona
npm run dev
```

Pertanyaan untuk cek mode:

- `Apa itu Personal Brain OS?` → `factual_brain_reader`
- `Apa yang harus saya fokuskan sekarang?` → `strategic_mirror`
- `Apa yang saya bilang tapi tidak saya lakukan?` → `contradiction_detector`
- `Jawab seperti saya: kenapa saya harus lanjut membangun Personal Brain OS?` → `diary_owner_voice`
- `Lanjut fitur apa lagi?` → `planning_guard`
- Pertanyaan tentang topik tanpa memory → `unknown_or_insufficient_memory` atau
  jawaban jujur bahwa context belum cukup.

Tetap cek:

```bash
npm run build
```

Pastikan bundle tidak mengandung service role key, LLM key, embedding key, atau
secret persona.

## 13. Brain Evaluation / Memory Accuracy Test

Fase 14 menambahkan evaluator lokal untuk memastikan Brain Chat dan Persona Layer
akurat, grounded, menampilkan source yang benar, dan jujur ketika memory tidak
cukup. Ini quality gate, bukan fitur user-facing utama.

Migration:

```text
supabase/migrations/20260612140000_create_brain_evaluations.sql
```

Migration membuat table `brain_eval_cases`, `brain_eval_runs`, dan
`brain_eval_results`, semuanya dengan RLS `auth.uid() = user_id`.

Command:

```bash
cd frontend
npm run brain:eval:cases
npm run brain:eval
npm run brain:eval:latest
npm run brain:eval:watch
```

`brain:eval:cases` membuat starter test cases dari `brain_nodes`,
`brain_edges`, `agent_memories`, `brain_reports`, dan `raw_entries`. Generator
membuat factual, source grounding/relationship, pattern, insufficient memory,
persona mode, contradiction, planning guard, timeline, digest, dan semantic
retrieval cases. Relationship case disimpan sebagai `source_grounding` karena
enum migration tidak punya `relationship`.

`brain:eval` membaca cases, memanggil existing Brain Chat (`npm run brain:chat`)
untuk tiap pertanyaan, lalu menyimpan hasil ke `brain_eval_results` dan summary
ke `brain_eval_runs`. Evaluator tidak mengubah node, edge, raw entry, report,
atau memory.

Scoring 0..1:

- `retrieval_accuracy` — apakah memory yang relevan ikut terambil.
- `source_accuracy` — apakah sources valid dan mendukung expected source.
- `groundedness` — apakah jawaban berbasis context, bukan klaim bebas.
- `hallucination_risk` — 0 aman, 1 berisiko tinggi.
- `persona_mode_accuracy` — apakah mode sesuai expected mode.
- `insufficient_memory_handling` — apakah agent mengaku data kurang.
- `answer_usefulness` — apakah jawaban menjawab pertanyaan dengan berguna.

Pass rule: average score minimal `BRAIN_EVAL_MIN_PASS_SCORE` (default `0.7`),
`hallucination_risk <= 0.3`, dan expected persona mode cocok atau kompatibel.

Optional LLM judge:

```env
BRAIN_EVAL_PROVIDER=claude-code
BRAIN_EVAL_MODEL=model-name
BRAIN_EVAL_API_KEY=YOUR_KEY
BRAIN_EVAL_BASE_URL=https://provider.example.com
BRAIN_EVAL_USE_LLM_JUDGE=false
```

Jika `BRAIN_EVAL_USE_LLM_JUDGE=false`, scoring deterministic tetap berjalan.
Jika `true`, judge hanya menambah penilaian; output wajib JSON dan tidak boleh
menulis brain data.

Report Obsidian ditulis ke:

```text
AhyarBrainVault/_system/evaluations/Latest Brain Evaluation.md
AhyarBrainVault/_system/evaluations/Brain Evaluation YYYY-MM-DD HH-mm.md
```

Report berisi summary score, failed cases, hallucination warnings, persona mode
errors, source errors, weakest area, dan recommended fixes. Konten otomatis
dibatasi marker:

```text
<!-- BRAIN_EVAL_AUTO_START -->
<!-- BRAIN_EVAL_AUTO_END -->
```

Frontend:

1. Jalankan `npm run dev`.
2. Login.
3. Buka mode `Evaluation` di sidebar.
4. Klik `Generate Test Cases`.
5. Klik `Run Evaluation`.
6. Buka failed case untuk melihat question, answer, expected/actual mode,
   sources, scores, failure reason, dan judge feedback.

Endpoint dev lokal:

```text
POST /__brain-eval/generate-cases
POST /__brain-eval/run
```

Endpoint hanya menerima `limit`, `force`, dan `useJudge`; tidak menerima command
atau path arbitrary. Secret tetap hanya di script/server lokal, bukan bundle
browser.

Testing manual:

```bash
cd frontend
npm run brain:eval:cases
npm run brain:eval
npm run dev
npm run build
```

Setelah build, pastikan bundle tidak mengandung:

```text
SUPABASE_SERVICE_ROLE_KEY
service_role
BRAIN_EVAL_API_KEY
BRAIN_CHAT_API_KEY
LLM_API_KEY
ANTHROPIC_API_KEY
```

Batasan fase ini: belum ada fine-tuning, task planner, agent action otomatis,
production backend, atau auto-fix node/edge/memory. Fase berikutnya bisa
memperluas eval dataset, menambah regression thresholds CI, dan memperbaiki
retrieval berdasarkan hasil failed cases.

---

## Phase 15: Daily Brain Routine + Stabilization

Daily Brain Routine adalah orchestrator lokal untuk menjalankan pipeline harian
Personal Brain OS secara berurutan dan bisa dipantau. Fitur ini tidak membuat
intelligence baru, tidak menjalankan agent action otomatis, dan tidak mengubah
node/edge di luar pipeline existing.

Urutan pipeline:

1. Import Obsidian diary.
2. Import attachments.
3. Process pending/failed raw entries.
4. Reindex semantic memory.
5. Refresh persona profile.
6. Sync knowledge back to Obsidian.
7. Generate daily digest.
8. Run lightweight brain evaluation.
9. Produce daily routine summary.

Command utama:

```bash
cd frontend
npm run brain:routine
npm run brain:routine:today
npm run brain:routine -- --dry-run
npm run brain:routine -- --skip-eval
npm run brain:routine -- --skip-attachments
npm run brain:routine -- --skip-sync
npm run brain:routine -- --limit 5
npm run brain:health
```

`--dry-run` hanya menampilkan step yang akan dijalankan. Mode ini tidak
menjalankan importer/worker/indexer/digest/eval, tidak menulis Supabase, dan
tidak menulis Obsidian.

Health check mengecek env Supabase, service role lokal, path vault, folder diary
dan attachments, akses Supabase, table utama, secret di frontend env, latest eval
score, pending/failed raw entries, low confidence node/edge, duplicate
candidates, embedding provider, dan Brain Chat config. Output health check:
`healthy`, `warning`, atau `critical` dengan score 0-100.

Routine menyimpan run ke table `brain_routine_runs`:

- `routine_type`: `daily`, `manual`, atau `health_check`.
- `status`: `done`, `partial`, atau `failed`.
- `steps`: status step-by-step (`pending`, `running`, `done`, `failed`,
  `skipped`).
- `metrics`: pending/failed raw entries, counts node/edge, low confidence count,
  duplicate candidate estimate, latest eval score, hallucination risk, dan
  parsed command metrics bila tersedia dari stdout.
- `warnings` dan `errors`: warning eval gate, low confidence, failed raw entry,
  dan error step.

Eval gate tidak membuat routine gagal total. Jika evaluation score di bawah
`BRAIN_ROUTINE_EVAL_MIN_SCORE` atau hallucination risk di atas
`BRAIN_ROUTINE_MAX_HALLUCINATION_RISK`, routine diberi status `partial` dan
warning: brain belum cukup akurat untuk dipercaya penuh.

Output Obsidian:

```text
AhyarBrainVault/_system/routine/Daily Brain Routine Latest.md
AhyarBrainVault/_system/routine/Daily Brain Routine YYYY-MM-DD HH-mm.md
AhyarBrainVault/_system/logs/brain-routine-YYYY-MM-DD.md
```

Konten otomatis dibatasi marker:

```text
<!-- BRAIN_ROUTINE_AUTO_START -->
<!-- BRAIN_ROUTINE_AUTO_END -->
```

Frontend:

1. Jalankan `npm run dev`.
2. Login.
3. Buka mode `Routine` di sidebar.
4. Pilih toggle attachments/evaluation/sync/dry-run.
5. Klik `Run Health Check` atau `Run Daily Routine`.

Endpoint dev lokal:

```text
POST /__brain-routine/run
POST /__brain-routine/health
```

Endpoint hanya menerima type whitelist, boolean flags, dan limit maksimal 50.
Endpoint tidak menerima command atau path arbitrary dan hanya untuk dev/local.

Watch mode:

```bash
npm run brain:routine:watch
```

Mode watch memakai interval panjang (`BRAIN_ROUTINE_WATCH_INTERVAL_MS`, default
6 jam). Ini bukan daemon production atau scheduler OS; gunakan hati-hati dari
terminal lokal.

Batasan fase ini: belum ada production backend, scheduler OS otomatis,
calendar/email/notifikasi, task planner, agent action otomatis, atau auto-fix
brain data. Fase berikutnya bisa menambah scheduler lokal eksplisit, dashboard
trend routine, dan regression budget yang lebih ketat.

---

## Phase 16: Brain Backup, Export & Recovery

Brain Backup adalah sistem local-first untuk membuat snapshot Personal Brain OS,
mengecek isi backup sebelum restore, melakukan restore Supabase secara
non-destructive, dan menjalankan recovery audit.

Yang dibackup dari Supabase:

- `raw_entries`
- `brain_nodes`
- `brain_edges`
- `brain_clusters`
- `brain_files`
- `extraction_jobs`
- `agent_memories`
- `brain_reports`
- `brain_eval_cases`
- `brain_eval_runs`
- `brain_eval_results`
- `brain_routine_runs`
- `brain_health_checks`

Jika table belum ada atau schema cache Supabase belum refresh, backup tidak
gagal total. Table tersebut dicatat sebagai warning/missing table dan backup
table lain tetap lanjut. Jika Fase 15 table masih bermasalah, apply migration
`20260612150000_create_brain_routine_runs.sql` lewat Supabase CLI/SQL Editor
lalu reload schema cache.

Yang dibackup dari lokal:

- `AhyarBrainVault` ke folder `obsidian-vault/`.
- `frontend/.env.example` dan `frontend/scripts/brain-worker.env.example`.
- `package.json` scripts.

Yang tidak dibackup default:

- `.env` aktual yang berisi secret.
- `node_modules`.
- `frontend/dist`.
- cache/trash/temp files.
- cloud backup otomatis.

Folder output:

```text
backups/brain-backup-YYYY-MM-DD-HH-mm-ss/
  manifest.json
  supabase/*.json
  obsidian-vault/
  config/
  logs/backup-log.md
```

Command:

```bash
cd frontend
npm run brain:backup
npm run brain:backup -- --no-vault
npm run brain:backup -- --tables brain_nodes,brain_edges
npm run brain:backup -- --include-env false
npm run brain:backup:list
npm run brain:restore:preview -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss
npm run brain:restore -- --backup backups/brain-backup-YYYY-MM-DD-HH-mm-ss --confirm
npm run brain:recovery -- --check
```

`manifest.json` berisi `backup_id`, `created_at`, `backup_version`, `user_id`,
included tables, row counts, missing tables, vault file count, total size,
checksum, warnings, errors, dan restore notes.

Restore preview hanya membaca backup dan membandingkan jumlah row backup dengan
row saat ini. Restore tanpa `--confirm` selalu ditolak. Restore MVP hanya
`upsert` berdasarkan `id`; tidak menghapus data existing dan tidak melakukan
destructive restore. Restore Obsidian Vault belum otomatis; folder vault backup
tersedia untuk recovery manual setelah user membuat pre-restore backup.

Recovery check bersifat read-only. Audit mengecek canonical name kosong,
dangling edge, duplicate candidates, failed raw entries/jobs, file tanpa
`raw_entry_id`, report kosong, eval score rendah, routine partial/failed,
referensi Obsidian yang tidak cocok, embedding missing, persona stale, digest
hari ini, dan umur backup terakhir.

Output Obsidian:

```text
AhyarBrainVault/_system/backups/Latest Backup.md
AhyarBrainVault/_system/logs/brain-backup-YYYY-MM-DD.md
AhyarBrainVault/_system/logs/brain-restore-YYYY-MM-DD.md
AhyarBrainVault/_system/logs/brain-recovery-YYYY-MM-DD.md
```

Frontend:

1. Jalankan `npm run dev`.
2. Buka mode `Backup`.
3. Klik `Create Backup`.
4. Pilih backup dari list.
5. Klik `Preview Latest Backup`.
6. Klik `Run Recovery Check`.
7. Restore dari UI membutuhkan checkbox konfirmasi dan tetap upsert-only.

Endpoint dev lokal:

```text
POST /__brain-backup/create
GET  /__brain-backup/list
POST /__brain-backup/preview-restore
POST /__brain-backup/restore
POST /__brain-backup/recovery-check
```

Endpoint hanya menerima boolean flags dan `backupId` dengan format folder backup
valid. Tidak menerima path arbitrary, tidak menerima command arbitrary, dan
hanya untuk dev/local.

Batasan fase ini: belum ada cloud backup otomatis, compression, encryption,
scheduled backup production, destructive restore, restore Obsidian otomatis, atau
auto-fix recovery. Fase berikutnya bisa menambah archive `.tar.gz`, enkripsi
lokal, verified restore sandbox, dan backup pruning dengan konfirmasi eksplisit.

---

## Phase 17: Final Polish, Performance & Release Hardening

Fase final menstabilkan MVP untuk pemakaian harian. Fokusnya bukan fitur
intelligence baru, tetapi recovery cleanup aman, lazy loading frontend, final
audit, release checklist, dan operating manual.

Perubahan utama:

- Mode frontend berat diload dengan `React.lazy` dan `Suspense`.
- Graph/Cytoscape dipisah dari initial bundle. Jika masih ada chunk warning,
  itu sudah terdokumentasi sebagai graph chunk.
- Merge/delete node/edge membutuhkan konfirmasi browser.
- Recovery cleanup opt-in tersedia:

```bash
npm run brain:recovery -- --check --fix
```

Cleanup hanya memperbaiki frontmatter Obsidian yang aman:

- menambahkan `brain_node_id` jika match node sangat jelas;
- menandai diary `processed: false`, `processing_status: needs_reimport` jika
  `raw_entry_id` tidak ditemukan.

Final audit:

```bash
npm run brain:audit
npm run brain:release-check
```

`brain:audit` mengecek env, vault, backup, frontend files, Supabase table utama,
brain data metrics, latest eval, latest routine, dan latest backup.

`brain:release-check` menjalankan audit yang lebih berat: syntax check script
utama, `npm run build`, dan secret scan `dist`.

Status output:

- `ready`: tidak ada blocker/warning.
- `warning`: bisa dipakai, tetapi ada hal yang perlu dipantau.
- `blocked`: jangan release sebelum blocker diperbaiki.

Dokumen final:

```text
docs/FINAL_OPERATING_MANUAL.md
docs/RELEASE_CHECKLIST.md
```

Known issue yang harus dibaca sebagai warning, bukan dipalsukan:

- latest eval score rendah berarti Brain belum cukup akurat untuk dipercaya
  penuh;
- latest routine `partial` harus dibaca dari Routine View;
- knowledge file tanpa `brain_node_id` hanya diperbaiki otomatis jika match
  confidence tinggi.

---

## Step 18: Identity Fidelity Engine

Identity Fidelity Engine membangun model identitas evidence-bound untuk arah
Personal Entity OS. Bedanya dengan Persona Profile: persona lama adalah ringkasan
gaya/konteks, sedangkan `identity_facts` adalah unit klaim identitas yang wajib
punya `evidence_refs`, `confidence_score`, `stability`, dan batas penggunaan.

Jalankan dari folder `frontend`:

```bash
npm run identity:build
npm run identity:build -- --limit 100
npm run identity:build -- --from 2026-06-01 --to 2026-06-12
npm run identity:refresh
npm run identity:snapshot
npm run identity:audit
```

Output Supabase:

- `identity_facts`: trait, belief, value, preference, goal, fear, ambition,
  decision pattern, communication pattern, emotional pattern, risk pattern,
  contradiction, boundary, dan identity summary.
- `identity_snapshots`: snapshot model identity dari waktu ke waktu.

Output Obsidian:

```text
AhyarBrainVault/_system/identity/Identity Fidelity Model.md
AhyarBrainVault/_system/identity/Identity Snapshot Latest.md
```

Brain Chat membaca `identity_facts` dan `identity_snapshots`. Untuk pertanyaan
personal, strategi diri, gaya diri, dan greeting seperti `hi`, identity facts
menjadi context utama. Klaim tegas hanya boleh memakai fact confidence tinggi;
confidence rendah hanya boleh disebut sebagai kemungkinan. Jika evidence belum
cukup, agent harus bilang data belum cukup.

Sapaan ringan seperti `hi`, `halo`, `p`, `bro`, dan `assalamu’alaikum`
diproses sebagai `social_response`: jawaban utama maksimal satu kalimat, tanpa
sources, basis, missing context, next actions, atau warning identity di UI.
Diagnostics tetap ada di JSON/debug manual, tetapi tidak ditampilkan default.

Endpoint dev lokal:

```text
POST /__identity-fidelity/build
```

Body dibatasi ke `limit` maksimal 500, `snapshot` boolean, dan `force` boolean.
Endpoint tidak menerima command/path arbitrary dan tidak mengekspos service role
atau API key ke browser bundle.

Batasan Step 18: belum ada task planner, agent action otomatis, fine-tuning,
voice/audio clone, production backend, atau autonomy runtime. Step berikutnya
adalah Communication Style Model dan Response Inference Engine.

---

## Step 19: Communication Style Model

Communication Style Model menyimpan gaya komunikasi evidence-bound. Bedanya
dengan `identity_facts`: identity menjawab "orang ini seperti apa", sedangkan
`communication_patterns` menjawab "kalau menerima prompt seperti ini, gaya
jawabannya sebaiknya bagaimana".

Apply migration:

```bash
supabase db push
```

Build dan audit dari folder `frontend`:

```bash
npm run communication:build
npm run communication:build -- --limit 100
npm run communication:samples
npm run communication:patterns
npm run communication:audit
```

Output Supabase:

- `communication_samples`: contoh gaya bahasa asli dari diary, raw entry,
  memory, report, atau manual/imported chat.
- `communication_patterns`: pola seperti `greeting_style`,
  `prompt_request_style`, `technical_style`, `correction_style`,
  `decision_style`, dan `general_voice`.

Output Obsidian:

```text
AhyarBrainVault/_system/communication/Communication Style Model.md
AhyarBrainVault/_system/communication/Communication Samples.md
```

Brain Chat memakai style model untuk memilih `communication_intent` dan
`response_shape`. Greeting seperti `hi`/`p` tetap satu kalimat tanpa sources.
Prompt seperti `buatkan prompt` diarahkan ke `prompt_request_style`: langsung
prompt siap paste, terstruktur, minim teori sebelum prompt. Koreksi seperti
`ini kurang, revisi` memakai `correction_style`: langsung revisi dan tidak
defensif.

Endpoint dev lokal:

```text
POST /__communication-style/build
```

Body hanya menerima `limit` maksimal 500 dan `force` boolean. Endpoint tidak
menerima command/path arbitrary dan tidak mengekspos API key ke bundle.

Batasan: kalau chat sample asli masih sedikit, style untuk sapaan/koreksi bisa
masih low confidence. Step berikutnya adalah Response Inference Engine.

---

## Step 20: Response Inference Engine

Response Inference Engine adalah layer utama Brain Chat. Targetnya bukan
menjawab sebagai chatbot umum, tapi memprediksi: kalau pemilik diary menerima
prompt ini, kemungkinan besar dia akan menjawab apa.

Command utama:

```bash
npm run response:rules
npm run response:infer -- --question "hi"
npm run response:infer -- --question "buatkan saya prompt untuk step berikutnya"
npm run response:audit
```

Migration:

```text
supabase/migrations/20260613090000_create_response_inference.sql
```

Table baru:

- `response_inference_logs`: log intent, mode, response shape, context yang
  dipakai, jawaban, score fidelity/groundedness/style, overclaim risk, dan
  underfit risk.
- `response_inference_rules`: rule deterministik per intent seperti
  `social_greeting`, `request_prompt`, `technical_instruction`,
  `strategy_question`, `correction`, `identity_question`, dan `unknown`.

Intent detection minimum:

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

Response shape menentukan bentuk jawaban sebelum LLM/fallback berjalan. Greeting
punya shape satu kalimat, tanpa sources, basis, missing context, atau next
actions. Request prompt memakai `writing_block` agar output siap paste.
Strategy memakai jawaban terstruktur dan boleh menampilkan basis/sources.

Brain Chat sekarang memanggil engine ini ketika
`RESPONSE_INFERENCE_ENABLED=true`. Retrieval memory hanya dipakai jika intent
membutuhkannya. Greeting tidak melakukan deep retrieval dan tidak menyebut diary,
identity facts, sources, atau context.

Endpoint dev lokal:

```text
POST /__response-inference/test
```

Body:

```json
{ "question": "hi" }
```

Endpoint hanya menerima `question` string maksimal 2000 karakter dan menolak
pola path/command sederhana. Output berisi intent, response shape, answer, dan
scores.

Guard overclaim/underfit:

- Klaim identitas tanpa evidence diturunkan confidence atau diubah menjadi
  "data belum cukup".
- Overclaim risk tinggi membuat jawaban dibaca sebagai kemungkinan, bukan fakta.
- Underfit risk tinggi menandai jawaban yang masih terlalu assistant-like.
- Social greeting dipotong menjadi satu kalimat dan warning disembunyikan.

Step 24 belum dibuat di sini: approval workflow untuk hints/rules, trend dashboard, dan release gate sebelum perubahan besar dipakai Brain Chat.

---

## Step 21: Owner Answer Calibration

Owner Answer Calibration menyimpan ground truth berupa prompt dan jawaban asli
pemilik diary. Ground truth ini dipakai untuk mengukur apakah Response Inference
Engine sudah mirip pemilik diary, bukan sekadar benar secara fakta.

Migration:

```text
supabase/migrations/20260613110000_create_owner_answer_calibration.sql
```

Table baru:

- `owner_answer_examples`: dataset prompt + owner answer.
- `owner_calibration_runs`: summary satu proses kalibrasi.
- `owner_calibration_results`: hasil perbandingan agent answer vs owner answer.
- `owner_calibration_hints`: hint aktif/needs_review yang dibaca Response
  Inference Engine.

Command:

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

Menambah example dari UI:

1. Jalankan `npm run dev`.
2. Buka tab `Calibration`.
3. Isi `prompt`, `owner_answer`, `intent_type`, `answer_style`, dan
   `context_note`.
4. Klik `Add Example`.

Seed examples:

```bash
npm run owner:examples -- --seed
```

Seed hanya contoh awal konservatif dan harus bisa diedit user. Seed bukan
kebenaran final sebelum user menyetujuinya.

Calibration run:

1. Membaca `owner_answer_examples` active.
2. Memanggil Response Inference Engine dengan prompt yang sama.
3. Menyimpan `agent_answer`, actual intent, dan inference score.
4. Menghitung deterministic score: similarity, style, intent, length, tone,
   fidelity, too AI, overclaim, dan underfit.
5. Jika `OWNER_CALIBRATION_USE_LLM_JUDGE=true`, LLM judge dipakai sebagai
   penilai tambahan.
6. Menyimpan `owner_calibration_results`.
7. Membuat `owner_calibration_hints`.
8. Menulis report Obsidian jika output diaktifkan.

Cara membaca score:

- `similarity_score`: overlap token, frasa kunci, dan penalty panjang.
- `style_match_score`: panjang, tone, format, dan anti frasa AI.
- `fidelity_score`: gabungan similarity, style, intent, overclaim, dan
  underfit.
- `too_ai_score`: naik jika ada frasa seperti `Sebagai AI`, `Saya dapat
  membantu`, `Memory yang tersedia`, atau greeting terlalu formal.
- `overclaim_risk`: naik jika agent menambah klaim identitas/fakta yang tidak
  ada di owner answer untuk prompt ringan.
- `underfit_risk`: naik jika agent terlalu umum, terlalu assistant-like, atau
  request prompt kurang detail.

Hints dipakai Response Inference Engine sebelum fallback umum:

- `greeting_reply`: untuk `hi`/`p`/`halo`, preferred response bisa langsung
  dipakai jika confidence cukup.
- `prompt_structure`: request prompt dipaksa lebih siap paste, step-by-step,
  memakai acceptance criteria dan batasan.
- `avoid_phrase`: menghindari frasa assistant umum.
- `length_adjustment`: patch target panjang jawaban.

Endpoint dev lokal:

```text
POST /__owner-calibration/seed-examples
POST /__owner-calibration/add-example
POST /__owner-calibration/run
GET  /__owner-calibration/latest
```

Endpoint hanya local dev, validasi enum/panjang input, dan tidak menerima SQL
atau command arbitrary.

Output Obsidian:

```text
AhyarBrainVault/_system/calibration/Owner Answer Calibration Latest.md
AhyarBrainVault/_system/calibration/Owner Answer Examples.md
AhyarBrainVault/_system/calibration/Calibration Hints.md
```

Boundary: ini bukan fine-tuning, bukan task planner, bukan agent action
otomatis, dan tidak mengubah `identity_facts` atau `communication_patterns`
secara otomatis.

Step 24: approval workflow untuk hints/rules, trend dashboard, dan release gate
sebelum perubahan besar dipakai Brain Chat.

---

## Step 24: Self-Reflection Memory Evolution

Self-Reflection Memory Evolution adalah lapisan refleksi internal yang
menjawab: setelah data baru masuk, **apa yang berubah dalam pemahaman tentang
pemilik diary?** Berbeda dari layer lain:

- Identity Fidelity Engine membuat identity facts dari data.
- Brain Digest merangkum apa yang terjadi.
- Similarity Eval mengukur kemiripan jawaban agent vs owner.
- Drift Control menjaga jawaban tidak melenceng saat itu juga.
- **Self-Reflection** menyimpulkan arti data baru terhadap model diri owner
  secara bertahap, evidence-bound, dan tidak liar.

Migration:

```text
supabase/migrations/20260613160000_create_self_reflection_evolution.sql
```

Table baru:

- `self_reflection_logs`: refleksi internal (observasi baru, pola menguat/melemah,
  kontradiksi, implikasi identity/komunikasi, risiko fidelity, ketidakpastian).
- `identity_evolution_suggestions`: saran perubahan terhadap identity_facts /
  communication_patterns / calibration hints — **proposal saja, bukan auto-apply**.
- `entity_evolution_snapshots`: snapshot evolusi entitas dari waktu ke waktu
  (evolution_score, stability_score, fidelity_risk_score).

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

Cara kerja reflection engine:

1. Tentukan periode refleksi (daily/weekly/manual/after_*).
2. Baca data baru di periode itu (raw_entries) + state terbaru identity,
   communication, similarity, drift, calibration, dan reflection sebelumnya
   (refleksi lama hanya konteks tren, bukan satu-satunya evidence).
3. Bangun context reflection dengan prioritas evidence: diary asli → owner
   answers/calibration → identity facts high confidence → communication patterns
   → similarity/drift → brain reports → agent memories.
4. Panggil LLM (provider-agnostic) jika enabled; jika gagal/disabled, pakai
   fallback deterministic dan tandai `metadata.generated_by`.
5. Simpan `self_reflection_logs`, lalu turunkan `identity_evolution_suggestions`.
6. Tulis report ke Obsidian. **Tidak menerapkan saran otomatis.**

Evolution suggestions (proposal):

- Status default `proposed`. Approve/reject/ignore hanya mengubah status
  suggestion — **tidak** menyentuh identity_facts atau communication_patterns.
- `increase_confidence` hanya jika `evidence_refs >= SELF_REFLECTION_MIN_EVIDENCE_FOR_SUGGESTION`
  (default 2); jika kurang, diturunkan ke `add_evidence`.
- `mark_core` hanya jika evidence kuat & berulang; `create_new` selalu proposal,
  bukan langsung fact aktif. Kontradiksi butuh evidence jelas. Tidak ada delete.
- `risk_score > 0.75` tetap `proposed` tapi ditandai high-risk.
- `SELF_REFLECTION_AUTO_APPLY=false` (default). Command
  `npm run reflection:suggestions -- --apply-approved` sengaja menolak apply
  sampai Step 25.

UI tersedia di sidebar `Reflection`: latest reflection, summary card, semua
section (observations, strengthened, weakened, contradictions, identity/
communication implications, risk, uncertainties), daftar evolution suggestions
dengan filter status, detail evidence + before/after, tombol Run Reflection /
Create Snapshot / Audit / Refresh, dan Approve/Reject/Ignore per suggestion.

Brain Chat memakai latest `self_reflection_logs` + `entity_evolution_snapshots`
sebagai **konteks pendukung**: identity facts tetap sumber utama klaim. Jika
reflection menyebut uncertainty atau high-risk fidelity, Brain Chat menurunkan
confidence. Debug Brain Chat menambah `self_reflection_used`, `reflection_log_id`,
`evolution_snapshot_id`, dan `reflection_warnings`.

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

Audit (`npm run reflection:audit`) mengecek: latest reflection ada & fresh,
jumlah proposed/high-risk suggestion, suggestion tanpa evidence, ketidakpastian
berulang, last similarity/drift, jumlah identity facts & communication patterns,
dan apakah reflection didasarkan data baru atau hanya mengulang refleksi lama.

Boundary: reflection tidak fine-tuning, tidak auto-apply, tidak menghapus data,
tidak auto-edit identity/communication, tidak agent action otomatis, dan tidak
membuat entitas berkembang di luar evidence owner.

Step 25: approval-to-apply workflow (terapkan approved suggestions ke identity
data dengan aman), trend dashboard evolusi, dan policy gate sebelum perubahan
besar aktif.

---

## Step 23: Drift Control / Anti-Overclaim Guard

Drift Control adalah guard layer sebelum jawaban final tampil ke user. Step 22
mengukur similarity setelah jawaban dibuat; Step 23 mencegah jawaban buruk
keluar: overclaim, hallucinated identity, terlalu AI-like, terlalu formal,
debug/source leak pada greeting, konteks privat tidak relevan, dan style drift.

Migration:

```text
supabase/migrations/20260613150000_create_drift_control.sql
```

Table baru:

- `drift_guard_rules`: rule anti-overclaim dan anti-drift.
- `drift_guard_logs`: hasil pengecekan tiap jawaban.
- `drift_baseline_snapshots`: baseline style/identity/similarity untuk guard.

Command:

```bash
npm run drift:rules -- --seed
npm run drift:check -- --question "hi" --answer "Halo! Ada yang bisa saya bantu hari ini?"
npm run drift:baseline -- --activate
npm run drift:audit
npm run drift:latest
```

Default rules:

- `no_ai_assistant_phrases_for_greeting`
- `no_sources_for_social_greeting`
- `no_debug_for_social_greeting`
- `no_identity_overclaim_without_evidence`
- `low_confidence_identity_must_be_softened`
- `do_not_make_owner_more_ideal`
- `do_not_make_owner_worse_without_evidence`
- `respect_response_shape`
- `avoid_irrelevant_private_context`
- `similarity_baseline_regression_warning`

Guard pipeline:

```text
Response Inference draft answer
Post-answer drift checks
Rewrite/fallback/block if needed
Final answer
Drift log
```

Risk score:

- `overclaim_score`: klaim terlalu kuat atau membuat owner lebih ideal/buruk
  dari evidence.
- `too_ai_score`: frasa seperti `Ada yang bisa saya bantu`, `Sebagai AI`,
  `Semoga membantu`.
- `unsupported_claim_score`: klaim identitas tanpa evidence atau low confidence.
- `style_drift_score`: terlalu panjang/formal atau melanggar response shape.
- `source_leak_score` / `debug_leak_score`: terutama untuk social greeting.

Risk level: `safe`, `warning`, `high`, `critical`. Untuk greeting AI-like,
fallback aman biasanya `Iya, ada apa?` atau preferred greeting dari calibration
hint.

UI tersedia di sidebar `Drift`: seed rules, create baseline, test draft answer,
latest logs, risk cards, active rules, dan before/after guard result.

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

Boundary: guard tidak fine-tuning, tidak auto-edit identity facts,
communication patterns, owner examples, atau logs; hanya warning,
confidence/risk lowering, rewrite/fallback/block, dan logging.

Step 24 (Self-Reflection Memory Evolution) menambah refleksi berkala di atas
guard ini; lihat section Step 24.

---

## Step 22: Similarity Evaluation Loop

Similarity Evaluation Loop menjalankan evaluasi berulang untuk memastikan agent
tetap mirip pemilik diary dari waktu ke waktu. Bedanya dengan Owner Answer
Calibration: calibration membuat examples dan hints, sedangkan similarity eval
mengukur tren, baseline, regression, dan drift.

Migration:

```text
supabase/migrations/20260613130000_create_similarity_evaluation.sql
```

Table baru:

- `similarity_eval_runs`: summary satu run, verdict, score rata-rata,
  regression/improvement count.
- `similarity_eval_results`: hasil per owner example, agent answer, score,
  failure reason, recommendations, dan baseline comparison.
- `similarity_baselines`: baseline kualitas agent yang dianggap cukup baik.

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

Cara kerja:

1. Membaca `owner_answer_examples` active.
2. Menjalankan Response Inference Engine untuk prompt yang sama.
3. Mengambil answer, actual intent, inference score, hints/facts/patterns yang
   dipakai.
4. Menghitung similarity, fidelity, style, intent, tone, length, too AI,
   overclaim, dan underfit.
5. Membandingkan dengan active baseline jika ada.
6. Menandai passed, failed, regressed, atau improved.
7. Menyimpan results dan summary run.
8. Menulis report Obsidian.

Verdict:

- `excellent`: overall >= 0.90 dan tidak ada critical regression.
- `good`: overall >= 0.80.
- `warning`: overall >= 0.70 atau ada regression kecil.
- `bad`: overall < 0.70.
- `blocked`: regression banyak atau overclaim tinggi.

Score penting:

- `too_ai_score`: naik jika jawaban mengandung frasa assistant umum seperti
  `Sebagai AI`, `Saya dapat membantu`, atau `Semoga membantu`.
- `overclaim_risk`: naik jika agent menambah identitas/fakta/konteks yang
  tidak ada di owner answer.
- `underfit_risk`: naik jika jawaban terlalu generik, netral, atau tidak
  memakai gaya owner.
- `regression_score`: penurunan fidelity dibanding baseline untuk example yang
  sama.

Endpoint dev lokal:

```text
POST /__similarity-eval/run
POST /__similarity-eval/create-baseline
GET  /__similarity-eval/latest
POST /__similarity-eval/compare
```

UI tersedia di sidebar `Similarity`: score cards, verdict badge, baseline
summary, failed/regressed cases, dan result list.

Output Obsidian:

```text
AhyarBrainVault/_system/similarity/Similarity Evaluation Latest.md
AhyarBrainVault/_system/similarity/Similarity Evaluation YYYY-MM-DD HH-mm.md
AhyarBrainVault/_system/similarity/Similarity Baseline.md
```

Daily Routine bisa menjalankan eval ringan jika:

```env
BRAIN_ROUTINE_RUN_SIMILARITY=true
```

Boundary: tidak fine-tuning, tidak auto-edit identity facts, communication
patterns, owner examples, atau hints; hanya menulis similarity tables dan report.

## Step 25 — Chat Sample Importer

Chat Sample Importer mengimpor contoh chat asli owner dari
`AhyarBrainVault/85_Chat_Samples/` sebagai evidence gaya percakapan pendek.
Diary tetap penting untuk isi pikiran, tetapi tidak cukup untuk meniru respons
chat seperti `hi`, `p`, `oke`, `lanjut`, `revisi`, atau `menurutmu gimana?`.

Format MVP:

- `.txt` plain: `[2026-06-12 21:01] owner: iya, ada apa?`
- `.txt`/`.md` WhatsApp-like: `12/06/26, 21.01 - Ahyar: iya, ada apa?`
- `.json`: array `{ timestamp, speaker, text }`
- `.csv`: header `timestamp,speaker,text`

Konfigurasi owner detection ada di `scripts/brain-worker.env`:

```env
CHAT_SAMPLE_DIR=../AhyarBrainVault/85_Chat_Samples
CHAT_SAMPLE_OWNER_ALIASES=Ahyar,Kukuh,Ahyar Pattani,owner,me,saya
```

Hanya speaker yang cocok alias owner menjadi `communication_samples` dan owner
style evidence. Pesan lawan bicara hanya menjadi prompt/context. Importer tidak
membuat identity fact, tidak fine-tuning, tidak menghapus chat, dan tidak
menjalankan agent action otomatis.

Command:

```bash
npm run chats:import
npm run chats:import -- --file "../AhyarBrainVault/85_Chat_Samples/sample.txt"
npm run chats:import -- --limit 10
npm run chats:import -- --dry-run
npm run chats:pairs
npm run chats:audit
```

Pipeline:

1. Scan folder fixed `CHAT_SAMPLE_DIR`.
2. Hash file untuk dedup import.
3. Parse message, speaker, timestamp, dan text.
4. Cocokkan speaker dengan `CHAT_SAMPLE_OWNER_ALIASES`.
5. Klasifikasi intent/tone/formality/length.
6. Simpan `chat_imports`, `chat_messages`, `chat_reply_pairs`, dan review.
7. Buat `owner_answer_examples` dari pair `other -> owner` jika confidence cukup.
8. Buat `communication_samples` dari owner messages.
9. Tulis report Obsidian di `_system/chat-samples/`.

Setelah import, jalankan:

```bash
npm run communication:build
npm run owner:calibrate
npm run similarity:run
```

UI tersedia di sidebar `Chat Samples` dengan tombol import, audit, generate reply
pairs, daftar import, reply pairs, dan reviews. Endpoint dev lokal hanya menerima
limit/dryRun/save, tidak menerima path bebas dari browser.

## Step 26 — Identity Conflict & Contradiction Resolver

Identity Conflict Resolver menyimpan kontradiksi owner sebagai tension berbasis
evidence. Kontradiksi bukan bug: manusia bisa ingin fokus, tapi tetap menambah
fitur; ingin local-first, tapi memakai API eksternal; ingin jawaban singkat,
tapi meminta prompt lengkap.

Migration:

```text
supabase/migrations/20260613180000_create_identity_conflicts.sql
```

Command:

```bash
npm run conflicts:detect
npm run conflicts:detect -- --limit 100
npm run conflicts:detect -- --from 2026-06-01 --to 2026-06-12
npm run conflicts:review
npm run conflicts:audit
npm run conflicts:latest
```

Cara kerja:

1. Membaca identity facts, snapshots, self-reflection, communication patterns,
   response logs, calibration/similarity/drift results, brain reports, raw
   entries, dan conflict existing.
2. LLM mendeteksi tension dua sisi; jika LLM gagal/disabled, deterministic
   fallback mencari pola seperti fokus vs scope expansion, local-first vs API,
   jawaban singkat vs prompt lengkap, dan autonomy vs fidelity.
3. Conflict disimpan dengan side A, side B, evidence refs, severity, recurrence,
   impact area, dan chat guidance.
4. Dedup berdasarkan user, normalized title, conflict type, dan impact area.
5. Existing conflict di-merge evidence-nya; tidak ada delete otomatis.
6. Review user hanya mengubah `identity_conflict_reviews` dan
   `resolution_status`, bukan identity facts atau communication patterns.

Severity menunjukkan tingkat risiko fidelity (`low` sampai `critical`).
Recurrence menunjukkan apakah tension sekali, berulang, recurring, atau
`core_tension`. Chat guidance dipakai Brain Chat/Response Inference untuk
menjawab dengan nuansa: “di satu sisi X, di sisi lain Y”, bukan memilih satu
sisi tanpa evidence kuat.

Endpoint dev lokal:

```text
POST /__identity-conflicts/detect
POST /__identity-conflicts/review
GET  /__identity-conflicts/latest
POST /__identity-conflicts/audit
```

UI tersedia di sidebar `Conflicts`: filter status/severity/type/impact, detail
side A/B, evidence, events, chat guidance, owner note, dan action Mark
Monitoring / Mark Resolved / Dismiss / Needs More Data.

Boundary: tidak auto-resolve, tidak auto-edit identity facts, tidak auto-edit
communication patterns, tidak fine-tuning, tidak agent action otomatis.

Step 27: merge/split conflict workflow, owner-approved promotion ke rules/hints,
dan trend dashboard konflik dari waktu ke waktu.

## Step 27 — Final Self-Clone Evaluation Suite

Final Self-Clone Evaluation Suite adalah evaluasi menyeluruh untuk menilai
apakah agent sudah layak disebut simulasi respons owner. Berbeda dari Similarity
Evaluation yang fokus membandingkan agent answer dengan owner answer examples,
suite ini menggabungkan identity fidelity, communication style, owner
similarity, memory grounding, conflict handling, drift safety, calibration,
reflection, too-AI risk, overclaim, underfit, dan private leak risk.

Migration:

```text
supabase/migrations/20260613190000_create_self_clone_evaluation.sql
```

Command:

```bash
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

Case generation membaca owner answer examples, chat reply pairs, communication
patterns, identity facts, identity conflicts, drift rules, reflection logs, dan
insufficient-memory guard cases. Evaluation menjalankan Response Inference,
menyimpan hasil per case, menghitung score dimensi, critical failures, readiness
level, dan release decision.

Readiness:

- `not_ready`: score rendah atau critical failures banyak.
- `early`: basic behavior mulai ada, belum stabil.
- `usable_with_warning`: bisa dipakai pribadi dengan review.
- `stable`: daily use relatif aman.
- `release_candidate`: siap lanjut phase berikutnya.

Release decision:

- `do_not_use`
- `internal_testing_only`
- `daily_use_with_warning`
- `stable_daily_use`
- `ready_for_next_phase`

UI tersedia di sidebar `Self-Clone Eval`: Generate Cases, Run Evaluation, Run
Release Evaluation, Audit, score cards, result list, critical failures,
recommendations, dan readiness report.

Boundary: evaluasi tidak fine-tuning, tidak auto-edit identity facts,
communication patterns, atau calibration hints, dan tidak menghapus data. Ia
hanya menulis tabel eval dan report.

Step 28: runtime boundary agar entitas bisa dipakai dalam mode aman.

## Step 28 — Safe Entity Runtime / Read-Only Autonomy Boundary

Safe Entity Runtime adalah lapisan aman untuk menjalankan self-clone secara
fidelity-first. Runtime boleh membaca brain, menjawab user, dan membuat action
proposal. Runtime tidak boleh menjalankan aksi eksternal atau memutasi brain
utama tanpa approval phase terpisah.

Migration:

```text
supabase/migrations/20260613200000_create_safe_entity_runtime.sql
```

Command:

```bash
npm run entity:policies -- --seed
npm run entity:session -- --start --mode read_only
npm run entity:session -- --end
npm run entity:run -- --question "hi"
npm run entity:run -- --question "kirim email ke HR bahwa saya tertarik"
npm run entity:proposal -- --latest
npm run entity:audit
npm run entity:latest
```

Boundary read-only:

- Reads: identity, snapshots, communication patterns, calibration hints,
  similarity/drift baselines, reflection logs, identity conflicts,
  self-clone readiness, reports, memories, nodes, dan edges.
- Writes: hanya `entity_runtime_sessions`, `entity_runtime_events`,
  `entity_action_proposals`, dan `entity_runtime_safety_reports`.
- Blocks: external action, identity mutation, communication mutation, command
  execution, arbitrary file write, debug/source leak untuk prompt ringan, dan
  klaim consciousness/original-human.

Prompt aksi seperti `kirim email`, `push ke github`, `jalankan command`,
`hapus file`, `ubah identity`, atau `edit file` diblokir. Runtime membuat
`entity_action_proposals` dengan required approval. Approve proposal di Step 28
hanya mengubah status menjadi `approved`; tidak ada email, command, GitHub,
calendar, file write, atau API action yang dieksekusi.

Brain Chat memakai runtime boundary saat `SAFE_ENTITY_RUNTIME_ENABLED=true`.
Prompt ringan seperti `hi` tetap pendek tanpa policy dump. Jika action
diblokir, UI menampilkan card action blocked dan proposal detail.

Report Obsidian:

```text
AhyarBrainVault/_system/runtime/Entity Runtime Latest.md
AhyarBrainVault/_system/runtime/Runtime Policies.md
AhyarBrainVault/_system/runtime/Action Proposals.md
AhyarBrainVault/_system/runtime/Safety Report.md
```

Daily routine dapat menjalankan `entity:audit` lewat
`BRAIN_ROUTINE_RUN_ENTITY_AUDIT=true`.

Step 29: Long-Term Memory Consolidation agar memory jangka panjang tetap rapi,
tidak duplikatif, dan evidence-bound.

## Step 29 — Long-Term Memory Consolidation

Long-Term Memory Consolidation membuat lapisan memory jangka panjang dari data
diary/chat/file/identity/style/reflection/conflict. Ini berbeda dari Brain
Digest: digest merangkum periode, sedangkan consolidation menjaga state memory
jangka panjang. Ini juga berbeda dari Identity Fidelity: identity fidelity
membangun identity facts, sedangkan consolidation menjaga memory agar tidak
noise, duplicate, stale, atau terlalu tegas tanpa evidence.

Migration:

```text
supabase/migrations/20260613210000_create_long_term_memory_consolidation.sql
```

Command:

```bash
npm run memory:consolidate
npm run memory:consolidate -- --run-type weekly
npm run memory:consolidate -- --from 2026-06-01 --to 2026-06-12
npm run memory:consolidate:full
npm run memory:snapshot
npm run memory:review
npm run memory:audit
npm run memory:latest
```

Core memory adalah memory yang confidence tinggi, evidence berulang, stabil,
dan berdampak ke identitas/keputusan/gaya respons. Stale memory adalah memory
yang lama tidak muncul lagi; ia tidak boleh dipakai sebagai fakta current tanpa
konteks historis. Review queue menyimpan duplicate/stale/core/conflict/low
confidence candidate agar owner bisa approve/reject/ignore tanpa destructive
action.

Brain Chat membaca `long_term_memories` aktif untuk pertanyaan identity,
strategy, pattern, dan contradiction. Prompt ringan seperti `hi` tidak memakai
long-term memory. Memory `needs_review` tidak boleh jadi klaim tegas, dan
memory `stale` harus disebut sebagai konteks historis.

Report Obsidian:

```text
AhyarBrainVault/_system/memory/Long-Term Memory Latest.md
AhyarBrainVault/_system/memory/Long-Term Memory Snapshot.md
AhyarBrainVault/_system/memory/Memory Review Queue.md
AhyarBrainVault/_system/memory/Memory Consolidation Report.md
```

Raw data tidak dihapus. `MEMORY_CONSOLIDATION_AUTO_MERGE=false` dan
`MEMORY_CONSOLIDATION_AUTO_ARCHIVE=false` default agar duplicate/archive hanya
menjadi review item, bukan aksi otomatis.

Step 30: Personal Entity OS Final Release.

## Step 30 — Personal Entity OS Final Release

Final Release bukan fase intelligence baru, fine-tuning, production backend,
atau external automation. Fase ini mengunci sistem agar layak dipakai harian
sebagai personal entity simulation yang fidelity-bound, local-first, dan tetap
read-only/proposal-only.

Migration:

```text
supabase/migrations/20260613220000_create_final_release.sql
```

Command:

```bash
npm run release:check
npm run release:check -- --type release_candidate
npm run release:final
npm run release:notes
npm run release:artifacts
npm run release:audit
npm run release:latest
```

Release check membaca migration, package scripts, build, dist bundle secret
scan, Supabase tables, backup, identity, communication, response inference,
calibration, similarity, drift, reflection, chat samples, conflicts,
self-clone eval, safe runtime, long-term memory, Obsidian folders, dan docs.
Script hanya menjalankan command allowlist seperti `npm run build` dan
`node --check scripts/<known-script>`. Endpoint Vite tidak menerima path atau
command bebas dari browser.

Scoring final memakai bobot keamanan, database/migration, build/scripts,
backup/recovery, identity/communication, response/calibration/similarity,
drift/runtime safety, self-clone eval, long-term memory/reflection/conflicts,
dan dokumentasi. Release decision:

- `do_not_use`: ada blocker critical security/runtime/data.
- `internal_testing_only`: build jalan tapi data/eval belum cukup.
- `daily_use_with_warning`: score >= 70 tanpa critical security blocker.
- `stable_daily_use`: score >= 85, backup ada, runtime boundary aktif.
- `ready_for_final_use`: score >= 92, self-clone eval stabil/release candidate,
  similarity baik, drift aman, dan tidak ada blocker.

Report Obsidian:

```text
AhyarBrainVault/_system/final-release/Final Release Latest.md
AhyarBrainVault/_system/final-release/Final Release Checklist.md
AhyarBrainVault/_system/final-release/Final Release Notes.md
AhyarBrainVault/_system/final-release/Final Release Blockers.md
AhyarBrainVault/_system/final-release/Final Release Artifacts.md
```

Frontend memiliki mode `Final Release` di sidebar. View ini menampilkan latest
run, overall score, readiness level, release decision, blockers, warnings,
check categories, artifacts, dan release notes. Tombol UI menjalankan local dev
endpoint `/__final-release/*`; endpoint tersebut tetap tidak menjalankan aksi
eksternal, tidak menghapus data, dan tidak mengubah identity/communication
secara otomatis.

Daily routine dapat menjalankan audit release optional lewat:

```env
BRAIN_ROUTINE_RUN_RELEASE_AUDIT=false
```

Default false agar routine harian tidak berat. Step berikutnya setelah release
tetap harus mempertahankan boundary: tidak ada email/calendar/GitHub/WhatsApp,
tidak ada command bebas, tidak ada data deletion, tidak ada fine-tuning, dan
tidak ada klaim agent sebagai manusia asli atau kesadaran asli.
