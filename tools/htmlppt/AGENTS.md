# Agent notes

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`; specs at `.scratch/<feature>/spec.md`, tickets at `.scratch/<feature>/issues/NN-<slug>.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label string equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root (both created lazily). See `docs/agents/domain.md`.
