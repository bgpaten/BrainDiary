# BrainDiary — Personal Brain OS

> **Diary → Graph otak → Konteks yang bisa dibaca AI & manusia.**

Sistem memori pribadi **local-first**: kamu menulis diary, sistem membaca isinya,
mengenali entitas & makna, lalu membangun "peta otak" (graph) yang bisa
divisualisasikan dan dibaca AI agent untuk memahami konteks hidup/proyekmu.

Stack: **React + Vite + TypeScript** (frontend) · **Supabase/Postgres** (structured
memory) · **Node scripts** (Brain Engine lokal) · **Obsidian vault** (raw diary) ·
**LLM** (Claude Code / Anthropic / OpenAI / Ollama).

---

## 1. Prasyarat

| Tool | Versi yang dipakai | Catatan |
|------|--------------------|---------|
| **Node.js** | `v22.15.0` (≥ 20 LTS) | wajib — frontend & scripts |
| **npm** | `v10.9.2` | ikut Node |
| **Supabase CLI** | terbaru | untuk migration & edge function — [docs](https://supabase.com/docs/guides/cli) |
| **Docker** | terbaru | opsional, hanya untuk `supabase start` (local dev DB) |
| **LLM provider** | salah satu | Claude Code CLI (default), Anthropic API, OpenAI-compatible, atau Ollama lokal |
| **Obsidian** | — | opsional, untuk menulis diary di vault |

Punya **akun Supabase** + sebuah project (untuk URL & anon key).

---

## 2. Struktur Repo

```
BrainDiary/
├── frontend/                 # React + Vite UI + Brain Engine scripts lokal
│   ├── src/                  # kode UI (graph visualizer, quick input, dll)
│   ├── scripts/              # *.mjs — brain worker, importer, backup, dll
│   ├── .env.example          # env frontend (Vite) → salin ke .env
│   └── scripts/brain-worker.env.example  # env scripts lokal → salin ke brain-worker.env
├── supabase/
│   ├── migrations/           # schema + RLS + index + trigger
│   ├── functions/            # edge function process-brain-entry (Brain Engine)
│   └── seed.sql              # dummy data minimal
├── AhyarBrainVault/          # contoh Obsidian vault (diary, attachments, reports)
├── docs/                     # manual operasi, troubleshooting, arsitektur
└── BRAINSTORM.md             # visi & model domain (baca sebelum ngoding)
```

---

## 3. Setup Langkah-demi-Langkah

### Langkah 1 — Clone & install dependency

```bash
git clone <repo-url> BrainDiary
cd BrainDiary/frontend
npm install
```

### Langkah 2 — Ganti nama vault sesuai pemilik repo

`AhyarBrainVault/` adalah vault milik penulis asli. Ganti jadi nama kamu
(mis. `BudiBrainVault/`) supaya "otak"-mu terpisah jelas:

```bash
# dari root project
mv AhyarBrainVault BudiBrainVault          # ganti "Budi" sesuai pemilik
```

Lalu arahkan script ke nama baru. Di `frontend/scripts/brain-worker.env`
(lihat bagian **4. Brain Engine**) set:

```env
OBSIDIAN_VAULT_PATH=../BudiBrainVault
CHAT_SAMPLE_DIR=../BudiBrainVault/85_Chat_Samples
```

> 💡 Default semua script menunjuk ke `../AhyarBrainVault`. Cukup override lewat
> dua env di atas — tidak perlu mengedit file script satu per satu.

Terakhir, samakan nama di `.gitignore` (bagian "PRIVASI: isi otak pribadi")
agar isi vault barumu tetap tidak ikut ter-commit — ganti tiap baris
`AhyarBrainVault/...` menjadi `BudiBrainVault/...`.

### Langkah 3 — Siapkan database Supabase

Pasang Supabase CLI lebih dulu, lalu pilih salah satu:

**Opsi A — Local dev (butuh Docker):**
```bash
# dari root project
supabase start            # jalankan stack Supabase lokal (sekali saja)
supabase db reset         # apply semua migration + jalankan seed.sql
```

**Opsi B — Project remote:**
```bash
supabase link --project-ref <project-ref>
supabase db push          # push migration ke database remote
```

**Opsi C — Manual:** tempel isi `supabase/migrations/*.sql` ke **Supabase Studio →
SQL Editor**, jalankan, lalu jalankan `supabase/seed.sql`.

> ⚠️ `seed.sql` memakai placeholder `user_id`
> `00000000-0000-0000-0000-000000000001`. Saat testing dengan akun asli,
> cari–ganti UUID itu dengan user id Supabase-mu (ambil dari `auth.users`), kalau
> tidak RLS akan menyembunyikan baris seed. Seed bersifat idempotent (aman
> dijalankan ulang).

Detail schema, tabel, dan RLS: lihat [`supabase/README.md`](supabase/README.md).

### Langkah 4 — Konfigurasi env frontend (Vite)

```bash
cd frontend
cp .env.example .env
```

Isi `.env` dengan kredensial Supabase project kamu:

| Variabel | Wajib | Keterangan |
|----------|-------|------------|
| `VITE_SUPABASE_URL` | ✅ | URL project Supabase |
| `VITE_SUPABASE_ANON_KEY` | ✅ | **anon key** saja — RLS yang melindungi data |
| `VITE_USE_DEV_FALLBACK` | — | `true` = pakai data graph dummy tanpa Supabase (untuk dev UI) |
| `VITE_BRAIN_ENGINE_TRIGGER` | — | `local_worker` (panggil script lokal) atau `edge_function` |

> 🔒 **JANGAN** pernah menaruh **service_role key** di frontend atau commit `.env`.
> Frontend hanya boleh memakai anon key.

### Langkah 5 — Jalankan frontend

```bash
npm run dev          # buka http://localhost:5173
```

Untuk sekadar melihat tampilan tanpa DB: set `VITE_USE_DEV_FALLBACK=true` di `.env`.

---

## 4. Brain Engine (opsional, untuk ekstraksi graph)

Brain Engine membaca raw diary dan mengekstrak node/edge via LLM. Ada dua mode.

### Mode A — Local worker (paling sederhana untuk dev)

```bash
cd frontend/scripts
cp brain-worker.env.example brain-worker.env
```

Edit `brain-worker.env`, minimal isi:

- **Akses Supabase** — pilih salah satu:
  - `SUPABASE_SERVICE_ROLE_KEY` (paling simpel, simpan **hanya lokal**), atau
  - `SUPABASE_USER_EMAIL` + `SUPABASE_USER_PASSWORD`, atau
  - `SUPABASE_ACCESS_TOKEN`
- **LLM provider** (default Claude Code CLI):
  ```env
  LLM_PROVIDER=claude-code
  CLAUDE_CODE_COMMAND=claude     # pastikan `claude` sudah login di terminal
  ```
  Alternatif: `LLM_PROVIDER=anthropic|openai|ollama` (lihat komentar di file).

Jalankan worker:
```bash
cd frontend
npm run brain:worker          # proses entry pending sekali
npm run brain:worker:watch    # mode watch (loop)
```

### Mode B — Supabase Edge Function

```bash
# set secrets (sekali)
supabase secrets set \
  ANTHROPIC_API_KEY=YOUR_KEY \
  ANTHROPIC_BASE_URL=https://api.anthropic.com

# deploy
supabase functions deploy process-brain-entry
```

Set `VITE_BRAIN_ENGINE_TRIGGER=edge_function` di `frontend/.env`. Detail:
[`supabase/functions/process-brain-entry/README.md`](supabase/functions/process-brain-entry/README.md).

---

## 5. Perintah Berguna

```bash
# Frontend
npm run dev              # dev server
npm run build            # type-check + build production
npm run preview          # preview hasil build

# Brain routine & maintenance (jalankan dari frontend/)
npm run brain:routine    # orchestrator: import → extract → sync → eval
npm run brain:backup     # backup brain data
npm run brain:audit      # audit final
npm run release:check    # cek kesiapan rilis

# Obsidian
npm run obsidian:import  # impor diary dari vault → raw_entries
npm run obsidian:sync    # sinkron graph → kembali ke vault
```

Daftar lengkap script ada di `frontend/package.json` (`scripts`).

---

## 6. Verifikasi Setup

1. `npm run dev` → buka browser, UI muncul tanpa error koneksi Supabase.
2. Tulis satu entry lewat Quick Input (atau impor dari Obsidian).
3. Jalankan `npm run brain:worker` → entry diproses jadi node/edge.
4. Refresh UI → graph "peta otak" tampil.

---

## 7. Dokumentasi Lanjutan

- [`BRAINSTORM.md`](BRAINSTORM.md) — visi, model domain, prinsip kerja
- [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md) — arsitektur 4 lapis
- [`docs/DAILY_USAGE_GUIDE.md`](docs/DAILY_USAGE_GUIDE.md) — alur pemakaian harian
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — masalah umum
- [`docs/FINAL_OPERATING_MANUAL.md`](docs/FINAL_OPERATING_MANUAL.md) — manual operasi lengkap
- [`supabase/README.md`](supabase/README.md) — schema & RLS

---

## 8. Catatan Keamanan & Batasan

- **Local-first & privasi default-on** — diary itu pribadi; jangan kirim isinya ke
  layanan eksternal tanpa izin eksplisit.
- **Anon key di frontend, service_role hanya di server/worker lokal.**
- **Raw entry itu suci** — tidak pernah diubah/dihapus otomatis; graph adalah
  turunan yang bisa di-build ulang.
- MVP ini **tidak** mencakup: aksi agent otonom, hosting backend produksi, mobile
  app, integrasi calendar/email, atau cloud backup otomatis.
