import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gitOutput = execFileSync('git', ['ls-files', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
const trackedFiles = gitOutput.split('\0').filter(Boolean);

const prohibitedNames = new Set(['.env', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519']);
const prohibitedExtensions = new Set(['.p12', '.pfx', '.key']);
const signatures = [
  [
    'PEM 私钥',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ],
  ['GitLab Access Token', /glpat-[A-Za-z0-9_-]{20,}/u],
  ['GitHub Token', /gh[pousr]_[A-Za-z0-9]{36,}/u],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/u],
  ['Google API Key', /AIza[0-9A-Za-z_-]{35}/u],
  ['Slack Token', /xox[baprs]-[0-9A-Za-z-]{20,}/u],
];
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.prisma',
  '.ps1',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const findings = [];
for (const relativePath of trackedFiles) {
  const fileName = basename(relativePath).toLowerCase();
  const extension = extname(fileName);
  if (
    (prohibitedNames.has(fileName) && fileName !== '.env.example') ||
    prohibitedExtensions.has(extension)
  ) {
    findings.push(`${relativePath}: 禁止提交凭证文件`);
    continue;
  }
  if (!textExtensions.has(extension) && fileName !== 'dockerfile') continue;

  const content = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
  for (const [label, pattern] of signatures) {
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split(/\r?\n/u).length;
    findings.push(`${relativePath}:${line}: 检测到 ${label}`);
  }
}

if (findings.length > 0) {
  throw new Error(`秘密扫描失败：\n- ${findings.join('\n- ')}`);
}

console.log(`秘密扫描通过：已检查 ${trackedFiles.length} 个 Git 跟踪文件。`);
