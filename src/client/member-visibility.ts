/**
 * Members the 成员视图 grid shows.
 *
 * The grid opens on every member. Picking one member — from the top tabs —
 * shows that column alone, so one member's work fills the pane instead of
 * sharing it with the others; picking the same member again returns to every
 * column. A member that left the team cannot stay picked.
 *
 * @param memberIds - current roster, in presentation order.
 * @param pickedSlotId - the member whose column alone is shown, if any.
 * @returns the slot ids to render, in roster order.
 */
export function visibleMemberSlots(
  memberIds: readonly string[],
  pickedSlotId: string | undefined,
): string[] {
  if (pickedSlotId === undefined || !memberIds.includes(pickedSlotId)) return [...memberIds]
  return [pickedSlotId]
}
