from senders.bale import BaleSender
from senders.eitaa import EitaaSender
from senders.rubika import RubikaSender
from senders.telegram import TelegramSender


def build_senders(config):
    senders = []
    if config.telegram_bot_token:
        senders.append(TelegramSender(config.telegram_bot_token))
    if config.rubika_bot_token:
        senders.append(RubikaSender(config.rubika_bot_token))
    if config.eitaa_bot_token:
        senders.append(EitaaSender(config.eitaa_bot_token))
    if config.bale_bot_token:
        senders.append(BaleSender(config.bale_bot_token))
    return senders
