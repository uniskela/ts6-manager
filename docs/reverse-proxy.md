# Reverse proxy deployment

TS6 Manager can run behind a reverse proxy such as the one managed by Coolify.

## Coolify starting point

Use [`docker-compose.coolify.yml`](../docker-compose.coolify.yml) as the deployment starting point.

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
- confirm the browser can reach the Docker/host network for WebRTC UDP — with `WEBRTC_UDP_PORT` published and `WEBRTC_NAT1TO1_IP` / `WEBRTC_BIND_IP` set to an IP that browser can reach (same LAN or Tailscale usually works; a remote public reverse proxy alone does not forward WebRTC media);
- **avoid** `127.0.0.1` for those values when the WebUI is opened via a public hostname — loopback advertise/bind only works for a browser on the Docker host itself;
- see [Troubleshooting](troubleshooting.md) for reverse-proxy and streaming checks.

## TLS

Terminate HTTPS at the reverse proxy unless you have a different deliberate architecture. Keep TeamSpeak Query and sidecar management endpoints restricted to trusted/internal networks.
