import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPolicy } from "../src/security/project-policy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

describe("project path policy", () => {
  it("returns a canonical project only when its real path is inside an allowed root", () => {
    const parent = root("agent-collab-project-");
    const allowed = join(parent, "allowed");
    const project = join(allowed, "team", "repo");
    const outside = join(parent, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    const policy = new ProjectPolicy([allowed]);

    expect(policy.resolve(project)).toBe(realpathSync(project));
    expect(policy.resolve(allowed)).toBe(realpathSync(allowed));
    expect(() => policy.resolve(outside)).toThrow(/allowed project roots/i);
    expect(() => policy.resolve(join(allowed, "missing"))).toThrow(/real project directory/i);
  });

  it("rejects a symlink whose lexical path is allowed but real target escapes", () => {
    const parent = root("agent-collab-project-symlink-");
    const allowed = join(parent, "allowed");
    const outside = join(parent, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, join(allowed, "escape"));

    const policy = new ProjectPolicy([allowed]);
    expect(() => policy.resolve(join(allowed, "escape"))).toThrow(/allowed project roots/i);
  });

});
