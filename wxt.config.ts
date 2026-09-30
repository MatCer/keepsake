import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// KEEPSAKE_E2E=1 builds a test-only variant: Playwright cannot click the toolbar
// button, so activeTab is never granted there and the test build gets host access instead.
const e2e = process.env.KEEPSAKE_E2E === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Keepsake for Karakeep',
    description:
      'Save pages to Karakeep, edit tags, lists and notes, read the scraped copy, and capture page Markdown or an already-open YouTube transcript.',
    permissions: ['activeTab', 'scripting', 'storage'],
    // Only the Karakeep origin the user configures is requested at runtime.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(e2e ? { host_permissions: ['<all_urls>'] } : {}),
    action: { default_title: 'Keepsake' },
    browser_specific_settings: { gecko: { id: 'keepsake@matcer.github.io' } },
  },
});
