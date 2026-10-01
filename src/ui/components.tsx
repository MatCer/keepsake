import { useEffect, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import type { Settings } from '../lib/types';

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary:
    'border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
  danger: 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950',
};

export function Button({
  variant = 'secondary',
  busy,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  );
}

type Tone = 'success' | 'warning' | 'error' | 'info';

const tones: Record<Tone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
  info: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
};

export function Banner({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-0.5 text-[12px] opacity-90">{children}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block font-medium">{label}</span>
        {description && <span className="block text-[12px] text-zinc-500">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-zinc-300 transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-accent checked:before:translate-x-4 dark:bg-zinc-700"
      />
    </label>
  );
}

export const inputClass =
  'h-8 w-full rounded-lg border border-zinc-200 bg-white px-2.5 placeholder:text-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block font-medium">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Logo({ className = 'size-5' }: { className?: string }) {
  return <img src="/icon/32.png" alt="" className={className} />;
}

/** Floating panel under a trigger: overlays the content below instead of pushing it down. */
export const popoverClass =
  'absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5 dark:border-zinc-800 dark:bg-zinc-900 dark:ring-white/5';

/** Calls onClose on a pointer press outside `ref` or on Escape, while `open`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const press = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', press);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('keydown', key);
    };
  }, [ref, open, onClose]);
}
