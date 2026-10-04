import assert from "node:assert/strict";
import { executionSelection } from "../src/baker.ts";
import { profiles, type Recipe } from "../src/profiles.ts";

const pinned = "5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186";
const recipe: Recipe = { ...profiles.gloas, elRef: pinned };

Deno.test("recipe EL source is the default, explicit source overrides it, explicit image disables it", () => {
  assert.deepEqual(executionSelection(recipe, {}), { elImage: recipe.elImage, elRef: pinned });
  assert.deepEqual(executionSelection(recipe, { elRef: "candidate-commit" }), {
    elImage: recipe.elImage,
    elRef: "candidate-commit",
  });
  assert.deepEqual(executionSelection(recipe, { elImage: "geth@sha256:explicit" }), {
    elImage: "geth@sha256:explicit",
    elRef: undefined,
  });
  assert.equal(recipe.elRef, pinned, "overrides must not mutate the shared recipe");
});

Deno.test("legacy recipes keep prebuilt EL default and incompatible explicit flags are rejected", () => {
  const legacy = { ...recipe };
  delete legacy.elRef;
  assert.deepEqual(executionSelection(legacy, {}), { elImage: legacy.elImage, elRef: undefined });
  assert.deepEqual(executionSelection(legacy, { elRef: pinned }), {
    elImage: legacy.elImage,
    elRef: pinned,
  });
  assert.throws(
    () => executionSelection(recipe, { elImage: "custom", elRef: pinned }),
    /Choose --el-image or --el-ref/,
  );
});
