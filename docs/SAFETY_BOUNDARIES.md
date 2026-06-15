# Safety Boundaries

Personal Entity OS adalah personal entity simulation, bukan manusia asli dan
bukan kesadaran asli. Target sistem adalah menjawab berdasarkan pertanyaan:
"Jika pemilik diary asli menerima prompt ini, kemungkinan besar dia akan
menjawab apa?"

Runtime default adalah read-only/proposal-only. Runtime boleh membaca memory,
identity, communication style, calibration, similarity, drift, reflection,
conflict, self-clone evaluation, dan long-term memory. Runtime boleh menjawab,
membuat saran, membuat draft, dan membuat action proposal.

Runtime tidak boleh:

- mengirim email, calendar event, GitHub action, WhatsApp, Telegram, atau API
  action eksternal;
- menjalankan shell command dari input user;
- menulis file bebas atau menghapus file;
- menghapus raw diary, chat, attachment, atau brain data;
- auto-edit `identity_facts`;
- auto-edit `communication_patterns`;
- auto-edit `owner_calibration_hints`;
- fine-tuning;
- mengklaim sebagai manusia asli;
- mengklaim punya kesadaran asli.

Memory consolidation tidak menghapus raw data. Duplicate, stale, archive, core
memory, dan identity/communication update candidate masuk review queue terlebih
dulu.

Approval proposal di Step 30 tidak mengeksekusi action otomatis. Approval hanya
mengubah status proposal. Semua proposal tetap harus dieksekusi manual oleh
owner di luar Personal Entity OS.
