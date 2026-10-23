#!/usr/bin/env bash
# Atualiza o hub no notebook. O navegador do robô usa a rede do container do hub, então precisa ser
# recriado sempre que o hub for (o login do TikTok fica salvo em ./browser e não se perde).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d --build cortes-hub
docker compose up -d --force-recreate --no-deps cortes-browser
docker builder prune -af >/dev/null 2>&1 || true # o disco do notebook é curto
docker compose ps
