import { type ProfileName, profileName } from "./profiles.ts";

// Pectra is temporarily paused. Keep its recipes/manifests readable for historical artifacts.
// This policy is separate from native build inputs: changing the release matrix must not rebuild CL.
export const activeProfiles: readonly [ProfileName, ...ProfileName[]] = ["gloas"];
export const defaultProfile = activeProfiles[0];

export function activeProfileName(value: string): ProfileName {
  const profile = profileName(value);
  if (!activeProfiles.includes(profile)) {
    throw new Error(
      `Profile ${profile} is temporarily disabled; active profiles: ${activeProfiles.join(", ")}`,
    );
  }
  return profile;
}

export function selectActiveProfiles(selection: string): readonly ProfileName[] {
  return selection === "all" ? activeProfiles : [activeProfileName(selection)];
}
