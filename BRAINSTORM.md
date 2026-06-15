# BrainDiary — Brainstorm & Context Brief

> **Baca file ini setiap mau mulai ngoding.**
> Tujuannya menyamakan pemahaman antara manusia & AI agent sebelum nulis kode.
> Kalau ada keputusan baru, update file ini dulu — baru ngoding.

Status: **🧠 Brainstorm / belum ada kode**
Update terakhir: 2026-06-11

---

## 1. Visi Singkat

Kamu menulis diary harian (cerita bebas). Sistem **membaca** isi diary,
**mengenali** entitas & makna, lalu **membangun "peta otak"** — graph dari
hidup dan proyekmu. AI agent lain bisa membaca graph ini untuk memahami
konteksmu tanpa kamu jelaskan ulang.

**One-liner:** *Diary → Graph otak → Konteks yang bisa dibaca AI & manusia.*

---

## 2. Alur Inti (end-to-end)

```
1. Tulis diary (teks bebas, harian)
        │
2. Ingest  → simpan entry mentah (raw, jangan diubah)
        │
3. Extract → AI baca entry, kenali:
        │     orang · tempat · project · kejadian ·
        │     keputusan · emosi · target · pola
        │
4. Resolve → samakan entitas ("Budi" hari ini = "Budi" minggu lalu)
        │
5. Graph   → buat/ update NODE + EDGE (relasi antar node)
        │
6. Visual  → frontend tampilkan peta otak (force-directed graph)
        │
7. Query   → AI agent baca graph untuk paham konteks hidup/proyek
```

Prinsip: **raw entry selalu disimpan utuh.** Graph adalah *turunan* yang bisa
dibangun ulang (re-extract) kapan saja kalau model/aturan berubah.

---

## 3. Model Domain (Node & Edge)

### Tipe Node (kandidat awal)
| Tipe        | Contoh                                   |
|-------------|------------------------------------------|
| `Person`    | Budi, klien, mentor                      |
| `Place`     | kantor, Bali, kos                        |
| `Project`   | BrainDiary, skripsi                      |
| `Event`     | rapat, deadline, jatuh sakit             |
| `Decision`  | "berhenti pakai X", "ambil tawaran kerja"|
| `Emotion`   | cemas, lega, semangat                    |
| `Goal`      | rilis MVP, lari 5K                       |
| `Topic`     | tema/pola berulang                       |
| `DiaryEntry`| entry mentah (node sumber)               |

### Tipe Edge (relasi — kandidat awal)
- `MENTIONS` — entry menyebut node
- `INVOLVES` — event/project melibatkan orang
- `LOCATED_AT` — kejadian di tempat
- `DECIDED` — keputusan terkait project/goal
- `FELT` — emosi terhadap sesuatu
- `WORKS_ON` — orang ↔ project
- `BLOCKS` / `LEADS_TO` — sebab-akibat antar event/decision
- `PROGRESSES` — entry/event mendorong goal

> Edge sebaiknya punya **timestamp/source** (dari entry mana relasi ini muncul)
> supaya graph bisa di-trace balik ke kalimat aslinya. Jangan bikin relasi
> "yatim" yang nggak bisa dibuktikan dari teks.

### Atribut wajib tiap node
`id` · `type` · `label/name` · `firstSeen` · `lastSeen` · `aliases[]` ·
`sourceEntries[]` (entry mana saja yang menyebut node ini).

---

## 4. Tantangan Kunci (yang harus dipikirkan sebelum ngoding)

1. **Entity resolution** — "Budi", "budi", "si B", "bos" bisa orang yang sama
   atau beda. Ini masalah tersulit. Mulai sederhana (match nama + konteks),
   sediakan cara koreksi manual (merge/split node).
2. **Konsistensi ekstraksi** — LLM bisa labil. Butuh skema output ketat
   (JSON schema) + validasi, bukan teks bebas.
3. **Idempotency** — re-extract entry yang sama tidak boleh bikin node dobel.
4. **Privasi** — diary itu sangat pribadi. Default lokal/terenkripsi. Pikirkan
   ini dari awal, bukan belakangan.
5. **Provenance** — tiap node/edge harus bisa dijawab: "ini datang dari kalimat
   mana, entry tanggal berapa?" Tanpa ini, graph nggak bisa dipercaya.
