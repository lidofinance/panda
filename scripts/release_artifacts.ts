import { atomicJson } from "../src/artifacts.ts";
import { maintainedProfiles } from "../src/profiles.ts";
import { latestPublishedLocks } from "../src/release_artifacts.ts";
import { type GitHub, GitHubError } from "../src/release_pr.ts";

const repository = Deno.env.get("GITHUB_REPOSITORY")!;
const branch = Deno.env.get("DEFAULT_BRANCH")!;
if (!branch || Deno.env.get("GITHUB_REF") !== `refs/heads/${branch}`) {
  throw new Error("Run this release from the repository default branch");
}
const token = Deno.env.get("GH_TOKEN");
if (!token) throw new Error("GH_TOKEN is required to read published client artifacts");
const api: GitHub = {
  async request<T>(method: string, path: string): Promise<T> {
    if (method !== "GET") throw new Error("Artifact selection is read-only");
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new GitHubError(response.status, `Read publication artifacts: HTTP ${response.status}`);
    }
    return await response.json();
  },
};
const locks = await latestPublishedLocks(
  api,
  repository,
  branch,
  [...maintainedProfiles],
);
await atomicJson(".cache/release-locks/sources.json", locks);
console.log(JSON.stringify(locks, null, 2));
const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summary) {
  await Deno.writeTextFile(
    summary,
    "Using existing published clients; no Lighthouse build is started.\n\n" +
      locks.map(({ profile, runId, artifactId }) =>
        `- ${profile}: [publication run ${runId}](https://github.com/${repository}/actions/runs/${runId}), artifact ${artifactId}.`
      ).join("\n") + "\n\n",
    { append: true },
  );
}
