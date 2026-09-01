import { closeSync, openSync } from "node:fs";

export const createEmptyStateDatabase = (path: string): string => {
  closeSync(openSync(path, "wx", 0o600));
  return path;
};
