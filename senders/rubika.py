"""Rubika sender, built on the `rubka` library (github.com/Mahdy-Ahmadi/rubka).

Unlike python-bale-bot, rubka's Robot makes plain one-shot async API calls -
no polling loop has to be started first - so it's a clean fit for a cron-run
sender. It also absorbs the upload dance (requestSendFile -> upload ->
sendFile) that we used to hand-roll against the raw API.
"""
from rubka import Robot

import config
from core.models import Item
from senders.base import Sender
from senders.formatting import build_message_text, build_short_caption
from senders.text_utils import DEFAULT_MESSAGE_LIMIT, split_text_into_chunks


class RubikaSender(Sender):
    name = "rubika"

    def enabled(self) -> bool:
        return bool(config.RUBIKA_BOT_TOKEN and config.RUBIKA_CHATID)

    async def send(self, item: Item) -> bool:
        bot = Robot(token=config.RUBIKA_BOT_TOKEN, raise_errors=False, parse_mode=None)
        plain_text = build_message_text(item, escape=False)
        fits_as_caption = len(plain_text) <= DEFAULT_MESSAGE_LIMIT

        try:
            if item.images:
                caption = plain_text if fits_as_caption else build_short_caption(item, escape=False)
                result = await bot.send_image(config.RUBIKA_CHATID, path=item.images[0], text=caption)
                if not result:
                    print("Rubika: image send failed, falling back to text-only.")
                    fits_as_caption = False
                elif fits_as_caption:
                    print("Sent item to Rubika.")
                    return True

            ok = True
            for chunk in split_text_into_chunks(plain_text, DEFAULT_MESSAGE_LIMIT):
                result = await bot.send_message(config.RUBIKA_CHATID, chunk)
                ok = ok and bool(result)
            if ok:
                print("Sent item to Rubika.")
            return ok
        except Exception as error:
            print("Failed to send to rubika: {}".format(error))
            return False
        finally:
            await bot.close()
