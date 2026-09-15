'use client';

import { useEffect, useState } from 'react';
import { CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { apiGet } from '@/lib/utils/api';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { InscriptionForm, type InvitationPublicView } from './InscriptionForm';

export default function InscriptionContextPage() {
  const [invitation, setInvitation] = useState<InvitationPublicView | null>(null);
  const [isValidating, setIsValidating] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<InvitationPublicView>('/api/invitations/context')
      .then((data) => {
        if (!data.valid) {
          setValidationError('Ce lien d\'invitation n\'est plus valide.');
          return;
        }
        setInvitation(data);
      })
      .catch(() => {
        setValidationError('Ce lien d\'invitation n\'est plus valide.');
      })
      .finally(() => setIsValidating(false));
  }, []);

  if (isValidating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-secondary-soft p-4">
        <LoadingSpinner text="Vérification du lien d'invitation..." />
      </div>
    );
  }

  if (validationError || !invitation?.valid) {
    return (
      <AuthShell>
        <CardHeader>
          <CardTitle className="text-center">Lien invalide</CardTitle>
          <CardDescription className="text-center">
            Ce lien d&apos;invitation n&apos;est plus valide.
          </CardDescription>
        </CardHeader>
      </AuthShell>
    );
  }

  return <InscriptionForm invitation={invitation} />;
}
