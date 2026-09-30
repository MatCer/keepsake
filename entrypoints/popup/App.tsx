import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { attachTranscript, bookmarkUrl, findBookmark } from '../../src/lib/attach';
import { KarakeepClient, originPattern, type Bookmark } from '../../src/lib/karakeep';
import { addToOutbox, listOutbox, removeFromOutbox, type OutboxItem } from '../../src/lib/outbox';
import { loadSettings } from '../../src/lib/settings';
import type { Settings } from '../../src/lib/types';
import { applyTheme, Banner, Button, Logo, Spinner } from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { BookmarkCard } from '../../src/ui/popup/BookmarkPanel';
import { CapturePanel } from '../../src/ui/popup/CapturePanel';
import { ScrapedPanel } from '../../src/ui/popup/ScrapedPanel';

type Tab = { id: number; url: string; title: string };
type BookmarkState =
  | { phase: 'loading' }
  | { phase: 'unsaved' }
  | { phase: 'saved'; bookmark: Bookmark; created: boolean }
  | { phase: 'deleted' }
  | { phase: 'error'; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    loadSettings().then((s) => {
      applyTheme(s.theme);
      setSettings(s);
    });
    // ?tabId= lets the e2e suite open the popup as a page aimed at another tab.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    (forced ? browser.tabs.get(forced) : browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => t)).then(
      (t) => {
        if (t?.id !== undefined) setTab({ id: t.id, url: t.url ?? '', title: t.title ?? '' });
      },
    );
  }, []);

  const configured = !!settings?.address && !!settings.apiKey;
  useEffect(() => {
    if (!configured || !settings) return;
    browser.permissions.contains({ origins: [originPattern(settings.address)] }).then(setGranted);
  }, [configured, settings]);

  const client = useMemo(
    () => (configured && granted && settings ? new KarakeepClient(settings.address, settings.apiKey) : null),
    [configured, granted, settings],
  );

  if (!settings || !tab) {
    return (
      <Shell>
        <p className="flex items-center gap-2 py-8 text-zinc-500">
          <Spinner /> Loading…
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      {!configured ? (
        <Banner tone="info" title="Connect your Karakeep">
          <p>Add your server address and sign in to save pages. Capturing Markdown and transcripts works without it.</p>
          <Button variant="primary" className="mt-2" onClick={() => browser.runtime.openOptionsPage()}>
            Open settings
          </Button>
        </Banner>
      ) : granted === false ? (
        <Banner tone="warning" title="Allow access to your Karakeep server">
          <p>Keepsake needs permission to talk to {settings.address}.</p>
          <Button
            variant="primary"
            className="mt-2"
            onClick={async () => setGranted(await browser.permissions.request({ origins: [originPattern(settings.address)] }))}
          >
            Allow
          </Button>
        </Banner>
      ) : null}
      <Main tab={tab} settings={settings} client={client} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[400px]">
      <header className="flex h-11 items-center justify-between border-b border-zinc-200 px-3 dark:border-zinc-800">
        <span className="flex items-center gap-2 font-semibold">
          <Logo /> Keepsake
        </span>
        <Button variant="ghost" className="!px-2" aria-label="Settings" onClick={() => browser.runtime.openOptionsPage()}>
          <Icon name="gear" />
        </Button>
      </header>
      <main className="max-h-[540px] space-y-4 overflow-y-auto p-3">{children}</main>
    </div>
  );
}

