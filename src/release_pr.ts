import { Buffer } from "node:buffer";
import {
  clientLockPath,
  type PublishedClients,
  validatePublishedClients,
} from "./client_release.ts";
import { canonical, maintainedProfiles, profileName, sha256 } from "./profiles.ts";
import { pandaRevision } from "./release.ts";

export const releasePlanPath = ".github/panda-release.json";
export interface ReleasePlan {
  schema: 1;
  version: string;
  sourceCommit: string;
  clients: Record<string, string>;
}
export interface ReleaseFiles {
  plan: ReleasePlan;
  files: Record<string, string>;
}
export interface GitHub {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}
export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
export interface ReleaseMerge {
  repository: { full_name: string; default_branch: string };
  pull_request: {
    merged: boolean;
    merge_commit_sha: string;
    base: { ref: string };
    head: { ref: string; repo: { full_name: string } | null };
  };
}

export function releaseBranch(version: string): string {
  pandaRevision(`refs/tags/${version}`);
  if (version !== version.trim()) throw new Error("Invalid release version");
  return `release-${version}`;
}
function assertCommit(commit: string): void {
  if (commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Expected a full source commit");
  }
}
function repositoryPath(repository: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository");
  }
  return `/repos/${repository}`;
}
export async function optionalGitHub<T>(api: GitHub, path: string): Promise<T | undefined> {
  try {
    return await api.request<T>("GET", path);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}
export async function requireUnusedTag(api: GitHub, repository: string, version: string) {
  releaseBranch(version);
  if (await optionalGitHub(api, `${repositoryPath(repository)}/git/ref/tags/${version}`)) {
    throw new Error(`Release tag ${version} already exists`);
  }
}

export async function prepareRelease(
  version: string,
  sourceCommit: string,
  clients: Record<string, PublishedClients>,
): Promise<ReleaseFiles> {
  releaseBranch(version);
  assertCommit(sourceCommit);
  if (canonical(Object.keys(clients).sort()) !== canonical([...maintainedProfiles].sort())) {
    throw new Error(
      "A Panda release requires published clients for exactly the maintained profiles",
    );
  }
  const plan: ReleasePlan = { schema: 1, version, sourceCommit, clients: {} };
  const files: Record<string, string> = {};
  for (const name of Object.keys(clients).sort()) {
    const profile = profileName(name);
    validatePublishedClients(clients[profile], profile);
    plan.clients[profile] = await sha256(canonical(clients[profile]));
    files[clientLockPath(profile)] = JSON.stringify(clients[profile], null, 2) + "\n";
  }
  files[releasePlanPath] = JSON.stringify(plan, null, 2) + "\n";
  return { plan, files };
}

/** A retry may reuse its own branch, but must never overwrite someone's changes. */
export async function openReleasePullRequest(
  api: GitHub,
  repository: string,
  base: string,
  { plan, files }: ReleaseFiles,
): Promise<string> {
  await requireUnusedTag(api, repository, plan.version);
  const root = repositoryPath(repository);
  const branch = releaseBranch(plan.version);
  let ref = await optionalGitHub<{ object: { sha: string } }>(
    api,
    `${root}/git/ref/heads/${branch}`,
  );
  if (!ref) {
    await api.request("POST", `${root}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: plan.sourceCommit,
    });
    ref = { object: { sha: plan.sourceCommit } };
  }
  if (ref.object.sha === plan.sourceCommit) {
    // GitHub signs createCommitOnBranch commits; no bot private key or local unsigned commit.
    const result = await api.request<{
      data?: { createCommitOnBranch?: { commit: { oid: string } } };
      errors?: { message: string }[];
    }>("POST", "/graphql", {
      query: `mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repository, branchName: branch },
          expectedHeadOid: ref.object.sha,
          message: { headline: `Prepare Panda ${plan.version} with published Lighthouse clients` },
          fileChanges: {
            additions: Object.entries(files).map(([path, contents]) => ({
              path,
              contents: Buffer.from(contents).toString("base64"),
            })),
          },
        },
      },
    });
    if (result.errors?.length || !result.data?.createCommitOnBranch?.commit.oid) {
      const reason = result.errors?.map((error) => error.message).join("; ") ||
        "GitHub did not return a commit OID";
      throw new Error(`Release commit failed: ${reason}`);
    }
  } else {
    for (const [path, expected] of Object.entries(files)) {
      const existing = await optionalGitHub<{ content: string; encoding: string }>(
        api,
        `${root}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      );
      if (
        existing?.encoding !== "base64" ||
        Buffer.from(existing.content, "base64").toString("utf8") !== expected
      ) throw new Error(`Release branch ${branch} has different changes; refusing to overwrite it`);
    }
  }
  const pulls = await api.request<{ html_url: string; state: string }[]>(
    "GET",
    `${root}/pulls?state=all&head=${
      encodeURIComponent(`${repository.split("/")[0]}:${branch}`)
    }&base=${encodeURIComponent(base)}`,
  );
  if (pulls.length) {
    if (pulls[0].state !== "open") {
      throw new Error("Release PR is closed; use its existing release run");
    }
    return pulls[0].html_url;
  }
  const clients = Object.keys(plan.clients).map((name) => {
    const value: PublishedClients = JSON.parse(files[clientLockPath(profileName(name))]);
    return `- **${name}**: Lighthouse ${value.lighthouse.build.upstream.version}, baker ${value.lighthouse.build.baker.version}; \`${value.lighthouse.image}\` → \`${value.lighthouse.digest}\`.`;
  });
  const pull = await api.request<{ html_url: string }>("POST", `${root}/pulls`, {
    title: `Release Panda ${plan.version}: update Lighthouse clients`,
    head: branch,
    base,
    body: [
      `Pin the published Lighthouse/client versions and prepare Git tag \`${plan.version}\`.`,
      `Native-tested Lighthouse images were published or reused before this PR. Release source: ${plan.sourceCommit}.`,
      clients.join("\n"),
      "Merge this PR to create the tag on the merge commit and automatically run Publish Panda images. Panda runs its own profile and packaged-service checks before publication.",
    ].join("\n\n"),
  });
  return pull.html_url;
}

