# Lock Cash

> **Public repository — read this first.** Never commit real data. The database (`data/`), `.env`, passwords,
> your invite code and your real Pochi number belong only on your server (they are git-ignored).
> Security does not depend on this code being secret: passwords are hashed, the lock is enforced on the server.
>
> **GitHub Pages cannot run this app** (it only serves static files; this app has a server).
> Keep the code on GitHub and run it on a host that can run Node or Docker — see `DEPLOY.md`.

Time-locked savings. Users save via M-Pesa (your Pochi la Biashara number); the money is recorded in a
locked ledger and can be withdrawn only after the due date. Works as a website and installs as a phone app (PWA).

## Run it
Needs Node 22.5+. No packages to install.

    npm run create-admin -- 0712345678 "a-strong-password" "Your Name"
    POCHI_PHONE="0722 000 111" POCHI_NAME="Your Name" SUPPORT_PHONE="+254722000111" npm start
    # open http://localhost:3000   (admins are sent to /admin.html automatically)

Settings (environment variables): `PORT`, `DB_FILE`, `POCHI_PHONE`, `POCHI_NAME`, `SUPPORT_PHONE`,
`MIN_DEPOSIT`, `MAX_DEPOSIT`, `MIN_LOCK_DAYS`, `MAX_LOCK_DAYS`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`.

## How money moves
1. User sends KES to your Pochi number, then enters the M-Pesa code in the app (a "pending" top-up).
2. Admin → *Deposits to confirm*: match the code with the SMS on your phone, press Confirm (you can correct the amount).
   Only then does the balance and lock start.
3. Withdrawals are allowed only after the due date (enforced on the server). The amount is held at once;
   Admin → *Withdrawals to pay*: send it by M-Pesa, enter your confirmation code, Mark paid. Reject returns the money.
4. Admin can adjust balances, change due dates, release early, freeze accounts, reset passwords, export CSV.
   Every admin action is written to the audit log.

## Before going live
- **Serve over HTTPS** (e.g. Caddy/nginx in front) and set `COOKIE_SECURE=1`, `TRUST_PROXY=1`.
- **Back up `data/lockcash.db` daily** — it is your only record of who is owed what.
- Pochi has no API, so confirmation is manual. To automate later you need a Paybill/Till + Safaricom Daraja (C2B/B2C).
- Keep at least "Total held" in your M-Pesa; it is what you owe users.
- Taking savings from the public can need licensing in Kenya. Get legal advice and review `public/legal.html`.

## Tests
`npm test` — covers signup/login, the lock, withdrawals, rejections, extensions and admin controls.

## Going live
See `DEPLOY.md` (serving at vanywinner.co.ke/lock-cash) and `.env.example`.
