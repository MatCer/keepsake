# Why Keepsake exists

I save almost everything I want to read or watch into Karakeep. Karakeep is the inbox. A
Hermes agent works through it on a schedule. It sorts each bookmark into lists, tags it,
fixes bad titles, writes the useful ones into my Obsidian vault and posts a short digest.
If I add a note line starting with `summary:`, it summarizes the bookmark for me.

That only works if Hermes has something to read. For a lot of what I save, it didn't.

## What went wrong without it

**YouTube transcripts.** A lot of what I save is video. Karakeep's crawler gets the YouTube
page, which is player chrome and recommendations, not what the video says. Fetching
transcripts from the server works for a while, then YouTube starts refusing the requests,
and after a refusal the server has to back off for a day. Meanwhile the transcript is already on my
screen in the browser tab I saved it from. Reading it from the page costs YouTube nothing
extra, because Keepsake makes no YouTube requests of its own.

**Scraped pages.** The crawler's HTML is fine for a preview, but it is noisy input for
classification. Defuddle (the engine behind Obsidian Web Clipper) already turns the open
page into clean Markdown, so Keepsake attaches that to the bookmark as well.

**Waiting.** Triage ran every 10 minutes, and classification happened inside that run. A
bookmark sat unsorted until the next tick. Now Keepsake asks Jev for the lists and topic
tag the moment I save, so the bookmark is filed before I close the tab. Hermes still does
the rest of the triage on its schedule, and it skips the Jev call for anything already
tagged `jev-tagged`.

## Why not the official Karakeep extension

The official extension saves the link and leaves the content to Karakeep's server-side
crawler. That is the part that fails for YouTube and is weakest for classification. I
needed the browser to hand over what it already has: the rendered transcript, the cleaned
page text, and a classification at save time. Adding that to the official extension would
mean carrying a fork of a project with different goals, so Keepsake is a separate extension
that talks to the same Karakeep API.

What I kept from the official one is the sign-in. Email and password are exchanged for an
API key the same way, so nothing changes on the Karakeep side.

## Design rules that follow from this

- Karakeep is the only store. Transcripts and page Markdown are bookmark attachments, so
  Hermes, the Karakeep UI and anything else read them from one place.
- Keepsake never contacts YouTube. If the transcript panel is closed, it clicks YouTube's
  own button, exactly what I would do by hand.
- Jev is optional and has no default provider. Without a key, endpoint and model, nothing
  leaves the browser except the requests to my own Karakeep.
