/**
 * Copies required ONNX Runtime Web WASM/MJS software assets from node_modules
 * into public/wasm/ so the static web application serves WebAssembly locally
 * from 'self' without contacting third-party script CDNs (e.g., jsdelivr).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist');
const destDir = path.join(projectRoot, 'public', 'wasm');

const REQUIRED_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

if (!fs.existsSync(srcDir)) {
  console.error(`[prepare-wasm] Missing source directory: ${srcDir}. Run npm install first.`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of REQUIRED_FILES) {
  const from = path.join(srcDir, file);
  const to = path.join(destDir, file);
  if (!fs.existsSync(from)) {
    console.error(`[prepare-wasm] Required ONNX Runtime Web asset not found: ${from}`);
    process.exit(1);
  }
  const shouldCopy =
    !fs.existsSync(to) || fs.statSync(from).size !== fs.statSync(to).size;
  if (shouldCopy) {
    fs.copyFileSync(from, to);
  }
}

console.log(`[prepare-wasm] Verified ${REQUIRED_FILES.length} ONNX Runtime Web WASM assets in public/wasm/`);
