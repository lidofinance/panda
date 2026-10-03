import assert from "node:assert/strict";
import { latestPublishedLocks } from "../src/release_artifacts.ts";
import { type GitHub, GitHubError } from "../src/release_pr.ts";

const repository = "eddort/panda";
const artifact = (id: number, profile: string, run = id) => ({
  id,
  name: `lighthouse-lock-${profile}`,
  expired: false,
  created_at: `2026-10-01T00:${String(id).padStart(2, "0")}:00Z`,
  workflow_run: { id: run },
});
const run = (id: number) => ({
  id,
  path: ".github/workflows/lighthouse.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "failure", // Publication succeeded; creating the release PR failed.
  head_branch: "main",
  head_repository: { full_name: repository },
});

class ArtifactAPI implements GitHub {
  artifacts = [artifact(1, "pectra"), artifact(2, "gloas")];
  runs = new Map([[1, run(1)], [2, run(2)]]);
  calls: string[] = [];
  failure = false;
  request<T>(method: string, path: string): Promise<T> {
    assert.equal(method, "GET", "artifact selection must never mutate GitHub");
    this.calls.push(path);
    if (this.failure) return Promise.reject(new GitHubError(403, "denied"));
    if (path.includes("/actions/artifacts?")) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return Promise.resolve({
        total_count: this.artifacts.length,
        artifacts: this.artifacts.slice((page - 1) * 100, page * 100),
      } as T);
    }
    const id = Number(path.split("/").at(-1));
    assert(this.runs.has(id), `unexpected request: ${path}`);
    return Promise.resolve(this.runs.get(id) as T);
  }
}

Deno.test("default release needs only Gloas even when Pectra locks are expired or absent", async () => {
  for (const pectra of [[], [{ ...artifact(3, "pectra"), expired: true }]]) {
    const api = new ArtifactAPI();
    api.artifacts = [...pectra, artifact(2, "gloas")];
    assert.deepEqual(await latestPublishedLocks(api, repository, "main"), [
      { profile: "gloas", artifactId: 2, runId: 2 },
    ]);
    assert.deepEqual(api.calls.filter((path) => path.includes("/actions/runs/")), [
      `/repos/${repository}/actions/runs/2`,
    ]);
  }
});

Deno.test("latest client locks survive a failed PR job and may come from separate profile runs", async () => {
  const api = new ArtifactAPI();
  api.artifacts.push(artifact(3, "pectra"));
  api.runs.set(3, run(3));
  assert.deepEqual(await latestPublishedLocks(api, repository, "main", ["pectra", "gloas"]), [
    { profile: "pectra", artifactId: 3, runId: 3 },
    { profile: "gloas", artifactId: 2, runId: 2 },
  ]);
});

Deno.test("artifact selection checks the publishing workflow, branch, repository and completion", async () => {
  for (
    const change of [
      { path: ".github/workflows/other.yml" },
      { event: "pull_request" },
      { status: "in_progress" },
      { head_branch: "feature" },
      { head_repository: { full_name: "other/panda" } },
    ]
  ) {
    const api = new ArtifactAPI();
    api.artifacts.push(artifact(3, "pectra"));
    api.runs.set(3, { ...run(3), ...change });
    const selected = await latestPublishedLocks(api, repository, "main", ["pectra", "gloas"]);
    assert.equal(selected[0].artifactId, 1);
  }
});

Deno.test("missing or expired latest client locks stop instead of building or silently downgrading", async () => {
  const api = new ArtifactAPI();
  api.artifacts.push({ ...artifact(3, "pectra"), expired: true });
  api.runs.set(3, run(3));
  await assert.rejects(
    () => latestPublishedLocks(api, repository, "main", ["pectra", "gloas"]),
    /expired.*pectra/i,
  );
  api.artifacts = [artifact(1, "pectra")];
  await assert.rejects(
    () => latestPublishedLocks(api, repository, "main", ["pectra", "gloas"]),
    /missing.*gloas/i,
  );
  api.failure = true;
  await assert.rejects(
    () => latestPublishedLocks(api, repository, "main", ["pectra"]),
    /denied/,
  );
});

Deno.test("selection paginates artifacts and uses publication time rather than workflow run order", async () => {
  const api = new ArtifactAPI();
  api.artifacts = Array.from({ length: 100 }, (_, i) => ({
    ...artifact(i + 10, "unrelated"),
    name: "unrelated",
  }));
  api.artifacts.push(artifact(1, "pectra"), artifact(2, "gloas"));
  api.artifacts.push({ ...artifact(3, "pectra", 1), created_at: "2026-10-02T00:00:00Z" });
  const selected = await latestPublishedLocks(api, repository, "main", ["pectra", "gloas"]);
  assert.equal(selected[0].artifactId, 3);
  assert.equal(selected[0].runId, 1);
  assert(api.calls.some((path) => path.includes("page=2")));
});

Deno.test("standalone release only downloads exact artifacts and opens a PR", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/release.yml");
  assert.match(workflow, /name: Release Panda from published images/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /scripts\/release_artifacts.ts/);
  assert.match(workflow, /actions\/artifacts\/\$artifact_id\/zip/);
  assert.match(workflow, /scripts\/release_pr.ts open/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /\bdocker\b|task bake|scripts\/bake.ts|workflow_call|lighthouse_ci.ts/,
  );
});