function Main({ tab, settings, client }: { tab: Tab; settings: Settings; client: KarakeepClient | null }) {
  const [state, setState] = useState<BookmarkState>({ phase: 'loading' });
  const [view, setView] = useState<'capture' | 'scraped'>('capture');
  const web = /^https?:/.test(tab.url);

  const open = useCallback(
    async (c: KarakeepClient, id: string, created: boolean) =>
      setState({ phase: 'saved', bookmark: await c.getBookmark(id, true), created }),
    [],
  );
  const save = useCallback(
    async (c: KarakeepClient) => {
      setState({ phase: 'loading' });
      try {
        const { bookmark, created } = await c.createLink(bookmarkUrl(tab.url));
        await open(c, bookmark.id, created);
      } catch (e) {
        setState({ phase: 'error', message: message(e) });
      }
    },
    [open, tab.url],
  );

  useEffect(() => {
    if (!client || !web) return;
    (async () => {
      try {
        const id = await findBookmark((u) => client.checkUrl(u), tab.url);
        if (id) await open(client, id, false);
        else if (settings.autoSave) await save(client);
        else setState({ phase: 'unsaved' });
      } catch (e) {
        setState({ phase: 'error', message: message(e) });
      }
    })();
  }, [client, web, tab.url, settings.autoSave, open, save]);

  const bookmark = state.phase === 'saved' ? state.bookmark : null;

  return (
    <>
      {client && web && (
        <>
          {state.phase === 'loading' && (
            <p className="flex items-center gap-2 text-zinc-500">
              <Spinner /> {settings.autoSave ? 'Saving to Karakeep…' : 'Checking Karakeep…'}
            </p>
          )}
          {state.phase === 'unsaved' && (
            <div className="space-y-2">
              <p className="line-clamp-2 font-medium">{tab.title || tab.url}</p>
              <Button variant="primary" className="w-full" onClick={() => save(client)}>
                Save to Karakeep
              </Button>
            </div>
          )}
          {state.phase === 'deleted' && <Banner tone="info" title="Bookmark deleted" />}
          {state.phase === 'error' && (
            <Banner tone="error" title="Karakeep is not reachable">
              {state.message}
            </Banner>
          )}
          {state.phase === 'saved' && (
            <BookmarkCard
              client={client}
              address={settings.address}
              bookmark={state.bookmark}
              created={state.created}
              onChange={(b) => setState({ ...state, bookmark: b })}
              onDeleted={() => setState({ phase: 'deleted' })}
            />
          )}
          <Outbox client={client} />
        </>
      )}

      <div>
        <div role="tablist" className="mb-3 flex gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
          {(['capture', 'scraped'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-7 flex-1 rounded-md text-[12px] font-medium transition-colors ${
                view === v ? 'bg-white shadow-sm dark:bg-zinc-800' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {v === 'capture' ? 'Capture' : 'Scraped by Karakeep'}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {view === 'capture' ? (
            <CapturePanel tabId={tab.id} tabUrl={tab.url} settings={settings} client={client} bookmark={bookmark} />
          ) : (
            <ScrapedPanel bookmark={bookmark} onRefresh={() => bookmark && client && open(client, bookmark.id, false)} />
          )}
        </div>
      </div>
    </>
  );
}

function Outbox({ client }: { client: KarakeepClient }) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    listOutbox().then(setItems);
  }, []);
  if (!items.length) return null;

  const retry = async () => {
    setBusy(true);
    for (const item of items) {
      try {
        const id = (await findBookmark((u) => client.checkUrl(u), item.bookmarkUrl)) ?? (await client.createLink(item.bookmarkUrl)).bookmark.id;
        const outcome = await attachTranscript(client, id, item.capture, {});
        if (outcome.kind === 'conflict') await addToOutbox({ ...item, lastError: 'A different transcript is attached; attach again from the video to choose' });
        else await removeFromOutbox(item.id);
      } catch (e) {
        await addToOutbox({ ...item, lastError: message(e) });
      }
    }
    setItems(await listOutbox());
    setBusy(false);
  };

  return (
    <Banner tone="warning" title={`${items.length} transcript upload${items.length > 1 ? 's' : ''} waiting`}>
      <p className="line-clamp-2">Last error: {items[0]?.lastError}</p>
      <div className="mt-2 flex gap-1.5">
        <Button busy={busy} onClick={retry}>
          <Icon name="refresh" /> Retry now
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            for (const i of items) await removeFromOutbox(i.id);
            setItems([]);
          }}
        >
          Discard
        </Button>
      </div>
    </Banner>
  );
}
