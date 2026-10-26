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

**Not created yet** — there is no GitHub repo behind this directory. Once the repo + remote exist, run this from the repo:

```sh
# A fresh GitHub repo already ships bug / enhancement / wontfix.
for l in needs-triage needs-info ready-for-agent ready-for-human; do
  gh label create "$l"
done
```

Then add a `wayfinder:*` family only if `/wayfinder` is used: `wayfinder:map`, plus `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
