# Reverse proxy deployment

TS6 Manager can run behind a reverse proxy such as the one managed by Coolify.

## Coolify starting point

Use [`docker-compose.coolify.yml`](../../docker-compose.coolify.yml) as the deployment starting point.

Compared with the standard compose file:

- public `ports` mappings are omitted;
- the reverse proxy should route the public domain to the **frontend** service on port 80; and
- internal backend/sidecar communication remains on Docker networks.

## TeamSpeak on another Docker network

If the TeamSpeak server is reachable through a different Docker network, attach the backend to both networks.

~~~yaml
services:
  backend:
    networks:
      - ts6-network
      - ts-server-net

networks:
  ts-server-net:
    external: true
    name: your-ts-server-network-id
~~~

Do not publish the media sidecar merely to make cross-container routing easier. Join the required Docker network instead.

## Frontend origin

Set `FRONTEND_URL` to the public frontend origin when it differs from the default. This is used for CORS policy.

## WebSockets

The application uses authenticated WebSockets. Ensure the reverse proxy supports WebSocket upgrade requests to the backend through the frontend/nginx path used by your deployment.

A minimal outer NGINX location that only sets `X-Forwarded-For` is not enough. Prefer something like:

~~~nginx
location / {
    proxy_pass http://127.0.0.1:3000;  # frontend / all-in-one published port
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}
~~~

Route the public domain to the **frontend** (or all-in-one nginx), not to the internal sidecar port.

## Browser video preview (WebRTC)

In-browser preview signaling uses ordinary HTTPS API calls through the reverse proxy. The media path is WebRTC over UDP to the host running the media sidecar (via STUN), not through NGINX.

If the preview stays on “Connecting to stream…” and then reports an ICE failure or timeout:

- confirm WebSocket/upgrade headers above so the rest of the live UI stays healthy;
- remember NGINX does **not** carry WebRTC media — only signaling;
- set `WEBRTC_NAT1TO1_IP` to an IPv4 the **browser** can dial (LAN or Tailscale for local clients; public IPv4 when the browser is on the Internet), and publish `WEBRTC_UDP_PORT` with `WEBRTC_BIND_IP` on the Docker host (bind may differ from the advertised address when a firewall/NAT forwards UDP);
- **avoid** advertising `127.0.0.1` unless the browser is on the Docker host itself;
- if the server side looks right, [check the browser side](troubleshooting.md#check-the-browser-side-first) — VPNs, privacy extensions and browser policies can stop the browser from producing ICE candidates at all;
- see [Troubleshooting](troubleshooting.md) for reverse-proxy and streaming checks.

## TLS

Terminate HTTPS at the reverse proxy unless you have a different deliberate architecture. Keep TeamSpeak Query and sidecar management endpoints restricted to trusted/internal networks.

## Listener remote and client IP limits

The listener remote backend generates private `!remote` links using the saved
**Public URL of this manager** (set in a channel's edit dialog, under the hosted
banner upload), falling back to `PUBLIC_URL`. Setting `PUBLIC_URL` is the simplest
route. Use an HTTPS URL reachable from listeners' phones. What listeners and
admins see is described in [Media bots — Listener remote](music-bots.md#listener-remote). An optional path prefix is preserved; the proxy must strip
that prefix consistently for both the frontend and `/api/` routes. Links never
derive their origin from a request's `Host` or forwarded headers.

Links open `/remote`. That page reads the fragment once, removes it, and exchanges
it for a short-lived session. The API contract is `docs/internal/listener-remote-api.md`
in the source repository.

`TRUST_PROXY` tells the backend which proxies may report a client's address in `X-Forwarded-For`. Without it, rate limits see the immediate proxy rather than individual listeners. The bundled images set a default, and a value you set always replaces it:

| Deployment | Default |
|---|---|
| All-in-one image | `loopback` (its bundled nginx) |
| Split backend image | `private-peer`: one hop, and only when the peer connecting to the backend has a private address (10/8, 172.16/12, 192.168/16, fc00::/7) |
| Backend run outside these images | nothing trusted |

With `private-peer` the backend takes the client address from the bundled frontend proxy, which records the address it saw itself. Whatever a client writes into `X-Forwarded-For` is ignored, whether the client has a public or a private address.

Stock installs with no other proxy in front need no action. Set `TRUST_PROXY` to **only** the IPs or subnets of your actual reverse proxies when:

- the all-in-one image sits behind an outer proxy: `TRUST_PROXY=loopback,<outer proxy IP/CIDR>`;
- the split image sits behind an outer proxy, on a public or a private address: name both hops, `TRUST_PROXY=<frontend container IP or compose subnet>,<outer proxy IP/CIDR>`. Without this the backend sees every visitor as the outer proxy and they share one limit. For a proxy on the Docker host that reaches the published frontend port, the address to name is the one the frontend container sees, usually the compose network's gateway; and
- you run the backend yourself, outside the images.

`uniquelocal` trusts every private address at every hop. It covers a private outer proxy in one word, but it also lets any client with a private address (a LAN user, or everyone when Docker hides the source address) choose its own rate-limit address by sending `X-Forwarded-For`. Use it only when the outer proxy overwrites that header and clients cannot reach the frontend or backend ports directly.

Accepted values are comma-separated IPs or CIDRs and the Express names `loopback`, `linklocal` and `uniquelocal`, or `private-peer` on its own. `none` (also `false`, `off`, `no`) trusts nothing. `true` and numeric hop counts are rejected at startup, because they let a direct caller pick its own rate-limit address. An empty value counts as unset. The backend logs `Trusted proxies: …` at startup and warns once if `X-Forwarded-For` arrives while nothing is trusted. Pass the value through your backend service's environment.

Two limits remain on the split image:

- **Direct access to the backend port.** A peer with a private address that connects straight to port 3001 is taken for the proxy, so it can still choose its own rate-limit address. The stock `docker-compose.yml` publishes `3001:3001` on every host interface. If nothing outside Docker needs the API directly, remove that mapping or bind it to `127.0.0.1`; the web interface only needs the frontend port.
- **Hidden source addresses.** Where Docker replaces the client's address with its own (rootless Docker, Docker Desktop, some IPv6 and userland-proxy setups), every visitor reaches the frontend from the same private address and shares one limit. Nobody can forge their way out of it, but one person's failed sign-ins count against everyone.

At the outermost proxy, **overwrite** `X-Forwarded-For` with `$remote_addr` and
`X-Forwarded-Proto` with `$scheme`. Inner trusted proxies may append their
observed address. Keep the backend private so callers cannot bypass that chain.
Do not set proxy trust to `true` or a numeric hop count when paths can have
different lengths. The configured Public URL and IP limits work independently
of TLS termination at the proxy.

Disable request-body and Authorization-header logging on this API. Link tokens
are in URL fragments, consumed once by a POST; browsers must remove the
fragment immediately. Do not cache `/api/listener-remote/` responses. Audit rows
contain actions, bot/scope, outcomes and an identity fingerprint, never access
credentials or pasted URLs.

Run one backend replica: tokens, sessions and limits are bounded, process-local
state and disappear on restart. Tokens last five minutes, sessions fifteen
minutes absolutely. Leaving the bot channel or revocation invalidates access.
Admins can revoke access through the documented API. No sidecar or database
ports need publication for this feature.
