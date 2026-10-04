import { join } from "node:path";
import { atomicJson, requireImage } from "./artifacts.ts";
import type { Infrastructure } from "./docker.ts";
import { type Bake, type BakedImage, canonical, sha256 } from "./profiles.ts";
import { StateLock } from "./storage.ts";

/** Bump whenever the Geth compiler command, environment or runtime installation changes. */
export const EL_BUILD_REVISION = 2;
const sha = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export interface ExecutionBuild {
  revision: number;
  source: { repository: string; commit: string };
  builder: { id: string; platform: string };
  runtime: { id: string; platform: string };
  key: string;
}
export async function executionBuild(
  repository: string,
  commit: string,
  builder: BakedImage,
  runtime: BakedImage,
  revision = EL_BUILD_REVISION,
): Promise<ExecutionBuild> {
  if (
    !repository || !/^[a-f0-9]{40}$/.test(commit) ||
    !Number.isSafeInteger(revision) || revision < 1 ||
    !imageId.test(builder.id) || !imageId.test(runtime.id) ||
    !/^linux\/[a-z0-9_]+$/.test(builder.platform) || builder.platform !== runtime.platform
  ) {
    throw new Error(
      "EL build identity requires an exact source, pinned images and matching platforms",
    );
  }
  const identity = {
    revision,
    source: { repository, commit },
    builder: { id: builder.id, platform: builder.platform },
    runtime: { id: runtime.id, platform: runtime.platform },
  };
  return { ...identity, key: await sha256(canonical(identity)) };
}

interface ExecutionArtifact {
  build: ExecutionBuild;
  image: BakedImage;
  /** Keep the old envelope as source proof, independently of legacy cache file cleanup. */
  legacyBake?: Bake;
}

async function availableImage(
  infra: Infrastructure,
  artifact: ExecutionArtifact,
): Promise<boolean> {
  const { image, build, legacyBake } = artifact;
  let ownerKey = build.key;
  if (legacyBake !== undefined) {
    const proven = await legacyArtifact(legacyBake, `${legacyBake?.key}.json`);
    if (
      !proven || canonical(proven.build) !== canonical(build) ||
      canonical(proven.image) !== canonical(image)
    ) throw new Error("EL cache legacy provenance mismatch");
    ownerKey = legacyBake.key;
  }
  if (
    !image || !imageId.test(image.id) || image.platform !== build.builder.platform
  ) throw new Error("EL cache image identity mismatch");
  try {
    await requireImage(infra, image);
  } catch (error) {
    if (String(error).includes("Missing local bake image")) return false;
    throw error;
  }
  const found = await infra.docker.getImage(image.id).inspect();
  if (
    found.Id !== image.id || `${found.Os}/${found.Architecture}` !== image.platform ||
    found.Config.Labels?.["io.panda.id"] !== `bake-${ownerKey.slice(0, 24)}`
  ) throw new Error("EL cache image identity or ownership mismatch");
  return true;
}

/** Only the exact old envelope proves the otherwise-unrecorded EL compiler revision was 2. */
async function legacyArtifact(
  value: Bake,
  filename: string,
): Promise<ExecutionArtifact | undefined> {
  if (
    !value || value.schema !== 1 || !sha.test(value.key) || filename !== `${value.key}.json` ||
    !value.source?.el || value.recipe?.elRef !== value.source.el ||
    !value.builders?.go || !value.builders.runtime || !value.images?.el
  ) return;
  const build = await executionBuild(
    value.recipe.elRepository,
    value.source.el,
    value.builders.go,
    value.builders.runtime,
    2,
  );
  if (value.images.el.platform !== build.builder.platform || !imageId.test(value.images.el.id)) {
    return;
  }
  if (value.source.importedCl && value.source.importedCl !== value.images.cl?.id) return;
  const key = await sha256(canonical({
    recipe: value.recipe,
    hashes: value.hashes,
    source: value.source,
    builders: value.builders,
    genesis: value.images.genesis,
    baseline: value.images.baseline,
    importedCl: value.source.importedCl ? value.images.cl : undefined,
    lighthouse: value.lighthouse,
    recipeRevision: 3,
    elBuildRevision: 2,
  }));
  if (value.key !== key) return;
  return { build, image: value.images.el, legacyBake: value };
}

export async function executionImage(
  infra: Infrastructure,
  build: ExecutionBuild,
  compile: () => Promise<BakedImage>,
  root = ".cache/baker",
): Promise<BakedImage> {
  await Deno.mkdir(join(root, "locks"), { recursive: true });
  const lock = await StateLock.acquire(join(root, "locks", `execution-${build.key}.lock`));
  try {
    const path = join(root, "execution", `${build.key}.json`);
    let cached: ExecutionArtifact | undefined;
    try {
      cached = JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (cached !== undefined) {
      if (!cached || canonical(cached.build) !== canonical(build)) {
        throw new Error("EL cache build identity mismatch");
      }
      if (await availableImage(infra, cached)) {
        console.log(JSON.stringify({
          event: "execution-reused",
          key: build.key,
          imageId: cached.image.id,
          from: "cache",
        }));
        return cached.image;
      }
    }
    let entries: Deno.DirEntry[] = [];
    try {
      entries = await Array.fromAsync(Deno.readDir(join(root, "artifacts")));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      let candidate: ExecutionArtifact | undefined;
      try {
        candidate = await legacyArtifact(
          JSON.parse(await Deno.readTextFile(join(root, "artifacts", entry.name))),
          entry.name,
        );
      } catch (error) {
        // Incomplete/unsupported old metadata is never proof of a source-built image.
        if (
          error instanceof Deno.errors.NotFound || error instanceof SyntaxError ||
          error instanceof TypeError || String(error).includes("EL build identity requires")
        ) continue;
        throw error;
      }
      if (!candidate || canonical(candidate.build) !== canonical(build)) continue;
      if (!await availableImage(infra, candidate)) continue;
      await atomicJson(path, candidate);
      console.log(JSON.stringify({
        event: "execution-reused",
        key: build.key,
        imageId: candidate.image.id,
        from: "legacy",
      }));
      return candidate.image;
    }
    const artifact = { build, image: await compile() };
    if (!await availableImage(infra, artifact)) throw new Error("Compiled EL image is unavailable");
    await atomicJson(path, artifact);
    return artifact.image;
  } finally {
    lock.release();
  }
}
