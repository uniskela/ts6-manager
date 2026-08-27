#!/bin/sh
set -e
# Entrypoint for the multi-service backend image (compose: backend + sidecar + frontend).
/usr/local/bin/apply-schema.sh
exec node dist/index.js
