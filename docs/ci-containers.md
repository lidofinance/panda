# Versioned CI images

## Separate Lighthouse and Panda releases

Lighthouse is built by **Publish Lighthouse images** (`.github/workflows/lighthouse.yml`). Panda is
packaged by **Publish Panda images** (`.github/workflows/images.yml`). Publishing a new Panda
version pulls existing client images by digest; it never invokes the Rust compiler or `bake`.

Each successful stable Panda publication also updates `panda-<profile>:latest` to the same image.
Prereleases keep the existing `latest` tag unchanged.

| Artifact                  | Example                                                 | Version source   |
| ------------------------- | ------------------------------------------------------- | ---------------- |
| Patched Pectra Lighthouse | `panda-lighthouse-pectra:v7.1.0-cfb1f7331064-b1-<hash>` | Upstream + baker |
| Patched Gloas Lighthouse  | `panda-lighthouse-gloas:v8.2.2-2d281dfa1b40-b1-<hash>`  | Upstream + baker |
| Panda with Pectra clients | `ghcr.io/eddort/panda-pectra:v1.2.3`                    | Git tag `v1.2.3` |
| Panda with Gloas clients  | `ghcr.io/eddort/panda-gloas:v1.2.3`                     | Git tag `v1.2.3` |

Lighthouse repositories also live under `ghcr.io/eddort/`. Their tags are derived automatically:
`v<upstream-version>-<commit-12>-b<baker-version>-<baker-hash-12>`. There is no manually assigned
client release number. `clVersion`, the pinned `clRef`, and `bakerVersion` are declared in each
profile recipe. The builder reads the actual upstream Cargo package version and rejects a mismatch.
The existing pins declare 7.1.0 for Pectra and 8.2.2 for Gloas; the Gloas commit identifies the
experimental branch even though its Cargo version is shared with other revisions.

The two inputs that invalidate a Lighthouse image are:

1. **Upstream Lighthouse:** its original package version and exact Git commit.
2. **Panda's baker:** its explicit version and the content hash of builder code, the selected
   patch/clock/native sources, native test targets, pinned toolchain/runtime images and platform.

Bump `bakerVersion` when releasing a new baker revision. The content hash also changes automatically
when a build input changes, protecting against accidentally reusing an image after an unbumped edit.
Changing another profile's patch or changing the Panda controller does not invalidate this image.
Rust and runtime image refs must be immutable before the CI identity is computed. The Gloas Rust
builder is now pinned to the digest already recorded in its existing bake.

The complete EL/CL/genesis selection has a separate `ci-<hash>` bake tag. Updating Geth, genesis,
baseline client or runtime profile settings changes that selection, while retaining the same
Lighthouse identity. The native Lighthouse cache is likewise separate from the full-bake cache. Two
Panda Git versions can therefore reuse precisely the same Lighthouse image and client lock.

## First publication and client updates

The normal release flow is **Run workflow → release PR → maintainer merge → automatic Panda
release**. Downloading artifacts, copying locks and pushing the release tag are automated.

1. Keep the desired `clVersion`/`clRef` and `bakerVersion` in each profile recipe on the default
   branch. In **Publish Lighthouse images**, enter the future Panda tag in `version` (for example
   `v1.2.3`) and choose `profile=all`, or only the updated profile. The first release needs `all`;
   later single-profile runs retain the other profiles' committed client locks. Invalid or occupied
   Git tags and missing unchanged locks are rejected before compilation.
2. The workflow builds the exact `linux/amd64` Lighthouse images with their native Rust tests, or
   reuses the matching published images, and publishes them before any Panda profile tests. After
   every selected profile succeeds, it opens a PR on `release-<version>`. The PR contains
   `bakes/<profile>/release/clients.lock.json` with the Lighthouse upstream/baker versions, image
   tags and immutable digests, plus `.github/panda-release.json` with the future Panda Git tag and
   hashes of the selected client locks. Its description lists the client versions and digests.
   Failed builds or native tests do not open a release PR.
3. Review and merge that PR yourself. **Release merged Panda PR** validates the merged client locks,
   creates the Git tag on the exact PR merge commit, and triggers **Publish Panda images**. The tag
   does not point at a newer moving `main`. Panda restores the pinned clients, runs its own full
   profile and packaged-service checks, then publishes both service images.

The `version` input chooses the tag that the PR will create. The Panda image revision still comes
from the actual Git tag; the image publisher does not accept a free-form revision override.
Lighthouse tags still come from its upstream/baker identity independently of the Panda version.

For controller-only releases with unchanged clients, pushing a new Panda Git tag still triggers
**Publish Panda images** directly. Prereleases such as `v1.2.3-rc.1` are accepted; branch refs,
malformed versions and SemVer build metadata (`+...`) are rejected.

