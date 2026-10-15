# dhc-steward — a Claude Code mod for this repository

Keeps Claude Code working to the [build plan](../../../docs/product/build-plan.md) and the repository rules while it maintains and builds the platform.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install dhc-steward --marketplace heyyrintu/digital-health-care
```

From a shell: `claude plugin install dhc-steward --marketplace heyyrintu/digital-health-care`. While working on the mod itself, run `claude --plugin-dir tools/claude/dhc-steward` instead.

## What it adds

| Kind        | Name                                          | What it does                                                                                                                                                                                     |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command     | `/dhc`                                        | Opens a pane with each phase from the §9.1 progress table, the last check result, and buttons: Refresh, Run checks, Build next                                                                   |
| Command     | `/dhc-check [package]`                        | Runs what CI runs: `pnpm format:check`, then `turbo run lint typecheck test build` (with a package, that package and its dependents); installs dependencies first when `node_modules` is missing |
| Command     | `/dhc-next [focus]`                           | Orchestrates the next increment: reads the plan, splits the work, runs `builder` agents in parallel, runs checks, has `reviewer` read the diff, updates docs and the changelog, opens a draft PR |
| Tool        | `plan_status`, `run_checks`                   | The same plan reading and checks, for the model to call itself                                                                                                                                   |
| Agent types | `dhc-steward:builder`, `dhc-steward:reviewer` | A builder for one well-scoped slice (does not commit) and a read-only reviewer for tenancy, safety, migrations, synthetic data, tests, strings, audit events and docs                            |
| Guards      | Edit, Write, Bash                             | Refuses edits to applied migrations under `packages/db/prisma/migrations`, pushes to `main`, and force pushes                                                                                    |
| Prompt      | system prompt section                         | The repository rules from the README and build plan, in every request                                                                                                                            |

The status line shows the current phase, then the result of the last check.

## Layout and tests

- `hooks/register.tsx` — the hooks module (commands, tools, agents, guards, pane)
- `hooks/plan.ts` — pure helpers: the §9.1 progress-table parser, the migration and push rules
- `types/index.d.ts` — the session state the pane reads

```
claude plugin validate tools/claude/dhc-steward
claude plugin test tools/claude/dhc-steward
```

When the §9.1 progress table changes shape (columns, the "Progress" heading), update `parseProgress` and its test in the same pull request.
