import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/package.mjs');
const directories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oss-browser-package-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error('Invalid test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release packaging', () => {
  it('replaces the directory package without carrying over old Electron files', () => {
    const directory = workspace();
    const source = join(directory, 'src-tauri/target/release');
    const output = join(directory, 'release/win-unpacked');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(output, 'resources'), { recursive: true });
    writeFileSync(join(source, 'oss-browser.exe'), 'Tauri v1', 'utf8');
    writeFileSync(join(output, 'chrome_100_percent.pak'), 'old runtime', 'utf8');
    writeFileSync(join(output, 'resources/app.asar'), 'old app', 'utf8');
    for (const version of ['Tauri v1', 'Tauri v2']) {
      writeFileSync(join(source, 'oss-browser.exe'), version, 'utf8');
      execFileSync(process.execPath, [script, 'dir'], { cwd: directory });
      expect(readdirSync(output)).toEqual(['OSS Browser.exe']);
      expect(readFileSync(join(output, 'OSS Browser.exe'), 'utf8')).toBe(version);
    }
  });

  it('copies only generated NSIS installers', () => {
    const directory = workspace();
    const source = join(directory, 'src-tauri/target/release/bundle/nsis');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'setup.exe'), 'installer', 'utf8');
    writeFileSync(join(source, 'debug.txt'), 'build log', 'utf8');
    execFileSync(process.execPath, [script, 'nsis'], { cwd: directory });
    expect(readdirSync(join(directory, 'release'))).toEqual(['setup.exe']);
  });
});
