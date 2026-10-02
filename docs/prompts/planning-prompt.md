# Planning Shipyard work for HTTP Sequence Logger

Plan work for Shipyard project `P-11` from an exact accepted specification commit. Read `AGENTS.md` and its task route first; source APIs and current contract files determine implemented behavior.

## Inputs

Record the specification paths and full commit, current main commit, affected platforms, concrete user flow, and relevant prior failures. Treat Android, iOS, browser, collector/viewer, and sequence comparison as separate implementation boundaries.

## Plan

- Break the objective into bounded work items with native dependency edges. Each item must fit one session; split by platform or product surface where that makes verification independent.
- Give each item an objective, source and test entry points, explicit scope, falsifiable acceptance criteria, verification command, handoff format, and tier rationale supported by the selected harness.
- Link the indexed `docs/prompts/wi-policy.md` policy and exact specification documents. Keep invariant policy out of individual work-item bodies.
- Create evidence requirements for acceptance criteria and pin the execution tier before moving work to `next`.
- Include platform checks from `AGENTS.md` when changing Android/iOS release isolation, browser release boundaries, collector connection behavior, or comparison behavior. The baseline `verify_command` alone does not replace those checks.
- Keep credentials, pairing files, unsanitized captures, and generated build artifacts outside commits.

## Outputs and readback

Produce a pinned roadmap with work items, dependency edges, test entry points, evidence requirements, and tiers. Create the corresponding native Shipyard records, then inspect representative `shipyard context` results for delivered documents and constraints before activating work. Do not schedule work justified only by a hypothetical future deployment.
