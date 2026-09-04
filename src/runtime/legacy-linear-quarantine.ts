export const LEGACY_LINEAR_DELEGATION_STATE = "permanently_disabled" as const;

export function denyLegacyLinearDelegation(): never {
  throw new Error("legacy linear delegation is permanently disabled; use the reviewed graph collaboration runtime");
}
