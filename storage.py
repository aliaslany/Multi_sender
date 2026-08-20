import json
from pathlib import Path


class Storage:
    def __init__(self, path="tokens.json"):
        self.path = Path(path)
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
        else:
            self.state = {"delivered": {}, "known_tokens": [], "state_version": 2}

    def mark_delivered(self, sender, item_id):
        self.state.setdefault("delivered", {}).setdefault(sender, []).append(item_id)

    def save(self):
        self.path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2))
