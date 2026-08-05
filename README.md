# Hydra Sender

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
  base.py                 # Source interface: fetch_new_ids(), fetch_item(id)
  registry.py              # SOURCE_TYPE env var -> Source instance
  divar/                   # the built-in Divar source
    client.py                # DivarSource - maps Divar's API response onto Item
    _raw_client.py           # low-level Divar API calls + parsing
    hashtags.py              # Divar-specific hashtag generation
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

**Adding a new listing source** (e.g. another classifieds site, an RSS feed, a Twitter search): create `sources/<name>/client.py` exporting a `SOURCE` instance whose class implements `fetch_new_ids()` and `fetch_item(id) -> Item | None`. Register it in `sources/registry.py`, then set `SOURCE_TYPE=<name>`. Nothing else in the repo needs to change — every sender already speaks `Item`.

**Adding a new sender** (e.g. Discord, WhatsApp, a webhook): create `senders/<name>.py` with a class implementing `enabled()` and `async send(item) -> bool`. Register an instance in `senders/registry.py`. It'll be picked up automatically once its config env vars are set.

**Why Bale and Eitaa use raw HTTP instead of a library:** `python-bale-bot` exists, but its `Bot.connect()` starts an infinite long-polling loop before its HTTP session is usable - it's built for a bot that stays running, not a one-shot cron job, so pulling it in here would mean depending on undocumented private internals. No maintained Eitaa library exists at all. Rubika's `rubka` library, by contrast, makes plain one-shot async calls with no polling step, so it's a clean fit and is used in `rubika.py`.

## How it works

Because free hosting doesn't give you a place to run a long-lived process, the bot doesn't run continuously. Instead, a **GitHub Actions workflow runs it on a schedule** (e.g. every 10 minutes). Each run:

1. Polls for any pending admin DM commands (if `ADMIN_USER_IDS` is set) and updates search filters accordingly.
2. Searches Divar for the configured cities/category, sorted by newest.
3. Sends every new ad to each configured messenger.
4. Optionally rechecks a batch of older ads to see if they look removed, and announces those.
5. Commits the updated state (`tokens.json`, and `filters.json`/`admin_state.json` if used) back to the repo, so the next run picks up where this one left off.

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
| `SEARCH_CITY_IDS` | ✅ | `823,1996,1999` | Comma-separated numeric city IDs (Divar source only) |
| `SEARCH_CATEGORY` | ✅ | `real-estate` | Divar category slug |
| `PROXY_URL` | optional | | Only needed if your runner can't reach Divar/Telegram directly |
| `ADMIN_USER_IDS` | optional | `111111,222222` | Telegram numeric user IDs allowed to change filters via DM (see below) |
| `STATUS_CHECK_LIMIT` | optional | `20` | Max old ads rechecked per run for the "likely removed" feature |

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

Go to the **Actions** tab → select the workflow → **Run workflow**. On success it'll run automatically on the schedule defined in `.github/workflows/run-bot.yml`.

## Admin filter commands

If `ADMIN_USER_IDS` is set, authorized users can DM the bot (private chat, not the channel):

```
/set_cities 823,1996,1999
/set_category real-estate
/show_filters
/help
```

Changes take effect starting the *next* scheduled run and only affect future searches — the bot never edits or deletes messages it already sent.

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
- The "likely sold/rented" detection is a **heuristic** (an ad becoming unreachable), not an explicit status field from Divar, since none is exposed on this endpoint. It can occasionally misfire; see `status_checker.py` for details and a debug flag to help refine it.
- Hashtag detection is keyword/substring-based, so unusual phrasing in an ad's text may be missed.

## License

See the original upstream project — no separate license has been added in this fork.
