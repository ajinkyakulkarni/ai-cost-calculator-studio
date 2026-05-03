# Publishing your calculator

You have multiple ways to host the calculator publicly. Pick whichever
matches your existing infrastructure.

## Option 1: Custom subdomain (e.g., ajinkya.ai/ai-cost-calculator)

The calculator is a static web app. Drop the `cost-calculator-studio/`
directory into your web root, point the URL at the `studio/index.html`
path, and you're done.

```bash
# On your server:
rsync -avz cost-calculator-studio/ user@host:/var/www/ajinkya.ai/ai-cost-calculator/
```

Visitors land at `ajinkya.ai/ai-cost-calculator/studio/index.html`. To
clean that up, configure your web server to default to that file.

**Nginx example** (`/etc/nginx/sites-available/ajinkya.ai`):

```nginx
location /ai-cost-calculator/ {
    alias /var/www/ajinkya.ai/ai-cost-calculator/studio/;
    index index.html;
    try_files $uri $uri/ =404;
}

location /ai-cost-calculator/lib/ {
    alias /var/www/ajinkya.ai/ai-cost-calculator/lib/;
}
location /ai-cost-calculator/examples/ {
    alias /var/www/ajinkya.ai/ai-cost-calculator/examples/;
}
```

## Option 2: Cloudflare Pages (recommended, free)

```bash
# Once, install wrangler:
npm install -g wrangler

# Then from cost-calculator-studio/:
wrangler pages deploy . --project-name=ai-cost-calculator
```

Cloudflare gives you a `ai-cost-calculator.pages.dev` URL automatically;
configure a custom domain (e.g., `calc.ajinkya.ai`) in the Cloudflare
dashboard.

## Option 3: GitHub Pages

```bash
# In the repo, enable Pages from Settings → Pages, source = main branch
# /cost-calculator-studio/ folder.
```

URL becomes `<username>.github.io/<repo>/cost-calculator-studio/studio/`.

## Option 4: AWS S3 static hosting (matching the EIE deployment)

```bash
# Sync to S3 with public-read:
aws s3 sync cost-calculator-studio/ s3://your-bucket/ai-cost-calculator/ \
    --acl public-read \
    --delete

# Configure the bucket for static website hosting if not already.
```

## Option 5: Single-file inline build

For the absolute simplest deployment — drop one HTML file anywhere — a
build script can inline the engine, the example presets, and the SheetJS
library (or skip Excel export). This produces one self-contained HTML
that needs no other resources.

(Build script `lib/build-single-file.js` is planned for v0.2.)

## Custom branding

The calculator inherits styling from the editorial palette in
`studio/index.html`. To rebrand:

- Change colors via the `:root` CSS variables (`--accent`, `--ink`, etc.)
- Replace the title in the topbar `<h1>`
- Swap the footer link
- Optionally add your logo to the topbar

## Updating

Each release of the toolkit may update the cost engine, default rate
cards, or schema. To pull updates without breaking your customizations:

```bash
git pull origin main
# Re-deploy whichever way you originally deployed.
```

The schema is versioned (`workload-v1`); breaking changes will bump the
major version, and an upgrade path will be provided in `docs/migration.md`.

## Analytics

By default the calculator has no analytics or tracking. If you want to
add usage analytics:

- Add a Plausible or Cloudflare Analytics snippet to `studio/index.html`
- Avoid Google Analytics for federal/regulated deployments
- Keep tracking minimal — the goal is "free, ad-free, no signup"

## Privacy

The calculator runs entirely client-side. Workload specifications never
leave the user's browser unless they explicitly click "Copy link"
(which embeds the spec in the URL hash, so it travels via the URL the
user shares).

If you're hosting for a federal program with strict privacy
requirements, the recommended posture is:

- Self-host (don't rely on third-party hosting)
- Inline SheetJS locally so there are no CDN dependencies
- Add a privacy notice to the page indicating that all computation is
  client-side