6. **Evolusi makna** — perasaan/keputusan berubah seiring waktu. Graph harus
   merekam *perubahan*, bukan cuma snapshot terakhir.

---

## 5. Arsitektur — Opsi (belum diputuskan)

### Penyimpanan graph
- **A. Graph DB** (Neo4j / Memgraph) — natural untuk query relasi, kurva belajar.
- **B. Relational/SQLite + tabel nodes/edges** — simpel, portable, lokal-first.
- **C. Embedded** (DuckDB / file JSON) — paling ringan untuk MVP.

### Lapisan ekstraksi
- LLM (Claude) dengan **structured output / tool-use** → JSON node+edge.
- Aturan/regex untuk hal deterministik (tanggal, mention).

### Frontend visual
- Web: `react-force-graph` / `cytoscape.js` / `d3-force`.
- Fitur: zoom, klik node → lihat entry sumber, filter per tipe, timeline.

### Bentuk sistem
- **Lokal-first** (privasi) vs **service** (sinkron multi-device). Lean ke lokal-first.

> ⚠️ Keputusan stack belum diambil. Isi bagian "Keputusan" di bawah saat dipilih.

---

## 6. Rencana Bertahap (saran milestone)

- **M0 — Skema & kontrak data.** Definisikan node/edge schema (JSON) + contoh.
- **M1 — Ingest.** Simpan diary entry mentah + metadata (tanggal, id).
- **M2 — Extract (1 entry).** LLM → JSON node/edge tervalidasi untuk satu entry.
- **M3 — Graph store + resolve.** Gabungkan banyak entry, hindari duplikat.
- **M4 — Visual.** Render peta otak dari graph.
- **M5 — Query API.** Endpoint biar AI agent baca konteks ("apa yang lagi
  dikerjakan?", "siapa yang sering muncul soal proyek X?").
- **M6 — Koreksi manual.** Merge/split/hapus node, edit relasi.

Bangun **tipis & vertikal**: lebih baik 1 entry yang jalan penuh sampai visual,
daripada semua fitur setengah jadi.

---

## 7. Pertanyaan Terbuka (jawab dulu sebelum ngoding fitur terkait)

- [ ] Bahasa diary: Indonesia, Inggris, atau campur? (pengaruh prompt ekstraksi)
- [ ] Lokal-first atau ada server? Enkripsi at-rest?
- [ ] Graph DB atau SQLite untuk MVP?
- [ ] Web app, desktop, atau CLI dulu?
- [ ] Realtime (extract saat nulis) atau batch (proses harian)?
- [ ] Sejauh mana koreksi manual dibutuhkan di MVP?
- [ ] Model LLM mana & jalan di mana (API vs lokal)? Anggaran token?

---

## 8. Prinsip Kerja AI Agent (aturan main di repo ini)

1. **Baca file ini dulu.** Kalau ada konflik dengan permintaan, tanyakan.
2. **Raw entry itu suci** — jangan pernah ubah/hapus teks diary asli.
3. **Structured output** untuk semua hasil ekstraksi LLM (skema + validasi).
4. **Provenance wajib** — tiap node/edge harus bisa dilacak ke entry sumber.
5. **Idempotent** — proses ulang tidak merusak / menggandakan data.
6. **Privasi default-on** — jangan kirim isi diary ke layanan eksternal tanpa
   izin eksplisit user.
7. **Vertikal dulu** — fitur tipis end-to-end > banyak fitur setengah jadi.
8. **Update dokumen sebelum kode** — keputusan arsitektur dicatat di §9.

---

## 9. Keputusan yang Sudah Diambil (Decision Log)

> Kosong dulu. Format:
> `2026-MM-DD — <keputusan> — <alasan singkat>`

- _(belum ada)_

---

## 10. Glosarium

- **Entry** — satu tulisan diary (teks mentah + tanggal).
- **Node** — entitas/konsep di graph (orang, tempat, project, dst).
- **Edge** — relasi berarah antar node, dengan sumber & waktu.
- **Brain / Graph** — keseluruhan peta node+edge, turunan dari semua entry.
- **Provenance** — jejak asal: node/edge ini berasal dari kalimat/entry mana.
- **Resolution** — proses menyatukan sebutan berbeda jadi satu node.
```