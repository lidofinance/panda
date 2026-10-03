import { profileName } from "../../../src/profiles.ts";
import { activeProfiles } from "../../../src/active_profiles.ts";

/** Direct lifecycle runs cover active hardforks; an explicit selection can check older artifacts. */
export function testProfiles(selected: string | undefined) {
  return selected === undefined ? activeProfiles : [profileName(selected)];
}

/** Deno steps return false on failure; stop dependent stages before mutating a broken fixture. */
export async function step(t: Deno.TestContext, name: string, run: () => Promise<void>) {
  const passed = await t.step({
    name,
    fn: run,
    // The same real clients remain alive across the stages of one lifecycle.
    sanitizeOps: false,
    sanitizeResources: false,
  });
  if (!passed) throw new Error(`Stopped after failed step: ${name}`);
}
