import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skills = join(root, "skills");

async function skillNames(): Promise<string[]> {
  const names = [];
  for await (const entry of Deno.readDir(skills)) if (entry.isDirectory) names.push(entry.name);
  return names.sort();
}

Deno.test("Claude Code and Codex discover the same canonical skill directory", async () => {
  for (const entry of [".agents/skills", ".claude/skills", ".codex/skills"]) {
    const info = await Deno.lstat(join(root, entry));
    assert(info.isSymlink, `${entry} must be a symlink`);
    assert.equal(await Deno.readLink(join(root, entry)), "../skills", entry);
  }
  const claude = await Deno.lstat(join(root, "CLAUDE.md"));
  assert(claude.isSymlink, "CLAUDE.md must be a symlink");
  assert.equal(await Deno.readLink(join(root, "CLAUDE.md")), "AGENTS.md");
});

Deno.test("skills use only portable SKILL.md frontmatter", async () => {
  const names = await skillNames();
  assert(names.length > 0);
  for (const name of names) {
    const source = await Deno.readTextFile(join(skills, name, "SKILL.md"));
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    assert(match, `${name}: missing frontmatter`);
    const keys = [...match[1].matchAll(/^([A-Za-z_-]+):/gm)].map((key) => key[1]);
    assert.deepEqual(keys, ["name", "description"], name);
    assert.match(match[1], new RegExp(`^name: ${name}$`, "m"), name);
    const description = match[1].match(/^description: (.+)$/m)?.[1] ?? "";
    assert(description.length > 0 && description.length <= 1024, `${name}: description length`);
    assert.doesNotMatch(description, /[<>]/, `${name}: angle brackets in description`);
  }
});

Deno.test("skill links resolve from every discovery entry point", async () => {
  for (const name of await skillNames()) {
    const source = await Deno.readTextFile(join(skills, name, "SKILL.md"));
    for (const [, target] of source.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      for (const entry of ["skills", ".agents/skills", ".claude/skills", ".codex/skills"]) {
        const path = target.startsWith("/")
          ? join(root, target)
          : resolve(root, entry, name, target);
        await Deno.stat(path).catch(() => assert.fail(`${entry}/${name}: broken link ${target}`));
      }
    }
  }
});

Deno.test("agent entry point references canonical skill paths", async () => {
  const agents = await Deno.readTextFile(join(root, "AGENTS.md"));
  assert.doesNotMatch(agents, /\.agents\/skills\//);
  for (const [, path] of agents.matchAll(/`(skills\/[^`]+\/SKILL\.md)`/g)) {
    await Deno.stat(join(root, path));
  }
});
