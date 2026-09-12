# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-messenger broadcast tool: build one piece of content (text + photo/video) and deliver it to any number of channels across Telegram, Bale, Rubika, and Eitaa (or a messenger you add). Where that content comes from is optional and swappable — a manual submission form (`docs/index.html`), a Telegram relay, or a crawler *source* polling a listing site. Ships with a working Divar (Iranian classifieds site) source out of the box, but that's just one option, not the core of the project — the source and sender layers are fully decoupled behind two small interfaces.

It's designed to run as a one-shot process triggered by a GitHub Actions cron schedule (`.github/workflows/run-bots.yml`, every 10 min), not as a long-lived service, since free hosting gives no place to run one. State (which items were delivered to which platform) persists in `tokens.json`, which the workflow commits back to the repo after each run.

The repo has no test suite and no lint config.

## Commands

```bash
pip install -r requirements.txt
cp .env.example .env        # fill in real tokens/ids, then: export $(grep -v '^#' .env | xargs)
echo '{}' > tokens.json
python main.py               # runs one polling pass and exits
```

Or via Docker: `docker compose up --build` (reads `.env`; see [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml)).

There's no watch/daemon mode — `python main.py` always does exactly one fetch-and-deliver pass, matching how the GitHub Actions workflow invokes it.

Required env vars differ by `SOURCE_TYPE` (default `divar`, which needs `SEARCH_CITY_IDS` and `SEARCH_CATEGORY`); see [config.py](config.py) for the full list and defaults, and [README.en.md](README.en.md)'s secrets table for what each one does. A given run only polls **one** `SOURCE_TYPE` — running Divar crawling and the website-submission wizard at the same time needs two separate scheduled workflows, not one.

## Architecture

```
main.py                    # entry point - wires one Source to N Senders, runs one pass
core/
  models.py                  # Item - generic shape every source produces, every sender consumes
  orchestrator.py            # the loop: fetch new ids -> fetch each item -> deliver -> save state
sources/
  base.py                    # Source interface: fetch_new_ids(state), fetch_item(id), target_senders
  registry.py                 # SOURCE_TYPE env var -> Source instance
  divar/                      # structured Divar listings -> Item (one optional source, not the core)
  telegram_relay/             # Telegram itself as the source (see below)
  website/                    # a Cloudflare Worker-backed submission wizard as the source (see below)
  common/                     # helpers shared by telegram_relay & website (quotes, cross-promo footer links)
senders/
  base.py                     # Sender interface: enabled(), async send(item) -> bool
  registry.py                  # lists all built-in senders, filters to ones with config present
  formatting.py                  # Item -> message text, shared across senders
  telegram.py, rubika.py, bale.py, eitaa.py
storage.py                  # tokens.json read/write - per-sender delivery tracking, source-agnostic
config.py                   # all env vars and defaults, in one place
worker/                     # Cloudflare Worker backing the website source (separate JS deploy, see worker/README.md)
docs/                        # GitHub Pages submission wizard (frontend for the website source)
```

**Extension points, both zero-touch elsewhere in the repo:**
- New source: create `sources/<name>/client.py` exporting `SOURCE = MyClass()` implementing `fetch_new_ids(state)` and `fetch_item(id) -> Item | None`; register in `sources/registry.py`; set `SOURCE_TYPE=<name>`. If it needs a cursor between runs, read/write `state["source_state"][self.name]` inside `fetch_new_ids` — auto-persisted to `tokens.json`.
- New sender: create `senders/<name>.py` implementing `enabled()` and `async send(item) -> bool`; register an instance in `senders/registry.py`. Picked up automatically once its env vars are set.

**Key mechanics:**
- `Item.raw_text` (set by `telegram_relay` and `website`) makes senders send that text verbatim instead of building the Divar-style structured template from title/price/features.
- `Source.target_senders` (a list, or `None` for "every configured sender") restricts which senders a *source's* items go to at all — e.g. `telegram_relay` targets only `["rubika", "eitaa"]` since the post already exists on Telegram.
- `Item.destination_overrides` (a dict keyed by sender name) restricts delivery *per item* to specific sender names, using a chat id the item carries instead of that sender's static config default. This is how `website` sends a customer's post only to the platforms they filled in.
- **A sender is only enabled at all if both its bot token AND its own default chat id are set** (`senders/registry.py`'s `enabled_senders()` calls each sender's `enabled()`, which checks both — see e.g. `TelegramSender.enabled()` in [senders/telegram.py](senders/telegram.py)). This holds even when every actual delivery for a run uses `destination_overrides` — the static `*_CHATID` secret still gates whether that platform runs at all.
- `tokens.json` tracks delivery **per platform**, not just per item — a failure on one sender is retried on the next run without re-sending to senders that already succeeded (`storage.py`, `core/orchestrator.py`).
- Bale and Eitaa senders use raw HTTP instead of a library: `python-bale-bot`'s `Bot.connect()` runs an infinite polling loop before its HTTP session is usable (wrong fit for a one-shot cron run), and no maintained Eitaa library exists. Rubika's `rubka` library is used because it supports one-shot async calls with no polling step.

**⚠️ README vs. code drift on the `website` source:** [README.md](README.md)/[README.en.md](README.en.md)'s architecture section text still describes it as reading files committed directly to a `submissions/` folder by the GitHub Pages form. The actual implementation ([sources/website/client.py](sources/website/client.py)) instead polls a Cloudflare Worker's private API (`worker/`, deployed separately via `wrangler`) that holds submissions in KV storage, including promo-code trial gating — see [worker/README.md](worker/README.md) and the endpoint list at the top of [worker/src/index.js](worker/src/index.js). Trust the code over that section of the README.

## Known limitations (from README)

- Divar source uses Divar's **unofficial** web API, reverse-engineered from browser traffic — can break if Divar changes it.
- Hashtag detection is keyword/substring-based.
- `telegram_relay` treats every Telegram message as its own post — a multi-photo album becomes several separate posts on destination platforms rather than one grouped album.
