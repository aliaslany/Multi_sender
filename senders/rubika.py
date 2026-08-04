"""Rubika sender.

Rubika's Bot API can't attach a remote image URL directly - a file has to be
uploaded to Rubika's own storage first (requestSendFile -> upload -> file_id),
then sendFile references that file_id.
"""
import asyncio

import requests

import config
from core.models import Item
from senders.base import Sender
from senders.formatting import build_message_text, build_short_caption
from senders.http_helpers import download_image_bytes, post_json, send_http_message
from senders.text_utils import DEFAULT_MESSAGE_LIMIT


class RubikaSender(Sender):
    name = "rubika"

    def enabled(self) -> bool:
        return bool(config.RUBIKA_BOT_TOKEN and config.RUBIKA_CHATID)

    def _upload_image(self, image_bytes: bytes) -> str | None:
        base_url = config.RUBIKA_API_BASE_URL.rstrip("/")

        ok, data = post_json(
            "Rubika requestSendFile",
            "{}/{}/requestSendFile".format(base_url, config.RUBIKA_BOT_TOKEN),
            {"type": "Image"},
        )
        upload_url = (data or {}).get("data", {}).get("upload_url") or (data or {}).get("upload_url")
        if not ok or not upload_url:
            print("Rubika: could not obtain an upload URL.")
            return None

        try:
            response = requests.post(
                upload_url, files={"file": ("item.jpg", image_bytes)}, timeout=config.MESSENGER_REQUEST_TIMEOUT
            )
            response.raise_for_status()
            upload_data = response.json()
        except (requests.RequestException, ValueError) as error:
            print("Rubika: image upload failed: {}".format(error))
            return None

        file_id = (upload_data or {}).get("data", {}).get("file_id") or (upload_data or {}).get("file_id")
        if not file_id:
            print("Rubika: upload response had no file_id: {}".format(upload_data))
            return None
        return file_id

    def _send_sync(self, item: Item) -> bool:
        plain_text = build_message_text(item, escape=False)
        base_url = config.RUBIKA_API_BASE_URL.rstrip("/")
        send_message_url = "{}/{}/sendMessage".format(base_url, config.RUBIKA_BOT_TOKEN)

        fits_as_caption = len(plain_text) <= DEFAULT_MESSAGE_LIMIT
        file_id = None

        if item.images:
            image_bytes = download_image_bytes(item.images[0])
            if image_bytes:
                file_id = self._upload_image(image_bytes)

        if file_id:
            send_file_url = "{}/{}/sendFile".format(base_url, config.RUBIKA_BOT_TOKEN)
            caption = plain_text if fits_as_caption else build_short_caption(item, escape=False)
            sent, _ = post_json(
                "Rubika file", send_file_url, {"chat_id": config.RUBIKA_CHATID, "file_id": file_id, "text": caption}
            )
            if not sent:
                return False
            if fits_as_caption:
                print("Sent item to Rubika.")
                return True
            return send_http_message("Rubika", send_message_url, config.RUBIKA_CHATID, plain_text)

        if item.images:
            print("Rubika: sending text-only (image upload failed).")
        return send_http_message("Rubika", send_message_url, config.RUBIKA_CHATID, plain_text)

    async def send(self, item: Item) -> bool:
        try:
            return await asyncio.to_thread(self._send_sync, item)
        except Exception as error:
            print("Failed to send to rubika: {}".format(error))
            return False
