# Brain Engine MVP - `process-brain-entry`

Supabase Edge Function yang membaca **satu** `raw_entries`, mengekstrak node &
edge memakai LLM, lalu menyimpannya ke `brain_nodes` / `brain_edges`.

## Fungsi Singkat

```
{ raw_entry_id }  ->  validasi user & kepemilikan
                  ->  extraction_jobs (processing) + raw_entries=processing
                  ->  LLM (structured JSON via forced tool use)
                  ->  upsert brain_nodes (anti-duplikat: user+type+canonical_name)
                  ->  upsert brain_edges (anti-duplikat: user+from+to+relation)
                  ->  agent_memories (important/core)
                  ->  raw_entries=done + extraction_jobs=done(output_snapshot)
   (error)        ->  raw_entries=failed + extraction_jobs=failed(error_message)
```

## Input

```json
{ "raw_entry_id": "uuid" }
```

Header `Authorization: Bearer <user-jwt>` wajib (otomatis dikirim supabase-js).

## Environment Variable

| Var | Wajib | Keterangan |
|---|---|---|
| `SUPABASE_URL` | auto | Tersedia otomatis di runtime function |
| `SUPABASE_ANON_KEY` | auto | idem |
| `SUPABASE_SERVICE_ROLE_KEY` | auto | idem - **hanya di server**, jangan di frontend |
| `LLM_API_KEY` / `ANTHROPIC_API_KEY` | ya | Kunci LLM |
| `LLM_BASE_URL` / `ANTHROPIC_BASE_URL` | ya | Endpoint LLM (untuk FreeModel: `https://cc.freemodel.dev`) |
| `LLM_MODEL` / `ANTHROPIC_MODEL` / `CLAUDE_CODE_MODEL` | tidak | Nama model; opsional, bisa override fallback Anthropic-compatible |
| `LLM_PROTOCOL` | tidak | `anthropic` (default) atau `openai` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | tidak | Sesuai rekomendasi config Claude Code FreeModel |

Untuk setup FreeModel dari docs Claude Code, gunakan `ANTHROPIC_API_KEY` dan
`ANTHROPIC_BASE_URL=https://cc.freemodel.dev`.

## Deploy

```bash
# 1. set secrets (sekali)
supabase secrets set \
  ANTHROPIC_API_KEY=YOUR_KEY \
  ANTHROPIC_BASE_URL=https://cc.freemodel.dev \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# 2. deploy function
supabase functions deploy process-brain-entry
```

## Test cepat (curl)

```bash
curl -i -X POST "https://<project-ref>.functions.supabase.co/process-brain-entry" \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"raw_entry_id":"<uuid>"}'
```

`<USER_JWT>` = access token user yang login (dari sesi Supabase di frontend).

## Lokal

```bash
supabase functions serve process-brain-entry --env-file supabase/functions/.env
```

## Keamanan

- User harus login; function memverifikasi JWT (`auth.getUser`).
- Semua query DB di-scope ke `user.id` -> tidak bisa memproses entry user lain.
- `SERVICE_ROLE_KEY` dipakai hanya di function (server), **tidak pernah** di frontend.
