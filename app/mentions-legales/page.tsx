import type { Metadata } from 'next';
import { LegalDocument } from '@/app/components/legal/LegalDocument';
import {
  CNIL_COMPLAINT_URL,
  DPO_BLOCKER,
  LEGAL_IDENTITY_INCOMPLETE,
  ROLE_QUALIFICATION_BLOCKER,
  readLegalPublisherIdentity,
} from '@/lib/compliance/legal-notice';

export const metadata: Metadata = { title: 'Mentions légales' };

export default function MentionsLegalesPage() {
  const publisher = readLegalPublisherIdentity();

  return (
    <LegalDocument title="Mentions légales">
      {!publisher.complete && <p>{LEGAL_IDENTITY_INCOMPLETE}</p>}

      <section>
        <h2 className="text-lg font-semibold">Éditeur</h2>
        {publisher.complete ? (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>{publisher.name}{publisher.legalForm ? ` — ${publisher.legalForm}` : ''}</li>
            <li>{publisher.address}</li>
            <li>Contact : {publisher.email}{publisher.phone ? ` — ${publisher.phone}` : ''}</li>
          </ul>
        ) : (
          <p className="mt-2">Aucun nom, adresse ou e-mail d’éditeur n’est publié tant que les variables LEGAL_PUBLISHER_* ne sont pas posées. Aucune identité n’est inventée.</p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Directeur de la publication</h2>
        <p className="mt-2">Non désigné dans le logiciel. L’exploitant du déploiement doit l’indiquer hors de cette page s’il y est tenu.</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Hébergement</h2>
        {publisher.hostingProvider ? (
          <p className="mt-2">
            Prestataire déclaré par l’exploitant : {publisher.hostingProvider}
            {publisher.hostingCountry ? ` (localisation déclarée : ${publisher.hostingCountry})` : ''}.
          </p>
        ) : (
          <p className="mt-2">L’hébergeur n’est pas renseigné (LEGAL_HOSTING_PROVIDER). Le code ne suppose ni un cloud ni un pays.</p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Rôles RGPD</h2>
        <p className="mt-2">{ROLE_QUALIFICATION_BLOCKER}</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Délégué à la protection des données</h2>
        <p className="mt-2">{DPO_BLOCKER}</p>
        {publisher.dpoEmail ? <p className="mt-2">Contact DPO configuré : {publisher.dpoEmail}</p> : null}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Réclamation</h2>
        <p className="mt-2">
          Vous pouvez saisir la CNIL : <a className="underline" href={CNIL_COMPLAINT_URL}>{CNIL_COMPLAINT_URL}</a>
        </p>
      </section>
    </LegalDocument>
  );
}
