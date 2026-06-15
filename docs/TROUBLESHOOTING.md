# Troubleshooting

## Supabase Migration Belum Apply

Jalankan:

```bash
supabase db push
```

Jika schema cache error, restart Supabase/local dev lalu ulangi command.

## RLS Blocked

Pastikan script memakai user yang benar. Untuk local scripts, set
`BRAIN_USER_ID` atau gunakan Supabase credentials yang punya akses sesuai RLS.

## Service Role Missing

Local scripts bisa memakai `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN`,
atau anon key dengan auth context. Jangan pernah memasukkan service role ke
frontend bundle atau `VITE_*`.

## Vite Endpoint Unavailable

Jalankan dari folder `frontend`:

```bash
npm run dev
```

Endpoint local dev seperti `/__final-release/check` hanya tersedia lewat Vite
dev server.

## Worker Failed

Cek env Supabase, migration, RLS, dan table yang diminta script. Jalankan
`node --check scripts/<script>.mjs` untuk syntax.

## LLM Provider Failed

Matikan provider terkait agar fallback deterministic berjalan, atau isi env
provider/model/API key yang sesuai. Jangan hardcode provider.

## Chat Berbelit atau Greeting Terlalu AI-like

Jalankan:

```bash
npm run chats:import
npm run communication:build
npm run owner:calibrate
npm run drift:audit
```

Pastikan social greeting owner examples tersedia.

## Identity Overclaim

Jalankan identity audit, drift audit, conflict detection, dan self-clone eval.
High confidence identity fact harus punya evidence.

## Communication Pattern Kurang Data

Tambahkan chat sample owner asli, import, lalu rebuild communication style.

## Calibration atau Similarity Rendah

Tambahkan owner answer examples, jalankan calibration, similarity, dan lihat
critical failures pada Self-Clone Eval.

## Drift Guard High Risk

Cek source/debug leak, too-AI phrase, overclaim, underfit, stale memory, dan
conflict-linked memory yang diabaikan.

## Backup Gagal

Cek `BRAIN_BACKUP_DIR`, permission folder, dan secret scan backup.

## Secret Scan Failed

Hapus secret dari bundle/env `VITE_*`, rebuild, lalu ulangi:

```bash
npm run build
npm run release:check
```

## Build Failed

Jalankan:

```bash
npm run build
```

Perbaiki TypeScript/Vite import yang gagal sebelum menjalankan final release.
