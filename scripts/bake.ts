import { argumentsFor } from "../src/arguments.ts";
import { defaultProfile } from "../src/active_profiles.ts";
import { bake } from "../src/baker.ts";
import { profileName } from "../src/profiles.ts";
const { flags, positional } = argumentsFor(Deno.args, [
  "tag",
  "import-cl",
  "reuse-cl",
  "cl-ref",
  "patch",
  "el-image",
  "el-ref",
  "genesis-image",
  "baseline-image",
  "rust-image",
  "go-image",
], ["replace"]);
if (positional.length > 1) throw new Error("Usage: deno task bake <hardfork> [--tag <name>]");
const result = await bake(profileName(positional[0] ?? defaultProfile), {
  tag: flags.tag,
  replace: flags.replace === "true",
  importCl: flags["import-cl"],
  reuseCl: flags["reuse-cl"],
  clRef: flags["cl-ref"],
  patch: flags.patch,
  elImage: flags["el-image"],
  elRef: flags["el-ref"],
  genesisImage: flags["genesis-image"],
  baselineImage: flags["baseline-image"],
  rustImage: flags["rust-image"],
  goImage: flags["go-image"],
});
console.log(
  JSON.stringify({
    event: "bake-complete",
    profile: result.profile,
    tag: result.tag,
    key: result.key,
    images: result.images,
  }),
);
