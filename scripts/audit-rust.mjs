import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyFindings(report, windowsTree) {
  const packages = new Set(
    [...windowsTree.matchAll(/^(\S+) v(\S+)/gm)].map((match) => `${match[1]}@${match[2]}`)
  );
  const onWindows = (finding) => packages.has(`${finding.package.name}@${finding.package.version}`);
  const vulnerabilities = report.vulnerabilities.list;
  const warnings = Object.values(report.warnings ?? {}).flat();
  return {
    blocking: vulnerabilities.filter(onWindows),
    warnings: warnings.filter(onWindows),
    otherTargets: [...vulnerabilities, ...warnings].filter((finding) => !onWindows(finding))
  };
}

function main() {
  const run = (args) => {
    const result = spawnSync('cargo', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  };
  const tree = run([
    'tree',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--target',
    'x86_64-pc-windows-msvc',
    '--edges',
    'normal,build',
    '--prefix',
    'none',
    '--format',
    '{p}'
  ]);
  if (tree.status !== 0) throw new Error(tree.stderr);
  const audit = run(['audit', '--file', 'src-tauri/Cargo.lock', '--json']);
  if (!audit.stdout.trim()) {
    throw new Error(
      `${audit.stderr}\nInstall the development tool: cargo install cargo-audit --locked`
    );
  }
  const report = JSON.parse(audit.stdout);
  if (!report.vulnerabilities) throw new Error(JSON.stringify(report));
  const findings = classifyFindings(report, tree.stdout);
  for (const [category, entries] of Object.entries(findings)) {
    for (const entry of entries) {
      console.log(
        `[${category}] ${entry.advisory?.id ?? entry.kind}: ${entry.package.name}@${entry.package.version} — ${entry.advisory?.title ?? entry.kind}`
      );
    }
  }
  console.log(
    `Windows x64: ${findings.blocking.length} vulnerabilities, ${findings.warnings.length} warnings; ${findings.otherTargets.length} findings for other targets.`
  );
  if (findings.blocking.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
