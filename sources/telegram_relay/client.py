import requests

from core.models import Item, Media
from sources.base import Source


class TelegramRelaySource(Source):
    name = "telegram_relay"
    target_senders = ["rubika", "eitaa"]

    def __init__(self, token, chat_ids):
        self.token = token
        self.chat_ids = {str(x) for x in chat_ids}
        self.base = f"https://api.telegram.org/bot{token}"

    def fetch_new_ids(self, state):
        source_state = state.setdefault("source_state", {}).setdefault(self.name, {})
        offset = source_state.get("offset")
        params = {"timeout": 1}
        if offset is not None:
            params["offset"] = offset
        data = requests.get(self.base + "/getUpdates", params=params, timeout=10).json()
        updates = data.get("result", []) if data.get("ok") else []
        ids = []
        for update in updates:
            source_state["offset"] = update["update_id"] + 1
            message = update.get("channel_post") or update.get("message")
            if not message:
                continue
            chat_id = str(message.get("chat", {}).get("id", ""))
            if chat_id in self.chat_ids:
                ids.append(str(update["update_id"]))
                source_state.setdefault("updates", {})[str(update["update_id"])] = update
        return ids

    def fetch(self, item_id):
        # The update is persisted by fetch_new_ids so it can be fetched here.
        raise NotImplementedError
