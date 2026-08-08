import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, '..');

// The smoke serves the examples/SDK repos from local sibling checkouts. Two
// things used to break this: the defaults assumed directory names ("examples",
// "ts-sdk") that nobody actually clones under, and `cliDir/..` is the worktree
// container — not the checkout root — whenever the CLI is worked on from a git
// worktree. Resolve the real checkout root via the shared git dir, then probe
// the names people actually use.
function checkoutRoot() {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: cliDir,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return path.resolve(cliDir, '..');
  // <root>/<repo>/.git -> <root>
  return path.resolve(result.stdout.trim(), '..', '..');
}

function isDirectory(candidate) {
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

function findSibling(override, candidateNames) {
  // An explicit override that does not exist is reported as missing rather than
  // trusted, so a typo surfaces here instead of as a confusing failure later.
  if (override) {
    const resolved = path.resolve(override);
    return isDirectory(resolved) ? resolved : null;
  }
  const root = checkoutRoot();
  for (const name of candidateNames) {
    const candidate = path.join(root, name);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

const examplesDir = findSibling(process.env.SOLIDACTIONS_EXAMPLES_DIR, ['solidactions-examples', 'examples']);
const sdkDir = findSibling(process.env.SOLIDACTIONS_SDK_DIR, ['solidactions-ts-sdk', 'ts-sdk']);
const packageJson = JSON.parse(await readFile(path.join(cliDir, 'package.json'), 'utf8'));
const skillNames = [
  'solidactions-getting-started',
  'solidactions-workflow-coding',
  'solidactions-deploy-and-config',
  'solidactions-oauth-actions',
  'solidactions-crew-skills',
];
const scaffoldFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'solidactions.yaml',
  '.env.example',
  'src/hello.ts',
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status !== 0) {
        const details = [stdout, stderr].filter(Boolean).join('\n');
        reject(new Error(`${command} ${args.join(' ')} failed with exit ${status}\n${details}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// The smoke needs local examples/SDK checkouts to serve template content from.
// On a clean clone (CI, a fresh contributor box) those siblings do not exist,
// and hard-failing there turned check:release into a gate nobody could pass.
// Skip with a loud notice instead. Set SOLIDACTIONS_SMOKE_REQUIRE_SOURCES=1
// (release builds) to turn a missing checkout back into a failure.
function skipUnlessSourcesPresent() {
  const missing = [];
  if (!examplesDir) missing.push('solidactions-examples');
  if (!sdkDir) missing.push('solidactions-ts-sdk');
  if (missing.length === 0) return false;

  const detail = `missing sibling checkout(s): ${missing.join(', ')}`;
  if (process.env.SOLIDACTIONS_SMOKE_REQUIRE_SOURCES === '1') {
    throw new Error(
      `smoke:init requires local source checkouts (${detail}). ` +
      'Clone them next to solidactions-cli, or point SOLIDACTIONS_EXAMPLES_DIR / SOLIDACTIONS_SDK_DIR at them.',
    );
  }
  console.log(`SKIP smoke:init — ${detail}.`);
  console.log('  Clone them beside solidactions-cli, or set SOLIDACTIONS_EXAMPLES_DIR / SOLIDACTIONS_SDK_DIR.');
  console.log('  Set SOLIDACTIONS_SMOKE_REQUIRE_SOURCES=1 to make this a hard failure instead.');
  return true;
}

function assertSafeSourcePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  assert(resolved === root || resolved.startsWith(`${root}${path.sep}`), `unsafe source path: ${relativePath}`);
  return relativePath;
}

// Resolved commit-ish per (checkout, ref). Resolution can hit the network, and
// a run reads a dozen files per repo — resolve once, reuse.
const resolvedRefs = new Map();

function revParse(root, candidate) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Resolve a ref to a commit inside a sibling checkout, fetching it if the
 * checkout does not already have it.
 *
 * CI clones the sibling repos at depth 1 with no tags, so a pinned ref the CLI
 * asks for — the SDK's `v0.7.3` tag, or an EXAMPLES_REF SHA that is not the tip
 * of the cloned branch — simply is not present locally, and the smoke failed
 * with "File not found ... (branch: v0.7.3)". Fetching on demand keeps the CI
 * checkouts cheap while still serving exactly the ref the CLI pins to.
 *
 * Remote-tracking refs are preferred over local ones so a stale local `main`
 * cannot shadow the fetched one.
 */
function resolveRef(root, ref) {
  const cacheKey = `${root}\0${ref}`;
  const cached = resolvedRefs.get(cacheKey);
  if (cached) return cached;

  const attempts = [];
  for (const candidate of [`origin/${ref}`, ref]) {
    const commit = revParse(root, candidate);
    if (commit) {
      resolvedRefs.set(cacheKey, commit);
      return commit;
    }
    attempts.push(candidate);
  }

  // Not present locally — ask the remote for it. Tags and SHAs both work as
  // fetch arguments; FETCH_HEAD then names whatever came back.
  const fetch = spawnSync('git', ['fetch', '--quiet', '--depth=1', 'origin', ref], {
    cwd: root,
    encoding: 'utf8',
  });
  if (fetch.status === 0) {
    const commit = revParse(root, 'FETCH_HEAD');
    if (commit) {
      resolvedRefs.set(cacheKey, commit);
      return commit;
    }
  }

  throw new Error(
    `could not resolve ref "${ref}" in ${root}\n` +
    `  tried locally: ${attempts.join(', ')}\n` +
    `  git fetch origin ${ref}: ${fetch.status === 0 ? 'succeeded but FETCH_HEAD was unusable' : String(fetch.stderr ?? '').trim()}\n` +
    '  If this ref is a pin in the CLI (EXAMPLES_REF, or the SDK tag derived from package.json), ' +
    'check that it exists and is pushed in the source repo.',
  );
}

// Read a file at the ref the CLI actually asked for, out of the checkout's git
// object store — NOT the working tree. Serving the working tree meant the smoke
// silently tested whatever branch the sibling checkout happened to be parked on
// (a feature branch, a stale main), which is why it failed even against real
// checkouts. Reading by ref also makes the smoke a genuine check on the refs the
// CLI pins to.
function readAtRef(root, ref, relativePath) {
  const commit = resolveRef(root, ref);
  const result = spawnSync('git', ['show', `${commit}:${relativePath}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `could not read ${relativePath} at ref ${ref} (${commit}) in ${root}\n${String(result.stderr ?? '').trim()}`,
    );
  }
  return result.stdout;
}

async function startSourceServer() {
  const repositories = new Map([
    ['SolidActions/solidactions-examples', examplesDir],
    ['SolidActions/solidactions-ts-sdk', sdkDir],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const parts = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).split('/').filter(Boolean);
      const root = repositories.get(`${parts[0]}/${parts[1]}`);
      assert(root, 'unknown source repository');
      const ref = parts[2];
      assert(ref, 'missing source ref');
      const file = assertSafeSourcePath(root, parts.slice(3).join('/'));
      const content = readAtRef(root, ref, file);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(content);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function expectHelp(binary, args, expected, env, cwd) {
  const output = await run(binary, [...args, '--help'], { capture: true, env, cwd });
  // commander wraps help text to the terminal width, which can be narrower in CI
  // (no TTY / piped output) than locally, splitting a phrase across a line break.
  // Collapse all whitespace before matching so wrapping doesn't affect the check.
  const normalized = output.replace(/\s+/g, ' ');
  for (const fragment of expected) {
    assert(normalized.includes(fragment), `${args.join(' ')} --help is missing ${fragment}`);
  }
}

async function verifyScaffold(projectDir, target) {
  for (const relativePath of scaffoldFiles) {
    assert((await stat(path.join(projectDir, relativePath))).isFile(), `missing scaffold file ${relativePath}`);
  }

  const targetFile = target === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const skillDir = path.join(projectDir, target === 'claude' ? '.claude' : '.agents', 'skills');
  const installedSkills = (await readdir(skillDir))
    .filter((file) => file.startsWith('solidactions-') && file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
    .sort();
  assert.deepEqual(installedSkills, [...skillNames].sort(), `${target} skill manifest drifted`);
  assert((await stat(path.join(projectDir, '.solidactions', 'sdk-reference.md'))).isFile(), 'SDK reference missing');

  const deploySkill = await readFile(path.join(skillDir, 'solidactions-deploy-and-config.md'), 'utf8');
  assert(
    deploySkill.includes('## Recipe — Databases'),
    'pinned solidactions-deploy-and-config.md is missing ## Recipe — Databases',
  );

  const helper = await readFile(path.join(projectDir, targetFile), 'utf8');
  for (const skillName of skillNames) {
    assert(helper.includes(skillName), `${targetFile} does not name ${skillName}`);
  }
  assert(helper.includes('.solidactions/sdk-reference.md'), `${targetFile} does not point to the SDK reference`);

  const generatedPackage = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
  assert.equal(generatedPackage.name, path.basename(projectDir));
  assert.equal(generatedPackage.scripts?.build, 'tsc');
  assert.equal(generatedPackage.engines?.node, '>=24');
}

if (skipUnlessSourcesPresent()) {
  process.exit(0);
}

// `npm pack` only ships "dist" (see package.json files), so running this smoke
// without a build produces a tarball with no binary and fails much later with
// an opaque ENOENT on node_modules/.bin/solidactions. Say so up front.
assert(
  existsSync(path.join(cliDir, 'dist', 'index.js')),
  'dist/index.js is missing — run `npm run build` before smoke:init (check:release does this for you).',
);

const tempRoot = await mkdtemp(path.join(tmpdir(), 'solidactions-cli-release-'));
const artifactDir = path.join(tempRoot, 'artifacts');
const installDir = path.join(tempRoot, 'install');
const homeDir = path.join(tempRoot, 'home');
await Promise.all([mkdir(artifactDir), mkdir(installDir), mkdir(homeDir)]);

let sourceServer;
try {
  const packOutput = await run('npm', ['pack', '--json', '--pack-destination', artifactDir], { capture: true, cwd: cliDir });
  const packed = JSON.parse(packOutput);
  assert.equal(packed.length, 1, 'npm pack must create exactly one CLI tarball');
  const tarball = path.join(artifactDir, packed[0].filename);

  await writeFile(path.join(installDir, 'package.json'), '{"private":true}\n');
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: installDir });
  const binary = path.join(installDir, 'node_modules', '.bin', 'solidactions');
  assert((await stat(binary)).isFile(), 'packed CLI binary was not installed');

  sourceServer = await startSourceServer();
  const env = {
    ...process.env,
    HOME: homeDir,
    SOLIDACTIONS_RAW_CONTENT_BASE_URL: sourceServer.baseUrl,
  };

  assert.equal((await run(binary, ['--version'], { capture: true, env, cwd: installDir })).trim(), packageJson.version);
  await expectHelp(binary, ['login'], ['--stdin', '--global', 'masked prompt'], env, installDir);
  await expectHelp(binary, ['init'], ['--claude', '--agents', '--no-skills'], env, installDir);
  await expectHelp(binary, ['project', 'deploy'], ['--env', '<project-name>', '[path]'], env, installDir);
  await expectHelp(binary, ['run', 'start'], ['--env', '--input', '--wait'], env, installDir);
  await expectHelp(binary, ['schedule', 'set'], ['--workflow', '--timezone'], env, installDir);

  for (const target of ['claude', 'agents']) {
    const projectDir = path.join(tempRoot, `quickstart-${target}`);
    await run(binary, ['init', projectDir, `--${target}`], { env, cwd: installDir });
    await verifyScaffold(projectDir, target);
    if (target === 'agents') {
      await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: projectDir });
      await run('npm', ['run', 'build'], { cwd: projectDir });
      await run('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: projectDir });
    }
  }

  console.log(`Packed CLI ${packageJson.version} scaffolded both agent targets and built/audited the generated quickstart.`);
} finally {
  if (sourceServer) {
    await new Promise((resolve) => sourceServer.server.close(resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}
