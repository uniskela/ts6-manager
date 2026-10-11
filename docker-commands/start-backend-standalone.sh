#!/bin/sh
set -e
# The frontend nginx container reaches this backend over the compose network, whose
# subnet is private but not fixed. Trust private ranges only; public peers are never
# trusted. An explicit TRUST_PROXY (including "none") wins.
export TRUST_PROXY="${TRUST_PROXY:-uniquelocal}"
# Entrypoint for the multi-service backend image (compose: backend + sidecar + frontend).
/usr/local/bin/apply-schema.sh
exec node dist/index.js
