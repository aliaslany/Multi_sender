"""Website-as-a-source: the GitHub Pages form under docs/ commits a new
photo/video + caption directly into this repo's submissions/ folder via the
GitHub Contents API. Since the GitHub Actions workflow always checks out
the full repo before running main.py, this source just reads those files
off disk - no API polling needed on the bot's side.

Layout the form writes:
  submissions/<id>.json         {"caption": "...", "media_filename": "...", "media_type": "photo"|"video"}
  submissions/media/<filename>  the actual photo/video file

Unlike telegram_relay, this content doesn't exist anywhere yet, so it's
delivered to every configured sender (target_senders stays None).

Cleanup tradeoff: processed submission files are deleted right after being
read, before delivery is confirmed to have succeeded. If a send fails, the
content is gone rather than retried - acceptable here since, unlike a Divar
listing, you can just resubmit through the form. The GitHub Actions workflow
commits these deletions back to the repo alongside tokens.json.
"""
import json
import os

import config
from core.models import Item, Media
from sources.base import Source
from sources.common.channel_links import cross_promotion_links
from sources.common.quotes import random_nature_quote

_SUBMISSIONS_DIR = "submissions"
_MEDIA_DIR = os.path.join(_SUBMISSIONS_DIR, "media")


class WebsiteSource(Source):
    name = "website"
    # This content doesn't exist anywhere yet - unlike telegram_relay,
    # deliver it everywhere that's configured.
    target_senders = None

    def fetch_new_ids(self, state: dict) -> list[str]:
        if not os.path.isdir(_SUBMISSIONS_DIR):
            return []

        return sorted(
            filename[: -len(".json")]
            for filename in os.listdir(_SUBMISSIONS_DIR)
            if filename.endswith(".json")
        )

    def fetch_item(self, item_id: str) -> Item | None:
        json_path = os.path.join(_SUBMISSIONS_DIR, "{}.json".format(item_id))
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                submission = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as error:
            print("website: could not read submission {}: {}".format(item_id, error))
            return None

        caption = submission.get("caption", "")
        media_filename = submission.get("media_filename")
        media_type = submission.get("media_type", "photo")

        media = []
        if media_filename:
            media_path = os.path.join(_MEDIA_DIR, media_filename)
            if os.path.exists(media_path):
                media.append(Media(type=media_type, url=self._raw_url(media_filename)))
            else:
                print("website: media file missing for {}: {}".format(item_id, media_path))

        quote = random_nature_quote()
        if quote:
            caption = "{}\n\n{}".format(caption, quote) if caption else quote

        item = Item(
            id=item_id,
            raw_text=caption,
            media=media,
            channel_links=cross_promotion_links(),
            source=self.name,
        )

        self._cleanup(item_id, media_filename)
        return item

    def _raw_url(self, media_filename: str) -> str:
        return "https://raw.githubusercontent.com/{}/main/{}/{}".format(
            config.GITHUB_REPO, _MEDIA_DIR, media_filename
        )

    def _cleanup(self, item_id: str, media_filename: str | None):
        json_path = os.path.join(_SUBMISSIONS_DIR, "{}.json".format(item_id))
        try:
            os.remove(json_path)
        except OSError as error:
            print("website: could not remove {}: {}".format(json_path, error))

        if media_filename:
            media_path = os.path.join(_MEDIA_DIR, media_filename)
            try:
                os.remove(media_path)
            except OSError as error:
                print("website: could not remove {}: {}".format(media_path, error))


SOURCE = WebsiteSource()