export async function releaseMergedPullRequest(
  api: GitHub,
  event: ReleaseMerge,
  plan: ReleasePlan,
  clients: Record<string, PublishedClients>,
): Promise<void> {
  const { pull_request: pull, repository } = event;
  const expected = await prepareRelease(plan.version, plan.sourceCommit, clients);
  if (
    canonical(expected.plan) !== canonical(plan) || !pull.merged ||
    pull.head.repo?.full_name !== repository.full_name ||
    pull.base.ref !== repository.default_branch || pull.head.ref !== releaseBranch(plan.version)
  ) throw new Error("Merged PR does not match the reviewed release plan and client pins");
  assertCommit(pull.merge_commit_sha);
  const root = repositoryPath(repository.full_name);
  const tag = await optionalGitHub<{ object: { sha: string; type: string } }>(
    api,
    `${root}/git/ref/tags/${plan.version}`,
  );
  if (tag) {
    let target = tag.object;
    // Accept an existing annotated tag only if it resolves to exactly this merge commit.
    for (let depth = 0; target.type === "tag" && depth < 5; depth++) {
      target =
        (await api.request<{ object: typeof target }>("GET", `${root}/git/tags/${target.sha}`))
          .object;
    }
    if (target.type !== "commit" || target.sha !== pull.merge_commit_sha) {
      throw new Error(`Release tag ${plan.version} points elsewhere; refusing to move it`);
    }
  } else {
    await api.request("POST", `${root}/git/refs`, {
      ref: `refs/tags/${plan.version}`,
      sha: pull.merge_commit_sha,
    });
  }
  // GITHUB_TOKEN-created tag pushes do not trigger workflows. Dispatch explicitly.
  const runs = await api.request<{ workflow_runs: { head_branch: string; head_sha: string }[] }>(
    "GET",
    `${root}/actions/workflows/images.yml/runs?head_sha=${pull.merge_commit_sha}&per_page=100`,
  );
  if (
    runs.workflow_runs.some((run) =>
      run.head_branch === plan.version && run.head_sha === pull.merge_commit_sha
    )
  ) {
    return;
  }
  await api.request("POST", `${root}/actions/workflows/images.yml/dispatches`, {
    ref: plan.version,
    inputs: { profile: "all" },
  });
}
