import { useEffect, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { exchangeApiKey, KarakeepClient, normalizeAddress, originPattern } from '../../src/lib/karakeep';
import { loadSettings, saveSettings } from '../../src/lib/settings';
import type { Settings } from '../../src/lib/types';
import { applyTheme, Banner, Button, Field, inputClass, Logo, Toggle } from '../../src/ui/components';

type Me = { name: string | null; email: string | null };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    loadSettings().then((s) => {
      applyTheme(s.theme);
      setSettings(s);
      if (s.address && s.apiKey) new KarakeepClient(s.address, s.apiKey).me().then(setMe, () => setMe(null));
    });
  }, []);

  if (!settings) return null;
  const update = async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    if (patch.theme) applyTheme(next.theme);
  };

  return (
    <div className="mx-auto max-w-md space-y-6 p-5">
      <header className="flex items-center gap-2 text-base font-semibold">
        <Logo className="size-6" /> Keepsake settings
      </header>

      <Section title="Karakeep">
        {settings.apiKey ? (
          <div className="space-y-3">
            <p>
              Server <span className="font-medium">{settings.address}</span>
            </p>
            <p>
              Logged in as{' '}
              <span className="font-medium">{me ? me.name || me.email : 'unknown (server not reachable)'}</span>
              {me?.name && me.email && <span className="text-zinc-500"> · {me.email}</span>}
            </p>
            <Button
              onClick={async () => {
                await update({ apiKey: '' });
                setMe(null);
              }}
            >
              Sign out
            </Button>
            <p className="text-[12px] text-zinc-500">Signing out forgets the key here. Revoke it under Settings → API Keys in Karakeep.</p>
          </div>
        ) : (
          <SignIn
            initialAddress={settings.address}
            onSignedIn={async (address, apiKey) => {
              await update({ address, apiKey });
              setMe(await new KarakeepClient(address, apiKey).me());
            }}
          />
        )}
      </Section>

      <Section title="Behaviour">
        <Toggle
          label="Auto-save on open"
          description="When disabled, you'll confirm before saving bookmarks."
          checked={settings.autoSave}
          onChange={(autoSave) => update({ autoSave })}
        />
        <Field label="Tag transcripts" hint="Added to the bookmark when a transcript is attached. Leave empty for none.">
          <input
            className={inputClass}
            placeholder="e.g. transcript"
            defaultValue={settings.transcriptTag}
            onBlur={(e) => update({ transcriptTag: e.target.value.trim() })}
          />
        </Field>
      </Section>

      <Section title="Theme">
        <div role="radiogroup" aria-label="Theme" className="flex gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={settings.theme === t}
              onClick={() => update({ theme: t })}
              className={`h-7 flex-1 rounded-md text-[12px] font-medium capitalize ${
                settings.theme === t ? 'bg-white shadow-sm dark:bg-zinc-800' : 'text-zinc-500'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Obsidian">
        <Field label="Vault name" hint="Shows an Obsidian button that creates the note from the clipboard, like Obsidian Web Clipper. Empty hides it.">
          <input
            className={inputClass}
            placeholder="ObsidianBrain"
            defaultValue={settings.obsidianVault}
            onBlur={(e) => update({ obsidianVault: e.target.value.trim() })}
          />
        </Field>
        <Field label="Folder">
          <input
            className={inputClass}
            defaultValue={settings.obsidianFolder}
            onBlur={(e) => update({ obsidianFolder: e.target.value.trim() })}
          />
        </Field>
      </Section>

      <p className="text-[12px] leading-relaxed text-zinc-500">
        Keepsake reads pages only when you open it. On YouTube it reads the transcript already shown on the page and never
        requests captions itself. The only server it talks to is your Karakeep.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function SignIn({ initialAddress, onSignedIn }: { initialAddress: string; onSignedIn: (address: string, apiKey: string) => Promise<void> }) {
  const [mode, setMode] = useState<'password' | 'key'>('password');
  const [address, setAddress] = useState(initialAddress);
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let origin: string;
    try {
      origin = normalizeAddress(address);
    } catch (err) {
      return setError(err instanceof Error ? err.message : 'Invalid server address');
    }
    // Must run inside the click, before any other await, or the browser drops the prompt.
    if (!(await browser.permissions.request({ origins: [originPattern(origin)] }))) {
      return setError('Keepsake needs permission to reach this server.');
    }
    setBusy(true);
    try {
      const key = mode === 'password' ? await exchangeApiKey(origin, email, secret) : secret.trim();
      await new KarakeepClient(origin, key).me();
      await onSignedIn(origin, key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Server address">
        <input
          className={inputClass}
          type="url"
          required
          placeholder="https://karakeep.example.com"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </Field>
      <div role="tablist" className="flex gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
        {(['password', 'key'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`h-7 flex-1 rounded-md text-[12px] font-medium ${mode === m ? 'bg-white shadow-sm dark:bg-zinc-800' : 'text-zinc-500'}`}
          >
            {m === 'password' ? 'Email & password' : 'API key'}
          </button>
        ))}
      </div>
      {mode === 'password' && (
        <Field label="Email">
          <input className={inputClass} type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}
      <Field label={mode === 'password' ? 'Password' : 'API key'} hint={mode === 'key' ? 'Create one in Karakeep under Settings → API Keys.' : undefined}>
        <input
          className={inputClass}
          type="password"
          required
          autoComplete={mode === 'password' ? 'current-password' : 'off'}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      {error && <Banner tone="error" title="Could not sign in">{error}</Banner>}
      <Button type="submit" variant="primary" busy={busy} className="w-full">
        Sign in
      </Button>
      <p className="text-[12px] text-zinc-500">The key is stored only in this browser profile and is never synced or exported.</p>
    </form>
  );
}
