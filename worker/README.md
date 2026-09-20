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

1. **`docs/config.js`** — set `API_BASE` to this URL (every page reads it
   from there).
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
thing they need to enter besides their own channel's chat id. Most people
won't need one from you: the wizard issues trial codes itself (see below).
There's no way to look up or list existing codes yet; keep a note of what
you create if that matters to you.

## Self-serve trials, referrals, and the tracked attribution link

Nobody has to create a code by hand any more. Step 3 of the wizard calls
`POST /trial`, which issues a `TRY-XXXXXX` code on the spot: `TRIAL_DAYS`
days and `TRIAL_MAX_POSTS` posts (default 3 / 5), one per Telegram handle or
phone number (Persian digits and `+98`/`0098` spellings are normalised), at
most `TRIAL_MAX_PER_IP_PER_DAY` per IP. A lost code is **not** re-issued — the
handle isn't verified, so handing the code back would give it to whoever typed
someone else's name; they're pointed at support instead. `POST /promo` still
works for codes you give out yourself (add `"max_posts": N` to cap one).

Every post delivered through a code ends with a link
`<worker>/r/<ref>?v=<n>`. `<ref>` is the customer's *public* referral id (never
the promo code itself — that would let anyone post as them) and `<n>` is which
of the wordings in `sources/website/client.py` was used. The Worker counts the
click and redirects to the site with `?ref=&v=`; the wizard remembers both for
30 days and sends them with `/trial`. A referral only pays out when the friend
sends their **first real post** (not at signup), so minting throwaway trials
earns nothing: the referrer gets `REFERRAL_BONUS_DAYS` days and
`REFERRAL_BONUS_POSTS` posts, at most `REFERRAL_MAX_REWARDS` times.

See which wording earns signups, and who is actually referring people:

```bash
curl https://<your-worker-url>/admin/stats -H "Authorization: Bearer <your ADMIN_TOKEN>"
# variants.<n> = { clicks, signups, activations, click_to_signup_pct, signup_to_activation_pct }
# top_referrers = [{ ref, contact, signups, activations }]  <- who to thank / reward
```

Variant `inv` is the invite link the wizard shows after a post. If you edit a
wording, give it a **new** id, otherwise old and new copy get averaged.

## Selling packs

The paid model is pay-per-pack credits (see `PLANS` in `src/index.js`), not a
subscription: a pack is a code with a post allowance and a year of validity
from its first use. **Nothing is for sale online until you opt in**, so
`pricing.html` shows "تماس با پشتیبانی" by default.

- **Sales you close through support:** `POST /admin/issue-pack` with
  `{"plan_id": "pack50", "contact": "@buyer"}` returns a `PK-XXXXXXXX` code to
  send them.
- **Online payments (Zarinpal)** turn on automatically once a pack has a price
  *and* a merchant id is set.

Going live with online payments:

1. Get a Zarinpal merchant id and `wrangler secret put ZARINPAL_MERCHANT_ID`.
2. Rehearse with fake money first: set the var `ZARINPAL_SANDBOX = "true"`
   (with a sandbox merchant id), buy a pack on `pricing.html`, and check that
   `pay-result.html` shows a working code.
3. **Check the endpoints against Zarinpal's current docs.** The flow was
   built and tested against a mock of their v4 API (request → StartPay →
   verify, amounts converted from toman to rials), *not* against the real
   gateway. If their base URL differs, set `ZARINPAL_BASE`.
4. Publish prices in `wrangler.toml`, then `wrangler deploy`:
   ```toml
   [vars]
   PLAN_PRICES_TOMAN = '{"pack50": <toman>, "pack200": <toman>}'
   ```
5. Remove `ZARINPAL_SANDBOX`.

The order stores the amount at checkout and verifies against *that*, and a
reloaded callback can't mint a second code.

## Tuning (all optional plain `[vars]`, defaults in `DEFAULTS`)

| Var | Default | Effect |
|---|---|---|
| `TRIAL_DAYS` / `TRIAL_MAX_POSTS` | 3 / 5 | What a self-serve trial grants |
| `TRIAL_MAX_PER_IP_PER_DAY` | 5 | Generous on purpose: mobile carriers put many people behind one IP |
| `REFERRAL_BONUS_DAYS` / `_POSTS` / `REFERRAL_MAX_REWARDS` | 2 / 2 / 10 | Referral payout and per-referrer cap |
| `CLICK_SAMPLE_RATE` | 1 | Below 1, only that fraction of clicks is recorded (weighted `1/rate`, so totals stay unbiased) |
| `PLAN_PRICES_TOMAN` | unset | JSON `{plan_id: toman}`; unset = contact support |
| `ZARINPAL_SANDBOX` / `ZARINPAL_BASE` | unset | Test mode / endpoint override |

`/plans` serves the live trial and referral numbers, and the pages swap them
into their copy at load. The static fallback text (what crawlers see) shows the
defaults, so if you retune the vars, update `guide.html` / `faq.html` /
`pricing.html` too.

**Mind the KV free tier.** It caps *writes per day* (about 1,000 when this was
written — check Cloudflare's current limits), and a submission, a trial, and
every counted click each spend some. If the attribution link spreads, click
counting can eat the budget that real submissions need: lower
`CLICK_SAMPLE_RATE`, or move to the Workers Paid plan. Stats are best-effort
(a failed counter never breaks a redirect), but the shared budget is not.

## Tests

```bash
cd worker && node --test    # Node 20+, no dependencies, in-memory KV, mocked gateway
```

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
