import Link from 'next/link';
import { LEGAL_PAGE_TITLES, LEGAL_PUBLIC_PATHS } from '@/lib/compliance/legal-notice';

export function LegalFooterLinks({ className, separator = ' · ' }: { className?: string; separator?: string }) {
  return (
    <>
      {LEGAL_PUBLIC_PATHS.map((href, index) => (
        <span key={href}>
          {index > 0 ? separator : null}
          <Link href={href} className={className}>{LEGAL_PAGE_TITLES[href]}</Link>
        </span>
      ))}
    </>
  );
}
