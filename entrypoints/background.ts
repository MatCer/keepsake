import { browser } from 'wxt/browser';
import { isRecord } from '../src/lib/capture-validation';
import { jevTag, type JevReply } from '../src/lib/jev-tag';
import { KarakeepClient } from '../src/lib/karakeep';
import { loadSettings } from '../src/lib/settings';
import type { Capture } from '../src/lib/types';

// Jev tagging runs here, not in the popup, so closing the popup mid-run does not cut it off.
// Settings (and keys) are read here; the popup only sends the bookmark id and its capture.
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: JevReply) => void) => {
    // Only our own pages: injected scripts report the web page as sender.url.
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('/'))) return;
    if (!isRecord(message) || message.type !== 'jev-tag' || typeof message.bookmarkId !== 'string' || !isRecord(message.capture)) return;
    const { bookmarkId, capture } = message as { bookmarkId: string; capture: Capture };
    (async () => {
      const s = await loadSettings();
      if (!s.address || !s.apiKey || !s.jevApiKey || !s.jevEndpoint || !s.jevModel) throw new Error('Karakeep or Jev is not configured');
      return jevTag(new KarakeepClient(s.address, s.apiKey), bookmarkId, capture, { apiKey: s.jevApiKey, endpoint: s.jevEndpoint, model: s.jevModel });
    })().then(
      (outcome) => sendResponse({ ok: true, outcome }),
      (e) => sendResponse({ ok: false, message: e instanceof Error ? e.message : 'Jev classification failed' }),
    );
    return true; // reply asynchronously
  });
});
