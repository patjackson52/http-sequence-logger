# Shipyard work-item policy

This indexed policy applies to HTTP Sequence Logger project `P-11`. Read the repository `AGENTS.md` and the relevant task guide before implementation.

## Landing and verification

- Commit durable work to the `wi/<id>` branch before final full-suite verification; finish with a committed state.
- Run the baseline `verify_command` from `.shipyard.yaml` through `shipyard verify` for dispatched work. Use Node 24.13.x and install pinned dependencies with `npm ci`.
- Also run the applicable platform and flow checks in `AGENTS.md`. Preserve debug/no-op release boundaries and validate actual captures when integrating a consumer application.
- Preserve others' edits and keep changes within the work-item scope. Credentials, pairing files, private capture payloads, and build artifacts stay out of commits.

## Session handoff

If work exceeds its budget or stalls, commit WIP and end `progressed` with the exact commits, remaining work, branch/rebase state, concrete blocker, and next step.

## Completion

Each acceptance criterion has evidence. Report checks actually run, their results, and concrete environmental limits. Distinguish source compatibility, publication, deployment, device installation, and human acceptance.
