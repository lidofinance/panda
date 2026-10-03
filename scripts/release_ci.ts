import { activeProfileName, selectActiveProfiles } from "../src/active_profiles.ts";
import { requireUnpublished } from "../src/registry.ts";
import { pandaRevision, releaseImage } from "../src/release.ts";

const [command, selection] = Deno.args;
if (Deno.args.length !== 2) throw new Error("Usage: release_ci.ts matrix|check <all|profile>");
const revision = pandaRevision(Deno.env.get("GITHUB_REF") ?? "");
const owner = Deno.env.get("GITHUB_REPOSITORY_OWNER")!;
if (command === "matrix") {
  const selected = selectActiveProfiles(selection);
  const include = selected.map((profile) => ({
    profile,
    image: releaseImage(owner, profile, revision),
  }));
  await Deno.writeTextFile(
    Deno.env.get("GITHUB_OUTPUT")!,
    `revision=${revision}\nmatrix=${JSON.stringify({ include })}\n`,
    { append: true },
  );
} else if (command === "check") {
  await requireUnpublished(releaseImage(owner, activeProfileName(selection), revision));
} else {
  throw new Error("Usage: release_ci.ts matrix|check <all|profile>");
}
