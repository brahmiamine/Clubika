'use client';

import { ProfileView } from '@/app/components/profile/ProfileView';
import { PrivacyRightsView } from '@/app/components/profile/PrivacyRightsView';

// Wrapper espace club : la logique vit dans ProfileView (issue #93).
export default function ProfilPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <ProfileView />
      <PrivacyRightsView />
    </div>
  );
}
