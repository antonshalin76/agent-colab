import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SkillManifestFile {
  path: string;
  sha256: string;
}

export interface SkillManifest {
  resolvedRoot: string;
  files: SkillManifestFile[];
  hash: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function localReferences(markdown: string): string[] {
  const references: string[] = [];
  const pattern = /\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1]?.trim() ?? "";
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
    if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      references.push(decodeURIComponent(target));
    } catch {
      throw new Error(`invalid encoded skill reference: ${target}`);
    }
  }
  return references;
}

export function captureSkillManifest(input: { root: string; skills: string[] }): SkillManifest {
  const resolvedRoot = realpathSync(input.root);
  if (!statSync(resolvedRoot).isDirectory()) throw new Error("skill root must be a directory");
  const names = [...new Set(input.skills)].sort();
  if (names.length === 0) throw new Error("at least one skill is required");
  const files = new Map<string, SkillManifestFile>();

  for (const name of names) {
    if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`invalid skill name: ${name}`);
    }
    const skillRoot = realpathSync(join(resolvedRoot, name));
    if (!statSync(skillRoot).isDirectory()) throw new Error(`skill is not a directory: ${name}`);
    const pending = [realpathSync(join(skillRoot, "SKILL.md"))];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      if (!inside(skillRoot, file)) throw new Error(`skill reference escapes its root: ${name}`);
      if (!statSync(file).isFile()) throw new Error(`skill reference is not a file: ${file}`);
      visited.add(file);
      const bytes = readFileSync(file);
      const logicalPath = join(name, relative(skillRoot, file)).split(sep).join("/");
      files.set(logicalPath, { path: logicalPath, sha256: sha256(bytes) });

      if (extname(file).toLowerCase() !== ".md") continue;
      for (const reference of localReferences(bytes.toString("utf8"))) {
        const lexical = resolve(dirname(file), reference);
        if (!inside(skillRoot, lexical)) throw new Error(`skill reference escapes its root: ${reference}`);
        pending.push(realpathSync(lexical));
      }
    }
  }

  const ordered = [...files.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const digest = createHash("sha256");
  for (const file of ordered) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return { resolvedRoot, files: ordered, hash: digest.digest("hex") };
}

export function freezeSkillBundle(input: {
  sourceRoot: string;
  destinationRoot: string;
  skills: string[];
}): SkillManifest {
  const source = captureSkillManifest({ root: input.sourceRoot, skills: input.skills });
  const destination = resolve(input.destinationRoot);
  if (existsSync(destination) && readdirSync(destination).length !== 0) {
    throw new Error("frozen skill bundle destination must be empty");
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of source.files) {
    const from = join(source.resolvedRoot, file.path);
    const to = join(destination, file.path);
    if (!inside(source.resolvedRoot, from) || !inside(destination, to)) {
      throw new Error("frozen skill bundle path escapes its root");
    }
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (sha256(readFileSync(from)) !== file.sha256) {
      throw new Error(`skill changed while freezing bundle: ${file.path}`);
    }
    copyFileSync(from, to);
  }
  const frozen = captureSkillManifest({ root: destination, skills: input.skills });
  if (frozen.hash !== source.hash || JSON.stringify(frozen.files) !== JSON.stringify(source.files)) {
    throw new Error("frozen skill bundle manifest mismatch");
  }
  return frozen;
}
