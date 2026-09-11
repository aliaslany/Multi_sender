"""Fetch new items from the configured source and deliver each to every
configured sender allowed for that source (or, for an item with its own
destination_overrides, just the senders it names). Knows nothing about
Divar, Telegram, Bale, etc. specifically - it only talks to the Source and
Sender interfaces.
"""
import asyncio
import datetime
import time

from senders.base import Sender
from sources.base import Source
from storage import load_state, save_state


async def _deliver(item, senders: list[Sender], destinations: list[str]) -> dict[str, bool]:
    outcomes = {}
    by_name = {sender.name: sender for sender in senders}
    for destination in destinations:
        sender = by_name[destination]
        try:
            outcomes[destination] = await sender.send(item)
        except Exception as error:
            print("Failed to send to {}: {}".format(destination, error))
            outcomes[destination] = False
    return outcomes


def _target_names_for_item(item, sender_names: list[str]) -> list[str]:
    """Which sender names this specific item should go to. Normally that's
    just the source-wide sender_names, but an item carrying its own
    destination_overrides (e.g. a website submission naming only the
    platforms the customer filled in) narrows it to just those - and only
    the ones actually configured/enabled this run."""
    if not item.destination_overrides:
        return sender_names
    return [name for name in sender_names if name in item.destination_overrides]


async def process_items(item_ids, state, source: Source, senders: list[Sender], sender_names: list[str]):
    for item_id in item_ids:
        item = source.fetch_item(item_id)
        if not item:
            continue
        print("ITEM - {} - {}".format(item_id, item.title or item.raw_text or item_id))

        target_names = _target_names_for_item(item, sender_names)
        if not target_names:
            print("No configured sender matches item {}'s destinations - skipping.".format(item_id))
            source.on_delivered(item_id, fully_delivered=False)
            continue

        delivered = state["delivered"]
        destinations = [name for name in target_names if item_id not in delivered.get(name, [])]
        if destinations:
            print("Sending {} to: {}".format(item_id, ", ".join(destinations)))
            outcomes = await _deliver(item, senders, destinations)
            if item_id not in state["known_tokens"]:
                state["known_tokens"].append(item_id)
            for name, succeeded in outcomes.items():
                if succeeded:
                    delivered.setdefault(name, []).append(item_id)
            time.sleep(1)

        fully_delivered = all(item_id in delivered.get(name, []) for name in target_names)
        source.on_delivered(item_id, fully_delivered)


def run(source: Source, senders: list[Sender]):
    print("Started at {}.".format(datetime.datetime.now()))

    sender_names = [s.name for s in senders]
    if source.target_senders is not None:
        sender_names = [name for name in sender_names if name in source.target_senders]
    if not sender_names:
        raise RuntimeError(
            "No configured sender is allowed for source '{}' "
            "(target_senders={}). Configure at least one of them.".format(
                source.name, source.target_senders
            )
        )

    state = load_state()
    state.setdefault("source_state", {})
    known_ids = set(state["known_tokens"])
    print("Known items: {}".format(len(known_ids)))

    new_ids = source.fetch_new_ids(state)
    print("Fetched {} items from {} this run.".format(len(new_ids), source.name))

    pending_ids = [
        item_id
        for item_id in new_ids
        if item_id not in known_ids
        or any(item_id not in state["delivered"].get(name, []) for name in sender_names)
    ]
    print("{} items need delivery this run.".format(len(pending_ids)))

    asyncio.run(process_items(pending_ids, state, source, senders, sender_names))

    save_state(state)
    print("Finished at {}.".format(datetime.datetime.now()))
