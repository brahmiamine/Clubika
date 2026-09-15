import Link from 'next/link';
import type { ReactNode } from 'react';
import { LegalFooterLinks } from '@/app/components/legal/LegalFooterLinks';
import { LEGAL_DISCLAIMER } from '@/lib/compliance/legal-notice';

export function LegalDocument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">Clubika</Link>
          <nav className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs">
            <LegalFooterLinks className="underline-offset-2 hover:underline" separator="" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">{LEGAL_DISCLAIMER}</p>
        <article className="mt-8 space-y-6 text-sm leading-6">{children}</article>
      </main>
    </div>
  );
}
