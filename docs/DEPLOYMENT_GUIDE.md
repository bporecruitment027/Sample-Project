# Static HTTPS Deployment Guide

`Private Live Transcriber` compiles into a 100% static frontend (`dist/`) with **zero backend server, zero database, zero API keys, and zero desktop installation required** on the end-user's Windows PC.

Because `navigator.mediaDevices.getDisplayMedia()`, `AudioWorklet`, and `WebGPU` require a **Secure Context (`https://`)**, always host `dist/` over HTTPS.

---

## 1. Build the Static Production Bundle

From a developer workstation or CI pipeline (the end user's Windows computer does **not** need Node.js):

```bash
npm install
npm run build
```

This runs:
1. `scripts/prepare-wasm.mjs` — copies ONNX Runtime Web `.wasm` and `.mjs` software assets into `public/wasm/`.
2. `tsc --noEmit` — verifies strict TypeScript types across the entire project.
3. `vite build` — outputs the self-contained static website to `dist/` with the strict production `<meta http-equiv="Content-Security-Policy">` tag injected into `dist/index.html` and relative asset paths (`base: './'`) so subpath hosting works out of the box.

---

## 2. Static Hosting Compatibility & Lowest-Cost Free Options

The compiled `dist/` directory includes ONNX Runtime Web's SIMD WebAssembly binary (`ort-wasm-simd-threaded.asyncify.wasm`, **~26.8 MB uncompressed / ~6.7 MB gzip**), served from `'self'` so no third-party script CDNs are needed.

| Static HTTPS Host | Free Tier Per-File Limit | Compatible Out-of-the-Box? | Notes |
|---|---|---|---|
| **Netlify (Free Starter)** | 100 MB+ | **Yes (Recommended)** | Automatically reads `dist/_headers` for HTTP CSP, `Permissions-Policy`, and `application/wasm` MIME headers. |
| **GitHub Pages (Free)** | 100 MB | **Yes (Recommended)** | Relative paths (`./`) work on both root custom domains and `https://<org>.github.io/<repo>/` subpaths. |
| **Vercel (Free Hobby)** | 100 MB | **Yes** | Deploy `dist/` as a pure static output (`Output Directory: dist`). |
| **Cloudflare Pages (Free)** | **25 MiB (26.2 MB)** | **Limitation (~26.8 MB WASM)** | Cloudflare Pages Free rejects individual static files above 25 MiB (`ort-wasm-simd-threaded.asyncify.wasm` is 25.6 MiB). Use **Netlify Free** or **GitHub Pages** instead. |
| **Internal Enterprise HTTPS (Nginx / IIS / Apache)** | Unlimited | **Yes** | Ensure `.wasm` is served as `application/wasm` and `.mjs`/`.js` as `text/javascript`. |

---

## 3. Deploying to Netlify (Free HTTPS — Recommended)

1. Connect your Git repository in Netlify (or use `npx netlify-cli deploy --prod --dir=dist`).
2. Configure build settings:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
3. Netlify automatically applies `public/_headers` (`dist/_headers`), enforcing:
   - Strict `Content-Security-Policy`
   - `Referrer-Policy: no-referrer`
   - `X-Content-Type-Options: nosniff`
   - `Permissions-Policy: microphone=(), camera=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()`
   - `Content-Type: application/wasm` for `/wasm/*.wasm`
4. Open the `https://<your-site>.netlify.app` URL in **Google Chrome on Windows**.

---

## 4. Deploying to GitHub Pages (Free HTTPS)

1. Create `.github/workflows/deploy-pages.yml` (if deploying via GitHub Actions):
   ```yaml
   name: Deploy Static Transcriber to GitHub Pages
   on:
     push:
       branches: [main]
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     build-and-deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
         - run: npm ci
         - run: npm run build
         - uses: actions/upload-pages-artifact@v3
           with:
             path: ./dist
         - uses: actions/deploy-pages@v4
   ```
2. In GitHub **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Open `https://<username>.github.io/<repo-name>/` in Google Chrome on Windows. Because `dist/index.html` embeds the strict `<meta http-equiv="Content-Security-Policy">` tag, CSP protection remains active even on GitHub Pages where custom HTTP headers are not configurable.

---

## 5. Deploying to an Internal Enterprise Static HTTPS Server (Nginx / IIS)

If your company security team prefers hosting inside your corporate network:

### Example Nginx Configuration
```nginx
server {
    listen 443 ssl http2;
    server_name transcriber.internal.example.com;

    root /var/www/private-live-transcriber/dist;
    index index.html;

    include mime.types;
    types {
        application/wasm wasm;
        text/javascript  mjs js;
    }

    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'none';" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Permissions-Policy "microphone=(), camera=(), geolocation=(), payment=(), usb=(), serial=()" always;

    # Disable access logging if zero-log corporate policy is desired
    access_log off;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```
