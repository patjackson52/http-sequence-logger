# Shipyard and sample distribution

The registered Shipyard repository is **P-11**, `http-sequence-logger`. Its server
checkout is `/home/shipyard/workspace/http-sequence-logger`; `.shipyard.yaml`
declares `npm test && npm run build:viewer` as the verification gate. Run tests
from the repository root with Node 24.13.x after `npm ci`. Dispatched work records
the gate with `shipyard verify --project P-11`.

Runner **RUN-3** uses the isolated Mac checkout
`/Users/patrick/workspace/runner-grok/http-sequence-logger`. Its agent **AG-8** has
P-11 read/write access, and the checkout has the pinned Node dependencies.

## Android sample on Shipyard Deploy

Shipyard Deploy project `http-sequence-logger` distributes the **devDebug** sample
as `dev.networklog.sample.dev`. This is a separate installation from the ordinary
USB sample (`dev.networklog.sample`). It includes the debug recorder, transfer
bootstrap and development UI. Ordinary debug and both release variants have no
Shipyard identity; release variants also exclude recorder/transfer code.

The config and agent directions live in `android/.shipyard-deploy.yaml` and
`android/AGENTS.md`, beside Gradle settings. The config routes `main` to the `main`
channel, with seven-day retention and automatic install only when existing device
policy permits. Other branches notify on `dev-{branch_slug}` for 48 hours.

### Tool bootstrap

Install JDK 17 and Android SDK 35. Set `JAVA_HOME` and `ANDROID_HOME` for Gradle and
the release audit. The Gradle plugin is pinned to **0.1.0**, resolved from
`mavenLocal()`. This is local source installation; no public Maven publication is
required or claimed. The onboarding used Shipyard Deploy source commit
`47c3840135e06d7719c042a6d1e424f61f9f194f`:

```sh
# In that Shipyard Deploy checkout:
cd gradle-plugin
./gradlew -PshipyardPluginVersion=0.1.0 publishToMavenLocal
cd ../cli
go build -o bin/shipyard-deploy ./cmd/shipyard-deploy
export PATH="$PWD/bin:$PATH"
```

Use an existing trusted login and publisher credential. Run `shipyard-deploy
doctor --json` before publication. Login and credential provisioning remain
operator tasks; credentials do not live in this repository.

The saved publisher login at onboarding time was scoped to earlier projects.
An operator must provision publisher access to Deploy project
`http-sequence-logger` before routine publication through that login. Initial
registration/publication used the existing administrator credential reference
only in the command process, without changing the saved login.

### Build and publish

From this repository's `android/` directory:

```sh
./gradlew :app:tasks --group shipyard
./gradlew :app:assembleDevDebug
shipyard-deploy publish app/build/outputs/apk/devDebug/app-devDebug.apk --dry-run --json
shipyard-deploy publish app/build/outputs/apk/devDebug/app-devDebug.apk --json
shipyard-deploy status --json
```

`./gradlew :app:shipyardPublishDevDebug` also builds and publishes through the CLI
on `PATH`. Commit before building a publishable APK so its embedded provenance
names the clean source commit. The build-instance UUID, provenance digest and APK
SHA-256 have separate meanings; status reads back the canonical published build.

The package allowlist uses the existing developer debug certificate recorded
during registration. Another developer's debug key cannot update this package.
Changing to a shared development signer requires a reviewed server allowlist
update, never bypassing signature checks.

From the repository root, verify SDK and distribution boundaries with:

```sh
android/scripts/verify-release.sh
```

The audit checks positive debug/devDebug controls, the dev-only signature guarded
marker and provenance asset, both release dependency graphs/APKs, and rejection
of an accidental release recorder dependency.

Enrolled devices need installation access and an app/channel subscription before
they receive this sample. Registration and publication do not widen access or
prove device installation.

## Other samples

Shipyard Deploy currently supports signed Android APKs. The iOS demo, browser
sample and desktop collector/viewer are maintained in this Shipyard repository;
their development commands remain in their platform guides. They cannot be
published through the current Android-only Deploy service.
