import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../src/shared/ipc';
import zh from '../src/shared/locales/zh-CN.json';
import en from '../src/shared/locales/en-US.json';

describe('Rust and frontend contracts', () => {
  it('has a Rust DTO field for every TypeScript interface field, including optionality', () => {
    const source = ts.createSourceFile(
      'types.ts',
      readFileSync('src/shared/types.ts', 'utf8'),
      ts.ScriptTarget.Latest
    );
    const rust = readFileSync('src-tauri/src/model.rs', 'utf8');
    for (const node of source.statements) {
      if (!ts.isInterfaceDeclaration(node)) continue;
      const body = rust.match(
        new RegExp(`pub struct ${node.name.text} \\{([\\s\\S]*?)\\n\\}`)
      )?.[1];
      expect(body, node.name.text).toBeDefined();
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const field = member.name.getText(source).replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);
        const match = body!.match(new RegExp(`pub (?:r#)?${field}: ([^,\\n]+)`));
        expect(match, `${node.name.text}.${field}`).not.toBeNull();
        expect(match![1].startsWith('Option<'), `${node.name.text}.${field}`).toBe(
          Boolean(member.questionToken)
        );
      }
      expect([...body!.matchAll(/pub (?:r#)?\w+:/g)]).toHaveLength(node.members.length);
    }
  });

  it('dispatches every command and preserves all event names', () => {
    const commands = readFileSync('src-tauri/src/commands.rs', 'utf8');
    const events = Object.values(IPC_CHANNELS).filter((channel) =>
      /:(updated|added|maximized-changed)$/.test(channel)
    );
    for (const channel of Object.values(IPC_CHANNELS).filter(
      (channel) => !events.includes(channel)
    )) {
      expect(commands, channel).toContain(`"${channel}"`);
    }
    const backend =
      commands +
      readFileSync('src-tauri/src/tasks.rs', 'utf8') +
      readFileSync('src-tauri/src/logger.rs', 'utf8') +
      readFileSync('src-tauri/src/main.rs', 'utf8');
    for (const event of events) expect(backend).toContain(`"${event}"`);
  });

  it('has matching language keys and no implicit WebView2 installer', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(config.bundle.windows.webviewInstallMode).toEqual({ type: 'skip' });
    expect(config.bundle.windows.minimumWebview2Version).toBeUndefined();
  });
});
