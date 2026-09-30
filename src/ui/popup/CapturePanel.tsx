import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { attachTranscript, type AttachOutcome } from '../../lib/attach';
import { noteFileName, obsidianUri, toJson, toMarkdown } from '../../lib/format';
import type { Bookmark, KarakeepClient } from '../../lib/karakeep';
import { addToOutbox } from '../../lib/outbox';
import type { CaptureResult, Settings, YoutubeCapture } from '../../lib/types';
import { formatTimestamp } from '../../lib/youtube';
import { Banner, Button, Spinner } from '../components';
import { Icon } from '../icons';
import { runCapture } from '../run-capture';

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function StatusBanner({ result }: { result: CaptureResult }) {
  switch (result.status) {
    case 'captured': {
      const c = result.capture;
      if (c.kind === 'page') return <Banner tone="success" title="Page captured">{c.page.markdown.length.toLocaleString()} characters of Markdown.</Banner>;
      const t = c.transcript;
      const last = t.segments.at(-1)?.start ?? 0;
      return (
        <Banner tone="success" title="Transcript captured">
          {t.segments.length.toLocaleString()} segments · {formatTimestamp(last)} · {t.languageLabel ?? t.language ?? 'language unknown'}
          {' · read from the open page, no requests made'}
        </Banner>
      );
    }
    case 'panel-not-loaded':
      return (
        <Banner tone="warning" title="Open the transcript first">
          Keepsake only reads a transcript YouTube already shows. Under the video, click <b>…more</b> then <b>Show transcript</b>, wait for the text to appear, then press Retry.
        </Banner>
      );
    case 'no-captions':
      return <Banner tone="info" title="No captions on this video">YouTube lists no caption tracks, so there is no transcript to capture.</Banner>;
    case 'stale':
      return <Banner tone="warning" title="The page is still switching videos">The transcript on screen belongs to another video. Wait a moment, reopen the transcript if needed, then Retry.</Banner>;
    case 'too-large':
      return <Banner tone="error" title="Too large to capture">{(result.bytes / 1e6).toFixed(1)} MB exceeds the capture limit.</Banner>;
    case 'unsupported':
      return <Banner tone="info" title="Nothing to capture here">{result.reason}.</Banner>;
  }
}

export function CapturePanel({
  tabId,
  tabUrl,
  settings,
  client,
  bookmark,
}: {
  tabId: number;
  tabUrl: string;
  settings: Settings;
  client: KarakeepClient | null;
  bookmark: Bookmark | null;
}) {
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [run, setRun] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setResult(null);
    runCapture(tabId, tabUrl).then(setResult);
  }, [tabId, tabUrl, run]);

  if (!result)
    return (
      <p className="flex items-center gap-2 py-6 text-zinc-500">
        <Spinner /> Reading the page…
      </p>
    );

  const capture = result.status === 'captured' ? result.capture : null;
  const markdown = capture ? toMarkdown(capture) : '';
  const copy = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-3">
      <StatusBanner result={result} />
      {capture ? (
        <>
          {capture.kind === 'youtube-transcript' && client && bookmark && (
            <AttachToKarakeep client={client} bookmark={bookmark} capture={capture} tag={settings.transcriptTag} />
          )}
          {capture.kind === 'youtube-transcript' && !bookmark && (
            <p className="text-[12px] text-zinc-500">Save the bookmark to attach this transcript to it.</p>
          )}
          <div className="grid grid-cols-4 gap-1.5">
            <Button onClick={copy}>
              <Icon name="copy" /> {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button onClick={() => download(noteFileName(capture), markdown, 'text/markdown')}>
              <Icon name="download" /> .md
            </Button>
            <Button onClick={() => download(noteFileName(capture).replace(/\.md$/, '.json'), toJson(capture), 'application/json')}>
              <Icon name="download" /> .json
            </Button>
            {settings.obsidianVault && (
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(markdown);
                  await browser.tabs.update(tabId, {
                    url: obsidianUri(settings.obsidianVault, settings.obsidianFolder, noteFileName(capture)),
                  });
                }}
              >
                <Icon name="note" /> Obsidian
              </Button>
            )}
          </div>
          <pre className="max-h-28 overflow-auto rounded-lg bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            {markdown.slice(0, 4000)}
          </pre>
        </>
      ) : (
        result.status !== 'unsupported' && (
          <Button onClick={() => setRun((n) => n + 1)}>
            <Icon name="refresh" /> Retry
          </Button>
        )
      )}
    </div>
  );
}

type AttachState = { phase: 'idle' | 'busy' } | { phase: 'done'; outcome: AttachOutcome } | { phase: 'failed'; message: string };

function AttachToKarakeep({
  client,
  bookmark,
  capture,
  tag,
}: {
  client: KarakeepClient;
  bookmark: Bookmark;
  capture: YoutubeCapture;
  tag: string;
}) {
  const [state, setState] = useState<AttachState>({ phase: 'idle' });
  const attach = async (replaceAssetId?: string) => {
    setState({ phase: 'busy' });
    try {
      setState({ phase: 'done', outcome: await attachTranscript(client, bookmark.id, capture, { replaceAssetId, tag }) });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      await addToOutbox({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        bookmarkUrl: capture.url,
        capture,
        lastError: message,
        attempts: 1,
      });
      setState({ phase: 'failed', message });
    }
  };

  if (state.phase === 'done') {
    const o = state.outcome;
    if (o.kind === 'conflict')
      return (
        <Banner tone="warning" title="A different transcript is already attached">
          <p>
            <code className="break-all">{o.existing.fileName}</code> is attached for this language. Replacing it discards that version on the bookmark.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button variant="primary" onClick={() => attach(o.existing.id)}>
              Replace
            </Button>
            <Button onClick={() => setState({ phase: 'idle' })}>Keep existing</Button>
          </div>
        </Banner>
      );
    const titles = { attached: 'Transcript attached to the bookmark', replaced: 'Transcript replaced', already: 'This exact transcript is already attached' } as const;
    return <Banner tone={o.kind === 'already' ? 'info' : 'success'} title={titles[o.kind]} />;
  }

  return (
    <div className="space-y-2">
      {state.phase === 'failed' && (
        <Banner tone="error" title="Karakeep did not accept the transcript">
          {state.message}. It is kept in the outbox, nothing was lost.
        </Banner>
      )}
      <Button variant="primary" busy={state.phase === 'busy'} onClick={() => attach()} className="w-full">
        <Icon name="paperclip" /> {state.phase === 'failed' ? 'Retry attach' : 'Attach transcript to Karakeep'}
      </Button>
    </div>
  );
}

