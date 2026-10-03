import type { ProfileName } from "./profiles.ts";
import { activeProfiles } from "./active_profiles.ts";
import type { GitHub } from "./release_pr.ts";

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number };
}
interface PublicationRun {
  path: string;
  event: string;
  status: string;
  head_branch: string;
  head_repository: { full_name: string } | null;
}
export interface PublishedLockArtifact {
  profile: ProfileName;
  artifactId: number;
  runId: number;
}

/** Lock artifacts are uploaded only after publication, even when the later PR job fails. */
export async function latestPublishedLocks(
  api: GitHub,
  repository: string,
  branch: string,
  profiles: readonly ProfileName[] = activeProfiles,
): Promise<PublishedLockArtifact[]> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository");
  }
  const root = `/repos/${repository}`;
  const artifacts: Artifact[] = [];
  for (let page = 1;; page++) {
    const result = await api.request<{ total_count: number; artifacts: Artifact[] }>(
      "GET",
      `${root}/actions/artifacts?per_page=100&page=${page}`,
    );
    artifacts.push(...result.artifacts);
    if (artifacts.length >= result.total_count || result.artifacts.length < 100) break;
  }
  const names = new Map(profiles.map((profile) => [`lighthouse-lock-${profile}`, profile]));
  const candidates = artifacts.filter((artifact) => names.has(artifact.name));
  for (const artifact of candidates) {
    if (
      !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
      !Number.isSafeInteger(artifact.workflow_run?.id) || artifact.workflow_run!.id <= 0 ||
      !Number.isFinite(Date.parse(artifact.created_at))
    ) throw new Error(`Invalid publication artifact metadata: ${artifact.name}`);
  }
  candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const runs = new Map<number, PublicationRun>();
  const selected = new Map<ProfileName, PublishedLockArtifact>();
  for (const artifact of candidates) {
    const profile = names.get(artifact.name)!;
    if (selected.has(profile)) continue;
    const runId = artifact.workflow_run!.id;
    let run = runs.get(runId);
    if (!run) {
      run = await api.request<PublicationRun>("GET", `${root}/actions/runs/${runId}`);
      runs.set(runId, run);
    }
    if (
      run.path !== ".github/workflows/lighthouse.yml" || run.event !== "workflow_dispatch" ||
      run.status !== "completed" || run.head_branch !== branch ||
      run.head_repository?.full_name !== repository
    ) continue;
    if (artifact.expired) {
      throw new Error(`Latest published lock expired for ${profile}; no clients will be built`);
    }
    selected.set(profile, { profile, artifactId: artifact.id, runId });
    if (selected.size === profiles.length) break;
  }
  const missing = profiles.filter((profile) => !selected.has(profile));
  if (missing.length) {
    throw new Error(
      `Missing published client locks for ${missing.join(", ")}; no clients will be built`,
    );
  }
  return profiles.map((profile) => selected.get(profile)!);
}
