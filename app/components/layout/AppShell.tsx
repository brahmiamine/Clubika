'use client';

import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from 'react';
import { usePathname } from 'next/navigation';

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

const SCROLL_HISTORY_LIMIT = 40;

export function AppShellMain({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const popped = useRef(false);

  useLayoutEffect(() => {
    const onPopState = () => {
      popped.current = true;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const restore = popped.current;
    popped.current = false;
    node.scrollTop = restore ? (positions.current.get(pathname) ?? 0) : 0;
  }, [pathname]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const map = positions.current;
    map.set(pathname, event.currentTarget.scrollTop);
    if (map.size <= SCROLL_HISTORY_LIMIT) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined && oldest !== pathname) map.delete(oldest);
  };

  return (
    <div ref={ref} className="app-shell-main min-h-0" onScroll={onScroll}>
      {children}
    </div>
  );
}
