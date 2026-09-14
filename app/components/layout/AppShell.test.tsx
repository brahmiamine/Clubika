import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell, AppShellMain } from './AppShell';

describe('AppShell', () => {
  it('verrouille la hauteur du viewport mobile et laisse défiler le contenu', () => {
    const html = renderToStaticMarkup(
      <AppShell>
        <AppShellMain>
          <p>contenu</p>
        </AppShellMain>
      </AppShell>,
    );

    expect(html).toContain('app-shell');
    expect(html).toContain('app-shell-main');
    expect(html).toContain('contenu');

    const css = readFileSync(resolve(import.meta.dirname, '../../globals.css'), 'utf8');
    expect(css).toContain('height: 100svh');
    expect(css).toContain('.app-shell-main');
    expect(css).toContain('overflow-y: auto');
  });
});
