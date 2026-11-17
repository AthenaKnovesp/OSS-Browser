import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const mode = process.argv[2];
const output = resolve('release');
await mkdir(output, { recursive: true });
if (mode === 'dir') {
  const directory = resolve(output, 'win-unpacked');
  if (relative(output, directory) !== 'win-unpacked') throw new Error('Invalid package directory');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await copyFile(
    resolve('src-tauri/target/release/oss-browser.exe'),
    resolve(directory, 'OSS Browser.exe')
  );
  console.log(directory);
} else if (mode === 'nsis') {
  const directory = resolve('src-tauri/target/release/bundle/nsis');
  const installers = (await readdir(directory)).filter((name) => name.endsWith('.exe'));
  if (installers.length === 0) throw new Error('NSIS installer was not generated');
  for (const name of installers) {
    await copyFile(resolve(directory, name), resolve(output, name));
    console.log(resolve(output, name));
  }
} else {
  throw new Error('Usage: node scripts/package.mjs dir|nsis');
}
