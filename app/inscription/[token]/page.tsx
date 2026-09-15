'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { apiGet } from '@/lib/utils/api';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

/**
 * Échange le jeton d'URL contre le cookie de contexte, puis retire le secret
 * de l'historique (issue #34).
 */
export default function InscriptionTokenPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setValidationError('Ce lien d\'invitation n\'est plus valide.');
      return;
    }
    apiGet<{ valid: boolean }>(`/api/invitations/${token}`)
      .then((data) => {
        if (!data.valid) {
          setValidationError('Ce lien d\'invitation n\'est plus valide.');
          return;
        }
        router.replace('/inscription');
      })
      .catch(() => {
        setValidationError('Ce lien d\'invitation n\'est plus valide.');
      });
  }, [token, router]);

  if (validationError) {
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-secondary-soft p-4">
      <LoadingSpinner text="Vérification du lien d'invitation..." />
    </div>
  );
}
