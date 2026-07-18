import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = resolve(
  repositoryRoot,
  process.env.AUTO_WORK_SBOM_OUTPUT ?? 'dist/release/auto-work-sbom.cdx.json',
);
const cdxgenEntrypoint = resolve(repositoryRoot, 'node_modules/@cyclonedx/cdxgen/bin/cdxgen.js');

mkdirSync(dirname(outputPath), { recursive: true });

// 直接调用固定版本的 Node 入口，避免 Windows cmd 转义和 PATH 劫持。
const result = spawnSync(
  process.execPath,
  [
    cdxgenEntrypoint,
    '-t',
    'js',
    '--recurse',
    '--no-install-deps',
    '--fail-on-error',
    '--spec-version',
    '1.6',
    '--json-pretty',
    '--output',
    outputPath,
    repositoryRoot,
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`CycloneDX SBOM 已生成：${outputPath}`);
