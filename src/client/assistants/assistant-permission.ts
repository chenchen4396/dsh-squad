/**
 * The permission preset a newly created Assistant starts at.
 *
 * The catalog lists the Host's presets in the deployment's own order and puts
 * the most restrictive one first, so defaulting to `permissions[0]` made every
 * new Assistant read-only — and every member built from it had to ask
 * permission before it could write a single file. Workspace write is the
 * intended default, and the catalog's first entry is only the fallback for a
 * deployment that does not offer it.
 */
export const DEFAULT_PERMISSION_PRESET = 'workspace-write'

/** The preset a new Assistant starts at, given the catalog's presets. */
export function defaultPermissionPreset(
  permissions: ReadonlyArray<{ value: string }>,
): string {
  return permissions.some(preset => preset.value === DEFAULT_PERMISSION_PRESET)
    ? DEFAULT_PERMISSION_PRESET
    : permissions[0]?.value ?? ''
}
