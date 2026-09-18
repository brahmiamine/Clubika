import type { ReactNode } from 'react';

/**
 * Coquille mobile : la page défile à l’intérieur, la barre d’onglets reste
 * dans le flux en bas du viewport (100svh). `position: fixed` + `overflow-x: hidden`
 * sur `body` faisait défiler / rétrécir la barre sur iOS PWA.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell flex min-h-0 flex-col">
      {children}
    </div>
  );
}

export function AppShellMain({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell-main min-h-0">
      {children}
    </div>
  );
}
