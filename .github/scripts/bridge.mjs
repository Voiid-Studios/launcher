// Public infrastructure only. Never print private command output or API bodies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const repository = 'Voiid-Studios/voiid-launcher';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
let publicStage = 'initialization';

export function archiveTool(platform = process.platform, systemRoot = process.env.SystemRoot) {
  // Git Bash prepends GNU tar to PATH. Its drive-letter handling treats D:\\... as a remote host.
  return platform === 'win32' ? path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

export function approveComparison(comparison, sha) {
  return /^[a-f0-9]{40}$/.test(sha) && ['ahead', 'identical'].includes(comparison.status)
    && comparison.merge_base_commit?.sha === sha;
}

export function distributionFiles(version, platform) {
  if (!versionPattern.test(version)) throw new Error('Invalid release version.');
  const labels = {'windows-x64': 'Windows-x86_64', 'macos-x64': 'macOS-Intel', 'macos-arm64': 'macOS-Silicon'};
  if (!Object.hasOwn(labels, platform)) throw new Error('Unsupported build platform.');
  const stem = `VoiidStudiosLauncher-${version}+${labels[platform]}`;
  return platform === 'windows-x64'
    ? [stem + '.exe', stem + '.exe.sig', 'latest.json']
    : [stem + '.dmg', stem + '.app.tar.gz', stem + '.app.tar.gz.sig',
      platform === 'macos-x64' ? 'latest-macos.json' : 'latest-macos-arm64.json'];
}

export function copyDistribution(input, output, files) {
  fs.mkdirSync(output, {recursive: true});
  if (fs.readdirSync(output).length) throw new Error('Export directory must be empty.');
  for (const name of files) {
    if (path.basename(name) !== name || /[\\/]/.test(name)) throw new Error('Invalid distribution filename.');
    const source = path.join(input, name), stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Invalid distributable.');
    fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL);
  }
}

export function quietRun(command, args, {cwd, log, env = process.env} = {}) {
  const descriptor = fs.openSync(log, 'a', 0o600);
  try {
    const result = spawnSync(command, args, {cwd, env, stdio: ['ignore', descriptor, descriptor], windowsHide: true});
    if (result.error || result.status !== 0) throw new Error('Private build step failed. Output was not published.');
  } finally { fs.closeSync(descriptor); }
}

async function api(endpoint, token, options = {}) {
  if (!token?.trim()) throw new Error('Required bridge credential is missing.');
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    ...options, headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('Private repository request failed. Check bridge credentials.');
  return response;
}

