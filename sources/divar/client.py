"""Divar implementation of the Source interface.

This is the only file that needs to exist for Divar specifically - it wraps
the low-level API calls in _raw_client.py and hashtags.py and maps their
output onto the generic core.models.Item that the rest of the app speaks.
"""
from core.models import Item, Media
from sources.base import Source
from sources.divar import _raw_client
from sources.divar.hashtags import generate_hashtags


class DivarSource(Source):
    name = "divar"

    def fetch_new_ids(self, state: dict) -> list[str]:
        return _raw_client.get_tokens_page()

    def fetch_item(self, item_id: str) -> Item | None:
        ad = _raw_client.fetch_ad_data(item_id)
        if ad is None:
            return None

        return Item(
            id=ad.token,
            title=ad.title,
            price=ad.price,
            description=ad.description,
            location=ad.posted_in or ad.district,
            media=[Media(type="photo", url=url) for url in ad.images],
            features=ad.features,
            tags=generate_hashtags(ad),
            source=self.name,
        )


SOURCE = DivarSource()
