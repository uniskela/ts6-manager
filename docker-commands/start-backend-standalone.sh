#!/bin/sh
set -e
# The frontend nginx container reaches this backend over the compose network, whose
# subnet is private but not fixed. Trust one hop, and only when the connecting peer has
# a private address: the client address is then the one nginx observed, and nothing a
# client wrote in X-Forwarded-For is believed. An explicit TRUST_PROXY (including
# "none") wins; an outer proxy in front of the frontend needs one.
export TRUST_PROXY="${TRUST_PROXY:-private-peer}"
# Entrypoint for the multi-service backend image (compose: backend + sidecar + frontend).
/usr/local/bin/apply-schema.sh
exec node dist/index.js
