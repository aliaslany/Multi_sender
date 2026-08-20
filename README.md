# Multi-Messenger Sender

A multi-source, multi-sender bot framework for forwarding content from sources such as Divar and Telegram to messaging platforms such as Telegram, Rubika, Eitaa, and Bale.

## Features

- Source/sender plugin architecture
- Divar source support
- Telegram relay source support
- Telegram, Rubika, Eitaa, and Bale senders
- Persistent delivery state
- Media forwarding for photos and videos
- Per-source target sender restrictions

## Telegram relay

The Telegram relay source polls Telegram `getUpdates` for direct messages and channel posts. The bot must be an administrator of channels whose posts it should receive. Configure `TELEGRAM_RELAY_BOT_TOKEN` and the allowlist `TELEGRAM_RELAY_CHAT_IDS`.

The relay keeps its Telegram update offset in persistent source state and forwards the original text/media without applying the normal structured-item template. It targets Rubika and Eitaa by default because the source content already exists on Telegram.

A known limitation is that Telegram media groups/albums are delivered as individual updates rather than as a single grouped post.

## Configuration

Copy `.env.example` to `.env` and configure the sender/source credentials required for your deployment. Runtime delivery and source state is stored in `tokens.json`.

## Running locally

```bash
pip install -r requirements.txt
python main.py
```

## Docker

```bash
docker compose up --build
```
