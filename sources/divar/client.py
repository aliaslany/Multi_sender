from sources.base import Source


class DivarSource(Source):
    name = "divar"

    def fetch_new_ids(self, state):
        return []

    def fetch(self, item_id):
        raise NotImplementedError
