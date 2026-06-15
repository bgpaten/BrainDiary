# Daily Usage Guide

Panduan ini memakai folder `frontend` sebagai working directory.

1. Tulis diary di `AhyarBrainVault/00_Diary`.
2. Import diary:

```bash
npm run obsidian:import
```

3. Import attachment jika ada:

```bash
npm run attachments:import
```

4. Import chat sample dari `AhyarBrainVault/85_Chat_Samples`:

```bash
npm run chats:import
```

5. Process brain:

```bash
npm run brain:worker
npm run brain:index
```

6. Build identity dan communication style:

```bash
npm run identity:build
npm run communication:build
```

7. Calibrate owner answers dan similarity:

```bash
npm run owner:calibrate
npm run similarity:run
```

8. Run drift, reflection, conflicts, dan long-term memory:

```bash
npm run drift:audit
npm run reflection:daily
npm run conflicts:detect
npm run memory:consolidate
npm run memory:snapshot
```

9. Run final self-clone eval:

```bash
npm run clone:cases -- --generate --suite release
npm run clone:run -- --suite release
npm run clone:readiness
```

10. Start safe runtime:

```bash
npm run entity:policies -- --seed
npm run entity:session -- --start --mode read_only
```

11. Chat dengan entity:

```bash
npm run brain:chat
npm run entity:run -- --question "hi"
```

12. Backup:

```bash
npm run brain:backup
```

13. Final release check:

```bash
npm run release:check
npm run release:final
npm run release:notes
```

14. Jalankan frontend:

```bash
npm run dev
```

Buka mode `Final Release` untuk melihat score, blockers, warnings, artifacts,
dan release notes.
