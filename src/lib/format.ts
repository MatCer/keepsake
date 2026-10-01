import { type Capture, type PageCapture, type YoutubeCapture } from './types';
import { canonicalVideoUrl, formatTimestamp } from './youtube';
import { isYoutubeCapture } from './capture-validation';

export function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '));
}
export function escapeMarkdownInline(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]#|~!]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}
function descriptionMarkdown(value: string): string {
  return value.split(/\r\n?|\n/).map(line => escapeMarkdownInline(line).replace(/^(\s*)([-+=])/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2')).join('\n');
}
function summary(description: string | null, title: string): string {
  const value = description?.trim().replace(/\s+/g, ' ') || title;
  return (value.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? value).slice(0, 200);
}
function transcriptLines(capture: YoutubeCapture, chapter: (title: string) => string, segment: (start: number, text: string) => string): string[] {
  const chapters = [...(capture.transcript.chapters ?? [])].sort((a, b) => a.start - b.start);
  const lines: string[] = []; let index = 0;
  for (const item of capture.transcript.segments) {
    let next = chapters[index];
    while (next && next.start <= item.start) { lines.push(chapter(next.title)); next = chapters[++index]; }
    lines.push(segment(item.start, item.text));
  }
  return lines;
}
export function toMarkdown(capture: Capture, _now?: Date): string {
  const youtube = capture.kind === 'youtube-transcript';
  const author = youtube ? capture.video.channel : capture.page.author;
  const published = youtube ? capture.video.publishedAt : capture.page.published;
  const description = youtube ? capture.video.description : capture.page.description;
  const source = youtube ? canonicalVideoUrl(capture.video.id) : capture.url;
  const fields = ['---', `title: ${yamlString(capture.title)}`, `source: ${yamlString(source)}`];
  if (author !== null) fields.push('author:', `  - ${yamlString(`[[${author.replace(/\[\[|\]\]/g, '')}]]`)}`);
  if (published !== null) fields.push(`published: ${yamlString(published.slice(0, 10))}`);
  fields.push(`created: ${yamlString(capture.capturedAt.slice(0, 10))}`, `description: ${yamlString(summary(description, capture.title))}`, 'tags:', '  - "clippings"');
  if (youtube) fields.push('  - "youtube"', `videoId: ${yamlString(capture.video.id)}`, `transcriptLanguage: ${yamlString(capture.transcript.language ?? 'und')}`, 'transcriptStatus: "browser-captured"');
  fields.push('provenance: "browser-dom"', '---');
  if (!youtube) return `${fields.join('\n')}\n\n${capture.page.markdown}\n`;
  const body = [`![](${source})`];
  if (description) body.push(descriptionMarkdown(description));
  body.push('## Transcript', ...transcriptLines(capture, title => `### ${escapeMarkdownInline(title)}`, (start, text) => `**${formatTimestamp(start)}** · ${escapeMarkdownInline(text)}`));
  return `${fields.join('\n')}\n${body.join('\n\n')}\n`;
}
export function toJson(capture: Capture): string { return JSON.stringify(capture, null, 2) + '\n'; }
export function assetFileName(capture: YoutubeCapture): string {
  const language = capture.transcript.language?.replace(/[^A-Za-z0-9-]/g, '') || 'und';
  return `keepsake-transcript-${capture.video.id}-${language}-${capture.transcript.sha256.slice(0, 12)}.html`;
}
export function parseAssetFileName(name: string): { videoId: string; language: string; hash12: string } | null {
  const match = /^keepsake-transcript-([A-Za-z0-9_-]{11})-([A-Za-z0-9-]+)-([a-f0-9]{12})\.html$/.exec(name);
  return match?.[1] && match[2] && match[3] ? { videoId: match[1], language: match[2], hash12: match[3] } : null;
}
function html(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function pageAssetFileName(capture: PageCapture): string {
  return `keepsake-page-${capture.page.sha256.slice(0, 12)}.html`;
}
export function toPageAssetHtml(capture: PageCapture): string {
  const record = JSON.stringify(capture).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="keepsake-schema" content="keepsake.capture/v1"><title>Page: ${html(capture.title)}</title></head><body><pre>${html(toMarkdown(capture))}</pre><script type="application/json" id="keepsake-capture">${record}</script></body></html>`;
}
export function toTranscriptAssetHtml(capture: YoutubeCapture): string {
  const source = html(canonicalVideoUrl(capture.video.id));
  const record = JSON.stringify(capture).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const lines = transcriptLines(capture, title => `<h2>${html(title)}</h2>`, (start, text) => `<p><a href="${source}&amp;t=${start}s">${formatTimestamp(start)}</a> ${html(text)}</p>`);
  return `<!doctype html><html lang="${html(capture.transcript.language ?? 'und')}"><head><meta charset="utf-8"><meta name="keepsake-schema" content="keepsake.capture/v1"><title>Transcript: ${html(capture.title)}</title></head><body><h1>${html(capture.title)}</h1><p>Source: <a href="${source}">${source}</a> · captured ${html(capture.capturedAt)} from the open YouTube page (browser-dom)</p>${lines.join('')}<script type="application/json" id="keepsake-capture">${record}</script></body></html>`;
}
export function parseTranscriptAssetHtml(value: string): YoutubeCapture | null {
  try {
    const doc = new DOMParser().parseFromString(value, 'text/html');
    const scripts = doc.querySelectorAll('script#keepsake-capture[type="application/json"]');
    const script = scripts[0];
    if (scripts.length !== 1 || !script) return null;
    const capture: unknown = JSON.parse(script.textContent ?? '');
    return isYoutubeCapture(capture) ? capture : null;
  } catch { return null; }
}
export function noteFileName(capture: Capture): string {
  let title = capture.title.replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
  return `${title.trim() || 'Untitled'}.md`;
}
export function obsidianUri(vault: string, folder: string, fileName: string): string {
  const path = [folder.replace(/^\/+|\/+$/g, ''), fileName.replace(/\.md$/, '')].filter(Boolean).join('/');
  return `obsidian://new?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}&clipboard`;
}
