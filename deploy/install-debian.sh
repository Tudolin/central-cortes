#!/usr/bin/env bash
# Instalação em Debian 12/13 (root). Rode a partir do checkout do repositório:
#   sudo bash deploy/install-debian.sh            # CPU
#   sudo CUDA=1 bash deploy/install-debian.sh     # whisper.cpp com GPU NVIDIA (requer CUDA toolkit já instalado)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_MODEL="${WHISPER_MODEL_NAME:-large-v3-turbo-q5_0}"

echo "==> Pacotes do sistema"
apt-get update
apt-get install -y --no-install-recommends ffmpeg fonts-montserrat fontconfig git cmake build-essential curl ca-certificates

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "==> Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

echo "==> yt-dlp (binário oficial)"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

if ! command -v whisper-cli >/dev/null; then
  echo "==> whisper.cpp"
  rm -rf /tmp/whisper.cpp
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
  cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF ${CUDA:+-DGGML_CUDA=1}
  cmake --build /tmp/whisper.cpp/build -j"$(nproc)" --target whisper-cli
  install -m 755 /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
fi

mkdir -p "$APP_DIR/models"
if [ ! -f "$APP_DIR/models/ggml-$WHISPER_MODEL.bin" ]; then
  echo "==> Modelo whisper ggml-$WHISPER_MODEL"
  curl -fL "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin" -o "$APP_DIR/models/ggml-$WHISPER_MODEL.bin"
fi

echo "==> Dependências Node"
cd "$APP_DIR"
npm ci --omit=dev

id cortes >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin cortes
mkdir -p "$APP_DIR/data"
[ -f "$APP_DIR/.env" ] || { cp .env.example .env; sed -i "s#^WHISPER_MODEL=.*#WHISPER_MODEL=models/ggml-$WHISPER_MODEL.bin#; s#^WHISPER_THREADS=.*#WHISPER_THREADS=$(nproc)#" .env; }
chown -R cortes:cortes "$APP_DIR/data" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "==> Serviço systemd"
sed "s#__APP_DIR__#$APP_DIR#" deploy/editor-cortes.service > /etc/systemd/system/editor-cortes.service
systemctl daemon-reload
systemctl enable --now editor-cortes

echo
echo "Pronto. Edite $APP_DIR/.env (ANTHROPIC_API_KEY e DASHBOARD_PASSWORD) e rode: systemctl restart editor-cortes"
echo "Logs: journalctl -u editor-cortes -f"
