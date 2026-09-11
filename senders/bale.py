"""Bale sender - mirrors Telegram's Bot API."""
import asyncio

import config
from core.models import Item
from senders.base import Sender
from senders.formatting import build_message_text, build_short_caption
from senders.http_helpers import post_json, send_http_message
from senders.text_utils import TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT


class BaleSender(Sender):
    name = "bale"

    def enabled(self) -> bool:
        return bool(config.BALE_BOT_TOKEN and config.BALE_CHATID)

    def _send_sync(self, item: Item) -> bool:
        chat_id = item.destination_overrides.get(self.name, config.BALE_CHATID)
        if not chat_id:
            print("Bale: no destination chat id.")
            return False

        html_text = build_message_text(item, escape=True)
        base_url = config.BALE_API_BASE_URL.rstrip("/")
        send_message_url = "{}/bot{}/sendMessage".format(base_url, config.BALE_BOT_TOKEN)

        fits_as_caption = len(html_text) <= TELEGRAM_CAPTION_LIMIT
        caption = html_text if fits_as_caption else build_short_caption(item, escape=True)
        photos = [m.url for m in item.media if m.type == "photo"]

        if photos:
            send_photo_url = "{}/bot{}/sendPhoto".format(base_url, config.BALE_BOT_TOKEN)
            photo_sent, _ = post_json(
                "Bale photo",
                send_photo_url,
                {
                    "chat_id": chat_id,
                    "photo": photos[0],
                    "caption": caption,
                    "parse_mode": "HTML",
                },
            )
            if not photo_sent:
                return False
            if fits_as_caption:
                print("Sent item to Bale.")
                return True

        return send_http_message("Bale", send_message_url, chat_id, html_text, TELEGRAM_MESSAGE_LIMIT)

    async def send(self, item: Item) -> bool:
        try:
            return await asyncio.to_thread(self._send_sync, item)
        except Exception as error:
            print("Failed to send to bale: {}".format(error))
            return False
