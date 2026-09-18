import Image from 'next/image';
import type { ReactNode } from 'react';

import { Card } from '@/app/components/ui/card';

export interface AuthShellBrand {
  name: string;
  logo?: string | null;
}

function BrandMark({ name, logo, size, className, branded }: {
  name: string;
  logo?: string | null;
  size: number;
  className?: string;
  branded?: boolean;
}) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className={className}
      />
    );
  }

  if (branded) {
    return (
      <span
        aria-hidden
        className={`flex items-center justify-center rounded-full bg-primary-foreground/15 text-sm font-bold ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <Image src="/branding/clubika-icon.png" alt="" width={size} height={size} className={className} priority />
  );
}

/**
 * Enveloppe des écrans hors session. `/login`, mot de passe oublié,
 * réinitialisation et inscription portent l'identité produit Clubika, éventuellement
 * complétée du nom public du club invité (sans logo distant, issue #34).
 */
export function AuthShell({ children, brand }: { children: ReactNode; brand?: AuthShellBrand | null }) {
  const name = brand?.name?.trim() || 'Clubika';
  const logo = brand?.logo?.trim() || null;

  return (
    <div className="grid min-h-screen lg:grid-cols-[480px_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-primary p-10 text-primary-foreground lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full border-[32px] border-white/10"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-24 h-72 w-72 rounded-full border border-white/10"
        />
        <div className="relative flex items-center gap-2.5">
          <BrandMark name={name} logo={logo} size={40} branded={Boolean(brand)} className="h-9 w-9 rounded-full object-cover" />
          <span className="text-xl font-extrabold tracking-tight">{name}</span>
        </div>
        <div className="relative flex flex-col gap-4">
          <span className="inline-flex w-fit items-center rounded-full bg-[color:var(--gold)]/15 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[color:var(--gold)]">
            Accès club
          </span>
          <h1 className="max-w-[16ch] text-3xl font-extrabold leading-tight tracking-tight">
            Le planning de votre club, enfin sous contrôle.
          </h1>
          <p className="max-w-[34ch] text-sm leading-6 text-primary-foreground/70">
            Matchs, affectations, disponibilités, chat et notifications réunis dans un seul espace pour tout le club.
          </p>
        </div>
        <p className="relative text-xs text-primary-foreground/50">© {new Date().getFullYear()} Clubika</p>
      </div>

      <div className="flex flex-col items-center justify-center gap-6 bg-secondary-soft p-4">
        <div className="flex items-center gap-2 lg:hidden">
          <BrandMark name={name} logo={logo} size={36} branded={Boolean(brand)} className="h-8 w-8 rounded-full object-cover" />
          <span className="text-lg font-extrabold tracking-tight text-foreground">{name}</span>
        </div>
        <Card className="w-full max-w-md">{children}</Card>
      </div>
    </div>
  );
}
