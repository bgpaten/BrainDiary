# Supabase — Structured Brain Database (Fase 3)

Folder ini berisi schema **Supabase** untuk Personal Brain OS: tempat menyimpan
**structured memory** (node, edge, cluster, file metadata, job, dan agent memory)
yang dihasilkan dari catatan mentah di Obsidian.

```
supabase/
├── migrations/
│   └── 20260611090000_create_brain_schema.sql   ← schema + RLS + index + trigger
├── seed.sql                                      ← dummy data minimal
└── README.md                                     ← dokumen ini
```

---

## 1. Tujuan Schema

Mengubah catatan mentah (diary Obsidian, quick input React, file) menjadi
**graph terstruktur** yang:

- rapi & ternormalisasi (anti-duplikat lewat `canonical_name`),
- aman & multi-tenant (Row Level Security per `user_id`),
- siap dibaca **Brain Visualizer** (node + edge) dan **AI Agent** (`agent_memories`),
- bisa ditelusuri balik ke sumbernya (`source_entry_id`).

> Migration ini hanya struktur data. Logika Brain Engine Fase 5 ada terpisah di
> `supabase/functions/process-brain-entry/`.

---

## 2. Fungsi Setiap Table

| Table             | Fungsi |
|-------------------|--------|
| `raw_entries`     | Sumber **mentah**: diary Obsidian, quick input React, upload file, atau API. Inilah pintu masuk semua data. |
| `brain_nodes`     | **Entitas** otak: person, place, event, project, decision, emotion, goal, pattern, organization, topic, tool, document. |
| `brain_edges`     | **Relasi** berarah antar node (mis. `works_on`, `uses`, `has_pattern`). |
| `brain_clusters`  | **Pengelompokan** node per tema besar agar visualizer bisa menampilkan kelompok. |
| `brain_files`     | **Metadata** file attachment (bukan binary). Binary ada di Storage/Obsidian. |
| `extraction_jobs` | **Status** proses Brain Engine (pending → processing → done/failed/needs_review). |
| `agent_memories`  | **Memory ringkas** yang dibaca AI Agent sebelum menjawab. |

### Nilai enum penting

- `raw_entries.source_type`: `text`, `image`, `document`, `audio`, `mixed`.
- `raw_entries.source_origin` / `brain_files.source_origin`: `obsidian`, `react_input`, `upload`, `api`.
- `raw_entries.processing_status` / `brain_files.processing_status` / `extraction_jobs.status`:
  `pending`, `processing`, `done`, `failed`, `needs_review`.
- `brain_nodes.type`: `person`, `place`, `event`, `project`, `decision`, `emotion`,
  `goal`, `pattern`, `organization`, `topic`, `tool`, `document`.
- `extraction_jobs.job_type`: `diary_extract`, `file_extract`, `node_merge`,
  `cluster_update`, `agent_memory_build`.
- `agent_memories.memory_type`: `preference`, `identity`, `decision`, `lesson`,
  `warning`, `goal`, `pattern`, `context`.
- `agent_memories.importance_level`: `low`, `normal`, `important`, `core`.
- `agent_memories.stability`: `temporary`, `normal`, `stable`, `core`.
- `agent_memories.sensitivity`: `public`, `private`, `sensitive`.

> `brain_edges.relation_type` **sengaja tidak di-CHECK** agar Brain Engine bebas
> menambah jenis relasi baru. Contoh nilai yang disarankan: `works_on`,
> `related_to`, `met_with`, `mentioned`, `happened_at`, `happened_in`, `decided`,
> `caused`, `feels_about`, `has_pattern`, `wants_to_achieve`, `uses`,
> `belongs_to_cluster`, `blocked_by`, `needs_validation`.

---

## 3. Relasi Antar Table (Foreign Key)

```
raw_entries ──< brain_nodes.source_entry_id        (ON DELETE SET NULL)
raw_entries ──< brain_edges.source_entry_id        (ON DELETE SET NULL)
raw_entries ──< brain_files.raw_entry_id           (ON DELETE CASCADE)
raw_entries ──< extraction_jobs.raw_entry_id       (ON DELETE CASCADE)
raw_entries ──< agent_memories.source_entry_id     (ON DELETE SET NULL)

brain_clusters ──< brain_nodes.cluster_id          (ON DELETE SET NULL)

brain_nodes ──< brain_edges.from_node_id           (ON DELETE CASCADE)
brain_nodes ──< brain_edges.to_node_id             (ON DELETE CASCADE)
brain_nodes ──< agent_memories.source_node_id      (ON DELETE SET NULL)
```

**Constraint anti-duplikat:**

- `brain_clusters`: unik `(user_id, slug)`.
- `brain_nodes`: unik `(user_id, type, canonical_name)` — mencegah
  `NusaOps` / `Nusa Ops` / `nusaops` jadi tiga node berbeda.
- `brain_edges`: unik `(user_id, from_node_id, to_node_id, relation_type)` —
  relasi yang sama tidak terus bertambah; plus larangan self-loop.

> **Kenapa edge CASCADE tapi source_entry SET NULL?**
> Jika node dihapus, relasinya tak bermakna lagi → ikut terhapus.
> Jika raw entry dihapus, node/edge tetap dipertahankan tetapi kehilangan
> jejak sumbernya (`null`) — graph tidak runtuh hanya karena satu entry hilang.

