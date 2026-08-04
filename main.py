"""Entry point. Wires the configured source and senders together and runs
one polling pass. This file should almost never need to change - to plug
in a new listing source or messenger, add a module under sources/ or
senders/ and register it (see sources/registry.py, senders/registry.py).
"""
import config
from core.orchestrator import run
from senders.registry import enabled_senders
from sources.registry import get_source


def main():
    source = get_source(config.SOURCE_TYPE)
    senders = enabled_senders()
    run(source, senders)


if __name__ == "__main__":
    main()