A retry reuses the same open PR when its generated files match. It never force-updates a branch,
changes a closed PR, or moves an existing tag. If the tag was created but dispatch failed, rerun
**Release merged Panda PR**: it accepts that tag only at the same merge commit. If a Panda run
already exists for that tag and commit, rerun its failed jobs instead of creating another release.
Artifacts can be overwritten within a workflow rerun, while published image identities remain
immutable. `clients:pin` remains available for manual recovery, but is not a normal release step.

One-time repository setup: enable **Settings → Actions → General → Workflow permissions → Allow
GitHub Actions to create and approve pull requests**. The workflow only creates the PR; it does not
approve or merge it. The workflow files must be present on the default branch. Repository rules must
permit the release workflow to create version tags. No additional PAT is required.

The PR commit uses GitHub's signed `createCommitOnBranch` API. The merge trigger explicitly
dispatches Panda because a tag pushed using `GITHUB_TOKEN` does not trigger another workflow by
itself. GitHub documents
[workflow chaining](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
and [API commit signing](https://docs.github.com/en/graphql/reference/commits).

The first published client locks do not exist yet. They will be generated by the actual successful
amd64 publication; no placeholder digests are committed. A default `all` Panda release requires a
valid committed lock for every registered hardfork. New profiles use the existing dynamic matrix and
receive their own lock in the release PR.

## Release already published clients

Use **Release Panda from published images** (`.github/workflows/release.yml`) on `main` and enter
only the new Panda `version`, for example `v0.2.0`. It opens the same release PR using the latest
published client lock for every registered profile. Merge the PR to trigger the existing tag and
Panda publication workflows.

This separate action does not run Docker, `bake`, Rust compilation or the Lighthouse workflow. It
downloads only the selected lock JSON artifacts by their immutable artifact IDs. Lighthouse images
remain in GHCR; the Panda publisher later restores them by digest. The existing build workflows are
unchanged.

Locks are selected by artifact creation time from completed **Publish Lighthouse images** runs on
the repository default branch. A run whose later PR job failed is eligible: its lock artifacts were
uploaded after successful client publication. Profiles can come from different runs. Artifacts from
other workflows, branches or fork repositories are excluded. The action summary links each selected
publication run and records the exact artifact ID; the PR lists the image digests.

If a required lock is missing or its latest retained artifact has expired, the action stops with an
error. It does not compile clients or silently use an older retained lock. Artifact retention is
separate from GHCR image retention. Existing release branches and occupied tags retain the same
protection as the original release flow.

## What each workflow verifies

The Lighthouse workflow runs the native Rust regressions as part of a new `bake`, then publishes the
compiled image and its immutable identity. Publication checks the native bake provenance,
upstream/baker identity, architecture and original source commit. A bake created with `--import-cl`
cannot be presented as a native Lighthouse release. The generated lock contains the original
immutable bake verbatim plus the published Lighthouse digest and build commit.

Full `test:profile` runs only in the Panda release workflow. A published Lighthouse image certifies
the native build, not Panda's protocol integration. If a later Panda profile or packaged-service
check fails, Panda publication is blocked and the Lighthouse image remains in GHCR for reuse. Fixing
the controller or its tests does not require compiling that unchanged Lighthouse again.

The Panda workflow validates that its ref is a release Git tag and that its client locks are
committed. `clients:restore` loads Lighthouse, Geth, genesis and the baseline client by digest and
checks the actual image IDs and architecture. Failed pulls do not install a bake manifest; an
existing conflicting local bake is preserved. Restoring clients has no compiler fallback. The
original bake identity and native provenance survive transport through the registry.

Panda then runs the selected full profile suite against the current controller, packages the exact
EL/CL/genesis images, and tests the resulting service before publishing. A new controller version
therefore requires compatibility verification, but does not require a new Lighthouse build. Each
profile publishes independently after its own checks.

Both workflows serialize publication per profile/version. New publication requires confirmed absence
in the registry. Panda rejects existing versions; Lighthouse reuses existing versions after checking
their digest and build identity. Administrators can still move tags outside these workflows, so
client locks and consumers use `@sha256:...`. Workflow artifacts retain verification and published
identities. The service's `/opt/panda/release.json` records its Git version and commit, original
bake, architecture, client identities and published Lighthouse reference. OCI labels expose the
Panda version, source commit, hardfork and bake key. The Lighthouse image also has labels for
upstream version/commit, baker version/hash, full build identity and the original Panda source
commit used to build it. Reusing Lighthouse preserves that original build commit instead of
substituting the current controller's commit.

GHCR packages must permit the repository's token to pull them. Client restore supports private GHCR
images using `GITHUB_ACTOR` and `GHCR_TOKEN`; public images can be restored without credentials.

## Use Panda as a CI service

Start a fresh service for each test suite and pin its published image digest:

```yaml
env:
  PANDA_URL: http://127.0.0.1:18547
  PANDA_BEACON_URL: http://127.0.0.1:5052
services:
  panda:
    image: ghcr.io/eddort/panda-gloas@sha256:<published-digest>
    ports:
      - 127.0.0.1:18547:8545
      - 127.0.0.1:5052:5052
      - 127.0.0.1:5062:5062
    options: --privileged --stop-timeout 120 --label io.panda.id=protocol-ci
```

Configure your test client to use these endpoints, wait for the service to become ready, then run
its normal test command. For private images, configure registry credentials in the consuming
workflow. The test client must not stop a service owned by the workflow.

Ethereum RPC, the Beacon API proxy and `/control` share port 8545. Native Beacon and validator APIs
are available on separate ports. Importing validator keys through Panda uses the Lighthouse
keymanager; Lighthouse signs voluntary exits before submission to the Beacon API. Time advancement
is honest by default; request `{ mode: "fast" }` explicitly for scenarios that allow skipped duties.

## Client APIs and logs

Publish the ports needed by your test on loopback:

| Container port | API                                                          | Authentication                |
| -------------- | ------------------------------------------------------------ | ----------------------------- |
| 8545           | Geth HTTP JSON-RPC, Panda `/control`, Beacon HTTP proxy      | Controller Host/Origin checks |
| 5052           | Native Lighthouse Beacon API, including `/eth/v1/events` SSE | Native Beacon API             |
| 5062           | Native Lighthouse Validator / Keymanager API                 | Lighthouse bearer token       |

For a local service named `panda`:

```sh
docker run -d --name panda --privileged --stop-timeout 120 \
  -p 127.0.0.1:18547:8545 \
  -p 127.0.0.1:5052:5052 \
  -p 127.0.0.1:5062:5062 \
  ghcr.io/eddort/panda-gloas@sha256:<published-digest>

curl --fail http://127.0.0.1:5052/eth/v1/beacon/headers/head
curl --no-buffer 'http://127.0.0.1:5052/eth/v1/events?topics=head'

PANDA_VC_TOKEN=$(docker exec panda panda validator-token)
curl --fail -H "Authorization: Bearer $PANDA_VC_TOKEN" \
  http://127.0.0.1:5062/eth/v1/keystores
```

Obtain the token after the service becomes healthy. It belongs to this fresh network and is not
printed in readiness logs. Port 5062 preserves Lighthouse authentication. After a fast warp replaces
VC, new connections use its new internal port; the token persists for that network. Clients should
reconnect if a request overlaps the restart. Use 5052 for long-lived Beacon event subscriptions; the
compatibility proxy on 8545 retains its bounded HTTP request timeout. Protocol clocks and the Engine
API remain private.

The outer service and its clients have separate logs. Use the bundled `panda` command inside the
running service to read each client's stdout and stderr:

```sh
docker logs --tail 200 -f panda                 # controller and private Docker daemon
docker exec panda panda logs el --tail 200     # Geth
docker exec panda panda logs cl --tail 200 -f  # Lighthouse beacon node
docker exec panda panda logs vc --tail all    # Lighthouse validator client
```

`logs` defaults to the last 300 lines; `--follow` / `-f` follows that client until it stops. Rerun
the command after VC is replaced by a fast warp. Each invocation selects the current client by the
service's exact `io.panda.id` and role, without accessing the host Docker daemon. Save client logs
before stopping or removing the outer service. In GitHub Actions, use the actual service ID:

```yaml
- name: Save Panda service and client logs
  if: always()
  env:
    SERVICE_ID: ${{ job.services.panda.id }}
  run: |
    mkdir -p .local/panda
    docker logs "$SERVICE_ID" > .local/panda/service.log 2>&1
    for client in el cl vc; do
      docker exec "$SERVICE_ID" panda logs "$client" --tail 2000 \
        > ".local/panda/$client.log" 2>&1 || true
    done
```

Upload these files as workflow artifacts even when tests fail. A log collection error is retained in
the corresponding file when the service or client has already stopped.

## Packaging and runtime

The final Panda image contains Deno, the controller and archives of the already published EL/CL and
genesis images. Its private Docker daemon loads those archives at startup. Beacon node and validator
client use the same Lighthouse image. Startup uses the packaged artifacts without compiling or
pulling clients. This self-contained service requires `--privileged` and has larger image/storage
requirements than a controller-only image.

The internal daemon uses a Unix socket and classic `overlay2` storage to preserve baked image IDs.
TCP relays listen on ports 8545, 5052 and 5062; bind host ports on loopback. Never mount the host
Docker socket. Controller Host/Origin checks and VC authentication still apply. All resources use
exact `io.panda.id` ownership. SIGTERM closes API connections, the controller and its resources
before stopping the private daemon.

Initial readiness requires block zero, slot zero and automine off. Health probes remain read-only
while the suite controls time. Restarts start a fresh chain; daemon failure stops the service. Time
control defaults to honest execution; skipped-slot jumps require explicit `mode: "fast"`. Both modes
use the same client image. Fast verifier scenarios do not certify economics across the skipped
interval. Full profile verification retains separate honest, fast and economics scenarios.

Deno 2.9.7 is inside the service. Base images use digests, direct npm dependencies use exact
versions, and dependency caching uses `deno.lock` with `--frozen-lockfile`. Runtime uses
`--cached-only`.

For local packaging of an existing bake (no registry publication):

```sh
deno task package:image gloas panda v0.0.0-local.1 eddort "$(git rev-parse HEAD)"
docker build -t panda-ci-gloas:local \
  -f .cache/containers/gloas/v0.0.0-local.1/container/Dockerfile \
  .cache/containers/gloas/v0.0.0-local.1
deno task test:image panda-ci-gloas:local gloas
```

Package directories refuse reuse. Choose a new local version after changing packaged sources. Local
packaging accepts an existing native bake; published client locks require `linux/amd64`. ARM
packaging checks do not establish that the amd64 publication pipeline passed.

## Verification record

Native API relays and client log access passed five focused regressions and all 72 fast tests (13
Docker/profile opt-ins ignored), plus formatting, lint, types and workflow validation. Checks cover
bearer/header preservation, streaming responses, VC endpoint replacement, connection cleanup and
Docker log demultiplexing with exact ownership. These use local HTTP and Docker transport fixtures.
The packaged-service CI check now exercises real CL/VC APIs, rejected tokens, access after fast warp
and client log collection for each profile. That Docker check was not run locally, as requested. See
[the local evidence](../reports/ci/container-access/README.md).

Release-PR automation passed `deno task check`, all 67 fast tests (13 Docker/profile opt-ins
ignored), and `actionlint` for all three workflows. Seven focused regressions cover PR contents,
partial-failure recovery, immutable tags and the merge trigger. This is local verification with a
mock GitHub transport; an actual Actions publication remains unverified. See the
[release-PR evidence](../reports/ci/release-pr/README.md). The earlier records below describe the
previous pipeline stages.

For the split release pipelines, local verification is limited to unit tests, formatting, lint,
types and workflow validation. Docker tests and builds were not run, as requested. Unit coverage
checks Git-tag version selection, reuse of a client release across Panda versions, rejection of
mutable/mismatched pins, failed restore behavior and Docker publication ownership using an in-memory
transport. Red/green evidence is under `.cache/ci-release-split-*.log`.

- `deno task check`: passed (formatting, lint and types).
- The split-pipeline unit run passed 39 checks, with 11 Docker/integration checks ignored. The newer
  upstream/baker identity checks are recorded separately below. The HTTP unit fixtures required
  permission to bind loopback; the initial sandbox-only attempt failed on those two fixtures, and
  the run with loopback access passed.
- `actionlint`: passed for both publisher workflows.
- The initial Git-tag regression run failed three assertions under the old manual revision behavior.
  After implementation all nine release/client unit checks passed.

The following results predate the split and are historical evidence only:

- Controller API regressions passed.
- ARM service checks passed for Pectra (23.46 seconds) and Gloas (20.45 seconds): genesis, read-only
  readiness, Host protection, transaction inclusion, pause and SIGTERM shutdown.
- A Gloas host run failed after its EL image was deleted during startup. The subsequent run in an
  isolated daemon passed all 8 scenarios in 536.2 seconds. The Pectra full run was interrupted; its
  report records failure, not a completed pass.

No GitHub amd64 workflow or GHCR publication has been executed. Current runtime changes require new
profile verification in CI; historical reports do not certify the new release.

The upstream/baker identity change has separate red/green evidence under
`.cache/ci-lighthouse-version-*.log` and `.cache/ci-lighthouse-identity-*.log`. Unit checks cover
both rebuild causes, reuse across Panda/Geth changes, per-profile patch isolation, actual Cargo
version parsing, registry absence/error handling and rejection of mismatched published build labels.
Docker/compiler/profile execution remains unverified for this change and was not run locally.

Current results: `deno task check` passed; the unit command with Docker/e2e disabled passed 45
checks (11 ignored); `actionlint` passed both publisher workflows. The actual cached upstream Cargo
files matched the declared 7.1.0 and 8.2.2 versions. A read-only HTTP query confirmed that the
pinned Gloas Rust digest is a multi-platform index containing `linux/amd64`; no Docker daemon or
container was used for that query.
