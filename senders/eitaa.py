"""Eitaa sender, via the EitaaYar API. Like Rubika, sendFile wants the
actual file bytes in the request body, not a URL, so we download from the
source and re-upload."""
import asyncio

import requests

import config
from core.models import Item
from senders.base import Sender
from senders.formatting import build_message_text, build_short_caption
from senders.http_helpers import download_image_bytes, send_http_message
from senders.text_utils import DEFAULT_MESSAGE_LIMIT


class EitaaSender(Sender):
    name = "eitaa"

    def enabled(self) -> bool:
        return bool(config.EITAA_TOKEN and config.EITAA_CHATID)

    def _send_sync(self, item: Item) -> bool:
        plain_text = build_message_text(item, escape=False)
        base_url = config.EITAA_API_BASE_URL.rstrip("/")
        send_message_url = "{}/{}/sendMessage".format(base_url, config.EITAA_TOKEN)

        fits_as_caption = len(plain_text) <= DEFAULT_MESSAGE_LIMIT
        image_bytes = download_image_bytes(item.images[0]) if item.images else None

        if image_bytes:
            send_file_url = "{}/{}/sendFile".format(base_url, config.EITAA_TOKEN)
            caption = plain_text if fits_as_caption else build_short_caption(item, escape=False)
            try:
                response = requests.post(
                    send_file_url,
                    data={"chat_id": config.EITAA_CHATID, "caption": caption},
                    files={"file": ("item.jpg", image_bytes)},
                    timeout=config.MESSENGER_REQUEST_TIMEOUT,
                )
                response.raise_for_status()
                sent = response.json().get("ok", True)
            except (requests.RequestException, ValueError) as error:
                print("Eitaa: file send failed: {}".format(error))
                sent = False

            if sent:
                if fits_as_caption:
                    print("Sent item to Eitaa.")
                    return True
                return send_http_message("Eitaa", send_message_url, config.EITAA_CHATID, plain_text)
            print("Eitaa: falling back to text-only (image send failed).")

        return send_http_message("Eitaa", send_message_url, config.EITAA_CHATID, plain_text)

    async def send(self, item: Item) -> bool:
        try:
            return await asyncio.to_thread(self._send_sync, item)
        except Exception as error:
            print("Failed to send to eitaa: {}".format(error))
            return False
