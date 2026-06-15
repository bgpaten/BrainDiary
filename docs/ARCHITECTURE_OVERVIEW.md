# Architecture Overview

Personal Entity OS adalah local-first personal memory system dengan empat
lapisan utama:

- Obsidian raw vault: diary, attachments, chat samples, dan report system.
- Supabase structured memory: raw entries, graph, identity, style, calibration,
  similarity, drift, reflection, conflicts, eval, runtime, long-term memory, dan
  final release tables.
- React UI: graph, review, chat, timeline, digest, evaluation, routine, backup,
  calibration, similarity, drift, reflection, chat samples, conflicts,
  self-clone eval, runtime, long-term memory, dan final release.
- Local scripts: importer, worker, sync, digest, backup, identity,
  communication, response inference, calibration, similarity, drift,
  reflection, chat sample importer, conflict resolver, self-clone eval, safe
  runtime, memory consolidation, dan final release.

Core pipeline:

1. Obsidian Importer membaca diary menjadi `raw_entries`.
2. Brain Worker mengekstrak graph dan memories.
3. Identity Fidelity membangun identity facts/snapshots.
4. Communication Style membaca samples/patterns.
5. Response Inference menjawab fidelity-first.
6. Owner Calibration dan Similarity Loop mengukur kemiripan dengan owner.
7. Drift Guard menahan overclaim, source leak, dan too-AI behavior.
8. Self Reflection menyimpan perubahan pemahaman tanpa auto-apply.
9. Chat Sample Importer menambah evidence percakapan owner.
10. Identity Conflicts menyimpan tension/contradiction sebagai konteks.
11. Self-Clone Evaluation mengukur readiness agent.
12. Safe Runtime membatasi agent ke read-only/proposal-only.
13. Long-Term Memory mengonsolidasikan memory jangka panjang.
14. Final Release mengecek seluruh sistem sebelum daily use.

Boundary desain:

- Raw data tidak dihapus otomatis.
- Identity/communication/calibration tidak auto-mutasi agresif.
- External actions tetap blocked.
- Runtime logs/proposals/reports boleh ditulis.
- Final release hanya membaca, mengecek, dan menulis release tables/reports.
