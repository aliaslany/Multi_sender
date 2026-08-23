"""Picks the active source module by name.

To add a new source: create sources/<name>/client.py exporting a `SOURCE`
instance (see sources/divar/client.py for the reference implementation),
then add it to AVAILABLE_SOURCES below. Select it with SOURCE_TYPE=<name>.
"""
from sources.base import Source
from sources.divar.client import SOURCE as DIVAR_SOURCE
from sources.telegram_relay.client import SOURCE as TELEGRAM_RELAY_SOURCE
from sources.website.client import SOURCE as WEBSITE_SOURCE

AVAILABLE_SOURCES: dict[str, Source] = {
    "divar": DIVAR_SOURCE,
    "telegram_relay": TELEGRAM_RELAY_SOURCE,
    "website": WEBSITE_SOURCE,
}


def get_source(source_type: str) -> Source:
    try:
        return AVAILABLE_SOURCES[source_type]
    except KeyError:
        raise RuntimeError(
            "Unknown SOURCE_TYPE '{}'. Available sources: {}".format(
                source_type, ", ".join(AVAILABLE_SOURCES)
            )
        )
