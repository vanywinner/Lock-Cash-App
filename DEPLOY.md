# Putting Lock Cash live at vanywinner.co.ke/lock-cash

The app is a small Node.js server (Node 22.5+, no packages). Your web server forwards `/lock-cash/` to it.
You need a server where you can run a background program: a VPS (Truehost, Hostafrica, DigitalOcean, etc.)
or a host with a "Node.js app" feature that offers Node 22+. Plain WordPress shared hosting cannot run it.

> **If vanywinner.co.ke is a static site (e.g. GitHub Pages / Netlify):** it cannot run this app or forward
> `/lock-cash` by itself. Two ways round it:
> 1. **Easiest:** run the app on a small VPS and give it a sub-domain, e.g. `savings.vanywinner.co.ke`
>    (one DNS A record pointing to the VPS). Leave `BASE_PATH` empty in the env file. Nothing changes on your main site.
> 2. **Exactly `/lock-cash`:** put the domain behind Cloudflare and add a Worker/route that forwards
>    `vanywinner.co.ke/lock-cash/*` to the VPS. Keep `BASE_PATH=/lock-cash`.

## Option A — Docker host (Render, Railway, Fly.io, any VPS)
The repo includes a `Dockerfile`. Connect the GitHub repo to the host, then:
- set the variables from `.env.example` in the host's dashboard (not in the repo),
- attach a **persistent disk/volume mounted at `/data`** (without it, every redeploy erases all savings records),
- run `node scripts/create-admin.js 07XXXXXXXX "strong-password" "Your Name"` once from the host's shell.
Free tiers often sleep or have no persistent disk — use a small paid plan for real money.

## Option B — plain server (steps below)

## 1. Install on the server
    sudo mkdir -p /opt/lock-cash /var/lib/lock-cash
    # upload and unzip lock-cash.zip so the files are in /opt/lock-cash
    sudo cp /opt/lock-cash/.env.example /etc/lock-cash.env      # then edit it (Pochi number, invite code, ...)
    cd /opt/lock-cash && set -a && . /etc/lock-cash.env && set +a
    node --no-warnings scripts/create-admin.js 07XXXXXXXX "strong-password" "Your Name"

## 2. Keep it running (systemd) — /etc/systemd/system/lock-cash.service
    [Unit]
    Description=Lock Cash
    After=network.target
    [Service]
    WorkingDirectory=/opt/lock-cash
    EnvironmentFile=/etc/lock-cash.env
    ExecStart=/usr/bin/node --no-warnings server/server.js
    Restart=always
    User=www-data
    [Install]
    WantedBy=multi-user.target

    sudo chown -R www-data /var/lib/lock-cash
    sudo systemctl enable --now lock-cash

## 3. Forward /lock-cash to it
nginx — add inside the existing `server { ... }` block for vanywinner.co.ke (must be HTTPS):

    location = /lock-cash { return 301 /lock-cash/; }
    location /lock-cash/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

Apache alternative: `ProxyPass /lock-cash/ http://127.0.0.1:3000/` and
`ProxyPassReverse /lock-cash/ http://127.0.0.1:3000/` (+ `RequestHeader set X-Forwarded-Proto "https"`).

Reload the web server, then open https://vanywinner.co.ke/lock-cash/ . Log in as admin.

## 4. Daily backup (cron) of the one file that matters
    0 2 * * * sqlite3 /var/lib/lock-cash/lockcash.db ".backup '/var/backups/lockcash-$(date +\%F).db'"
Copy those backups somewhere off the server too.

## Sharing with family
Send them https://vanywinner.co.ke/lock-cash/ and the invite code. On a phone they tap **Download App**
(Android) or Share → Add to Home Screen (iPhone).
