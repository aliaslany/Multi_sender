# Submission Worker

This is the small backend behind `docs/index.html`. It's the *only* place
that ever sees a promo code or a destination chat id — no bot tokens, no
GitHub credentials, nothing sensitive passes through it. See the comment
block at the top of `src/index.js` for the full endpoint list.

## One-time deploy

```bash
npm install -g wrangler
cd worker
wrangler login                      # opens a browser to authorize once
wrangler secret put API_TOKEN       # pick any long random string - the bot uses this
wrangler secret put ADMIN_TOKEN     # a different long random string - only you use this
wrangler deploy
```

`wrangler deploy` prints your Worker's URL, something like
`https://multi-sender-submissions.<your-subdomain>.workers.dev`. You need it
in two places:

1. **`docs/index.html`** — replace the `API_BASE` constant near the top of
   the `<script>` block with this URL.
2. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `WEBSITE_API_URL` = that same URL
   - `WEBSITE_API_TOKEN` = the same value you set for `API_TOKEN` above

The KV namespace (`multi_sender_submissions`, id in `wrangler.toml`) is
already created — `wrangler.toml` just needs to point at it, which it does.

## Creating a promo code

Each code has its own trial window, which starts counting from the first
time it's actually used (not when you create it):

```bash
curl -X POST https://<your-worker-url>/promo \
  -H "Authorization: Bearer <your ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"code": "SUMMER7", "trial_days": 7}'
```

Give `SUMMER7` (or whatever you name it) to a customer — that's the only
thing they need to enter besides their own channel's chat id. There's no
way to look up or list existing codes yet; keep a note of what you create
if that matters to you.

## Rubika auto-reply ("someone found the bot, now what?")

If someone finds your Rubika bot directly (search, a shared link, whatever)
and messages it or taps start, the bot used to say nothing at all — a real
dead end for a curious potential customer. This makes it reply instantly
with a link to the site and to support, via a webhook (Rubika supports
webhooks, not just polling, so this is instant - no cron delay).

Set these two additional secrets, then register the webhook once:

```bash
wrangler secret put RUBIKA_BOT_TOKEN        # same token as your RUBIKA_BOT_TOKEN repo secret
wrangler secret put RUBIKA_WEBHOOK_SECRET   # any long random string you make up - not shared anywhere
wrangler deploy

curl -X POST https://<your-worker-url>/admin/register-rubika-webhook \
  -H "Authorization: Bearer <your ADMIN_TOKEN>"
```

That last call tells Rubika's servers to POST here whenever your bot gets
a message or a "start" - it only needs to be run once (re-run it if you
ever change `RUBIKA_WEBHOOK_SECRET`). The reply text and links are in
`GREETING_TEXT` near the top of `src/index.js` - edit and redeploy to
change the wording.

**Why not the sender bot on Telegram too?** Telegram's Bot API only lets a
bot use either a webhook or polling, never both at once - and the sender
bot already polls via `telegram_relay`, so pointing a webhook at *that*
token would break it. A second bot has no such conflict, which is exactly
what the next section uses. Bale has no conflict either and could get the
same treatment later if it turns out to matter there.

## Telegram Business auto-responder (rule-based, no AI)

Telegram Premium's **Chat Automation** (Settings → Telegram Business → Chat
Automation) lets you attach a bot to your personal account. It then sees
your DMs and can answer **as you**. This Worker answers the questions
customers keep repeating - trial codes, price, how to post, which
messengers - and says nothing to anything else, so you still answer the
real questions yourself and the bot can never invent a term you didn't
offer.

It is deliberately keyword-based, not AI: no API key, no cost, and no
chance of it making up a price.

Use a **separate bot** from the one in `BOT_TOKEN` (the sender bot polls
`getUpdates`; a webhook on the same token returns `409 Conflict`). Then:

```bash
wrangler secret put SUPPORT_BOT_TOKEN        # the support bot's token from @BotFather
wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any long random string you make up
wrangler deploy

curl -X POST https://<your-worker-url>/admin/register-telegram-webhook \
  -H "Authorization: Bearer <your ADMIN_TOKEN>"
```

Then attach that bot under Chat Automation and leave its **reply
permission on** - without it Telegram sends the messages here but refuses
to let the bot answer.

Two things worth knowing:

- `business_message` updates are **never delivered unless asked for by
  name**, which is what the `allowed_updates` in
  `handleRegisterTelegramWebhook` does. A plain `setWebhook` gets you
  nothing.
- The messages *you* send in those chats arrive as `business_message` too.
  They're dropped by comparing the sender against the connection's
  `owner_id`, otherwise the bot would answer you.

To change what it says, edit `AUTO_REPLY_RULES` (and `BUSINESS_GREETING`)
in `src/index.js` and redeploy. First matching rule wins, short keywords
match whole words and longer ones match substrings, and an unmatched
message gets the greeting once per chat per 30 days - then silence.

## Updating the Worker later

Edit `src/index.js`, then just run `wrangler deploy` again from this
directory. Secrets you've already set persist across deploys.
