"""Reading/writing delivery state for ads sent to messenger platforms."""
import json
import os

_TOKENS_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), "tokens.json")
_STATE_VERSION = 2


def load_state():
    """Load delivery state and upgrade legacy Telegram delivery markers."""
    try:
        with open(_TOKENS_PATH, "r") as content:
            data = content.read()
            if not data:
                return {"state_version": _STATE_VERSION, "known_tokens": [], "delivered": {}, "source_state": {}}
            parsed = json.loads(data)
            if isinstance(parsed, list):
                return {
                    "state_version": _STATE_VERSION,
                    "known_tokens": parsed,
                    "delivered": {},
                    "source_state": {},
                }
            if not isinstance(parsed, dict):
                print(
                    "Warning: tokens.json did not contain a list or object "
                    "(got {}), resetting to empty list.".format(type(parsed))
                )
                return {"state_version": _STATE_VERSION, "known_tokens": [], "delivered": {}, "source_state": {}}

            known_tokens = parsed.get("known_tokens", [])
            delivered = parsed.get("delivered", {})
            source_state = parsed.get("source_state", {})
            if not isinstance(known_tokens, list) or not isinstance(delivered, dict):
                print("Warning: invalid tokens.json state, resetting to empty state.")
                return {"state_version": _STATE_VERSION, "known_tokens": [], "delivered": {}, "source_state": {}}
            if not isinstance(source_state, dict):
                source_state = {}

            if parsed.get("state_version", 1) < _STATE_VERSION:
                delivered.pop("telegram", None)
                print("Reset legacy Telegram delivery markers for a one-time retry.")

            return {
                "state_version": _STATE_VERSION,
                "known_tokens": known_tokens,
                "delivered": delivered,
                "source_state": source_state,
            }
    except (FileNotFoundError, json.JSONDecodeError):
        return {"state_version": _STATE_VERSION, "known_tokens": [], "delivered": {}, "source_state": {}}


def save_state(state):
    with open(_TOKENS_PATH, "w") as outfile:
        json.dump(state, outfile, ensure_ascii=False, sort_keys=True)
