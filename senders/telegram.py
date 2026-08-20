"""Telegram sender - rich photo/album delivery via python-telegram-bot."""
import telegram

import config
from core.models import Item
from senders.base import Sender
from senders.formatting import build_message_text, build_short_caption
from senders.text_utils import TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT, split_text_into_chunks

_bot = None
if config.BOT_TOKEN:
    _req_proxy = telegram.request.HTTPXRequest(
        proxy_url=config.PROXY_URL,
        connect_timeout=30,
        read_timeout=30,
        write_timeout=30,
        pool_timeout=30,
    )
    _bot = telegram.Bot(token=config.BOT_TOKEN, request=_req_proxy)


class TelegramSender(Sender):
    name = "telegram"

    def enabled(self) -> bool:
        return bool(config.BOT_TOKEN and config.BOT_CHATID)

    async def _send_text_chunks(self, text: str):
        for chunk in split_text_into_chunks(text, TELEGRAM_MESSAGE_LIMIT):
            await _bot.send_message(text=chunk, chat_id=config.BOT_CHATID, parse_mode="HTML")

    async def send(self, item: Item) -> bool:
        if _bot is None or not config.BOT_CHATID:
            print("Telegram is not configured.")
            return False

        text = build_message_text(item, escape=True)
        fits_as_caption = len(text) <= TELEGRAM_CAPTION_LIMIT
        photos = [m.url for m in item.media if m.type == "photo"]

        try:
            if photos:
                caption = text if fits_as_caption else build_short_caption(item, escape=True)

                if len(photos) == 1:
                    await _bot.send_photo(
                        caption=caption,
                        photo=photos[0],
                        chat_id=config.BOT_CHATID,
                        parse_mode="HTML",
                    )
                else:
                    media_list = [telegram.InputMediaPhoto(img) for img in photos[:10]]
                    try:
                        await _bot.send_media_group(
                            caption=caption,
                            media=media_list,
                            chat_id=config.BOT_CHATID,
                            parse_mode="HTML",
                        )
                    except telegram.error.BadRequest as e:
                        print("Error sending photos:", e)
                        fits_as_caption = False

                if not fits_as_caption:
                    await self._send_text_chunks(text)
            else:
                await self._send_text_chunks(text)
            print("Sent item to Telegram.")
            return True
        except Exception as error:
            print("Failed to send to telegram: {}".format(error))
            return False
