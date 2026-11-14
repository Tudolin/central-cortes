#!/usr/bin/env bash
# Túnel público só para as fotos dos posts do Instagram (a Meta e o Templated baixam a imagem por URL).
# Abre um "quick tunnel" do Cloudflare para a porta das fotos do hub (IG_MEDIA_PORT, padrão 8196 no host), que
# responde apenas /public/ig/*, e grava o endereço em data/ig-media-url.txt. O hub lê esse arquivo a cada
# uso, então não precisa reiniciar quando o endereço muda (ele muda sempre que o cloudflared reinicia).
# Requer o cloudflared instalado. Como serviço: deploy/ig-media-tunnel.service.
set -u
cd "$(dirname "$0")/.."
PORT="${IG_MEDIA_PORT:-8196}"
OUT="data/ig-media-url.txt"
LOG="$(mktemp)"
trap 'kill "${CF:-0}" 2>/dev/null; rm -f "$LOG" "$OUT"' EXIT

while true; do
  : > "$LOG"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 &
  CF=$!
  LAST=""
  while kill -0 "$CF" 2>/dev/null; do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
    if [ -n "$URL" ] && [ "$URL" != "$LAST" ]; then
      echo "$URL" > "$OUT"
      echo "$(date -Is) fotos do Instagram em $URL"
      LAST="$URL"
    fi
    sleep 3
  done
  rm -f "$OUT" # sem túnel, o hub volta para o endereço configurado no painel
  echo "$(date -Is) cloudflared caiu; reabrindo em 15 s"
  sleep 15
done
