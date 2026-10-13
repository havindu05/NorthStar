# Northstar

A student planning MVP with a public product page, account signup/sign-in, a private task and weekly activity dashboard, free-tier limits, a private owner dashboard, and installable PWA support. It uses SQLite for local development/tests and PostgreSQL when `DATABASE_URL` is configured.

## Local setup

- Node.js 22.13 or newer.

```sh
cp .env.example .env
npm start
```

Open http://localhost:3000. The marketing page is `/`, sign-in is `/login`, the student dashboard is `/dashboard`, and the owner dashboard is `/owner`. Without `DATABASE_URL`, the app initializes `data/auth.sqlite` automatically. Set `DATABASE_URL` to use PostgreSQL. The `.env` and `data/` paths are ignored by Git. Run integration tests with `npm test`.

Set `ADMIN_EMAILS` in `.env` to the comma-separated email address(es) that should receive the owner dashboard. The email must match an existing signup (case-insensitive). Leave it empty to disable owner analytics.

## Deploy to Render

The included `render.yaml` is a Render Blueprint for a free Node.js web service backed by Neon PostgreSQL. Render free services have an ephemeral filesystem and may sleep, so Northstar must use the external database; never deploy with `DATABASE_URL` empty.

1. Create a private GitHub repository and upload/push this project. Do not include `.env`, `data/`, or real credentials. The working copy's local `.env` and SQLite database are private local data and must not be uploaded.
2. In Render, create a Blueprint from that GitHub repository and review `render.yaml`. Choose a unique service name if the suggested one is unavailable.
3. During Blueprint setup, provide `ADMIN_EMAILS` with the exact email used for your owner account and `DATABASE_URL` with the rotated Neon URL, entered directly into Render's private Environment settings. Never commit or paste database credentials into chat.
4. Deploy, then open the `onrender.com` URL Render assigns. The app uses Render's `RENDER_EXTERNAL_URL` automatically for secure origin checks and production URLs. Render provisions HTTPS.
5. Confirm the homepage, sign-in, signup, `/healthz`, and owner dashboard work. Cloud PostgreSQL starts with empty tables; the local SQLite database and accounts are not copied automatically.
6. Configure a custom domain only if you have one; set `PUBLIC_BASE_URL` to its final HTTPS origin and redeploy. Use the final HTTPS URL in your Paddle application. Leave Paddle live billing disabled until Paddle approves both the seller and payout route.

Render's free service can sleep and has limited resources; it is for demos and testing, not production reliability. Neon also has free-tier limits that may change. Review both providers' current quotas and billing alerts before deploying.

## Working features

- Create an account, sign in/out, and keep a session for 12 hours; opting into “Keep me signed in” extends it to 30 days.
- Create, complete, and delete tasks; add and remove classes, study sessions, breaks, clubs, sports, and other activities.
- Free accounts can keep 25 active tasks and add 5 extracurricular activities per calendar month. These limits are enforced server-side. Plus removes those limits.
- Paddle sandbox and production checkout paths, configured with Paddle recurring price IDs. Paddle-hosted checkout collects card details; Northstar never receives or stores card numbers.
- Paddle customer portal for card and subscription management after Paddle has created a customer record.
- Paddle webhooks validate HMAC signatures and timestamp, deduplicate event IDs, ignore stale subscription events, and only grant Plus based on a signed active subscription event.
- Stripe-hosted checkout is retained only for a real business registered in a Stripe-supported country. It is disabled for the default `BUSINESS_COUNTRY=LK`.
- Private owner dashboard shows registered students, free/Plus counts, latest signups, and app activity. The owner screen directs the seller to Paddle for actual sales, fees, refunds, and payout reports.
- Installable responsive PWA for supported desktop/mobile browsers. Only public interface files are cached; authenticated API data and owner pages are never cached. Student data still needs an internet connection to load and save.

## Sri Lanka and seller approval