---

## 4. Alur Data

```
                 ┌─────────────────────────────────────────────┐
 Obsidian diary  │                                             │
 React input ───▶│  raw_entries  (sumber mentah, processed?)    │
 Upload / API    │                                             │
                 └───────────────┬─────────────────────────────┘
                                 │  Brain Engine membaca (Fase 5)
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │  extraction_jobs   (status proses)                 │
        └────────────────────────────────────────────────────┘
                                 │
                ┌────────────────┼─────────────────┐
                ▼                ▼                  ▼
          brain_nodes      brain_edges        brain_clusters
          (entitas)        (relasi)           (kelompok tema)
                │
                ▼
          agent_memories   (memory ringkas untuk AI Agent)

  brain_files  ←─ metadata attachment, dikaitkan ke raw_entries
```

1. Diary Obsidian / input React / upload masuk ke **`raw_entries`**.
2. **Brain Engine** membaca `raw_entries` yang `processed = false`.
3. Hasil ekstraksi disimpan ke **`brain_nodes`** dan **`brain_edges`**.
4. Node dikelompokkan ke **`brain_clusters`**.
5. Metadata file masuk ke **`brain_files`**.
6. Status tiap proses dicatat di **`extraction_jobs`**.
7. Ringkasan penting untuk AI ditulis ke **`agent_memories`**.

---

## 5. Cara Menjalankan Migration

Prasyarat: [Supabase CLI](https://supabase.com/docs/guides/cli) terpasang.

### Opsi A — Local dev (Docker)
```bash
# dari root project
supabase start            # jalankan stack lokal (sekali saja)
supabase db reset         # apply semua migration di supabase/migrations + jalankan seed.sql
```
`supabase db reset` otomatis menerapkan migration **dan** menjalankan `seed.sql`.

### Opsi B — Apply ke project remote
```bash
supabase link --project-ref <project-ref>
supabase db push          # push migration ke database remote
```

### Opsi C — Manual via psql / SQL Editor
Tempel isi `migrations/20260611090000_create_brain_schema.sql` ke
**Supabase Studio → SQL Editor**, lalu jalankan.

---

## 6. Cara Menjalankan Seed

`seed.sql` memakai **placeholder** `user_id`:
`00000000-0000-0000-0000-000000000001`.

### Local
```bash
supabase db reset         # sudah termasuk menjalankan seed.sql
```

### Manual
Jalankan isi `seed.sql` di SQL Editor / psql.

> ⚠️ **Ganti placeholder UUID dengan user id Supabase asli saat testing.**
> Ambil dari `auth.users` (atau `select auth.uid();` saat login). Jika tidak,
> RLS akan menyembunyikan baris seed dari akunmu karena `user_id` tidak cocok.
> Cari–ganti `00000000-0000-0000-0000-000000000001` di `seed.sql` dengan id-mu.
>
> Seed bersifat **idempotent**: STEP 0 menghapus baris seed lama (berdasarkan id
> tetap) sebelum insert ulang, jadi aman dijalankan berkali-kali tanpa error
> `duplicate key` — termasuk bila sebelumnya dijalankan dengan `user_id` berbeda.

---

## 7. Row Level Security (RLS)

- **RLS aktif di semua table.**
- Setiap table punya 4 policy: `select`, `insert`, `update`, `delete`, semuanya
  memakai `auth.uid() = user_id`. Artinya **user hanya bisa mengakses datanya
  sendiri**.
- `insert`/`update` memakai `WITH CHECK (auth.uid() = user_id)` agar user tidak
  bisa menulis baris atas nama orang lain.

**Keamanan key:**

- Gunakan **anon key** + sesi login user di frontend (React) — RLS yang melindungi.
- **Jangan pernah** menaruh **service role key** di frontend. Service role
  mem-bypass RLS dan hanya boleh dipakai di server tepercaya / Brain Engine.

---

## 8. Brain Engine (Fase 5) — Edge Function

Edge Function **`process-brain-entry`** sudah ada di `supabase/functions/process-brain-entry/`.
Ia membaca satu `raw_entries`, mengekstrak node/edge via LLM, lalu menulis ke
`brain_nodes` / `brain_edges`, mencatat `extraction_jobs`, dan menandai entry `done`.

Alur status `raw_entries`: `pending` → `processing` → `done` (atau `failed`).
Alur status `extraction_jobs`: `processing` → `done` (atau `failed` + `error_message`).

Detail, env var, cara deploy & test: lihat
[`functions/process-brain-entry/README.md`](functions/process-brain-entry/README.md).

> Service role key hanya dipakai di Edge Function (server). **Jangan pernah** di frontend.

---

## 9. Yang Belum Dikerjakan (Fase Berikutnya)

Sengaja **tidak** dibuat:

- ❌ Parser Obsidian (Brain Engine fase ini hanya memproses teks `raw_entries`).
- ❌ Pemrosesan file/foto/PDF/audio & upload attachment.
- ❌ Agent chat / tanya-jawab ke `agent_memories`.
- ❌ Fitur edit node/edge dari UI.
- ❌ Embedding/`vector` aktif (extension disiapkan tapi di-comment, belum dipakai).
- ❌ Supabase Storage bucket config (baru disebut sebagai `storage_bucket` di metadata).
