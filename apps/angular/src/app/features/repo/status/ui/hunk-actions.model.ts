import type { FileDiff } from '@contracts/domain';

/** True when the file supports hunk/line actions (tracked, textual, hunks present). */
export function isHunkActionable(file: FileDiff): boolean {
  return (
    !file.isBinary &&
    !file.hasConflictMarkers &&
    file.status !== 'D' &&
    file.hunks.length > 0
  );
}
