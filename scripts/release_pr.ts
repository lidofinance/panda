import { type PublishedClients, readPublishedClients } from "../src/client_release.ts";
import { activeProfiles, selectActiveProfiles } from "../src/active_profiles.ts";
import {
  type GitHub,
  GitHubError,
  openReleasePullRequest,
  prepareRelease,
  type ReleaseMerge,
  releaseMergedPullRequest,
  releasePlanPath,
  requireUnusedTag,
} from "../src/release_pr.ts";

const [command] = Deno.args;
if (Deno.args.length !== 1 || !["check", "open", "tag"].includes(command)) {
  throw new Error("Usage: release_pr.ts check|open|tag");
}
const token = Deno.env.get("GH_TOKEN");
if (!token) throw new Error("GH_TOKEN is required for release automation");
const repository = Deno.env.get("GITHUB_REPOSITORY")!;
const api: GitHub = {
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const failure = await response.text();
      throw new GitHubError(
        response.status,
        `GitHub ${method} ${path}: ${response.status} ${failure}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json();
  },
};
const activeClients = async () =>
  Object.fromEntries(
    await Promise.all(
      activeProfiles.map(async (
        name,
      ) => [name, await readPublishedClients(name)]),
    ),
  );
if (command === "tag") {
  const event: ReleaseMerge = JSON.parse(
    await Deno.readTextFile(Deno.env.get("GITHUB_EVENT_PATH")!),
  );
  if (event.repository.full_name !== repository) throw new Error("Wrong release repository");
  const head = await new Deno.Command("git", { args: ["rev-parse", "HEAD"], stdout: "piped" })
    .output();
  if (
    !head.success ||
    new TextDecoder().decode(head.stdout).trim() !== event.pull_request.merge_commit_sha
  ) {
    throw new Error("Release checkout must be the exact PR merge commit");
  }
  const plan = JSON.parse(await Deno.readTextFile(releasePlanPath));
  await releaseMergedPullRequest(api, event, plan, await activeClients());
  console.log(`Release ${plan.version} is tagged; Panda publication is scheduled.`);
} else {
  const version = Deno.env.get("PANDA_VERSION")!;
  const base = Deno.env.get("DEFAULT_BRANCH")!;
  if (Deno.env.get("GITHUB_REF") !== `refs/heads/${base}`) {
    throw new Error("Start a Lighthouse release from the repository default branch");
  }
  const selection = Deno.env.get("PROFILE") ?? "all";
  const selected = selectActiveProfiles(selection);
  if (command === "check") {
    await requireUnusedTag(api, repository, version);
    // A first release needs all active profiles; later releases can update just one.
    for (const name of activeProfiles) {
      if (!selected.includes(name)) await readPublishedClients(name);
    }
  } else {
    const clients: Record<string, PublishedClients> = {};
    for (const name of activeProfiles) {
      clients[name] = selected.includes(name)
        ? JSON.parse(
          await Deno.readTextFile(`.cache/release-locks/lighthouse-lock-${name}/clients.lock.json`),
        )
        : await readPublishedClients(name);
    }
    const release = await prepareRelease(version, Deno.env.get("GITHUB_SHA")!, clients);
    const url = await openReleasePullRequest(api, repository, base, release);
    const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summary) {
      await Deno.writeTextFile(
        summary,
        `Release PR: ${url}\n\nMerge it to publish Panda ${version}.\n`,
        { append: true },
      );
    }
    console.log(url);
  }
}
