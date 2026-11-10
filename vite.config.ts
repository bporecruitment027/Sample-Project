import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * Serves ONNX Runtime Web .wasm and .mjs assets directly with exact MIME types
 * and injects strict production Content-Security-Policy on static builds.
 */
function privacyAndWasmPlugin(): Plugin {
  let isBuild = false;

  const serveWasmDir = (rootDir: string) => {
    return (
      req: { url?: string },
      res: {
        setHeader: (name: string, value: string) => void;
        end: (data: Buffer) => void;
      },
      next: () => void,
    ) => {
      const cleanUrl = (req.url ?? '').split('?')[0];
      if (!cleanUrl.includes('/wasm/ort-wasm')) {
        next();
        return;
      }
      const fileName = path.basename(cleanUrl);
      const filePath = path.join(rootDir, 'wasm', fileName);
      if (!fs.existsSync(filePath)) {
        next();
        return;
      }
      if (fileName.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      } else if (fileName.endsWith('.mjs') || fileName.endsWith('.js')) {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(fs.readFileSync(filePath));
    };
  };

  const applyPrivacyHeaders = (
    _req: unknown,
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Permissions-Policy',
      'microphone=(), camera=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()',
    );
    next();
  };

  return {
    name: 'privacy-and-wasm-plugin',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use(applyPrivacyHeaders);
      server.middlewares.use(serveWasmDir(path.join(__dirname, 'public')));
    },
    configurePreviewServer(server) {
      server.middlewares.use(applyPrivacyHeaders);
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', PRODUCTION_CSP);
        next();
      });
      server.middlewares.use(serveWasmDir(path.join(__dirname, 'dist')));
    },
    transformIndexHtml(html) {
      if (!isBuild) {
        return html;
      }
      const metaCsp = `    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />\n`;
      return html.replace('<!-- CSP_PLACEHOLDER -->', metaCsp.trim());
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [privacyAndWasmPlugin()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
