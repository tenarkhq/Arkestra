# Arkestra webhook relay (AR28)

The Arkestra GitHub App sends its webhooks to this relay on the edge server. The relay
checks GitHub's signature, keeps the last events (500 events, at most 24 hours) and passes
each event to the Arkestra clients allowed to see it, over Server-Sent Events. A client needs
no open port; one that was away gets what it missed when it reconnects (Last-Event-ID).

```
GitHub ──webhook──▶ edge: nginx ─▶ relay (127.0.0.1:8787) ──SSE──▶ Arkestra IDE (arkestra-github)
```

No dependencies: Node 18 or newer, three files (`server.mjs`, `remote.mjs`, and the phone page
`remote-app.html` for Remote Control).

## Endpoints

| Path | What |
| --- | --- |
| `POST /github/webhook` | GitHub's deliveries; refused (401) without a valid `X-Hub-Signature-256`. |
| `GET /events` | The SSE stream for a client: `Authorization: Bearer <token>` (or `?token=`). |
| `GET /healthz` | `{ ok, clients, buffered, lastEventAt }`. |
| `GET /remote/<channel>/host` | Remote Control: the IDE's SSE stream (Bearer client token); events `hello`, `phones`, `cmd`. |
| `POST /remote/<channel>/up` | The IDE sends an encrypted frame (Bearer); the newest per topic is kept while the IDE is online. |
| `GET /remote/<channel>/down` | The phone's SSE stream: `status` (online/offline) and `frame` events. |
| `POST /remote/<channel>/cmd` | An encrypted command from the phone; 503 while the IDE is offline. |
| `GET /remote/app` | The phone page. |

## Deploying on the edge server (owner step)

1. **Create the GitHub App** from `github-app.json`: replace `EDGE_HOST` with the edge
   server's name, then create the app (organization settings → Developer settings → GitHub
   Apps → New, with the permissions and events listed in the manifest). Set a webhook secret.
   Note the app's slug; the IDE's `arkestra.github.appSlug` setting takes it.
2. **Copy the relay** to the server, e.g. `/opt/arkestra-relay/`: `server.mjs`, `remote.mjs` and
   `remote-app.html` side by side (without the page, `/remote/app` answers 404).
3. **Clients file** `/etc/arkestra-relay/clients.json` (mode 600, owned by the service user).
   One entry per IDE; the token is at least 24 characters (`openssl rand -hex 24`):

   ```json
   {
     "<token>": { "name": "laptop", "installations": [12345678], "repos": ["tenarkhq/Arkestra"] }
   }
   ```

   A client sees an event when its installation id or its repository is listed (`"*"` for
   all). The file is re-read within 5 s of a change; no restart is needed.
4. **Environment** `/etc/arkestra-relay/env` (mode 600):

   ```
   WEBHOOK_SECRET=<the GitHub App's webhook secret>
   RELAY_CLIENTS_FILE=/etc/arkestra-relay/clients.json
   PORT=8787
   HOST=127.0.0.1
   ```

5. **systemd unit** `/etc/systemd/system/arkestra-relay.service`:

   ```ini
   [Unit]
   Description=Arkestra webhook relay
   After=network-online.target

   [Service]
   User=arkestra-relay
   EnvironmentFile=/etc/arkestra-relay/env
   ExecStart=/usr/bin/node /opt/arkestra-relay/server.mjs
   Restart=always
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

   `systemctl daemon-reload && systemctl enable --now arkestra-relay`

6. **nginx** in the edge server's TLS site. SSE needs buffering off and a long read timeout:

   ```nginx
   location /arkestra/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 1h;
       client_max_body_size 5m;
   }
   ```

   With this location the webhook URL is `https://EDGE_HOST/arkestra/github/webhook` and the
   IDE's relay address is `https://EDGE_HOST/arkestra`.

7. **Check:** `curl https://EDGE_HOST/arkestra/healthz`, then GitHub's app page →
   Advanced → Recent deliveries shows 202 answers.

## In the IDE

**Arkestra: Connect to the GitHub relay…** asks for the relay address and the client token
(stored in the OS keychain, never in settings). The status bar shows `live · 12 s` while the
stream is open; **Arkestra: Show the GitHub event log** lists the events.

## Remote Control (AR36)

The threads on a phone, through this relay. **Remote Control: turn on** (or the radio
tower in the status bar) makes a pairing: a channel id and an AES-256 key. **Remote Control: copy the
pairing link** gives `https://EDGE_HOST/arkestra/remote/app#c=<channel>&k=<key>`; open it on the phone
(send it to yourself) and add the page to the home screen.

- **End to end encrypted.** Everything between the IDE and the phone is AES-256-GCM with the
  channel id as additional data. The key stays after `#`, which the browser never sends; the
  relay stores and forwards only ciphertext, and keeps nothing once the IDE goes offline.
- **Which threads.** Every thread, or only the ones switched on (right click a thread →
  Remote Control on/off). Turning a thread off takes it off the phones at once.
- **What the phone does.** Thread list, a thread's messages, each agent's state (working,
  waits for you and why, task list, sub-agents, background commands), model and effort per
  agent, writing to the thread and stopping a running round. Approvals stay in the IDE.
- **New pairing link** makes a new channel and key: the old link stops working at once.
- The channel belongs to the client token that opened it; another client gets 409.

## Tests

`node --test relay/server.test.mjs relay/remote.test.mjs`
