# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

`/triage` also uses two **category** roles, `bug` and `enhancement`, alongside exactly one state role above.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

**Created 2026-10-26** on `rml4791lol-lang/ppt.an520.xin`: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, each with a description. GitHub ships `bug`, `enhancement`, and `wontfix` on every new repo, so those three needed no creation.

Re-running is safe if a label is ever deleted — `gh label create` only fails on an existing name:

```sh
for l in needs-triage needs-info ready-for-agent ready-for-human; do
  gh label create "$l" || true
done
```

**Not created**: the `wayfinder:*` family (`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`). Add them only if `/wayfinder` gets used.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
