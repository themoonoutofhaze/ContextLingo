// Post-build script: fix the service-worker-loader.js to import background.js
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = join(__dirname, 'dist/service-worker-loader.js');

writeFileSync(loaderPath, "import './assets/background.js';\n", 'utf8');
console.log('[fix-sw-loader] Patched service-worker-loader.js → imports assets/background.js');
