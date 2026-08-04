"""Registry of built-in senders. Add a new sender module, then register an
instance of it here - main.py picks up whichever ones are `enabled()`."""
from senders.bale import BaleSender
from senders.base import Sender
from senders.eitaa import EitaaSender
from senders.rubika import RubikaSender
from senders.telegram import TelegramSender

ALL_SENDERS: list[Sender] = [
    TelegramSender(),
    BaleSender(),
    RubikaSender(),
    EitaaSender(),
]


def enabled_senders() -> list[Sender]:
    """Return configured senders, in delivery order."""
    return [sender for sender in ALL_SENDERS if sender.enabled()]
