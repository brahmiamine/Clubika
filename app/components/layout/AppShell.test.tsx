/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockPathname = '/mon-planning';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

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

  it('remet le scroll en haut à une navigation avant, et le restaure au retour', () => {
    mockPathname = '/mon-planning';
    const screen = render(
      <AppShellMain>
        <div>page-a</div>
      </AppShellMain>,
    );
    const main = screen.container.querySelector('.app-shell-main');
    expect(main).toBeTruthy();
    if (!(main instanceof HTMLElement)) throw new Error('expected scroll container');

    main.scrollTop = 420;
    main.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(main.scrollTop).toBe(420);

    mockPathname = '/mon-planning/profil';
    screen.rerender(
      <AppShellMain>
        <div>page-b</div>
      </AppShellMain>,
    );
    expect(main.scrollTop).toBe(0);

    window.dispatchEvent(new PopStateEvent('popstate'));
    mockPathname = '/mon-planning';
    screen.rerender(
      <AppShellMain>
        <div>page-a</div>
      </AppShellMain>,
    );
    expect(main.scrollTop).toBe(420);
  });
});