async function main() {
  if (!process.env.RUNNER_TEMP || process.env.GITHUB_REPOSITORY !== 'Voiid-Studios/launcher'
      || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Bridge must run from the public main workflow.');
  const temporary = path.resolve(process.env.RUNNER_TEMP);
  const root = path.join(temporary, 'voiid-bridge');
  const source = path.join(root, 'source'), desktop = path.join(source, 'desktop');
  const log = path.join(root, 'private-build.log');
  const run = (command, args, cwd = source) => quietRun(command, args, {cwd, log});
  const version = () => {
    const value = fs.readFileSync(path.join(desktop, 'VERSION'), 'utf8').trim();
    if (!versionPattern.test(value) || (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${value}`)) {
      throw new Error('Release tag and launcher version must match.');
    }
    return value;
  };
  const output = directory => fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${directory}\n`);
  const npm = (directory, ...args) => {
    const npmCli = process.platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      : path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    run(process.execPath, [npmCli, '--prefix', directory, ...args]);
  };
  const command = process.argv[2];
  publicStage = 'command';
  if (command === 'clean') {
    // Verify the fixed child of RUNNER_TEMP before recursive removal.
    if (path.dirname(root) !== temporary || path.basename(root) !== 'voiid-bridge') throw new Error('Invalid cleanup path.');
    fs.rmSync(root, {recursive: true, force: true});
    return;
  }
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  if (command === 'preflight') {
    if (!process.env.SOURCE_READ_TOKEN?.trim() || !process.env.UPDATER_PRIVATE_KEY?.trim()
        || (process.env.PUBLISH === 'true' && !process.env.CALLBACK_TOKEN?.trim())) {
      throw new Error('Required bridge credential is missing.');
    }
  } else if (command === 'download') {
    publicStage = 'source-authorization';
    const sha = process.env.SOURCE_SHA;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('An exact source commit is required.');
    const token = process.env.SOURCE_READ_TOKEN;
    const comparison = await (await api(`compare/${sha}...main?per_page=1`, token)).json();
    if (!approveComparison(comparison, sha)) throw new Error('Source commit must belong to approved main history.');
    if (fs.existsSync(source)) throw new Error('Temporary source directory already exists.');
    const archive = path.join(root, 'source.tar.gz');
    publicStage = 'source-download';
    const response = await api(`tarball/${sha}`, token);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive, {flags: 'wx', mode: 0o600}));
    fs.mkdirSync(source, {mode: 0o700});
    publicStage = 'archive-extraction';
    run(archiveTool(), ['-xzf', archive, '--strip-components=1', '-C', source], root);
    fs.rmSync(archive);
    publicStage = 'source-version';
    version();
  } else if (command === 'install') {
    publicStage = 'dependency-installation';
    if (process.arch !== process.env.EXPECTED_ARCH) throw new Error('Runner architecture mismatch.');
    npm(desktop, 'ci', '--no-audit', '--no-fund');
    npm(path.join(source, 'frontend'), 'ci', '--no-audit', '--no-fund');
    run('rustup', ['toolchain', 'install', 'stable', '--profile', 'minimal', '--no-self-update']);
    run('rustup', ['default', 'stable']);
  } else if (command === 'build') {
    publicStage = 'compilation-and-signing';
    const expected = process.platform === 'win32' ? 'windows-x64' : `macos-${process.arch}`;
    if (process.env.EXPECTED_PLATFORM !== expected) throw new Error('Runner platform mismatch.');
    if (!process.env.UPDATER_PRIVATE_KEY?.trim()) throw new Error('Original updater signing key is required.');
    const key = path.join(root, 'updater.key');
    const config = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
    fs.writeFileSync(key, process.env.UPDATER_PRIVATE_KEY.trim(), {mode: 0o600});
    fs.writeFileSync(key + '.pub', config.plugins.updater.pubkey + '\n', {mode: 0o600});
    process.env.TAURI_SIGNING_PRIVATE_KEY = key;
    delete process.env.UPDATER_PRIVATE_KEY;
    process.env.CARGO_BUILD_JOBS = String(Math.max(1, Math.min(4, os.availableParallelism(), Math.floor(os.totalmem() / (3 * 1024 ** 3)))));
    try {
      run(process.execPath, [path.join(desktop, 'scripts/tauri.mjs'), 'check-signing']);
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
    copyDistribution(input, destination, distributionFiles(version(), platform));
    output(destination);
  } else if (command === 'merge') {
    publicStage = 'manifest-merge';
    run(process.execPath, [path.join(desktop, 'scripts/merge-release.mjs')]);
    const files = ['windows-x64', 'macos-x64', 'macos-arm64'].flatMap(platform => distributionFiles(version(), platform))
      .filter(name => !name.endsWith('.sig'));
    const destination = path.join(root, 'distribution');
    copyDistribution(path.join(desktop, 'release-combined'), destination, files);
    output(destination);
  } else if (command === 'publish') {
    publicStage = 'release-publication';
    version();
    run(process.execPath, [path.join(desktop, 'scripts/publish-ci.mjs')]);
  } else if (command === 'website') {
    publicStage = 'website-notification';
    await api('actions/workflows/publish-website.yml/dispatches', process.env.CALLBACK_TOKEN,
      {method: 'POST', body: JSON.stringify({ref: 'main'})});
  } else throw new Error('Unknown bridge command.');
  console.log('Bridge step completed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {
    // Exceptions can contain source excerpts, private paths or signed archive URLs.
    console.error(`::error::Bridge step failed (${publicStage}). Private diagnostics were withheld. Check credentials, approved commit, version and signing configuration.`);
    process.exitCode = 1;
  }
}