You selected Sri Lanka as the business/payout country. Stripe’s [global availability page](https://stripe.com/global) does not offer Sri Lanka as a direct Stripe account country. Stripe direct checkout is blocked in the app when `BUSINESS_COUNTRY=LK`. Do not use a false address or another person’s account.

[Paddle’s supplier guidance](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle) makes it a potential Merchant of Record to apply to; it does **not** guarantee seller approval or confirm your specific Sri Lankan bank/Payoneer payout route. Ask Paddle to confirm both before live billing. Paddle’s Merchant-of-Record agreement may handle certain customer payment/tax obligations; it does not remove your Sri Lankan business, tax, privacy, or reporting obligations.

Paddle integration is now wired but remains disabled until server credentials and prices are configured. A sandbox purchase is for testing only. Live Paddle calls require `PADDLE_ENV=production`, a live API key, and an explicit `PADDLE_MERCHANT_APPROVED=true` setting. Only set that after Paddle approves your account and confirms your payout route. Do not put secrets in browser code, source control, or chat.

## Suggested first price to test

- **Free:** 25 active tasks and 5 extracurricular activities per calendar month.
- **Northstar Plus:** **USD $3.99 monthly** or **USD $29.99 yearly** (about $2.50/month, approximately 37% less than 12 monthly payments).

This is a pricing hypothesis, not a proven “best” price. Ask students in your target countries, run a small pilot, and monitor upgrade conversion, churn, refunds, and support costs. Paddle recurring prices are the checkout source of truth: configure those exact prices in Paddle and the app fetches and shows them before checkout. Currency conversion and taxes may change the amount a student pays.

## Apply/configure Paddle

1. Apply to Paddle as a software seller and explicitly confirm that they can onboard your Sri Lankan business and pay out to your exact bank/Payoneer account.
2. Until approved, use Paddle **sandbox**. Create sandbox monthly and yearly recurring prices for Plus (suggested `$3.99` and `$29.99` USD), and copy their `pri_...` price IDs into `PADDLE_PRICE_MONTHLY` and `PADDLE_PRICE_YEARLY` in `.env`.
3. Copy the sandbox API key into `PADDLE_API_KEY` and configure a Paddle notification destination at `https://your-domain/api/paddle/webhook`. Subscribe to `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, and `subscription.past_due`. Put that notification destination’s secret into `PADDLE_WEBHOOK_SECRET`.
4. Keep `PADDLE_ENV=sandbox` and `PADDLE_MERCHANT_APPROVED=false` while testing. Sandbox cards are for tests only; **never use real student cards in sandbox**.
5. Set `PUBLIC_BASE_URL` to the actual origin used to reach the app. Restart the server after each `.env` change.
6. Test: price display, monthly/yearly checkout, cancel checkout, complete a sandbox subscription, wait for the webhook, verify Plus limits lift only after the signed `subscription.*` event, then change/cancel the sandbox subscription and verify access updates.
7. For live launch, only after approval: use the live price IDs, live API key, live webhook secret, `PADDLE_ENV=production`, and `PADDLE_MERCHANT_APPROVED=true`. Verify payout settings and one complete refund/cancellation journey with Paddle.

Paddle checkout creation uses the server API and a per-request idempotency key. The browser never receives the API key. Webhooks are signature checked using the raw request body and Paddle’s `Paddle-Signature` timestamp/HMAC format.

## Owner dashboard

1. Copy `.env.example` to `.env`.
2. Replace the example `ADMIN_EMAILS` with the exact email you use to sign up.
3. Restart the app, sign in, and choose **Owner overview** or visit `/owner`.

Do not put an admin password/credential into code. The owner page and API check the email allow-list for every request. Paddle sales, settled payout, fees, refunds, and tax reporting belong in the Paddle seller dashboard; Northstar does not estimate bank deposits.

## Desktop/mobile app

The responsive website can be installed as a PWA from supported browsers using **Install app** / **Add to Home Screen** after deployment over HTTPS. Northstar provides an install button with platform-specific steps; Android users can use Chrome’s Install app/Add to Home screen option, and iPhone/iPad users should open the HTTPS site in Safari, tap Share, then Add to Home Screen. The local `localhost` address is not reachable from another phone; deploy to a public HTTPS domain before installing on mobile. Offline, only the public UI shell is available; private dashboard data is intentionally not saved offline.

For store apps, package the PWA with a wrapper such as Capacitor, then complete Apple/Google developer enrollment, store review, privacy disclosures, and their payment rules for digital subscriptions. Public HTTPS hosting and a deployed database are required before students can use the app outside your computer.

## Configuration and production

- `PORT`: HTTP port (default `3000`).
- `DATABASE_URL`: optional PostgreSQL connection URL with TLS enabled (`sslmode=require`); when set, PostgreSQL is used instead of SQLite.
- `DATABASE_PATH`: optional SQLite path used when `DATABASE_URL` is not set (default `data/auth.sqlite`).
- `DATA_DIRECTORY`: directory for SQLite when PostgreSQL is not configured.
- `ADMIN_EMAILS`: comma-separated owner email allow-list.
- `BUSINESS_COUNTRY`: actual business registration country; defaults to `LK` and blocks direct Stripe billing.
- `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_MONTHLY`, `PADDLE_PRICE_YEARLY`, `PADDLE_MERCHANT_APPROVED`: Paddle integration settings.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`: Stripe-only settings for an eligible non-LK business.
- `NODE_ENV=production`: enables Secure cookies and HSTS. Set an HTTPS `PUBLIC_BASE_URL`; on Render the app falls back to Render's HTTPS `RENDER_EXTERNAL_URL` when this is omitted.

SQLite WAL, foreign keys, indexes, parameterized queries, and private database-file permissions are configured. SQLite fits a single-server MVP; move to managed PostgreSQL before multiple app instances or high concurrent write throughput. Back up data and test restores. Rate limiting is currently in-memory/per-process and needs a shared limiter before multi-instance production.

## Before public paid launch

- Complete Paddle seller verification and confirm the actual payout account/currency.
- Add email verification, secure password recovery, MFA/passkeys, privacy export/delete, support, monitoring, and backup/restore operations.
- Confirm business registration, Sri Lankan tax reporting, international tax responsibilities, refund/cancellation terms, privacy notice, and rules for minors. Seek qualified local advice.
- Test with an invited student pilot before widening access.

This is a functional MVP—not a security certification, payment-provider approval, legal advice, or earnings guarantee.
