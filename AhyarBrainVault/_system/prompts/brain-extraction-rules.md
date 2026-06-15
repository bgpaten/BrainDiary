# Brain Extraction Rules

> Aturan untuk **Brain Engine** di fase berikutnya. File ini adalah kontrak.
> Brain Engine membaca catatan dari vault ini lalu menghasilkan node + relasi
> yang nantinya disimpan ke Supabase.
>
> **Fase ini belum mengimplementasikan engine apa pun.** Dokumen ini hanya
> menetapkan aturan main supaya implementasi nanti konsisten.

---

## Tipe Node yang Harus Diekstrak

Brain Engine harus mampu mengenali dan mengekstrak entitas berikut dari diary:

- `person` — orang
- `place` — tempat
- `event` — kejadian
- `project` — project / pekerjaan
- `decision` — keputusan
- `emotion` — emosi / perasaan
- `goal` — target / tujuan / ambisi
- `pattern` — pola berulang, kebiasaan, masalah berulang, insight
- `organization` — organisasi / perusahaan / institusi
- `topic` — tema / topik yang dibahas

---

## Aturan Ekstraksi (WAJIB)

1. **Jangan mengarang fakta.** Hanya ekstrak yang benar-benar ada di teks.
2. **Jangan membuat node tanpa bukti dari diary.** Setiap node harus punya
   kalimat sumber.
3. **Gabungkan entitas yang jelas sama.** Contoh: "Budi", "si Budi", "bos"
   yang merujuk orang yang sama → satu node.
4. **Jika tidak yakin, beri confidence rendah.** Jangan paksakan kepastian.
5. **Bedakan dengan tegas `event`, `decision`, `goal`, dan `pattern`:**
   - `event` = sesuatu yang **terjadi** (sudah/sedang berlangsung).
   - `decision` = **pilihan** yang diambil.
   - `goal` = sesuatu yang **ingin dicapai** di masa depan.
   - `pattern` = sesuatu yang **berulang** atau insight lintas waktu.
6. **Diary mentah tidak boleh dihapus.** Engine hanya membaca, tidak mengubah
   teks diary asli.
7. **Status proses lewat field `processed`:**
   - `processed: false` → file **belum** diproses Brain Engine.
   - `processed: true` → file **sudah** diproses.
8. **Attachment harus tetap dikaitkan ke diary asalnya.** Jangan memutus relasi
   file pendukung dengan entry sumbernya.
9. **Setiap hasil ekstraksi harus bisa dilacak kembali ke diary sumber**
   (provenance). Simpan referensi ke file/baris/tanggal asal.

---

## Catatan Implementasi (untuk fase berikutnya)

- Hasil ekstraksi sementara ditaruh di `_system/extraction-output/` sebelum
  masuk ke Supabase.
- Log proses ditaruh di `_system/logs/`.
- Engine menandai file yang sudah diproses dengan `processed: true` dan
  mengisi field relasi (`people`, `projects`, dst) di frontmatter diary.
