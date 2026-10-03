import assert from "node:assert/strict";
import { clientLockPath, type PublishedClients } from "../src/client_release.ts";
import { lighthouseBuild, lighthouseTag } from "../src/lighthouse_build.ts";
import { canonical, profiles, readBake } from "../src/profiles.ts";
import { lighthouseImage } from "../src/release.ts";
import {
  type GitHub,
  GitHubError,
  openReleasePullRequest,
  prepareRelease,
  releaseBranch,
  type ReleaseMerge,
  releaseMergedPullRequest,
  releasePlanPath,
} from "../src/release_pr.ts";

const repository = "eddort/panda";
const source = "a".repeat(40);
const merged = "b".repeat(40);
const branchCommit = "c".repeat(40);
const version = "v0.1.0";

async function clients(): Promise<Record<string, PublishedClients>> {
  const result: Record<string, PublishedClients> = {};
  for (const profile of ["gloas"] as const) {
    const bake = await readBake(profile, "panda");
    bake.recipe.clVersion = profiles[profile].clVersion;
    bake.recipe.bakerVersion = profiles[profile].bakerVersion;
    bake.lighthouse = await lighthouseBuild(profiles[profile], "linux/amd64");
    for (const [role, image] of Object.entries(bake.images)) {
      image.platform = "linux/amd64";
      image.digest = `example.test/${role}@sha256:${"d".repeat(64)}`;
    }
    result[profile] = {
      schema: 1,
      bake,
      lighthouse: {
        build: bake.lighthouse,
        image: lighthouseImage("eddort", profile, lighthouseTag(bake.lighthouse)),
        digest: `ghcr.io/eddort/panda-lighthouse-${profile}@sha256:${"e".repeat(64)}`,
        sourceCommit: source,
      },
    };
  }
  return result;
}

class FakeGitHub implements GitHub {
  calls: { method: string; path: string; body: unknown }[] = [];
  tag: string | undefined;
  branch: string | undefined;
  files: Record<string, string> = {};
  pr: { html_url: string; state: string } | undefined;
  runs: { head_branch: string; head_sha: string }[] = [];
  dispatchFailure = false;
  failure: "commit" | "pr" | undefined;
  commitErrors: { message: string; extensions?: unknown }[] | undefined;
  unauthorized = false;
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (this.unauthorized) return Promise.reject(new GitHubError(403, "denied"));
    const data = body as Record<string, unknown>;
    let value: unknown;
    if (path.includes("/git/ref/tags/")) {
      if (!this.tag) return Promise.reject(new GitHubError(404, "missing tag"));
      value = { object: { type: "commit", sha: this.tag } };
    } else if (path.includes("/git/ref/heads/")) {
      if (!this.branch) return Promise.reject(new GitHubError(404, "missing branch"));
      value = { object: { sha: this.branch } };
    } else if (path.endsWith("/git/refs")) {
      if (String(data.ref).startsWith("refs/tags/")) this.tag = String(data.sha);
      else this.branch = String(data.sha);
      value = {};
    } else if (path === "/graphql") {
      if (this.failure === "commit") {
        return Promise.reject(new GitHubError(503, "commit unavailable"));
      }
      const input = (data.variables as { input: Record<string, unknown> }).input;
      assert.deepEqual(input.branch, {
        repositoryNameWithOwner: repository,
        branchName: releaseBranch(version),
      });
      assert.equal(input.expectedHeadOid, this.branch);
      if (this.commitErrors) return Promise.resolve({ errors: this.commitErrors } as T);
      const changes = input.fileChanges as { additions: { path: string; contents: string }[] };
      for (const file of changes.additions) {
        this.files[file.path] = new TextDecoder().decode(
          Uint8Array.from(atob(file.contents), (c) => c.charCodeAt(0)),
        );
      }
      this.branch = branchCommit;
      value = { data: { createCommitOnBranch: { commit: { oid: branchCommit } } } };
    } else if (path.includes("/contents/")) {
      const file = decodeURIComponent(path.split("/contents/")[1].split("?")[0]);
      if (!this.files[file]) return Promise.reject(new GitHubError(404, "missing file"));
      value = { encoding: "base64", content: btoa(this.files[file]) };
    } else if (path.includes("/pulls")) {
      if (method === "POST" && this.failure === "pr") {
        return Promise.reject(new GitHubError(503, "PR unavailable"));
      }
      if (method === "GET") value = this.pr ? [this.pr] : [];
      else {value = this.pr = {
          html_url: "https://github.com/eddort/panda/pull/123",
          state: "open",
        };}
    } else if (path.includes("/actions/workflows/images.yml/runs")) {
      value = { workflow_runs: this.runs };
    } else if (path.endsWith("/dispatches")) {
      if (this.dispatchFailure) return Promise.reject(new GitHubError(503, "dispatch unavailable"));
      assert.deepEqual(body, { ref: version, inputs: { profile: "all" } });
      this.runs.push({ head_branch: version, head_sha: merged });
      value = {};
    } else throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    return Promise.resolve(value as T);
  }
}

