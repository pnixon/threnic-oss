/**
 * butterchurnStatus — one-shot user notice when Butterchurn can't run.
 *
 * Butterchurn needs WebGL2 with float-ish render targets; some phones / locked
 * down browsers can't provide that. The renderers fall back to "no visualizer"
 * silently, so surface it once per session instead of every retry.
 */

import { toast } from '@/utils/toast';

let _notified = false;

/** Show the "MilkDrop visualizer unavailable" toast at most once per session. */
export function notifyButterchurnUnavailable(): void {
  if (_notified) return;
  _notified = true;
  toast.warning("MilkDrop visualizer (Butterchurn) isn't available on this device.", 6000);
}

/** Test hook: allow the notice to fire again. */
export function _resetButterchurnNoticeForTests(): void {
  _notified = false;
}
