import { captureDocument } from '../src/lib/page';
import type { PlayerSnapshot } from '../src/lib/types';

// Injected on demand by the popup (never registered as a content script). Defines one
// function the popup calls; it only reads the DOM and makes no network requests.
export default defineUnlistedScript(() => {
  (globalThis as unknown as { __keepsakeCapture: unknown }).__keepsakeCapture = (player: PlayerSnapshot | null) =>
    captureDocument(document, location.href, player, new Date());
});