function event(): ReleaseMerge {
  return {
    repository: { full_name: repository, default_branch: "main" },
    pull_request: {
      merged: true,
      merge_commit_sha: merged,
      base: { ref: "main" },
      head: { ref: releaseBranch(version), repo: { full_name: repository } },
    },
  };
}

Deno.test("release PR carries only active Gloas pins and the intended tag, without publishing Panda", async () => {
  const selected = await clients();
  const release = await prepareRelease(version, source, selected);
  assert.deepEqual(Object.keys(release.plan.clients), ["gloas"]);
  assert.deepEqual(
    Object.keys(release.files).sort(),
    [releasePlanPath, clientLockPath("gloas")].sort(),
  );
  for (const profile of ["gloas"] as const) {
    assert.deepEqual(JSON.parse(release.files[clientLockPath(profile)]), selected[profile]);
  }
  assert.equal(JSON.parse(release.files[releasePlanPath]).version, version);
  const api = new FakeGitHub();
  const url = await openReleasePullRequest(api, repository, "main", release);
  assert.equal(url, "https://github.com/eddort/panda/pull/123");
  assert.equal(api.branch, branchCommit);
  assert.equal(api.tag, undefined);
  assert.equal(api.runs.length, 0);
  assert.equal(await openReleasePullRequest(api, repository, "main", release), url);
  assert.equal(api.calls.filter((c) => c.path === "/graphql").length, 1);
  assert.equal(api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls")).length, 1);
});

Deno.test("release preparation rejects missing profiles, mutable clients and invalid versions", async () => {
  const selected = await clients();
  for (const invalid of ["main", "v1.2", "v1.2.3+build", "v1.2.3\nmalicious"]) {
    await assert.rejects(() => prepareRelease(invalid, source, selected));
  }
  await assert.rejects(() => prepareRelease(version, "main", selected));
  await assert.rejects(() => prepareRelease(version, source, {}));
  // Even a stale Pectra entry must not leak into the release PR.
  await assert.rejects(() =>
    prepareRelease(version, source, { ...selected, pectra: selected.gloas })
  );
  selected.gloas.lighthouse.digest = "ghcr.io/eddort/panda-lighthouse-gloas:latest";
  await assert.rejects(() => prepareRelease(version, source, selected));
});

Deno.test("release commit errors report the API message without echoing file contents", async () => {
  const release = await prepareRelease(version, source, await clients());
  const api = new FakeGitHub();
  const message = "CommittableBranch requires repositoryNameWithOwner and branchName";
  api.commitErrors = [{
    message,
    extensions: { value: { fileChanges: { additions: [{ contents: "private-file-payload" }] } } },
  }];
  await assert.rejects(
    () => openReleasePullRequest(api, repository, "main", release),
    { message: `Release commit failed: ${message}` },
  );
  assert.equal(api.branch, source);
  assert.deepEqual(api.files, {});
  assert.equal(api.pr, undefined);
  assert.equal(api.tag, undefined);
  api.commitErrors = undefined;
  assert.equal(
    await openReleasePullRequest(api, repository, "main", release),
    "https://github.com/eddort/panda/pull/123",
  );
});

Deno.test("partial GitHub failures resume the same release branch without duplicate commits or PRs", async () => {
  const release = await prepareRelease(version, source, await clients());
  for (const failure of ["commit", "pr"] as const) {
    const api = new FakeGitHub();
    api.failure = failure;
    await assert.rejects(
      () => openReleasePullRequest(api, repository, "main", release),
      /unavailable/,
    );
    assert.equal(api.pr, undefined);
    assert.equal(api.branch, failure === "commit" ? source : branchCommit);
    api.failure = undefined;
    assert.equal(
      await openReleasePullRequest(api, repository, "main", release),
      "https://github.com/eddort/panda/pull/123",
    );
    assert.equal(api.branch, branchCommit);
    assert.equal(api.calls.filter((c) => c.path.endsWith("/git/refs")).length, 1);
    assert.equal(
      api.calls.filter((c) => c.path === "/graphql").length,
      failure === "commit" ? 2 : 1,
    );
  }
});

Deno.test("release PR retries preserve unrelated branches and fail closed on API authorization errors", async () => {
  const release = await prepareRelease(version, source, await clients());
  for (const mode of ["tag", "branch", "authorization"]) {
    const api = new FakeGitHub();
    if (mode === "tag") api.tag = merged;
    if (mode === "branch") api.branch = "f".repeat(40);
    if (mode === "authorization") api.unauthorized = true;
    await assert.rejects(() => openReleasePullRequest(api, repository, "main", release));
    assert.equal(api.calls.filter((c) => c.method !== "GET").length, 0);
  }
});

Deno.test("merging the release PR tags its exact merge commit and dispatches Panda once", async () => {
  const selected = await clients();
  const { plan } = await prepareRelease(version, source, selected);
  const api = new FakeGitHub();
  await releaseMergedPullRequest(api, event(), plan, selected);
  assert.equal(api.tag, merged);
  assert.equal(api.runs.length, 1);
  await releaseMergedPullRequest(api, event(), plan, selected);
  assert.equal(api.calls.filter((c) => c.path.endsWith("/dispatches")).length, 1);
});

Deno.test("release trigger rejects unmerged, foreign or changed PR data before creating a tag", async () => {
  const selected = await clients();
  const { plan } = await prepareRelease(version, source, selected);
  for (const kind of ["closed", "fork", "base", "branch", "sha", "locks", "profiles"]) {
    const changedEvent = event();
    const changedClients = structuredClone(selected);
    if (kind === "closed") changedEvent.pull_request.merged = false;
    if (kind === "fork") changedEvent.pull_request.head.repo!.full_name = "other/panda";
    if (kind === "base") changedEvent.pull_request.base.ref = "other";
    if (kind === "branch") changedEvent.pull_request.head.ref = "feature/unrelated";
    if (kind === "sha") changedEvent.pull_request.merge_commit_sha = "main";
    if (kind === "locks") changedClients.gloas.bake.createdAt = "changed after publication";
    if (kind === "profiles") delete changedClients.gloas;
    const api = new FakeGitHub();
    await assert.rejects(() => releaseMergedPullRequest(api, changedEvent, plan, changedClients));
    assert.equal(api.calls.length, 0, kind);
  }
  assert.equal(canonical(plan), canonical((await prepareRelease(version, source, selected)).plan));
});

Deno.test("a failed dispatch can be retried after tag creation without moving or replacing the tag", async () => {
  const selected = await clients();
  const { plan } = await prepareRelease(version, source, selected);
  const api = new FakeGitHub();
  api.dispatchFailure = true;
  await assert.rejects(() => releaseMergedPullRequest(api, event(), plan, selected), /dispatch/);
  assert.equal(api.tag, merged);
  api.dispatchFailure = false;
  await releaseMergedPullRequest(api, event(), plan, selected);
  assert.equal(api.runs.length, 1);
  assert.equal(api.calls.filter((c) => c.path.endsWith("/git/refs")).length, 1);
  api.tag = "f".repeat(40);
  await assert.rejects(() => releaseMergedPullRequest(api, event(), plan, selected), /tag/i);
  assert.equal(api.tag, "f".repeat(40));
});
