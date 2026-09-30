import { readFileSync } from 'node:fs';

/** Original test transcript. Includes text that must survive escaping untouched. */
export const SEGMENTS = [
  { start: 0, time: '0:00', text: 'Welcome to the Keepsake fixture.' },
  { start: 4, time: '0:04', text: 'This transcript was written for tests, not taken from a real video.' },
  { start: 9, time: '0:09', text: 'Timestamps must survive exactly as shown.' },
  { start: 31, time: '0:31', text: 'Markup like <script>alert(1)</script> is text here.' },
  { start: 47, time: '0:47', text: 'So are **stars**, [links](javascript:alert(1)) and | pipes #hash.' },
  { start: 62, time: '1:02', text: 'Unicode stays intact: Ďakujem – ✓ 日本語.' },
  { start: 90, time: '1:30', text: 'Thanks for watching.' },
];
export const CHAPTERS = [
  { title: 'Getting started', start: 0 },
  { title: 'Edge cases & escaping', start: 31 },
];
export const TEXT = SEGMENTS.map((s) => s.text).join(' ');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const secondsLabel = (n: number) => `${n} seconds`;

const segmentHtml = (s: (typeof SEGMENTS)[number]) => `
  <macro-markers-panel-item-view-model class="ytwMacroMarkersPanelItemViewModelHost">
    <timeline-item-view-model class="ytwTimelineItemViewModelHost"><div class="ytwTimelineItemViewModelContentItems">
      <transcript-segment-view-model class="ytwTranscriptSegmentViewModelHost">
        <div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">${s.time}</div>
        <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">${secondsLabel(s.start)}</div>
        <span class="ytAttributedStringHost ytAttributedStringLinkInheritColor" role="text">${esc(s.text)}</span>
      </transcript-segment-view-model>
    </div></timeline-item-view-model>
  </macro-markers-panel-item-view-model>`;

export function watchPage(videoId: string, panel: 'open' | 'closed') {
  const open = panel === 'open';
  return readFileSync(new URL('./fixtures/youtube-watch.html', import.meta.url), 'utf8')
    .replaceAll('{{VIDEO_ID}}', videoId)
    .replace('{{VISIBILITY}}', open ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' : 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN')
    .replace('{{SEGMENTS_1}}', open ? SEGMENTS.slice(0, 3).map(segmentHtml).join('') : '')
    .replace('{{SEGMENTS_2}}', open ? SEGMENTS.slice(3).map(segmentHtml).join('') : '');
}
