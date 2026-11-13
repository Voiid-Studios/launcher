// Public infrastructure only. Never print private command output or API bodies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const repository = 'Voiid-Studios/voiid-launcher';
// Internal (SemVer) version produced by desktop/scripts/version.mjs from the root VERSION label.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
// Set BRIDGE_DEBUG=false in the workflow env to silence the debug lines.
const debugEnabled = process.env.BRIDGE_DEBUG !== 'false';
let publicStage = 'initialization';

// Messages of this error type are written by us and are safe to print publicly.
class PublicError extends Error {
  constructor(message) { super(message); this.name = 'PublicError'; }
}

function debug(message) {
  if (debugEnabled) console.log(`[bridge:debug] ${message}`);
}

function listEntries(directory, limit = 50) {
  try {
    const names = fs.readdirSync(directory);
    return `${names.slice(0, limit).join(', ')}${names.length > limit ? `, ... (+${names.length - limit} more)` : ''}` || '(empty)';
  } catch { return '(unreadable)'; }
}

export function archiveTool(platform = process.platform, systemRoot = process.env.SystemRoot) {
  // Git Bash prepends GNU tar to PATH. Its drive-letter handling treats D:\\... as a remote host.
  return platform === 'win32' ? path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

export function approveComparison(comparison, sha) {
  return /^[a-f0-9]{40}$/.test(sha) && ['ahead', 'identical'].includes(comparison.status)
    && comparison.merge_base_commit?.sha === sha;
}

export function distributionFiles(version, platform) {
  if (!versionPattern.test(version)) throw new PublicError('Invalid release version.');
  const labels = {'windows-x64': 'Windows-x86_64', 'macos-x64': 'macOS-Intel', 'macos-arm64': 'macOS-Silicon'};
  if (!Object.hasOwn(labels, platform)) throw new PublicError('Unsupported build platform.');
  const stem = `VoiidStudiosLauncher-${version}+${labels[platform]}`;
  return platform === 'windows-x64'
    ? [stem + '.exe', stem + '.exe.sig', 'latest.json']
    : [stem + '.dmg', stem + '.app.tar.gz', stem + '.app.tar.gz.sig',
      platform === 'macos-x64' ? 'latest-macos.json' : 'latest-macos-arm64.json'];
}

export function copyDistribution(input, output, files) {
  debug(`Copying distribution: ${files.length} expected file(s).`);
  fs.mkdirSync(output, {recursive: true});
  if (fs.readdirSync(output).length) throw new PublicError('Export directory must be empty.');
  for (const name of files) {
    if (path.basename(name) !== name || /[\\/]/.test(name)) throw new PublicError('Invalid distribution filename.');
    const source = path.join(input, name);
    let stat;
    try { stat = fs.lstatSync(source); }
    catch {
      debug(`Missing distributable: ${name}`);
      debug(`Input directory entries: ${listEntries(input)}`);
      throw new PublicError(`Missing distributable file: ${name}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      debug(`Invalid distributable ${name}: isFile=${stat.isFile()}, symlink=${stat.isSymbolicLink()}, size=${stat.size}`);
      throw new PublicError(`Invalid distributable: ${name}`);
    }
    debug(`Copying ${name} (${stat.size} bytes).`);
    fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL);
  }
}

export function quietRun(command, args, {cwd, log, env = process.env, allowedExitCodes = [0]} = {}) {
  const descriptor = fs.openSync(log, 'a', 0o600);
  const offset = fs.fstatSync(descriptor).size;
  try {
    const result = spawnSync(command, args, {cwd, env, stdio: ['ignore', descriptor, descriptor], windowsHide: true});
    if (result.error || !allowedExitCodes.includes(result.status)) {
      // Only the tool name and exit information are public; its output stays in the private log.
      debug(`Command "${path.basename(String(command))}" failed: status=${result.status}, signal=${result.signal ?? 'none'}, spawnErrorCode=${result.error?.code ?? 'none'}`);
      // Opt-in only (BRIDGE_DEBUG_LOG=true): prints the tail of this command's output. It can contain
      // private source excerpts or paths, so enable it only temporarily and disable it afterwards.
      if (process.env.BRIDGE_DEBUG_LOG === 'true') {
        const tail = fs.readFileSync(log, 'utf8').slice(offset).split(/\r?\n/).filter(Boolean).slice(-40);
        console.log('[bridge:debug] ---- tail of failed command output (BRIDGE_DEBUG_LOG=true) ----');
        for (const line of tail) console.log(`[bridge:debug] | ${line.slice(0, 300)}`);
        console.log('[bridge:debug] ---- end of tail ----');
      }
      throw new PublicError('Private build step failed. Output was not published.');
    }
    return result.status;
  } finally { fs.closeSync(descriptor); }
}

async function api(endpoint, token, options = {}) {
  if (!token?.trim()) throw new PublicError('Required bridge credential is missing.');
  const label = endpoint.replace(/[a-f0-9]{40}/g, '<sha>');
  debug(`GitHub API request: ${options.method ?? 'GET'} ${label}`);
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    ...options, headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(120000),
  });
  debug(`GitHub API response: HTTP ${response.status} for ${label}`);
  if (!response.ok) throw new PublicError(`Private repository request failed (HTTP ${response.status} on ${label}). Check bridge credentials.`);
  return response;
}

// Reads the root VERSION label, derives the internal version exactly like the build does
// (desktop/scripts/version.mjs) and validates it. Prints public-safe diagnostics.
async function readVersion(source, desktop) {
  const file = path.join(source, 'VERSION');
  debug('Looking for VERSION at <source>/VERSION');
  if (!fs.existsSync(file)) {
    debug(`VERSION not found at the source root. Source root entries: ${listEntries(source)}`);
    throw new PublicError('VERSION file not found at the source root.');
  }
  const buffer = fs.readFileSync(file);
  debug(`VERSION size: ${buffer.length} byte(s); first bytes (hex): ${buffer.subarray(0, 8).toString('hex') || '(none)'}`);
  const label = buffer.toString('utf8').trim();
  if (process.argv[2] !== 'website-download' && label.toUpperCase().endsWith('INDEV')) {
    throw new PublicError('INDEV versions are private and cannot be built or published on GitHub.');
  }
  debug(`VERSION label: ${JSON.stringify(label.slice(0, 80))} (length ${label.length})`);
  let value;
  try {
    const {readVersion: internalVersion} = await import(pathToFileURL(path.join(desktop, 'scripts/version.mjs')).href);
    value = internalVersion(desktop);
  } catch (error) {
    // version.mjs messages come from the private source; only the error type and code are public.
    debug(`version.mjs failed: ${error?.name ?? 'unknown'} ${error?.code ?? ''}`.trim());
    throw new PublicError('The internal version could not be derived from VERSION (desktop/scripts/version.mjs rejected it).');
  }
  debug(`Internal version: ${JSON.stringify(value)}`);
  if (!versionPattern.test(value)) throw new PublicError(`Internal version ${JSON.stringify(String(value).slice(0, 80))} is not valid SemVer.`);
  const tag = process.env.RELEASE_TAG;
  debug(`RELEASE_TAG: ${JSON.stringify(tag ?? '')}; expected when set: v${value}`);
  if (tag && tag !== `v${value}`) {
    throw new PublicError(`release_tag ${JSON.stringify(tag)} does not match the internal version (expected v${value}).`);
  }
  debug(`Version accepted: ${value}`);
  return value;
}

async function main() {
  debug(`Node ${process.version} on ${process.platform}/${process.arch}; command: ${process.argv[2] ?? '(none)'}`);
  debug(`Env: GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY ?? '(unset)'}, GITHUB_REF=${process.env.GITHUB_REF ?? '(unset)'}, RUNNER_TEMP set=${Boolean(process.env.RUNNER_TEMP)}`);
  if (!process.env.RUNNER_TEMP || process.env.GITHUB_REPOSITORY !== 'Voiid-Studios/launcher'
      || process.env.GITHUB_REF !== 'refs/heads/main') throw new PublicError('Bridge must run from the public main workflow.');
  const temporary = path.resolve(process.env.RUNNER_TEMP);
  const root = path.join(temporary, 'voiid-bridge');
  const source = path.join(root, 'source'), desktop = path.join(source, 'desktop');
  const log = path.join(root, 'private-build.log');
  const run = (command, args, cwd = source) => quietRun(command, args, {cwd, log});
  const version = async () => readVersion(source, desktop);
  const output = directory => fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${directory}\n`);
  const npm = (directory, ...args) => {
    const npmCli = process.platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      : path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    debug(`npm ${args.slice(0, 2).join(' ')} (cli exists: ${fs.existsSync(npmCli)})`);
    run(process.execPath, [npmCli, '--prefix', directory, ...args]);
  };
  const command = process.argv[2];
  publicStage = 'command';
  if (command === 'clean') {
    // Verify the fixed child of RUNNER_TEMP before recursive removal.
    if (path.dirname(root) !== temporary || path.basename(root) !== 'voiid-bridge') throw new PublicError('Invalid cleanup path.');
    fs.rmSync(root, {recursive: true, force: true});
    debug('Temporary bridge directory removed.');
    return;
  }
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  if (command === 'preflight') {
    const checks = {
      SOURCE_READ_TOKEN: Boolean(process.env.SOURCE_READ_TOKEN?.trim()),
      UPDATER_PRIVATE_KEY: Boolean(process.env.UPDATER_PRIVATE_KEY?.trim()),
      APP_ID: Boolean(process.env.APP_ID?.trim()),
      APP_PRIVATE_KEY: Boolean(process.env.APP_PRIVATE_KEY?.trim()),
    };
    debug(`Credentials present: ${Object.entries(checks).map(([name, ok]) => `${name}=${ok}`).join(', ')}; PUBLISH=${process.env.PUBLISH}`);
    if (!checks.SOURCE_READ_TOKEN || !checks.UPDATER_PRIVATE_KEY
        || (process.env.PUBLISH === 'true' && (!checks.APP_ID || !checks.APP_PRIVATE_KEY))) {
      const missing = Object.entries(checks)
        .filter(([name, ok]) => !ok && (process.env.PUBLISH === 'true' || !name.startsWith('APP_')))
        .map(([name]) => name);
      throw new PublicError(`Required bridge credential is missing: ${missing.join(', ')}.`);
    }
  } else if (command === 'download' || command === 'website-download') {
    publicStage = 'source-authorization';
    const token = process.env.SOURCE_READ_TOKEN;
    // A standalone website refresh resolves main once; subsequent downloads use that immutable SHA.
    const sha = command === 'website-download' && !process.env.SOURCE_SHA?.trim()
      ? (await (await api('commits/main', token)).json()).sha : process.env.SOURCE_SHA;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new PublicError('An exact source commit is required (40 lowercase hexadecimal characters).');
    debug(`Source SHA: ${sha}`);
    const comparison = await (await api(`compare/${sha}...main?per_page=1`, token)).json();
    debug(`Comparison status: ${comparison.status}; merge base matches SHA: ${comparison.merge_base_commit?.sha === sha}`);
    if (!approveComparison(comparison, sha)) throw new PublicError(`Source commit must belong to approved main history (comparison status: ${comparison.status}).`);
    if (fs.existsSync(source)) throw new PublicError('Temporary source directory already exists.');
    const archive = path.join(root, 'source.tar.gz');
    publicStage = 'source-download';
    const response = await api(`tarball/${sha}`, token);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive, {flags: 'wx', mode: 0o600}));
    debug(`Source archive downloaded: ${fs.statSync(archive).size} bytes.`);
    fs.mkdirSync(source, {mode: 0o700});
    publicStage = 'archive-extraction';
    debug(`Extracting with: ${archiveTool()}`);
    run(archiveTool(), ['-xzf', archive, '--strip-components=1', '-C', source], root);
    fs.rmSync(archive);
    debug(`Source root entries after extraction: ${listEntries(source)}`);
    publicStage = 'source-version';
    await version();
    if (command === 'download' && process.env.GITHUB_OUTPUT) {
      const label = fs.readFileSync(path.join(source, 'VERSION'), 'utf8').trim();
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `channel=${label.toUpperCase().endsWith('PTB') ? 'beta' : 'stable'}\n`);
    }
  } else if (command === 'install') {
    publicStage = 'dependency-installation';
    debug(`Runner arch: ${process.arch}; expected: ${process.env.EXPECTED_ARCH}`);
    if (process.arch !== process.env.EXPECTED_ARCH) throw new PublicError(`Runner architecture mismatch (got ${process.arch}, expected ${process.env.EXPECTED_ARCH}).`);
    npm(desktop, 'ci', '--no-audit', '--no-fund');
    npm(path.join(source, 'frontend'), 'ci', '--no-audit', '--no-fund');
    run('rustup', ['toolchain', 'install', 'stable', '--profile', 'minimal', '--no-self-update']);
    run('rustup', ['default', 'stable']);
  } else if (command === 'build') {
    publicStage = 'compilation-and-signing';
    await version();
    const expected = process.platform === 'win32' ? 'windows-x64' : `macos-${process.arch}`;
    debug(`Runner platform: ${expected}; expected: ${process.env.EXPECTED_PLATFORM}`);
    if (process.env.EXPECTED_PLATFORM !== expected) throw new PublicError(`Runner platform mismatch (got ${expected}, expected ${process.env.EXPECTED_PLATFORM}).`);
    if (!process.env.UPDATER_PRIVATE_KEY?.trim()) throw new PublicError('Original updater signing key is required.');
    const key = path.join(root, 'updater.key');
    const configPath = path.join(desktop, 'src-tauri/tauri.conf.json');
    debug(`tauri.conf.json exists: ${fs.existsSync(configPath)}`);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    debug(`tauri.conf.json version: ${JSON.stringify(config.version ?? null)}; updater pubkey present: ${Boolean(config.plugins?.updater?.pubkey)}`);
    fs.writeFileSync(key, process.env.UPDATER_PRIVATE_KEY.trim(), {mode: 0o600});
    fs.writeFileSync(key + '.pub', config.plugins.updater.pubkey + '\n', {mode: 0o600});
    process.env.TAURI_SIGNING_PRIVATE_KEY = key;
    delete process.env.UPDATER_PRIVATE_KEY;
    process.env.CARGO_BUILD_JOBS = String(Math.max(1, Math.min(4, os.availableParallelism(), Math.floor(os.totalmem() / (3 * 1024 ** 3)))));
    debug(`CARGO_BUILD_JOBS=${process.env.CARGO_BUILD_JOBS}`);
    try {
      debug('Running signing check.');
      run(process.execPath, [path.join(desktop, 'scripts/tauri.mjs'), 'check-signing']);
      debug(`Running npm script: ${process.platform === 'win32' ? 'dist:win' : 'dist:mac'}`);
      npm(desktop, 'run', process.platform === 'win32' ? 'dist:win' : 'dist:mac');
    } finally {
      fs.rmSync(key, {force: true});
      fs.rmSync(key + '.pub', {force: true});
    }
  } else if (command === 'export') {
    publicStage = 'distribution-export';
    const platform = process.env.EXPECTED_PLATFORM;
    const input = path.join(desktop, 'release', ...(platform === 'windows-x64' ? [] : [platform]));
    const destination = path.join(root, 'distribution');
    debug(`Export platform: ${platform}; release directory entries: ${listEntries(input)}`);
    copyDistribution(input, destination, distributionFiles(await version(), platform));
    output(destination);
  } else if (command === 'merge') {
    publicStage = 'manifest-merge';
    run(process.execPath, [path.join(desktop, 'scripts/merge-release.mjs')]);
    const releaseVersion = await version();
    const files = ['windows-x64', 'macos-x64', 'macos-arm64'].flatMap(platform => distributionFiles(releaseVersion, platform))
      .filter(name => !name.endsWith('.sig'));
    const destination = path.join(root, 'distribution');
    debug(`Combined release directory entries: ${listEntries(path.join(desktop, 'release-combined'))}`);
    copyDistribution(path.join(desktop, 'release-combined'), destination, files);
    output(destination);
  } else if (command === 'publish') {
    publicStage = 'release-publication';
    await version();
    run(process.execPath, [path.join(desktop, 'scripts/publish-ci.mjs')]);
  } else if (command === 'website-key') {
    publicStage = 'website-app-configuration';
    const {prepareAppKey} = await import(pathToFileURL(path.join(source, 'website/scripts/prepare-app-key.mjs')).href);
    // This helper masks the normalized PEM before returning it as a step output.
    prepareAppKey();
  } else if (command === 'website-build') {
    publicStage = 'website-build-and-routing-tests';
    npm(path.join(source, 'website'), 'run', 'build');
    npm(path.join(source, 'website'), 'test');
  } else if (command === 'website-sync') {
    publicStage = 'website-publication';
    if (!process.env.GITHUB_WORKSPACE) throw new PublicError('Missing public workspace.');
    const workspace = path.resolve(process.env.GITHUB_WORKSPACE);
    const hub = path.join(workspace, 'pages-hub');
    // Only reset the dedicated pages-hub checkout, never the private source tree.
    if (path.dirname(hub) !== workspace || fs.lstatSync(hub).isSymbolicLink()) throw new PublicError('Invalid hub checkout.');
    run('git', ['config', 'user.name', 'pages-hub-writer[bot]'], hub);
    run('git', ['config', 'user.email', 'pages-hub-writer[bot]@users.noreply.github.com'], hub);
    for (let attempt = 0; attempt < 5; attempt++) {
      debug(`Website sync attempt ${attempt + 1}/5.`);
      run('git', ['fetch', 'origin', 'main'], hub);
      run('git', ['reset', '--hard', 'origin/main'], hub);
      run(process.execPath, [path.join(source, 'website/scripts/sync-pages.mjs'), '--hub', hub]);
      run('git', ['add', 'launcher', 'functions/launcher/download.js', '_routes.json', '_redirects'], hub);
      const unchanged = quietRun('git', ['diff', '--cached', '--quiet'], {cwd: hub, log, allowedExitCodes: [0, 1]}) === 0;
      if (unchanged) { debug('No website changes to publish.'); break; }
      run('git', ['commit', '-m', 'launcher: update website and latest stable installers'], hub);
      try { run('git', ['push', 'origin', 'HEAD:main'], hub); break; }
      catch { if (attempt === 4) throw new PublicError('Concurrent hub update did not converge.'); }
    }
  } else throw new PublicError(`Unknown bridge command: ${JSON.stringify(String(command ?? ''))}`);
  console.log('Bridge step completed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    // Only PublicError messages are printed. Other exceptions can contain source excerpts,
    // private paths or signed archive URLs, so just their type and code are exposed.
    const reason = error instanceof PublicError ? error.message : 'Private diagnostics were withheld.';
    if (!(error instanceof PublicError)) {
      debug(`Unexpected error type: ${error?.name ?? 'unknown'}; code: ${error?.code ?? 'n/a'}`);
    }
    console.error(`::error::Bridge step failed (${publicStage}). ${reason} Check credentials, approved commit, version and signing configuration.`);
    process.exitCode = 1;
  }
}
