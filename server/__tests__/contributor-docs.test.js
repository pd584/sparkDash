import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// These are the onboarding links documented by README's Contributing section.
// Check the linked resources, rather than allowing another release with dead links.
test("README contributor onboarding documents resolve in the source tree", () => {
  const root = new URL("../../", import.meta.url);
  const readme = fs.readFileSync(new URL("README.md", root), "utf8");
  const contributing = readme.split("## Contributing")[1]?.split("\n## ")[0];
  assert.ok(contributing, "README must retain contributor guidance");
  for (const name of ["AGENTS.md", "CODEBASE.md"]) {
    const link = `[${name}](./${name})`;
    assert.ok(contributing.includes(link), `${name} should be linked for contributors`);
    assert.ok(fs.readFileSync(new URL(name, root), "utf8").trim().length > 0, `${name} must resolve to a nonempty document`);
  }
});
