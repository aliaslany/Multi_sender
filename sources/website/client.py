"""Website-as-a-source: the GitHub Pages form under docs/ posts a new
photo/video + caption + promo code + destination chat ids to a small
Cloudflare Worker (see worker/), which validates the promo code's trial
window and stores the submission. This source polls that Worker's private
API - the bot never touches a repo-committed file for this, and no bot
token or repo-write credential is ever collected from a customer.

Unlike telegram_relay (which already exists on Telegram) or Divar (which
always goes to every configured sender), a website submission specifies
its own destinations per item - Item.destination_overrides restricts
delivery to just the platforms the customer filled in, using the chat id
they gave rather than your own default channel.

This is a general-purpose app, not a nature-content channel, so the
nature-quote + channel-links extras are opt-in per submission (the
"add_extras" checkbox on the form) rather than automatic - by default a
post's text is exactly what the customer wrote, nothing appended. The one
thing that's always added, opted in or not, is a "multiSender" attribution
link back to @Divarassist, since every post here went out through a
promo code.
"""
import requests

import config
from core.models import ChannelLink, Item, Media
from sources.base import Source
from sources.common.channel_links import cross_promotion_links
from sources.common.quotes import random_nature_quote

_DESTINATION_KEY_TO_SENDER = {
    "telegram_chat_id": "telegram",
    "bale_chat_id": "bale",
    "rubika_chat_id": "rubika",
    "eitaa_chat_id": "eitaa",
}

# Required attribution on every post sent through a promo code, regardless
# of whether the customer opted into the nature-quote/channel-links extras.
_BRAND_LINK = ChannelLink(label="multiSender", url="https://t.me/Divarassist")


class WebsiteSource(Source):
    name = "website"
    # No fixed restriction here - each item narrows itself via
    # destination_overrides, computed in fetch_item below.
    target_senders = None

    def _headers(self) -> dict:
        return {"Authorization": "Bearer {}".format(config.WEBSITE_API_TOKEN)}

    def fetch_new_ids(self, state: dict) -> list[str]:
        if not config.WEBSITE_API_URL or not config.WEBSITE_API_TOKEN:
            print("website: WEBSITE_API_URL/WEBSITE_API_TOKEN not configured - skipping.")
            return []

        try:
            response = requests.get(
                "{}/pending".format(config.WEBSITE_API_URL.rstrip("/")),
                headers=self._headers(),
                timeout=config.MESSENGER_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            return response.json().get("ids", [])
        except requests.RequestException as error:
            print("website: failed to list pending submissions: {}".format(error))
            return []

    def fetch_item(self, item_id: str) -> Item | None:
        try:
            response = requests.get(
                "{}/submission/{}".format(config.WEBSITE_API_URL.rstrip("/"), item_id),
                headers=self._headers(),
                timeout=config.MESSENGER_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            submission = response.json()
        except requests.RequestException as error:
            print("website: failed to fetch submission {}: {}".format(item_id, error))
            return None

        caption = submission.get("caption", "")
        media_type = submission.get("media_type")

        media = []
        if media_type:
            media_url = "{}/media/{}".format(config.WEBSITE_API_URL.rstrip("/"), item_id)
            media.append(Media(type=media_type, url=media_url))

        destinations = submission.get("destinations", {})
        overrides = {
            sender_name: destinations[key]
            for key, sender_name in _DESTINATION_KEY_TO_SENDER.items()
            if destinations.get(key)
        }
        if not overrides:
            print("website: submission {} has no destinations, skipping.".format(item_id))
            return None

        quote = random_nature_quote() if submission.get("add_extras") else None
        if quote:
            caption = "{}\n\n{}".format(caption, quote) if caption else quote

        channel_links = [_BRAND_LINK]
        if submission.get("add_extras"):
            channel_links = cross_promotion_links() + channel_links

        return Item(
            id=item_id,
            raw_text=caption,
            media=media,
            channel_links=channel_links,
            destination_overrides=overrides,
            source=self.name,
        )

    def on_delivered(self, item_id: str, fully_delivered: bool) -> None:
        if not fully_delivered:
            return
        try:
            response = requests.delete(
                "{}/submission/{}".format(config.WEBSITE_API_URL.rstrip("/"), item_id),
                headers=self._headers(),
                timeout=config.MESSENGER_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
        except requests.RequestException as error:
            print("website: failed to clean up submission {}: {}".format(item_id, error))


SOURCE = WebsiteSource()
