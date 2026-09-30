import { useEffect, useState, type KeyboardEvent } from 'react';
import type { Bookmark, KarakeepClient, List, Tag } from '../../lib/karakeep';
import { Banner, Button, inputClass } from '../components';
import { Icon } from '../icons';

export function BookmarkCard({
  client,
  address,
  bookmark,
  tabTitle,
  created,
  onChange,
  onDeleted,
}: {
  client: KarakeepClient;
  address: string;
  bookmark: Bookmark;
  tabTitle: string;
  created: boolean;
  onChange: (b: Bookmark) => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = async () => onChange(await client.getBookmark(bookmark.id, true));
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  };
  const title = bookmark.title || bookmark.content.title || tabTitle || bookmark.content.url || 'Untitled';

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        {/* No remote favicon: for a YouTube bookmark that would be a request to YouTube. */}
        <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm bg-accent-soft text-[10px] font-semibold text-accent uppercase">
          {title.trim().charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={`${address}/dashboard/preview/${bookmark.id}`}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-2 font-medium hover:underline"
          >
            {title}
          </a>
          <p className="text-[12px] text-zinc-500">{created ? 'Saved to Karakeep' : 'Already in Karakeep'}</p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button
            variant="ghost"
            className="!px-2"
            aria-label={bookmark.favourited ? 'Remove from favourites' : 'Add to favourites'}
            aria-pressed={bookmark.favourited}
            onClick={act(() => client.setFlags(bookmark.id, { favourited: !bookmark.favourited }))}
          >
            <Icon name="star" fill={bookmark.favourited ? 'currentColor' : 'none'} className={`size-4 ${bookmark.favourited ? 'text-amber-500' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            className="!px-2"
            aria-label={bookmark.archived ? 'Unarchive' : 'Archive'}
            aria-pressed={bookmark.archived}
            onClick={act(() => client.setFlags(bookmark.id, { archived: !bookmark.archived }))}
          >
            <Icon name="archive" className={`size-4 ${bookmark.archived ? 'text-accent' : ''}`} />
          </Button>
          <Button
            variant={confirmDelete ? 'danger' : 'ghost'}
            className="!px-2"
            aria-label={confirmDelete ? 'Click again to delete' : 'Delete bookmark'}
            title={confirmDelete ? 'Click again to delete' : 'Delete bookmark'}
            onBlur={() => setConfirmDelete(false)}
            onClick={async () => {
              if (!confirmDelete) return setConfirmDelete(true);
              try {
                await client.deleteBookmark(bookmark.id);
                onDeleted();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Delete failed');
              }
            }}
          >
            <Icon name="trash" />
            {confirmDelete && <span className="text-[12px]">Delete?</span>}
          </Button>
        </div>
      </div>
      <TagEditor client={client} bookmark={bookmark} act={act} />
      <ListPicker client={client} bookmarkId={bookmark.id} />
      <NoteEditor client={client} bookmark={bookmark} onSaved={refresh} />
      {error && <Banner tone="error" title="Karakeep request failed">{error}</Banner>}
    </section>
  );
}

function TagEditor({
  client,
  bookmark,
  act,
}: {
  client: KarakeepClient;
  bookmark: Bookmark;
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const [all, setAll] = useState<Tag[]>([]);
  const [value, setValue] = useState('');
  useEffect(() => {
    client.allTags().then(setAll, () => setAll([]));
  }, [client]);
  const add = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    setValue('');
    void act(() => client.attachTags(bookmark.id, [name]))();
  };
  const own = new Set(bookmark.tags.map((t) => t.name));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bookmark.tags.map((t) => (
        <span
          key={t.id}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft pr-1 pl-2 text-[12px] text-accent dark:text-violet-200"
        >
          {t.name}
          <button
            type="button"
            aria-label={`Remove tag ${t.name}`}
            className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
            onClick={act(() => client.detachTags(bookmark.id, [t.id]))}
          >
            <Icon name="x" className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        placeholder="Add tag…"
        list="keepsake-tags"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={add}
        className="h-6 min-w-24 flex-1 bg-transparent text-[12px] placeholder:text-zinc-400 focus:outline-none"
      />
      <datalist id="keepsake-tags">
        {all.filter((t) => !own.has(t.name)).map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

function ListPicker({ client, bookmarkId }: { client: KarakeepClient; bookmarkId: string }) {
  const [lists, setLists] = useState<List[] | null>(null);
  const [member, setMember] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  useEffect(() => {
    Promise.all([client.lists(), client.bookmarkLists(bookmarkId)]).then(
      ([all, mine]) => {
        setLists(all.filter((l) => l.type !== 'smart'));
        setMember(new Set(mine.map((l) => l.id)));
      },
      () => setError(true),
    );
  }, [client, bookmarkId]);
  if (error) return <p className="text-[12px] text-red-600">Could not load lists.</p>;
  if (!lists?.length) return null;

  const toggle = async (id: string, on: boolean) => {
    const next = new Set(member);
    if (on) next.add(id);
    else next.delete(id);
    setMember(next);
    try {
      await (on ? client.addToList(id, bookmarkId) : client.removeFromList(id, bookmarkId));
    } catch {
      setMember(member);
      setError(true);
    }
  };
  const names = lists.filter((l) => member.has(l.id)).map((l) => `${l.icon} ${l.name}`);

  return (
    <details className="group rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="flex h-8 cursor-pointer list-none items-center justify-between px-2.5 text-[12px]">
        <span className="truncate">{names.length ? names.join(', ') : <span className="text-zinc-500">Add to list…</span>}</span>
        <span className="text-zinc-400 group-open:rotate-180">▾</span>
      </summary>
      <ul className="max-h-40 overflow-y-auto border-t border-zinc-200 p-1 dark:border-zinc-800">
        {lists.map((l) => (
          <li key={l.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <input
                type="checkbox"
                checked={member.has(l.id)}
                onChange={(e) => toggle(l.id, e.target.checked)}
                className="accent-accent"
              />
              <span>{l.icon}</span>
              <span className="truncate">{l.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}

function NoteEditor({ client, bookmark, onSaved }: { client: KarakeepClient; bookmark: Bookmark; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(bookmark.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => setNote(bookmark.note ?? ''), [bookmark.note]);
  const dirty = note !== (bookmark.note ?? '');

  return (
    <div className="space-y-1.5">
      <textarea
        aria-label="Note"
        placeholder="Note…"
        rows={2}
        value={note}
        readOnly={busy}
        onChange={(e) => setNote(e.target.value)}
        className={`${inputClass} h-auto resize-y py-1.5`}
      />
      {(dirty || error) && (
        <div className="flex items-center justify-end gap-2">
          {error && <span className="text-[12px] text-red-600">Not saved</span>}
          <Button variant="ghost" onClick={() => setNote(bookmark.note ?? '')}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(false);
              try {
                await client.updateNote(bookmark.id, note);
                await onSaved();
              } catch {
                setError(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save note
          </Button>
        </div>
      )}
    </div>
  );
}
