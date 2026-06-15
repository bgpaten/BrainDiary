# Local Brain Engine Worker

Worker lokal untuk memproses `raw_entries` dari Supabase tanpa memanggil LLM dari
Supabase Edge Function.

Alur:

```text
React Quick Input -> raw_entries pending/failed
local brain worker -> Claude Code CLI / Anthropic / OpenAI / Ollama
local brain worker -> brain_nodes + brain_edges + extraction_jobs
React refresh graph
```

## Setup

```bash
cd frontend
cp scripts/brain-worker.env.example scripts/brain-worker.env
```

Isi `scripts/brain-worker.env`.

Untuk memakai official Claude Code client lokal:

```env
LLM_PROVIDER=claude-code
CLAUDE_CODE_COMMAND=claude
ANTHROPIC_API_KEY=YOUR_FREEMODEL_KEY
ANTHROPIC_BASE_URL=https://cc.freemodel.dev
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

Pilih salah satu akses Supabase:

```env
# Mode user login biasa, RLS tetap berlaku.
SUPABASE_USER_EMAIL=you@example.com
SUPABASE_USER_PASSWORD=your-password
```

atau:

```env
# Mode service role lokal. Jangan commit file ini.
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

## Jalankan

Proses maksimal 5 entry `pending` / `failed` sekali jalan:

```bash
npm run brain:worker
```

Watch mode, polling setiap 15 detik:

```bash
npm run brain:worker:watch
```

Override limit:

```bash
npm run brain:worker -- --limit 1
```

## Catatan

- Worker ini berjalan di terminal lokal, bukan di browser.
- `frontend/.env` tetap hanya untuk `VITE_*`.
- Jika memakai `LLM_PROVIDER=claude-code`, request LLM berasal dari official
  Claude Code CLI lokal.
- Edge Function tetap bisa dipakai nanti jika provider API server-to-server sudah
  tersedia.
