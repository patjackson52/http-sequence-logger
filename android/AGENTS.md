<!-- shipyard-deploy:begin -->
## Shipyard Deploy

This repository publishes development builds of `dev.networklog.sample.dev` (Gradle variant `devDebug`)
to the Shipyard Deploy project `http-sequence-logger`. Configuration lives in `.shipyard-deploy.yaml`;
read it rather than hard-coding a project or a channel name.

Which channel a build goes to is decided by the current git branch
(`{branch_slug}` is the branch lowercased, non-alphanumerics collapsed to
`-`, truncated to 40 characters — so two similar branch names can land on
one channel and overwrite each other):

- branch `main` → `main`
- any other branch → `dev-{branch_slug}`

### The commands an agent may run

```sh
shipyard-deploy doctor --json                 # is the environment usable at all
shipyard-deploy status --json                 # what is published, where, from which branch
shipyard-deploy channels list --json          # where this branch would publish
shipyard-deploy publish <apk> --dry-run       # resolve the plan without uploading
shipyard-deploy publish <apk>                 # publish; the channel is created if missing
```

That is the whole list. `login`, `logout`, `rollback`, `enroll-code`,
`devices`, `channels create` and `resume` belong to a human.

Build the APK first with `./gradlew :app:assembleDevDebug`.
Every command takes `--json` and returns a single object; exit code 0 means it worked.

### Do not

- Do not publish a build you did not just build from the current working tree.
- Do not pass `--project` or `--channel` to work around a failure; they
  override this file, and the failure is usually the honest answer.
- Do not choose a control plane. This file's `server:` is a hint, not a
  decision: the CLI takes the server from `--server`, then
  `SHIPYARD_DEPLOY_SERVER`, then one you have logged in to. If it refuses
  with `server_untrusted` (exit 21), stop and report both hostnames rather
  than passing `--trust-config-server`.
- Do not publish from a dirty working tree without saying so in the release notes;
  provenance records `dirty: true` and reviewers will see it.
- Do not touch the release variant. Shipyard refuses it by design: it distributes
  development builds only.
- Do not add or edit credentials. `shipyard-deploy doctor` says whether the
  environment is usable; if it is not, stop and report that.
<!-- shipyard-deploy:end -->
