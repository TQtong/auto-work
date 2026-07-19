import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inputPath = resolve(
  repositoryRoot,
  process.env.AUTO_WORK_SBOM_OUTPUT ?? 'dist/release/auto-work-sbom.cdx.json',
);
const packageManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));

let bom;
try {
  bom = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (error) {
  throw new Error(`SBOM 不是合法 UTF-8 JSON：${error instanceof Error ? error.message : error}`);
}

const failures = [];
if (bom.bomFormat !== 'CycloneDX') failures.push('bomFormat 必须为 CycloneDX');
if (bom.specVersion !== '1.6') failures.push('specVersion 必须固定为 1.6');
if (!/^urn:uuid:[0-9a-f-]{36}$/iu.test(bom.serialNumber ?? '')) {
  failures.push('serialNumber 必须是 CycloneDX UUID URN');
}
if (bom.metadata?.component?.name !== packageManifest.name) {
  failures.push('metadata.component.name 与根 package.json 不一致');
}
if (bom.metadata?.component?.version !== packageManifest.version) {
  failures.push('metadata.component.version 与根 package.json 不一致');
}
if (!Array.isArray(bom.components) || bom.components.length === 0) {
  failures.push('components 不能为空');
}
if (!Array.isArray(bom.dependencies) || bom.dependencies.length === 0) {
  failures.push('dependencies 不能为空');
}

const workspaceNames = new Set(
  (bom.metadata?.component?.components ?? []).map((component) => component.name),
);
for (const requiredName of ['api', 'web', 'contracts', 'domain']) {
  if (!workspaceNames.has(requiredName)) failures.push(`缺少工作区组件：${requiredName}`);
}

const knownReferences = new Set([
  bom.metadata?.component?.['bom-ref'],
  ...(bom.metadata?.component?.components ?? []).map((component) => component['bom-ref']),
  ...(bom.components ?? []).map((component) => component['bom-ref']),
]);
for (const dependency of bom.dependencies ?? []) {
  if (!knownReferences.has(dependency.ref)) {
    failures.push(`依赖图引用未知组件：${dependency.ref}`);
    break;
  }
  const unresolved = (dependency.dependsOn ?? []).find(
    (reference) => !knownReferences.has(reference),
  );
  if (unresolved) {
    failures.push(`依赖图包含无法解析的 dependsOn：${unresolved}`);
    break;
  }
}

if (failures.length > 0) {
  throw new Error(`SBOM 结构校验失败：\n- ${failures.join('\n- ')}`);
}

console.log(
  `SBOM 校验通过：CycloneDX ${bom.specVersion}，${bom.components.length} 个组件，${bom.dependencies.length} 条依赖关系。`,
);
