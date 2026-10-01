import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Bookmark, KarakeepClient, List, Tag } from '../../lib/karakeep';
import { Banner, Button, inputClass, popoverClass, useDismiss } from '../components';
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
      <ListPicker client={client} bookmark={bookmark} />
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  useEffect(() => {
    client.allTags().then(setAll, () => setAll([]));
  }, [client]);

  const own = new Set(bookmark.tags.map((t) => t.name.toLowerCase()));
  const query = value.trim();
  const q = query.toLowerCase();
  const matches = all
    .filter((t) => !own.has(t.name.toLowerCase()) && t.name.toLowerCase().includes(q))
    // Prefix matches first, then alphabetical.
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((t) => t.name);
  const exists = all.some((t) => t.name.toLowerCase() === q) || own.has(q);
  const options = query && !exists ? [...matches, query] : matches;
  const showMenu = open && options.length > 0;

  const add = (name: string) => {
    setValue('');
    setActive(0);
    void act(() => client.attachTags(bookmark.id, [name]))();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (options.length ? (i + step + options.length) % options.length : 0));
    } else if (e.key === 'Enter' || (e.key === 'Tab' && query)) {
      // Enter/Tab take the highlighted suggestion; a comma always takes the typed text as is.
      const pick = showMenu ? options[active] : query;
      if (!pick) return;
      e.preventDefault();
      add(pick);
    } else if (e.key === ',') {
      e.preventDefault();
      if (query) add(query);
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !value && bookmark.tags.length) {
      const last = bookmark.tags.at(-1)!;
      void act(() => client.detachTags(bookmark.id, [last.id]))();
    }
  };

  return (
    <div ref={box} className="relative">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-zinc-200 bg-white px-1 py-0.5 focus-within:border-accent dark:border-zinc-800 dark:bg-zinc-900">
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
          role="combobox"
          aria-label="Add tag"
          aria-expanded={showMenu}
          aria-controls="keepsake-tag-options"
          aria-activedescendant={showMenu ? `keepsake-tag-${active}` : undefined}
          aria-autocomplete="list"
          placeholder="Add tag…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className="h-6 min-w-24 flex-1 bg-transparent px-1.5 text-[12px] placeholder:text-zinc-400 focus:outline-none"
        />
      </div>
      {showMenu && (
        <ul id="keepsake-tag-options" role="listbox" aria-label="Tag suggestions" className={`${popoverClass} max-h-56 overflow-y-auto p-1`}>
          {options.map((name, i) => {
            const create = i === matches.length;
            return (
              <li
                key={create ? '\0create' : name}
                id={`keepsake-tag-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: keep focus in the input so typing can continue.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(name);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] ${
                  i === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                }`}
              >
                {create ? (
                  <>
                    <span className="text-zinc-500">Create</span>
                    <span className="truncate rounded bg-accent-soft px-1.5 text-accent dark:text-violet-200">{name}</span>
                  </>
                ) : (
                  <span className="truncate">
                    <Highlight text={name} query={q} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-accent dark:text-violet-300">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function ListPicker({ client, bookmark }: { client: KarakeepClient; bookmark: Bookmark }) {
  const bookmarkId = bookmark.id;
  const [lists, setLists] = useState<List[] | null>(null);
  const [member, setMember] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  useEffect(() => {
    Promise.all([client.lists(), client.bookmarkLists(bookmarkId)]).then(
      ([all, mine]) => {
        setLists(all.filter((l) => l.type !== 'smart'));
        setMember(new Set(mine.map((l) => l.id)));
      },
      () => setError(true),
    );
  }, [client, bookmarkId, bookmark]);
  if (error) return <p className="text-[12px] text-red-600">Could not load lists.</p>;
  if (!lists?.length) return null;

  const toggle = async (id: string, on: boolean) => {
    const next = new Set(member);
    if (on) next.add(id);
    else next.delete(id);
    setMember(next);
    setSaveError(false);
    try {
      await (on ? client.addToList(id, bookmarkId) : client.removeFromList(id, bookmarkId));
    } catch {
      setMember(member);
      setSaveError(true);
    }
  };
  const chosen = lists.filter((l) => member.has(l.id));
  const f = filter.trim().toLowerCase();
  const shown = lists.filter((l) => l.name.toLowerCase().includes(f));

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${inputClass} flex items-center justify-between gap-2 text-left text-[12px]`}
      >
        <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
          {chosen.length ? (
            chosen.map((l) => (
              <span key={l.id} className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                {l.icon} {l.name}
              </span>
            ))
          ) : (
            <span className="text-zinc-500">Add to list…</span>
          )}
        </span>
        <span aria-hidden className={`text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Lists" className={popoverClass}>
          {lists.length > 6 && (
            <input
              autoFocus
              aria-label="Filter lists"
              placeholder="Filter lists…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-full border-b border-zinc-200 bg-transparent px-2.5 text-[12px] placeholder:text-zinc-400 focus:outline-none dark:border-zinc-800"
            />
          )}
          <ul className="max-h-56 overflow-y-auto p-1">
            {shown.map((l) => (
              <li key={l.id}>
                <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <input
                    type="checkbox"
                    checked={member.has(l.id)}
                    onChange={(e) => toggle(l.id, e.target.checked)}
                    className="accent-accent"
                  />
                  <span aria-hidden>{l.icon}</span>
                  <span className="truncate">{l.name}</span>
                </label>
              </li>
            ))}
            {!shown.length && <li className="px-2 py-1.5 text-[12px] text-zinc-500">No list matches.</li>}
          </ul>
          {saveError && <p role="alert" className="border-t border-zinc-200 px-2.5 py-1.5 text-[12px] text-red-600 dark:border-zinc-800">Could not update the list. Try again.</p>}
        </div>
      )}
    </div>
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
