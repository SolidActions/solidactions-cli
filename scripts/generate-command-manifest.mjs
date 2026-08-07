#!/usr/bin/env node
// #1004 PR 0: emit dist/command-manifest.json from the built command tree.
// Runs after tsc in `npm run build`, so it loads compiled CommonJS output.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');

const { program } = require(path.join(dist, 'index.js'));
const { buildCommandManifest, COMMAND_MANIFEST_FILE } = require(path.join(dist, 'utils/command-manifest.js'));
const pkg = require(path.resolve(here, '../package.json'));

const manifest = buildCommandManifest(program, pkg.version);
const outPath = path.join(dist, COMMAND_MANIFEST_FILE);
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`command manifest: ${manifest.commands.length} commands -> ${path.relative(process.cwd(), outPath)}`);
