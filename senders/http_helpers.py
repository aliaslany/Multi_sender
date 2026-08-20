"""Small HTTP helpers shared by the Bot-API-style senders (Bale, Rubika,
Eitaa). Telegram uses python-telegram-bot instead, so it doesn't need these.
"""
import requests

import config
from senders.text_utils import DEFAULT_MESSAGE_LIMIT, split_text_into_chunks


def post_json(name: str, url: str, payload: dict) -> tuple[bool, dict | None]:
    try:
        response = requests.post(url, json=payload, timeout=config.MESSENGER_REQUEST_TIMEOUT)
        response.raise_for_status()
    except requests.RequestException as error:
        print("Failed to send to {}: {}".format(name, error))
        return False, None

    try:
        response_data = response.json()
    except ValueError:
        response_data = None

    if isinstance(response_data, dict) and response_data.get("ok") is False:
        print("Failed to send to {}: {}".format(name, response_data))
        return False, response_data

    return True, response_data


def send_http_message(name: str, url: str, chat_id: str, text: str, limit: int = DEFAULT_MESSAGE_LIMIT) -> bool:
    ok = True
    for chunk in split_text_into_chunks(text, limit):
        sent, _ = post_json(name, url, {"chat_id": chat_id, "text": chunk})
        ok = ok and sent
    if ok:
        print("Sent item to {}.".format(name))
    return ok


def download_bytes(url: str) -> bytes | None:
    try:
        response = requests.get(url, timeout=config.MESSENGER_REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.content
    except requests.RequestException as error:
        print("Failed to download item image {}: {}".format(url, error))
        return None
