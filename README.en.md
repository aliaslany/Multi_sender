# Hydra Sender

[نسخهٔ فارسی (پیش‌فرض) →](README.md)

A scheduled crawler-and-notifier **template**: point it at a *source* (a site/API to poll for new listings) and it delivers each new item — with rich details and auto-generated hashtags — to any number of *senders* (Telegram, Bale, Rubika, Eitaa, or a new one you add).

Ships with a working [Divar](https://divar.ir) (Iran's largest classifieds app) source out of the box, but the source and messenger layers are decoupled behind small interfaces, so this repo is meant to be forked and pointed at a different listing source without touching the delivery logic.

> The Divar source is a heavily modified fork of [debMan/divar-telegram-bot](https://github.com/debMan/divar-telegram-bot) (originally [ehcaning/divar-telegram-bot](https://github.com/ehcaning/divar-telegram-bot)). Divar changed its unofficial API since the original project was written, so the crawling logic here is substantially different.

## Features

- **Runs on GitHub Actions** — no server to host or pay for. A scheduled workflow runs the bot every few minutes.
- **Source/sender decoupled** — `main.py` only talks to a `Source` interface and a list of `Sender`s; neither knows the other exists (see [Architecture](#architecture)).
- **Multi-city search** *(Divar source)* — search across several cities at once (`SEARCH_CITY_IDS`).
- **Rich item details** *(Divar source)* — pulls structured fields Divar shows on the item page (area, room count, capacity, nightly rates, amenities, etc.), not just title/price/description.
- **Auto-generated hashtags** *(Divar source)* — combines keyword-based tags detected in the item text with Divar's own breadcrumb category chain.
- **Channel-ready formatting** — sends photos/albums with an HTML-formatted caption and a fixed contact/footer block, no direct outbound link.
- **Multi-messenger delivery** — Telegram gets rich photo/album delivery; Bale, Rubika, and Eitaa get text + first-image delivery. Per-platform delivery is tracked independently, so a failure on one platform doesn't block or duplicate on the others.

## Architecture

```
main.py                 # entry point - wires one Source to N Senders, then runs one pass
core/
  models.py              # Item - the generic shape every source produces and every sender consumes
  orchestrator.py         # the polling loop itself: fetch new ids -> fetch each item -> deliver -> save state
sources/
  base.py                 # Source interface: fetch_new_ids(state), fetch_item(id), target_senders
  registry.py              # SOURCE_TYPE env var -> Source instance
  divar/                   # the built-in Divar source (structured listings -> templated message)
    client.py                # DivarSource - maps Divar's API response onto Item
    _raw_client.py           # low-level Divar API calls + parsing
    hashtags.py              # Divar-specific hashtag generation
  telegram_relay/          # Telegram itself as the source (see "Telegram-relay source" below)
    client.py                # TelegramRelaySource - listens via getUpdates, relays to Rubika/Eitaa only
    quotes.py                 # (moved) see sources/common/quotes.py
  website/                 # a GitHub Pages form as the source (see "Website source" below)
    client.py                # WebsiteSource - reads submissions/ committed by the Pages form
  common/                  # helpers shared by relay-style sources (telegram_relay, website)
    quotes.py                 # random Persian nature quote fetcher
    channel_links.py          # "follow us elsewhere" footer link builder
senders/
  base.py                  # Sender interface: enabled(), send(item)
  registry.py                # lists all built-in senders, filters to configured ones
  formatting.py               # Item -> message text, shared across senders
  telegram.py                  # via python-telegram-bot
  rubika.py                     # via the rubka library (one-shot async calls, no polling loop)
  bale.py, eitaa.py              # raw HTTP - no maintained one-shot library fit these; see note below
  http_helpers.py             # shared HTTP plumbing for the Bot-API-style senders
  text_utils.py                # message-length chunking helpers
storage.py               # tokens.json state (per-sender delivery tracking), source-agnostic
config.py                # env vars and constants
requirements.txt
.github/workflows/run-bot.yml
```

**Adding a new listing source** (e.g. another classifieds site, an RSS feed, a Twitter search): create `sources/<name>/client.py` exporting a `SOURCE` instance whose class implements `fetch_new_ids(state)` and `fetch_item(id) -> Item | None`. Register it in `sources/registry.py`, then set `SOURCE_TYPE=<name>`. Nothing else in the repo needs to change — every sender already speaks `Item`. If your source needs to remember a cursor between runs (like `telegram_relay`'s update offset), read/write `state["source_state"][self.name]` inside `fetch_new_ids` — it's persisted to `tokens.json` automatically.

**Two kinds of Item content:** Divar's items are structured listing data (price, features, etc.) that senders template into a message. Not every source is like that — `telegram_relay` relays an already-written Telegram post as-is. Set `Item.raw_text` and senders will send that text verbatim instead of building the Divar-style template around it.

**Restricting delivery per source:** set a `Source.target_senders` list (e.g. `["rubika", "eitaa"]`) if a source's items shouldn't go to every configured sender — `telegram_relay` uses this since the post already exists on Telegram itself. Leave it `None` (the default) to deliver to every configured sender, like Divar does.

**Adding a new sender** (e.g. Discord, WhatsApp, a webhook): create `senders/<name>.py` with a class implementing `enabled()` and `async send(item) -> bool`. Register an instance in `senders/registry.py`. It'll be picked up automatically once its config env vars are set.

**Why Bale and Eitaa use raw HTTP instead of a library:** `python-bale-bot` exists, but its `Bot.connect()` starts an infinite long-polling loop before its HTTP session is usable - it's built for a bot that stays running, not a one-shot cron job, so pulling it in here would mean depending on undocumented private internals. No maintained Eitaa library exists at all. Rubika's `rubka` library, by contrast, makes plain one-shot async calls with no polling step, so it's a clean fit and is used in `rubika.py`.

## Telegram-relay source

`SOURCE_TYPE=telegram_relay` turns the idea around: instead of crawling a listings site, your own Telegram bot *is* the source. Send it a post — a photo or video with a caption, either as a DM to the bot or as a channel post in a channel where the bot is an admin — and it gets mirrored to Rubika and Eitaa. Telegram itself is skipped as a delivery target since the post is already there.

**Setup:**
1. Use the same bot from [step 1](#1-create-your-bot) (or a separate one) - it needs `BOT_TOKEN` set either way.
2. To relay channel posts: add the bot as an **admin** of the channel (Channel → Administrators → Add Admin). It doesn't need special permissions beyond reading messages.
3. Get the numeric chat ID(s) you want to accept posts from:
   - Your own user id, for DMing the bot directly — message [`@userinfobot`](https://t.me/userinfobot).
   - A channel's numeric id (looks like `-1001234567890`) — forward a message from the channel to [`@userinfobot`](https://t.me/userinfobot), or check the bot's `getUpdates` response after posting once.
4. Set `TELEGRAM_RELAY_CHAT_IDS` to a comma-separated list of those ids (e.g. `123456789,-1001234567890`). **This is required** — without it the source processes nothing, so a stray DM from someone else can't get relayed to your channels.
5. Set `SOURCE_TYPE=telegram_relay` as a repository secret.

**Nature quote + channel-links footer:** every relayed post gets a random Persian nature-themed quote appended (fetched at run time from the `tabiat.json` theme file of [aliaslany/persian-quotes](https://github.com/aliaslany/persian-quotes), no bundling needed), plus a "follow us elsewhere" footer linking back to the same content's Telegram/Bale/Rubika channels. Each sender renders the footer links in whatever markup that platform actually supports — real clickable links on Rubika (via HTML→Rubika-metadata conversion), plain `label: url` text on Eitaa (no rich-link support there). Configure via `CHANNEL_LINK_LABEL`, `TELEGRAM_CHANNEL_URL`, `BALE_CHANNEL_URL`, `RUBIKA_CHANNEL_URL`, and `NATURE_QUOTES_URL` (see the secrets table below) — leave any `*_CHANNEL_URL` empty to drop that platform from the footer.

**Known limitation:** Telegram sends each photo of a multi-photo album as a separate update. This source currently treats every message as its own post, so an album becomes several separate posts on Rubika/Eitaa rather than one grouped album. Fine for single photo/video posts; grouping by `media_group_id` would be the natural next step if you post albums often.

## Website source

`SOURCE_TYPE=website` uses the GitHub Pages form under `docs/` as the source instead of Telegram. Open the page, write a caption, attach a photo or video, and submit — the form commits both files directly into this repo's `submissions/` folder using your own GitHub token (entered in the browser, never stored anywhere but there, optionally remembered in that browser's `localStorage` if you check the box). Since GitHub Actions always checks out the full repo before running, the next scheduled run just reads those files off disk like any other file on disk — no polling API needed on the bot's side.

Unlike `telegram_relay`, this content doesn't exist anywhere yet, so `target_senders` is `None` — it's delivered to every sender you've configured (Telegram, Bale, Rubika, Eitaa). It gets the same nature-quote + channel-links footer treatment as `telegram_relay` (see above), since both share the same `sources/common/` helpers.

**Setup:**
1. Enable GitHub Pages: **Settings → Pages → Source** → "Deploy from a branch" → branch `main`, folder `/docs`. Wait a minute for the first deploy, then your form is live at `https://<username>.github.io/<repo>/`.
2. Set `SOURCE_TYPE=website` as a repository secret.
3. When you use the form, generate a fine-grained personal access token scoped to just this repo with **Contents: Read and write** permission (`https://github.com/settings/tokens?type=beta`) and paste it into the form's token field. It's used only for the two API calls that commit your submission — nothing is sent anywhere else.

**Cleanup tradeoff worth knowing:** processed submission files are deleted right after being read, before delivery is confirmed to have succeeded on every platform. If a send fails partway through, the content is gone rather than retried automatically — acceptable here since, unlike a Divar listing, you can just resubmit through the form. The workflow's state-commit step pushes these deletions back to the repo alongside `tokens.json`.

## How it works

Because free hosting doesn't give you a place to run a long-lived process, the bot doesn't run continuously. Instead, a **GitHub Actions workflow runs it on a schedule** (e.g. every 10 minutes). Each run:

1. Fetches new items from the configured source (Divar listings, or Telegram messages for `telegram_relay`).
2. Delivers each new item to every sender that source allows (see `Source.target_senders`).
3. Commits the updated state (`tokens.json`) back to the repo, so the next run picks up where this one left off.

## Setup

### 1. Create your bot

Open `@BotFather` in Telegram, create a bot, and note its token.

### 2. Get your chat/channel ID

- **Private chat:** message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and read the `chat.id` field.
- **Public channel:** you can just use its `@username` directly as the chat ID.
- **Private channel/group:** add the bot as an **admin** with "Post Messages" permission, send a message in it, then check `getUpdates` the same way — the ID will be a large negative number.

### 3. Find your city ID(s) and category slug

Go to [divar.ir](https://divar.ir), pick your city and category, and open the browser's Network tab (DevTools) while browsing search results. Look for the `city_ids` and `category` values in the request sent to `api.divar.ir/v8/postlist/w/search`. Alternatively, the URL shown when browsing `divar.ir/s/...` often reflects the category slug (e.g. `real-estate`, `villa`, `temporary-rent`).

### 4. Fork this repo, then add repository secrets

Go to **Settings → Secrets and variables → Actions** in your fork and add:

| Secret | Required | Example | Notes |
|---|---|---|---|
| `BOT_TOKEN` | optional | `123456:ABC-DEF...` | Telegram bot token from BotFather |
| `BOT_CHATID` | optional | `-1001234567890` or `@mychannel` | Telegram destination chat/channel |
| `BALE_BOT_TOKEN` | optional | | Bale bot token |
| `BALE_CHATID` | optional | | Bale destination chat/channel |
| `RUBIKA_BOT_TOKEN` | optional | | Rubika bot token |
| `RUBIKA_CHATID` | optional | | Rubika destination chat/channel |
| `EITAA_TOKEN` | optional | | EitaaYar API token |
| `EITAA_CHATID` | optional | | Eitaa destination chat/channel |
| `SOURCE_TYPE` | optional | `divar` | Which source to poll (see `sources/registry.py`); defaults to `divar` |
| `TELEGRAM_RELAY_CHAT_IDS` | required for `telegram_relay` | `123456789,-1001234567890` | Comma-separated chat ids allowed to post through the relay (see [Telegram-relay source](#telegram-relay-source)) |
| `CHANNEL_LINK_LABEL` | optional | `طبیعت+` | Clickable label used for every "follow us elsewhere" footer link |
| `TELEGRAM_CHANNEL_URL` | optional | `https://t.me/nature_plus` | Footer link to your Telegram channel; empty to omit |
| `BALE_CHANNEL_URL` | optional | `https://ble.ir/natureplus` | Footer link to your Bale channel; empty to omit |
| `RUBIKA_CHANNEL_URL` | optional | `https://rubika.ir/natureplus1` | Footer link to your Rubika channel; empty to omit |
| `NATURE_QUOTES_URL` | optional | jsDelivr URL to `tabiat.json` | Override to point at a different quotes dataset/theme |
| `GITHUB_REPO` | auto-set in Actions | `aliaslany/Multi_sender` | Used by the `website` source to build raw file URLs; set manually only for local dev outside Actions |
| `SEARCH_CITY_IDS` | ✅ | `823,1996,1999` | Comma-separated numeric city IDs (Divar source only) |
| `SEARCH_CATEGORY` | ✅ | `real-estate` | Divar category slug |
| `PROXY_URL` | optional | | Only needed if your runner can't reach Divar/Telegram directly |

Configure at least one token/chat-ID pair. Telegram keeps its rich photo or album
delivery. Bale sends the first listing image followed by the formatted ad text; Rubika
and Eitaa receive the formatted ad as text. The non-Telegram clients use compatible
Bot API endpoints and can be pointed at alternative gateways with the optional
`BALE_API_BASE_URL`, `RUBIKA_API_BASE_URL`, or `EITAA_API_BASE_URL` environment
variables.

`tokens.json` now records delivery per platform. If one platform fails, the next run
retries only that platform, avoiding duplicate posts on the platforms that succeeded.

### 5. Enable Actions write permissions

**Settings → Actions → General → Workflow permissions** → select **"Read and write permissions"** (needed so the workflow can commit `tokens.json` back to the repo).

### 6. Run it

Go to the **Actions** tab → select the workflow → **Run workflow**. On success it'll run automatically on the schedule defined in `.github/workflows/run-bots.yml`.

## Local development

```bash
git clone https://github.com/<your-username>/hydra-sender.git
cd hydra-sender
pip install -r requirements.txt
export BOT_TOKEN=...
export BOT_CHATID=...
export SEARCH_CITY_IDS=823,1996
export SEARCH_CATEGORY=real-estate
echo '{}' > tokens.json
python main.py
```

## Known limitations

- This uses Divar's **unofficial** web API (the same one divar.ir itself calls), reverse-engineered from browser traffic. It can break again if Divar changes headers, endpoints, or response shapes.
- Hashtag detection is keyword/substring-based, so unusual phrasing in an ad's text may be missed.
- `telegram_relay` treats every Telegram message as its own post, so a multi-photo album becomes several separate posts on the destination platforms rather than one grouped album.
- `website` deletes a submission's files as soon as they're read, before delivery is confirmed on every platform — a failed send loses the content rather than retrying it automatically.

## License

See the original upstream project — no separate license has been added in this fork.
