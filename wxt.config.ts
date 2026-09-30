import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// KEEPSAKE_E2E=1 builds a test-only variant: Playwright cannot click the toolbar
// button, so activeTab is never granted there and the test build gets host access instead.
const e2e = process.env.KEEPSAKE_E2E === '1';
// Public key only, so the e2e build has a fixed extension id (hllnpofcacphnggifnlhkikkedipacjk).
const E2E_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6LHWyeeGJ2U10/pJ6k5fhVz/uIs8U2WbmnpKo6+rerF3CDBo8/IscjGUWG9dIZmtR7kX7OpdQ03AR50FrEgd4H3aIQQ8w/JFvHwxv53F9WFftjfh/xbGn8M3jzBUbWTP3Yjh8tW6L5j2iW8W3RFIBeAnJfCroCWkX1I9BE/qpLXP2IYUcRlsJ1MPPtjnIn9dEag70AZe/vNL6iDHijVfp9srqCQ3pUMtz99eLu0+ErP5hWLNxUT2AT8ovEngc/6hFb3irjYkEquOD9hYa7CBKQEHihl9yLyZ0GtL/7s+KoM+oLOpBvLb/ufuGD2N3zboiewIInnXS6sG+B1UjkOEXwIDAQAB';

export default defineConfig({
  outDir: e2e ? '.output-e2e' : '.output',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Keepsake for Karakeep',
    description:
      'Save pages to Karakeep, edit tags, lists and notes, read the scraped copy, and capture page Markdown or an already-open YouTube transcript.',
    permissions: ['activeTab', 'scripting', 'storage'],
    // Only the Karakeep origin the user configures is requested at runtime.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(e2e ? { host_permissions: ['<all_urls>'], key: E2E_KEY } : {}),
    action: { default_title: 'Keepsake' },
    browser_specific_settings: { gecko: { id: 'keepsake@matcer.github.io' } },
  },
});
