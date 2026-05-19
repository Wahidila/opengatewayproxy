set -e

REPO=https://github.com/Wahidila/opengatewayproxy.git
DIR=/opt/opengateway-proxy

echo "[1/5] Clone or pull repo..."
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git pull
else
  rm -rf "$DIR"
  git clone "$REPO" "$DIR"
  cd "$DIR"
fi

echo "[2/5] Create config.json if missing..."
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "  -> Empty config.json created. You must populate keys."
fi

echo "[3/5] Check docker compose..."
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: no docker compose available"
  exit 1
fi
echo "  Using: $COMPOSE"

echo "[4/5] Build & start container..."
$COMPOSE up -d --build

echo "[5/5] Status:"
sleep 3
$COMPOSE ps
echo ""
echo "Health check:"
curl -s http://localhost:8787/health || echo "no response"
echo ""