import pectra from "../bakes/pectra/recipe.json" with { type: "json" };
import gloas from "../bakes/gloas/recipe.json" with { type: "json" };

export const profiles = { pectra, gloas } satisfies Record<string, Recipe>;
export type ProfileName = keyof typeof profiles;
export interface Recipe {
  schema: number;
  name: string;
  elFork: string;
  clFork: string;
  slotMs: number;
  slotsPerEpoch: number;
  tailMs: number;
  clockSource: string;
  clockTest: string;
  /** Environment namespace compiled into the selected client's protocol clock. */
  clockEnvPrefix?: string;
  /** Native, bounded completion notifications supported by this baked clock. */
  clockWait?: boolean;
  /** Complete, verified sync contributions are delivered locally without gossip aggregators. */
  directSync?: boolean;
  /** Absolute PTC deadline selection marks and Panda's validator bootstrap gates. */
  ptcReadiness?: boolean;
  patch: string;
  sourceFiles?: string[];
  nativeTests?: { package: string; target: string }[];
  preparedSkip?: boolean;
  runtime: string;
  clRepository: string;
  elRepository: string;
  clRef: string;
  /** Optional only for legacy immutable manifests. New native builds record both versions. */
  clVersion?: string;
  bakerVersion?: number;
  rust: string;
  goBuilder: string;
  elImage: string;
  genesisImage: string;
  baselineImage: string;
  phases: number[];
  attestationMs: number;
  aggregateMs: number;
  churnLimitQuotient: number;
  engineMethods: string[];
  genesisEnv: Record<string, string>;
  /** Arrays occur only in immutable manifests created before suite paths were explicit. */
  tests: Record<string, string> | string[];
}
export function profileName(value: string): ProfileName {
  if (!Object.hasOwn(profiles, value)) throw new Error(`Unknown hardfork profile: ${value}`);
  return value as ProfileName;
}
/** Use the namespace declared by the bake; never guess a compiled clock ABI. */
export function clockEnvironment(recipe: Recipe): { startMs: string; port: string } {
  const prefix = recipe.clockEnvPrefix;
  if (prefix === undefined) {
    throw new Error(
      `Missing clock environment namespace. Build and select a new tag: deno task bake ${recipe.name} --tag <new-tag>`,
    );
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new Error("Invalid clock environment namespace");
  return { startMs: `${prefix}_CLOCK_START_MS`, port: `${prefix}_CLOCK_PORT` };
}
export function bakeTag(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error(`Invalid bake tag: ${value}`);
  return value;
}
export interface BakedImage {
  ref: string;
  id: string;
  digest?: string;
  platform: string;
}
export interface Bake {
  schema: 1;
  profile: ProfileName;
  tag: string;
  key: string;
  createdAt: string;
  recipe: Recipe;
  source: { cl: string; el?: string; importedCl?: string };
  hashes: Record<string, string>;
  images: { el: BakedImage; cl: BakedImage; genesis: BakedImage; baseline: BakedImage };
  builders: Record<string, BakedImage>;
  lighthouse?: LighthouseBuild;
}
export interface LighthouseBuild {
  upstream: { version: string; commit: string; repository: string };
  baker: { version: number; hash: string };
  platform: string;
  key: string;
}
export function bakePath(profile: ProfileName, tag: string): string {
  return `bakes/${profileName(profile)}/tags/${bakeTag(tag)}.json`;
}
export function legacyBakePath(profile: ProfileName, tag: string): string {
  return `bakes/${profileName(profile)}/${bakeTag(tag)}.json`;
}
async function manifestAt(path: string): Promise<Bake | undefined> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path));
    // The new profile definition occupies the former location of a possible "recipe" tag.
    if (path.endsWith("/recipe.json") && "clRef" in value && !("images" in value)) return;
    return value;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
/** Read legacy locations during migration, but never choose between conflicting artifacts. */
export async function bakeLocation(profile: ProfileName, tag: string): Promise<string> {
  const current = bakePath(profile, tag);
  const legacy = legacyBakePath(profile, tag);
  const [a, b] = await Promise.all([manifestAt(current), manifestAt(legacy)]);
  if (a && b && canonical(a) !== canonical(b)) {
    throw new Error(`Conflicting bake manifests: ${current} and ${legacy}`);
  }
  return a || !b ? current : legacy;
}
export async function bakeTags(profile: ProfileName): Promise<string[]> {
  const tags = new Set<string>();
  for (const directory of [`bakes/${profileName(profile)}/tags`, `bakes/${profile}`]) {
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        if (entry.name === "recipe.json" && !await manifestAt(`${directory}/${entry.name}`)) {
          continue;
        }
        tags.add(bakeTag(entry.name.slice(0, -5)));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return [...tags].sort();
}
export async function readBake(profile: ProfileName, tag = "default"): Promise<Bake> {
  let bake: Bake;
  try {
    bake = JSON.parse(await Deno.readTextFile(await bakeLocation(profile, tag)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Bake ${profile}:${tag} is missing. Run: deno task bake ${profile} --tag ${tag}`,
      );
    }
    throw error;
  }
  if (
    bake.schema !== 1 || bake.profile !== profile || bake.tag !== tag ||
    bake.recipe.name !== profile || !/^[a-f0-9]{64}$/.test(bake.key)
  ) {
    throw new Error(`Invalid bake manifest: ${profile}:${tag}`);
  }
  for (const role of ["el", "cl", "genesis", "baseline"] as const) {
    const image = bake.images[role];
    if (!image) throw new Error(`Missing bake image: ${role}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.id) || !image.platform.startsWith("linux/")) {
      throw new Error("Bake requires immutable Linux image identities");
    }
  }
  if (new Set(Object.values(bake.images).map((image) => image.platform)).size !== 1) {
    throw new Error("Bake images must use the same platform");
  }
  if (
    bake.recipe.slotMs !== 12000 || bake.recipe.slotsPerEpoch !== 32 || bake.recipe.tailMs !== 11500
  ) {
    throw new Error("This controller requires the mainnet 12-second slot schedule");
  }
  return bake;
}
export async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function sourceHashes(recipe: Recipe): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (
    const path of [recipe.patch, recipe.clockSource, recipe.clockTest, ...recipe.sourceFiles ?? []]
  ) {
    result[path] = await sha256(await Deno.readFile(path));
  }
  return result;
}
/** Canonical object keys make build identities independent of JSON formatting/key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) =>
        a.localeCompare(b)
      )
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}
