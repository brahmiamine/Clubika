'use client';

import { Copy, Share2 } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { toast } from 'sonner';

async function copyLink(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  toast.success('Lien copié');
}

interface PublicShareLinkRowProps {
  url: string;
  shareTitle?: string;
  shareText?: string;
}

async function shareLink(url: string, shareTitle: string, shareText: string): Promise<void> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url,
      });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Share failed:', error);
    }
  }

  await copyLink(url);
  toast.info('Partage natif indisponible — lien copié');
}

export function PublicShareLinkRow({
  url,
  shareTitle = 'Planning du club',
  shareText = 'Consultez le planning en lecture seule.',
}: PublicShareLinkRowProps) {
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <p className="min-w-0 break-all text-muted-foreground">{url}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void shareLink(url, shareTitle, shareText)}>
          <Share2 className="mr-2 h-4 w-4" />
          Partager
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void copyLink(url)}>
          <Copy className="mr-2 h-4 w-4" />
          Copier
        </Button>
      </div>
    </div>
  );
}
