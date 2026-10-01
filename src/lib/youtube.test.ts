import { expect, test, afterEach, vi } from 'vitest';
import modern from './__fixtures__/modern.html?raw';
import legacy from './__fixtures__/legacy.html?raw';
import { videoIdFromUrl, isCapturableVideoUrl, canonicalVideoUrl, parseTimestamp, formatTimestamp, readTranscript, readOrOpenTranscript, probePlayer } from './youtube';
import { sha256Hex } from './hash';
import { LIMITS, type PlayerSnapshot } from './types';
const id = 'dQw4w9WgXcQ';
const url = `https://www.youtube.com/watch?v=${id}`;
const now = new Date('2026-09-30T12:00:00Z');
const player: PlayerSnapshot = { videoId: id, title: 'Workshop', channel: 'Maker', lengthSeconds: 90, publishDate: '2026-09-01', description: 'Fold a kite.', captionTracks: [{ languageCode: 'en', name: 'English (auto-generated)', generated: true }] };
function doc(html = modern) { return new DOMParser().parseFromString(html, 'text/html'); }
afterEach(() => { document.body.innerHTML = ''; });
test.each(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])('normalizes %s', host => {
  for (const path of [`/watch?x=1&v=${id}&t=2`, `/shorts/${id}`, `/live/${id}`, `/embed/${id}`]) expect(videoIdFromUrl(`https://${host}${path}`)).toBe(id);
});
test('strict hosts, ids and capturable pages', () => {
  expect(videoIdFromUrl(`https://youtu.be/${id}?t=1`)).toBe(id);
  expect(canonicalVideoUrl(id)).toBe(url);
  for (const input of ['bad', `https://example.com/watch?v=${id}`, `https://notyoutube.com/watch?v=${id}`, `https://youtube.com.evil.com/watch?v=${id}`, 'https://youtube.com/watch?v=short', 'https://youtube.com/watch?v=abcdefghij!', `https://youtube.com/shorts/${id}/extra`]) expect(videoIdFromUrl(input)).toBeNull();
  for (const input of [url, `https://youtube.com/live/${id}`, `https://youtube.com/shorts/${id}`]) expect(isCapturableVideoUrl(input)).toBe(true);
  for (const input of [`https://youtu.be/${id}`, `https://youtube.com/embed/${id}`]) expect(isCapturableVideoUrl(input)).toBe(false);
});
test.each([['0:01', 1], ['12:34', 754], ['1:02:03', 3723], [' 61:01 ', 3661]])('parses %s', (s, n) => expect(parseTimestamp(s)).toBe(n));
test.each(['', 'abc', '1:2:3:4', '-1:02', '61:99', '1:60:00', '1:2', '1.2:03'])('rejects timestamp %s', s => expect(parseTimestamp(s)).toBeNull());
test('formats timestamps and hashes UTF-8 deterministically', async () => {
  expect([1,754,3723].map(formatTimestamp)).toEqual(['0:01','12:34','1:02:03']);
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(await sha256Hex('kite 🪁')).toBe(await sha256Hex('kite 🪁'));
});
test('modern DOM chapters, metadata and no accessibility label', async () => {
  const result = await readTranscript(doc(), url, player, now);
  expect(result).toMatchObject({ status: 'captured', capture: { capturedAt: now.toISOString(), video: { description: player.description }, transcript: { language: 'en', generated: true, text: 'Fold the paper carefully. Add a silver ribbon.', chapters: [{ title: 'Building a kite', start: 1 }] } } });
});
test('legacy footer selects among multiple tracks and preserves unknown label', async () => {
  const multiple = { ...player, captionTracks: [...player.captionTracks, { languageCode: 'fr', name: 'French', generated: false }] };
  expect(await readTranscript(doc(legacy), url, multiple, now)).toMatchObject({ capture: { transcript: { language: 'en', chapters: [{ title: 'A tiny observatory', start: 5 }] } } });
  expect(await readTranscript(doc(legacy.replace('English (auto-generated)', 'Unknown (auto-generated)')), url, multiple, now)).toMatchObject({ capture: { transcript: { language: null, languageLabel: 'Unknown (auto-generated)', generated: true } } });
  expect(await readTranscript(doc(), url, null, now)).toMatchObject({ capture: { transcript: { language: null, generated: null } } });
});
test('unloaded, description-only, hidden and no-caption states', async () => {
  expect(await readTranscript(doc('<p>Description only</p>'), url, player, now)).toEqual({ status: 'panel-not-loaded', videoId: id });
  expect(await readTranscript(doc(''), url, { ...player, captionTracks: [] }, now)).toEqual({ status: 'no-captions', videoId: id });
  expect(await readTranscript(doc(modern.replace('EXPANDED', 'HIDDEN')), url, player, now)).toEqual({ status: 'panel-not-loaded', videoId: id });
  expect(await readTranscript(doc(), 'https://youtube.com/', player, now)).toMatchObject({ status: 'unsupported' });
});
test('rejects stale player, watch-flexy and duration', async () => {
  for (const [html, snapshot] of [[modern, { ...player, videoId: 'abcdefghijk' }], [modern.replace(id, 'abcdefghijk'), player], [modern, { ...player, lengthSeconds: 10 }]] as const) expect(await readTranscript(doc(html), url, snapshot, now)).toEqual({ status: 'stale', videoId: id });
});
test('drops empty and malformed segments', async () => {
  expect(await readTranscript(doc(modern.replace('0:01', 'bad').replace('Add a silver ribbon.', '   ')), url, player, now)).toMatchObject({ status: 'panel-not-loaded' });
});
test('enforces text limit with UTF-8 byte count', async () => {
  const text = 'é'.repeat(LIMITS.maxTranscriptChars + 1);
  expect(await readTranscript(doc(modern.replace('Fold   the paper\n carefully.', text).replace('Add a silver ribbon.', '')), url, player, now)).toEqual({ status: 'too-large', bytes: new TextEncoder().encode(text).length });
});
test('enforces segment limit', async () => {
  const segment = '<ytd-transcript-segment-renderer><b class="segment-timestamp">0:01</b><b class="segment-text">Kite</b></ytd-transcript-segment-renderer>';
  expect(await readTranscript(doc(`<ytd-engagement-panel-section-list-renderer visibility="EXPANDED">${segment.repeat(LIMITS.maxSegments + 1)}</ytd-engagement-panel-section-list-renderer>`), url, player, now)).toMatchObject({ status: 'too-large' });
}, 20000);
test('probe is self-contained, selective and graceful', () => {
  const empty = { videoId: null, title: null, channel: null, lengthSeconds: null, publishDate: null, description: null, captionTracks: [] };
  expect(probePlayer()).toEqual(empty);
  const element = document.createElement('div'); element.id = 'movie_player'; document.body.append(element);
  Object.assign(element, { getPlayerResponse: () => ({ videoDetails: { videoId: id, title: 'Workshop', author: 'Maker', lengthSeconds: '90', shortDescription: 'Fold a kite.', secret: 'omit' }, microformat: { playerMicroformatRenderer: { publishDate: '2026-09-01' } }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', name: { runs: [{ text: 'English (auto-generated)' }] }, kind: 'asr' }] } } }) });
  expect(probePlayer()).toEqual(player);
  expect(new Function(`return (${probePlayer.toString()})()`)()).toEqual(player);
  Object.assign(element, { getPlayerResponse: () => { throw Error('bad'); } });
  expect(probePlayer()).toEqual(empty);
});

test('segments without any way to confirm the current video are not trusted', async () => {
  const noFlexy = modern.replace(/<ytd-watch-flexy[^>]*>/, '<div>');
  expect(await readTranscript(doc(noFlexy), url, null, now)).toEqual({ status: 'stale', videoId: id });
  expect(await readTranscript(doc(noFlexy), url, { ...player, videoId: null }, now)).toEqual({ status: 'stale', videoId: id });
  expect(await readTranscript(doc(noFlexy), url, player, now)).toMatchObject({ status: 'captured' });
});

/** Modern fixture with the transcript panel removed until YouTube's "Show transcript" button is clicked. */
function closedDoc(withButton = true) {
  const d = doc();
  const panels = [...d.querySelectorAll('ytd-engagement-panel-section-list-renderer')];
  const parent = panels[0]!.parentElement!;
  panels.forEach(panel => panel.remove());
  const clicks = { count: 0 };
  for (const panel of panels) {
    const close = panel.insertBefore(d.createElement('div'), panel.firstChild);
    close.id = 'header';
    const holder = close.appendChild(d.createElement('div'));
    holder.id = 'visibility-button';
    holder.appendChild(d.createElement('button')).addEventListener('click', () => panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'));
  }
  if (withButton) {
    const section = parent.appendChild(d.createElement('ytd-video-description-transcript-section-renderer'));
    section.appendChild(d.createElement('button')).addEventListener('click', () => { clicks.count++; panels.forEach(panel => parent.append(panel)); });
  }
  return { d, clicks };
}
const noWait = () => Promise.resolve();
test("opens a closed transcript panel with YouTube's own button only when asked", async () => {
  const off = closedDoc();
  expect(await readOrOpenTranscript(off.d, url, player, now, false, noWait)).toMatchObject({ status: 'panel-not-loaded' });
  expect(off.clicks.count).toBe(0);
  const on = closedDoc();
  expect(await readOrOpenTranscript(on.d, url, player, now, true, noWait)).toEqual(await readTranscript(doc(), url, player, now));
  expect(on.clicks.count).toBe(1);
  // The page is put back: the panel this capture opened is closed again.
  expect(on.d.querySelectorAll('ytd-engagement-panel-section-list-renderer[visibility$="EXPANDED"]')).toHaveLength(0);
  const sleep = vi.fn(noWait);
  expect(await readOrOpenTranscript(closedDoc(false).d, url, player, now, true, sleep)).toMatchObject({ status: 'panel-not-loaded' });
  expect(sleep).not.toHaveBeenCalled();
});
test('an open panel or a video without captions is never clicked', async () => {
  const sleep = vi.fn(noWait);
  const open = doc();
  expect(await readOrOpenTranscript(open, url, player, now, true, sleep)).toMatchObject({ status: 'captured' });
  expect(open.querySelectorAll('ytd-engagement-panel-section-list-renderer[visibility$="EXPANDED"]').length).toBeGreaterThan(0);
  const none = closedDoc();
  expect(await readOrOpenTranscript(none.d, url, { ...player, captionTracks: [] }, now, true, sleep)).toMatchObject({ status: 'no-captions' });
  expect(none.clicks.count).toBe(0);
  expect(sleep).not.toHaveBeenCalled();
});
