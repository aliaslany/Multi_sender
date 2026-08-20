from core.models import Item


class Orchestrator:
    def __init__(self, sources, senders, storage):
        self.sources = sources
        self.senders = senders
        self.storage = storage

    def run(self):
        for source in self.sources:
            ids = source.fetch_new_ids(self.storage.state)
            for item_id in ids:
                item = source.fetch(item_id)
                targets = source.target_senders or [s.name for s in self.senders]
                for sender in self.senders:
                    if sender.name in targets:
                        sender.send(item)
                        self.storage.mark_delivered(sender.name, item.id)
        self.storage.save()
