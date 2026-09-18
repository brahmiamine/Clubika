import type { Metadata } from 'next';
import { LegalDocument } from '@/app/components/legal/LegalDocument';
import { CGU_SECTIONS, LEGAL_HUMAN_REVIEW } from '@/lib/compliance/legal-notice';

export const metadata: Metadata = { title: 'Conditions d’utilisation' };

export default function CguPage() {
  return (
    <LegalDocument title="Conditions d’utilisation">
      <p>{LEGAL_HUMAN_REVIEW} Une simple lecture de cette page ne vaut pas contrat signé.</p>
      {CGU_SECTIONS.map((section) => (
        <section key={section.title}>
          <h2 className="text-lg font-semibold">{section.title}</h2>
          <p className="mt-2">{section.body}</p>
        </section>
      ))}
    </LegalDocument>
  );
}
