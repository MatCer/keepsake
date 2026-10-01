import { captureDocument } from '../src/lib/page';
import type { PlayerSnapshot } from '../src/lib/types';

// Injected on demand by the popup (never registered as a content script). Defines one
// function the popup calls; it reads the DOM and makes no network requests. With
// `openTranscript` it may click YouTube's "Show transcript" button, as the user would.
export default defineUnlistedScript(() => {
  (globalThis as unknown as { __keepsakeCapture: unknown }).__keepsakeCapture = (player: PlayerSnapshot | null, openTranscript: boolean) =>
    captureDocument(document, location.href, player, new Date(), openTranscript);
});
