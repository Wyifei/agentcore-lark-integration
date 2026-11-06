// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Bundle the JS only (no Node download, no tarball), for local checks: node scripts/build.mjs → dist/afb.mjs
import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/afb.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: "import { createRequire as __r } from 'node:module'; import { fileURLToPath as __f } from 'node:url'; import { dirname as __d } from 'node:path'; const require = __r(import.meta.url); const __filename = __f(import.meta.url); const __dirname = __d(__filename);",
  },
  logLevel: 'warning',
});
console.log('dist/afb.mjs');
