import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocument } from '@/app/components/legal/LegalDocument';
import {
  CNIL_COMPLAINT_URL,
  LEGAL_BASIS_BLOCKER,
  LEGAL_TRANSFERS_NOTE,
  PROCESSING_INVENTORY,
  ROLE_QUALIFICATION_BLOCKER,
} from '@/lib/compliance/legal-notice';

export const metadata: Metadata = { title: 'Confidentialité' };

export default function ConfidentialitePage() {
  return (
    <LegalDocument title="Confidentialité">
      <p>
        Cette notice décrit les traitements réellement implémentés. {LEGAL_BASIS_BLOCKER} {ROLE_QUALIFICATION_BLOCKER}
      </p>
      <p>
        Canaux d’exercice : <Link className="underline" href="/exercice-des-droits">compte ou e-mail</Link>
        {' · '}
        <Link className="underline" href="/droits-sans-compte">fiches sans compte</Link>.
        Pas de pièce d’identité numérisée. L’application n’invente ni délai légal ni refus.
      </p>
      <p>{LEGAL_TRANSFERS_NOTE}</p>

      {PROCESSING_INVENTORY.map((item) => (
        <section key={item.id}>
          <h2 className="text-lg font-semibold">{item.title}</h2>
          <dl className="mt-2 grid gap-1">
            <div><dt className="font-medium">Finalité</dt><dd>{item.purpose}</dd></div>
            <div><dt className="font-medium">Données</dt><dd>{item.data}</dd></div>
            <div><dt className="font-medium">Sources</dt><dd>{item.sources}</dd></div>
            <div><dt className="font-medium">Destinataires</dt><dd>{item.recipients}</dd></div>
            <div><dt className="font-medium">Durée (paramètre produit)</dt><dd>{item.retention}</dd></div>
            <div><dt className="font-medium">Droits</dt><dd>{item.rights}</dd></div>
            <div><dt className="font-medium">Base juridique</dt><dd>Non qualifiée.</dd></div>
          </dl>
        </section>
      ))}

      <section>
        <h2 className="text-lg font-semibold">Statistiques et suggestions automatiques</h2>
        <p className="mt-2">
          Le dashboard calcule des indicateurs de couverture et d’équité à partir des affectations du club.
          Aucun moteur de profilage commercial ni de scoring externe n’est branché. Les suggestions d’auto-affectation
          restent dans le club, d’après indisponibilités, conflits et charge.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Réclamation CNIL</h2>
        <p className="mt-2">
          <a className="underline" href={CNIL_COMPLAINT_URL}>{CNIL_COMPLAINT_URL}</a>
        </p>
      </section>
    </LegalDocument>
  );
}
