"use client";

import { logError } from '@/lib/observability/client-log';
import { Share2, Loader2 } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { Match } from "@/types/match";
import { MatchExtras } from "@/hooks/useMatchExtras";
import { Button } from "@/components/ui/button";
import { generateMatchShareImage } from "@/lib/utils/share-match-image";
import { useClubs } from "@/hooks/useClubs";
import { toast } from "sonner";
import { ShareMatchPreview } from "./ShareMatchPreview";
import { useAppSettings } from "@/hooks/useAppSettings";
import { resolveMatchLogos } from "@/lib/utils/match";

interface ShareMatchButtonProps {
  match: Match;
  extras?: MatchExtras | null;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export function ShareMatchButton({ match, extras, variant = "ghost", size = "icon", className }: ShareMatchButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const { clubs } = useClubs();
  const { settings } = useAppSettings();

  // Récupérer les logos : logos du match (scraper), club de l'utilisateur, puis
  // recherche tolérante dans la liste des clubs connus.
  const { localTeamLogo, awayTeamLogo } = resolveMatchLogos(match, clubs, {
    name: settings.clubName,
    logo: settings.clubLogo,
  });

  // Nettoyer l'URL de l'image quand le composant se démonte ou que l'image change
  useEffect(() => {
    return () => {
      if (imageBlob) {
        // L'URL sera révoquée automatiquement quand le blob change
      }
    };
  }, [imageBlob]);

  const handleShare = useCallback(async () => {
    setIsGenerating(true);
    setIsPreviewOpen(true);
    setImageBlob(null);

    try {
      const blob = await generateMatchShareImage({
        match,
        extras,
        localTeamLogo,
        awayTeamLogo,
        clubName: settings.clubName,
        clubAbbreviation: settings.clubAbbreviation,
        clubLogo: settings.clubLogo,
        primaryColor: settings.primaryColor,
        secondaryColor: settings.accentColor,
      });

      setImageBlob(blob);
      toast.success("Image générée avec succès !");
    } catch (error) {
      logError('app.unhandled', "Error generating share image:", error);
      const errorMessage = error instanceof Error ? error.message : "Erreur inconnue";
      toast.error(`Erreur lors de la génération de l'image: ${errorMessage}`);
      setIsPreviewOpen(false);
    } finally {
      setIsGenerating(false);
    }
  }, [match, extras, localTeamLogo, awayTeamLogo, settings]);

  return (
    <>
      <Button
        onClick={handleShare}
        variant={variant}
        size={size}
        className={className}
        disabled={isGenerating}
        title="Partager le match"
        aria-label="Partager le match"
      >
        {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
      </Button>
      <ShareMatchPreview open={isPreviewOpen} onOpenChange={setIsPreviewOpen} imageBlob={imageBlob} match={match} isGenerating={isGenerating} />
    </>
  );
}
