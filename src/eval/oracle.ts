import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const canonicalPath = (path: string): string => {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
};

const isContainedBy = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(pathFromParent));
};

export const runHiddenOracle = async <T>(input: {
  readonly workspaceRoot: string;
  readonly oracleRoot: string;
  readonly providerExited: boolean;
  readonly execute: () => Promise<T>;
}): Promise<T> => {
  if (!input.providerExited) {
    throw new Error("provider must exit before the hidden oracle runs");
  }
  const workspace = canonicalPath(input.workspaceRoot);
  const oracle = canonicalPath(input.oracleRoot);
  if (isContainedBy(workspace, oracle)) {
    throw new Error("oracle root must remain outside the candidate workspace");
  }
  return input.execute();
};
