#!/bin/bash
set -a
source "$(dirname "$0")/.env"
set +a
exec ~/.nvm/versions/node/v22.22.2/bin/node "$(dirname "$0")/dist/index.js"
