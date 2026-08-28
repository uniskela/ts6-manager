/** Hint shown in Music Bots → Commands when editing custom command responses. */
export const TS6_CHAT_FORMATTING_GUIDE =
  'TS6 renders Markdown in channel chat: **bold**, *italic*, lists, > quotes, `code`, tables, images, <details>/<summary> blocks, and legacy BBCode ([b], [color=#hex], [url]…). Pause/skip are text commands (!pause, !skip) — the client does not support clickable control buttons in bot messages.';

export const TS6_CHAT_RESPONSE_EXAMPLE = `## Welcome

Thanks for joining! Quick tips:

- **!np** — now playing (with controls hint)
- **!play** \`<url>\` — queue a track

<details>
<summary>More commands</summary>

Type **!help** for the full list.
</details>`;
