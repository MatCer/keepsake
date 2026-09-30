import { useState } from 'react';
import type { Bookmark } from '../../lib/karakeep';
import { Banner, Button } from '../components';
import { Icon } from '../icons';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Karakeep's scraped HTML is untrusted. It renders in a sandboxed iframe without
 * allow-scripts, with a CSP that blocks every remote load (images only on request,
 * since they would be fetched from the original site, e.g. YouTube).
 */
function srcdoc(html: string, baseUrl: string, dark: boolean, images: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images ? 'https: data:' : 'data:'}; style-src 'unsafe-inline'">
<base href="${escapeAttr(baseUrl)}" target="_blank">
<style>
  body{font:14px/1.6 ui-sans-serif,system-ui,sans-serif;margin:12px;color:${dark ? '#e4e4e7' : '#18181b'};background:${dark ? '#09090b' : '#fff'}}
  img,video{max-width:100%;height:auto}pre{overflow:auto;white-space:pre-wrap}a{color:#7c3aed}
  h1,h2,h3{line-height:1.25}table{border-collapse:collapse;max-width:100%}
</style></head><body>${html}</body></html>`;
}

export function ScrapedPanel({ bookmark, onRefresh }: { bookmark: Bookmark | null; onRefresh: () => void }) {
  const [images, setImages] = useState(false);
  if (!bookmark) return <Banner tone="info" title="Not in Karakeep yet">Save the page to see what Karakeep scraped.</Banner>;
  const { htmlContent, crawlStatus, url } = bookmark.content;
  const dark = document.documentElement.classList.contains('dark');

  if (!htmlContent)
    return (
      <div className="space-y-2">
        <Banner
          tone={crawlStatus === 'failure' ? 'error' : 'info'}
          title={crawlStatus === 'failure' ? 'Karakeep could not scrape this page' : 'Karakeep has not scraped this page yet'}
        >
          {crawlStatus === 'pending' || !crawlStatus ? 'Crawling usually takes a few seconds.' : `Crawl status: ${crawlStatus}.`}
        </Banner>
        <Button onClick={onRefresh}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
    );

  return (
    <div className="space-y-2">
      <iframe
        title="Scraped content stored in Karakeep"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcdoc(htmlContent, url ?? 'about:blank', dark, images)}
        className="h-[300px] w-full rounded-lg border border-zinc-200 dark:border-zinc-800"
      />
      {!images && (
        <Button variant="ghost" onClick={() => setImages(true)}>
          Load images from the original site
        </Button>
      )}
    </div>
  );
}
