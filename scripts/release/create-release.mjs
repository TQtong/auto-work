import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const releaseRoot = resolve(repositoryRoot, 'dist/release');
const packageName = `auto-work-${rootManifest.version}`;
const packageRoot = resolve(releaseRoot, packageName);
const sbomSource = resolve(releaseRoot, 'auto-work-sbom.cdx.json');

if (!packageRoot.startsWith(`${releaseRoot}${sep}`)) throw new Error('发布目录越界');
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });

const copyEntries = [
  ['package.json', 'package.json'],
  ['pnpm-lock.yaml', 'pnpm-lock.yaml'],
  ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
  ['.env.example', '.env.example'],
  ['.env.docker.example', '.env.docker.example'],
  ['.dockerignore', '.dockerignore'],
  ['Dockerfile', 'Dockerfile'],
  ['compose.yaml', 'compose.yaml'],
  ['docker', 'docker'],
  ['README.md', 'README.md'],
  ['tsconfig.base.json', 'tsconfig.base.json'],
  ['apps/api/package.json', 'apps/api/package.json'],
  ['apps/api/nest-cli.json', 'apps/api/nest-cli.json'],
  ['apps/api/tsconfig.json', 'apps/api/tsconfig.json'],
  ['apps/api/tsconfig.build.json', 'apps/api/tsconfig.build.json'],
  ['apps/api/src', 'apps/api/src'],
  ['apps/api/dist', 'apps/api/dist'],
  ['apps/api/prisma', 'apps/api/prisma'],
  ['apps/api/scripts/prisma-cli.mjs', 'apps/api/scripts/prisma-cli.mjs'],
  ['apps/web/package.json', 'apps/web/package.json'],
  ['apps/web/index.html', 'apps/web/index.html'],
  ['apps/web/tsconfig.json', 'apps/web/tsconfig.json'],
  ['apps/web/vite.config.ts', 'apps/web/vite.config.ts'],
  ['apps/web/src', 'apps/web/src'],
  ['apps/web/dist', 'apps/web/dist'],
  ['packages/contracts/package.json', 'packages/contracts/package.json'],
  ['packages/contracts/tsconfig.json', 'packages/contracts/tsconfig.json'],
  ['packages/contracts/src', 'packages/contracts/src'],
  ['packages/contracts/dist', 'packages/contracts/dist'],
  ['packages/domain/package.json', 'packages/domain/package.json'],
  ['packages/domain/tsconfig.json', 'packages/domain/tsconfig.json'],
  ['packages/domain/src', 'packages/domain/src'],
  ['packages/domain/dist', 'packages/domain/dist'],
  ['scripts/windows', 'scripts/windows'],
  ['docs/operations', 'docs/operations'],
  [relative(repositoryRoot, sbomSource), 'SBOM.cdx.json'],
];

for (const [source, destination] of copyEntries) {
  const sourcePath = resolve(repositoryRoot, source);
  const destinationPath = resolve(packageRoot, destination);
  if (!destinationPath.startsWith(`${packageRoot}${sep}`))
    throw new Error(`发布路径越界：${destination}`);
  cpSync(sourcePath, destinationPath, { recursive: true, force: false, errorOnExist: true });
}

const migrationNames = readdirSync(resolve(repositoryRoot, 'apps/api/prisma/migrations'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const schemaChecksum = migrationNames.at(-1);
if (!schemaChecksum) throw new Error('没有找到 Prisma 迁移，禁止生成发布包');

const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const releaseManifest = {
  product: 'auto-work',
  version: rootManifest.version,
  gitCommit,
  schemaChecksum,
  generatedAt: new Date().toISOString(),
  runtime: {
    os: ['Docker Linux containers', 'Windows 10/11 x64'],
    node: '>=22.14.0 <23',
    pnpm: '10.14.0',
    binding: 'host loopback only',
  },
  entrypoints: {
    install: 'scripts/windows/Install-AutoWork.ps1',
    upgrade: 'scripts/windows/Upgrade-AutoWork.ps1',
    rollback: 'scripts/windows/Rollback-AutoWork.ps1',
    start: 'scripts/windows/Start-AutoWork.ps1',
    stop: 'scripts/windows/Stop-AutoWork.ps1',
    docker: 'docker compose up --detach --build --wait',
  },
};
writeFileSync(
  resolve(packageRoot, 'release-manifest.json'),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  'utf8',
);

const files = listFiles(packageRoot).filter((path) => relative(packageRoot, path) !== 'SHA256SUMS');
const checksumLines = files
  .map(
    (path) => `${sha256(readFileSync(path))} *${relative(packageRoot, path).replaceAll('\\', '/')}`,
  )
  .sort();
writeFileSync(resolve(packageRoot, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, 'utf8');

const zip = new JSZip();
for (const path of listFiles(packageRoot)) {
  zip.file(
    `${packageName}/${relative(packageRoot, path).replaceAll('\\', '/')}`,
    readFileSync(path),
  );
}
const zipPath = resolve(releaseRoot, `${packageName}.zip`);
writeFileSync(
  zipPath,
  await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  }),
);
writeFileSync(
  resolve(releaseRoot, `${packageName}.zip.sha256`),
  `${sha256(readFileSync(zipPath))} *${packageName}.zip\n`,
  'utf8',
);

console.log(`发布包已生成：${zipPath}`);
console.log(`文件清单：${files.length + 1} 个文件，schema ${schemaChecksum}，commit ${gitCommit}`);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .filter((path) => statSync(path).isFile());
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
