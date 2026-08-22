"""Telegram-as-a-source: relays posts you send the bot (as a DM, or as a
channel post in a channel where the bot is admin) to other messengers.

Unlike Divar, this isn't "crawl a listings site" - it's "watch a Telegram
bot's inbox for new messages and mirror each one elsewhere". It reuses the
same polling model as every other source (fetch_new_ids/fetch_item, run on
a cron via GitHub Actions) by calling Telegram's getUpdates and persisting
an offset in state["source_state"]["telegram_relay"] between runs.

Each relayed post gets a random Persian nature quote (from
github.com/aliaslany/persian-quotes) and a "follow us elsewhere" links
footer appended - see quotes.py and config.CHANNEL_LINK_LABEL/*_CHANNEL_URL.

Known limitation: Telegram sends each photo of an album ("media group") as
a separate update. This implementation treats every message as its own
Item, so a multi-photo album currently becomes several separate posts on
the destination platforms rather than one album. Fine for single
photo/video posts (which is all this channel currently posts); grouping
by media_group_id would be the natural next step if that changes.
"""
import requests

import config
from core.models import ChannelLink, Item, Media
from sources.base import Source
from sources.telegram_relay.quotes import random_nature_quote

_API_BASE = "https://api.telegram.org/bot{token}"


def _channel_links() -> list[ChannelLink]:
    pairs = [
        (config.TELEGRAM_CHANNEL_URL, "telegram"),
        (config.BALE_CHANNEL_URL, "bale"),
        (config.RUBIKA_CHANNEL_URL, "rubika"),
    ]
    return [ChannelLink(label=config.CHANNEL_LINK_LABEL, url=url) for url, _name in pairs if url]


class TelegramRelaySource(Source):
    name = "telegram_relay"
    # The post already exists on Telegram - only mirror it elsewhere.
    target_senders = ["rubika", "eitaa"]

    def __init__(self):
        self._pending: dict[str, dict] = {}

    def fetch_new_ids(self, state: dict) -> list[str]:
        if not config.TELEGRAM_RELAY_CHAT_IDS:
            print(
                "telegram_relay: TELEGRAM_RELAY_CHAT_IDS is not set - "
                "refusing to process any updates. Set it to your user id "
                "and/or the channel's numeric id."
            )
            return []

        src_state = state.setdefault("source_state", {}).setdefault(self.name, {})
        offset = src_state.get("offset", 0)

        url = _API_BASE.format(token=config.BOT_TOKEN) + "/getUpdates"
        try:
            response = requests.get(
                url,
                params={
                    "offset": offset,
                    "timeout": 0,
                    "allowed_updates": '["message","channel_post"]',
                },
                timeout=config.MESSENGER_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as error:
            print("telegram_relay: failed to fetch updates: {}".format(error))
            return []

        if not data.get("ok"):
            print("telegram_relay: getUpdates returned an error: {}".format(data))
            return []

        item_ids = []
        max_update_id = offset - 1
        for update in data.get("result", []):
            max_update_id = max(max_update_id, update["update_id"])

            msg = update.get("channel_post") or update.get("message")
            if not msg:
                continue
            chat_id = msg["chat"]["id"]
            if chat_id not in config.TELEGRAM_RELAY_CHAT_IDS:
                continue
            if not (msg.get("photo") or msg.get("video") or msg.get("text") or msg.get("caption")):
                continue

            item_id = "{}:{}".format(chat_id, msg["message_id"])
            self._pending[item_id] = msg
            item_ids.append(item_id)

        # Persist past this batch so the next run doesn't refetch it,
        # regardless of whether every item above ends up delivered -
        # per-item/per-sender de-dup is handled separately by storage.py.
        src_state["offset"] = max_update_id + 1
        return item_ids

    def fetch_item(self, item_id: str) -> Item | None:
        msg = self._pending.get(item_id)
        if not msg:
            print("telegram_relay: no cached message for {}, skipping.".format(item_id))
            return None

        media = []
        if msg.get("photo"):
            # Telegram sends multiple resolutions; the last is the largest.
            file_id = msg["photo"][-1]["file_id"]
            url = self._resolve_file_url(file_id)
            if url:
                media.append(Media(type="photo", url=url))
        elif msg.get("video"):
            file_id = msg["video"]["file_id"]
            url = self._resolve_file_url(file_id)
            if url:
                media.append(Media(type="video", url=url))

        text = msg.get("caption") or msg.get("text") or ""

        quote = random_nature_quote()
        if quote:
            text = "{}\n\n{}".format(text, quote) if text else quote

        return Item(
            id=item_id,
            raw_text=text,
            media=media,
            channel_links=_channel_links(),
            source=self.name,
        )

    def _resolve_file_url(self, file_id: str) -> str | None:
        url = _API_BASE.format(token=config.BOT_TOKEN) + "/getFile"
        try:
            response = requests.get(
                url, params={"file_id": file_id}, timeout=config.MESSENGER_REQUEST_TIMEOUT
            )
            response.raise_for_status()
            file_path = response.json()["result"]["file_path"]
        except (requests.RequestException, KeyError, ValueError) as error:
            print("telegram_relay: could not resolve file {}: {}".format(file_id, error))
            return None
        return "https://api.telegram.org/file/bot{}/{}".format(config.BOT_TOKEN, file_path)


SOURCE = TelegramRelaySource()
