import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = '0.54.0';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installDirectory = path.join(projectRoot, '.tools', 'k6');
const executablePath = path.join(installDirectory, 'k6');
const assets: Partial<Record<string, { name: string; sha256: string; archive: 'zip' | 'tar' }>> = {
  'darwin-arm64': {
    name: `k6-v${version}-macos-arm64.zip`,
    sha256: '9fb42e1343d28fc26e6efa1269283edf39ddc20767249869c84aa333741fc3ae',
    archive: 'zip',
  },
  'darwin-x64': {
    name: `k6-v${version}-macos-amd64.zip`,
    sha256: '244ce603e3e1f0081b5b0b444de5631c22d0204ffbfa8b7f13ea6316da1f4376',
    archive: 'zip',
  },
  'linux-arm64': {
    name: `k6-v${version}-linux-arm64.tar.gz`,
    sha256: '6be08e8578af0ca79ce7d5f8f6e1adb4cae080d6752a342295260fe246655b1f',
    archive: 'tar',
  },
  'linux-x64': {
    name: `k6-v${version}-linux-amd64.tar.gz`,
    sha256: 'c7f03434854f837b6790ee81572e4b0f955241974c79a43cbb9f8d0fef069589',
    archive: 'tar',
  },
};

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    throw new Error(`Could not install pinned k6: ${command} failed.`);
  }

  return result.stdout.trim();
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  const finalUrl = new URL(response.url);
  const allowedHosts = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ]);

  if (
    !response.ok ||
    finalUrl.protocol !== 'https:' ||
    !allowedHosts.has(finalUrl.hostname)
  ) {
    throw new Error('Could not download the pinned k6 release from an approved GitHub host.');
  }

  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const asset = assets[`${process.platform}-${process.arch}`];

  if (!asset) {
    throw new Error('Pinned k6 installation supports macOS and Linux on x64 or arm64 only.');
  }

  const existing = spawnSync(executablePath, ['version'], { encoding: 'utf8' });

  if (existing.status === 0 && existing.stdout.startsWith(`k6 v${version}`)) {
    console.log(`Pinned k6 v${version} is already installed.`);
    return;
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rrdapi-k6-'));

  try {
    const archivePath = path.join(temporaryDirectory, asset.name);
    const archive = await download(`https://github.com/grafana/k6/releases/download/v${version}/${asset.name}`);
    const digest = createHash('sha256').update(archive).digest('hex');

    if (digest !== asset.sha256) {
      throw new Error('Pinned k6 archive checksum does not match the reviewed release checksum.');
    }

    await writeFile(archivePath, archive);
    let executableBytes;

    if (asset.archive === 'zip') {
      const entries = run('unzip', ['-Z1', archivePath])
        .split(/\r?\n/)
        .filter(Boolean);
      const executableEntry = entries.find((entry) => entry === 'k6' || /^[^/]+\/k6$/.test(entry));

      if (!executableEntry) {
        throw new Error('Pinned k6 archive did not contain the expected executable.');
      }

      const extracted = spawnSync('unzip', ['-p', archivePath, executableEntry], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      });

      if (extracted.error || extracted.status !== 0 || extracted.stdout.length === 0) {
        throw new Error('Could not extract the pinned k6 executable.');
      }

      executableBytes = extracted.stdout;
    } else {
      const entries = run('tar', ['-tzf', archivePath]).split(/\r?\n/).filter(Boolean);
      const executableEntry = entries.find((entry) => /^k6-v[^/]+\/k6$/.test(entry));

      if (!executableEntry) {
        throw new Error('Pinned k6 archive did not contain the expected executable.');
      }

      const extracted = spawnSync('tar', ['-xOzf', archivePath, executableEntry], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      });

      if (extracted.error || extracted.status !== 0 || extracted.stdout.length === 0) {
        throw new Error('Could not extract the pinned k6 executable.');
      }

      executableBytes = extracted.stdout;
    }

    await mkdir(installDirectory, { recursive: true });
    const stagedPath = path.join(installDirectory, 'k6.tmp');
    await writeFile(stagedPath, executableBytes);
    await chmod(stagedPath, 0o755);
    await rename(stagedPath, executablePath);

    const installed = spawnSync(executablePath, ['version'], { encoding: 'utf8' });

    if (installed.status !== 0 || !installed.stdout.startsWith(`k6 v${version}`)) {
      await rm(executablePath, { force: true });
      throw new Error('Installed k6 version did not match the pinned release.');
    }

    console.log(`Installed ${installed.stdout.trim()} at .tools/k6/k6 (archive SHA-256 verified).`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Pinned k6 installation failed.');
  process.exitCode = 1;
});
