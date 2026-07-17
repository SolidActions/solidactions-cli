import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, '..');
const examplesDir = path.resolve(process.env.SOLIDACTIONS_EXAMPLES_DIR ?? path.join(cliDir, '..', 'examples'));
const sdkDir = path.resolve(process.env.SOLIDACTIONS_SDK_DIR ?? path.join(cliDir, '..', 'ts-sdk'));
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

async function ensureDirectory(directory, label) {
  const value = await stat(directory).catch(() => null);
  assert(value?.isDirectory(), `${label} not found at ${directory}`);
}

function safeSourcePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  assert(resolved === root || resolved.startsWith(`${root}${path.sep}`), `unsafe source path: ${relativePath}`);
  return resolved;
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
      assert(parts[2], 'missing source ref');
      const file = safeSourcePath(root, parts.slice(3).join('/'));
      const content = await readFile(file);
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

await ensureDirectory(examplesDir, 'examples checkout');
await ensureDirectory(sdkDir, 'SDK checkout');

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
