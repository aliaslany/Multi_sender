from config import config
from core.orchestrator import Orchestrator
from senders.registry import build_senders
from sources.registry import build_sources
from storage import Storage


def main():
    storage = Storage()
    senders = build_senders(config)
    sources = build_sources(config)
    Orchestrator(sources, senders, storage).run()


if __name__ == "__main__":
    main()
