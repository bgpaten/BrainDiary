# Personal Brain OS Release Checklist

## Migrations And Env

- [ ] All Supabase migrations applied remotely.
- [ ] `brain_routine_runs` exists.
- [ ] `brain_health_checks` exists or optional health fallback is documented.
- [ ] RLS policies are enabled for brain tables.
- [ ] `frontend/.env` configured locally.
- [ ] `frontend/scripts/brain-worker.env` configured locally.
- [ ] No service role key in any `VITE_*` variable.

## Frontend Smoke Test

- [ ] `npm run dev` starts.
- [ ] Login works.
- [ ] Graph mode loads.
- [ ] Review mode loads.
- [ ] Chat mode loads.
- [ ] Timeline mode loads.
- [ ] Digest mode loads.
- [ ] Evaluation mode loads.
- [ ] Routine mode loads.
- [ ] Backup mode loads.
- [ ] Calibration mode loads.
- [ ] Similarity mode loads.
- [ ] Drift mode loads.
- [ ] Reflection mode loads.
- [ ] Chat Samples mode loads.
- [ ] Conflicts mode loads.
- [ ] Self-Clone Eval mode loads.
- [ ] Runtime mode loads.
- [ ] Long-Term Memory mode loads.
- [ ] Final Release mode loads.
- [ ] Quick diary input works.

## Pipeline Commands

- [ ] `npm run obsidian:import`
- [ ] `npm run attachments:import`
- [ ] `npm run brain:worker`
- [ ] `npm run brain:index`
- [ ] `npm run obsidian:sync`
- [ ] `npm run brain:persona`
- [ ] `npm run brain:digest:today`
- [ ] `npm run brain:eval`
- [ ] `npm run brain:routine`
- [ ] `npm run brain:backup`
- [ ] `npm run brain:recovery -- --check`

## Quality Gates

- [ ] Latest evaluation exists.
- [ ] Latest evaluation score is acceptable or documented.
- [ ] Latest hallucination risk is acceptable or documented.
- [ ] Latest routine is `done` or `partial` reasons are documented.
- [ ] Recovery check is not critical, or critical issue has a next action.
- [ ] Low confidence nodes/edges reviewed or documented.
- [ ] Duplicate candidates reviewed or documented.

## Backup And Restore

- [ ] Latest backup exists.
- [ ] `manifest.json` exists.
- [ ] Supabase JSON files exist.
- [ ] Obsidian vault backup exists if enabled.
- [ ] Backup secret scan is clean.
- [ ] Restore preview works.
- [ ] Restore without `--confirm` is rejected.

## Build And Release

- [ ] `npm run build` passes.
- [ ] `npm run brain:audit` runs.
- [ ] `npm run brain:release-check` runs.
- [ ] `npm run release:check` runs.
- [ ] `npm run release:final` runs if final gate is intended.
- [ ] `npm run release:notes` creates notes.
- [ ] `dist` secret scan is clean.
- [ ] Large chunk warning is reduced by lazy loading or documented.
- [ ] `docs/FINAL_OPERATING_MANUAL.md` is current.
- [ ] User has read restore and backup limitations.

## Final Release Gate

- [ ] `final_release_runs` exists.
- [ ] `final_release_checks` exists.
- [ ] `final_release_artifacts` exists.
- [ ] `final_release_notes` exists.
- [ ] RLS is enabled for final release tables.
- [ ] Latest final release decision is documented.
- [ ] Critical security/runtime blockers are zero.
- [ ] Backup requirement is satisfied or release is intentionally blocked.
- [ ] Runtime policies are seeded and external actions are blocked.
- [ ] Self-clone evaluation latest readiness is at least `usable_with_warning`.
- [ ] Long-term memory consolidation and snapshot exist if required.
- [ ] Final release Obsidian reports exist.
