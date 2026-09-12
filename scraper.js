import {
  loadSportCoricoClubPlanning,
} from "./app/lib/scraper/sportcorico-api.mapper.ts";
import { sportCoricoClubPageUrl } from "./app/lib/scraper/sportcorico-api.client.ts";
import { resolveMatchesUrlKey } from "./app/lib/scraper/sportcorico-parser.js";

const SCRAPER_RESULT_PREFIX = "__CLUBIKA_SCRAPER_RESULT__=";

let matchesUrlKey;
try {
  matchesUrlKey = resolveMatchesUrlKey(process.env.SCRAPER_MATCHES_URL_KEY);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

const scraperClubName = typeof process.env.SCRAPER_CLUB_NAME === "string" ? process.env.SCRAPER_CLUB_NAME.trim() : "";
const clubPageUrl = sportCoricoClubPageUrl(matchesUrlKey);

async function scrapeMatches() {
  console.log("🚀 Démarrage du scraper SportCorico API...\n");
  console.log(`📄 Source club: ${clubPageUrl}`);
  console.log(`🔌 API club: /api/clubs/${matchesUrlKey}\n`);

  try {
    const startTime = Date.now();
    const { club, matches, errors } = await loadSportCoricoClubPlanning({
      matchesUrlKey,
      configuredClubName: scraperClubName,
    });

    console.log(`🏆 Club: ${club.name || "Non trouvé"}`);
    console.log(`📝 Description: ${club.description || "Non trouvé"}`);
    console.log(`📸 Logo: ${club.logo || "Non trouvé"}`);
    console.log(`✅ ${matches.length} matchs récupérés`);
    if (errors.length > 0) {
      console.log(`⚠️  ${errors.length} match(s) ignoré(s)`);
      for (const error of errors) {
        console.error(`    ❌ ${error.slug || "match"}: ${error.message}`);
      }
    }

    const matchesData = {};
    for (const match of matches) {
      const date = match.date || "Date inconnue";
      if (!matchesData[date]) {
        matchesData[date] = [];
      }
      matchesData[date].push(match);
    }

    const jsonData = {
      club,
      url: clubPageUrl,
      scrapedAt: new Date().toISOString(),
      matches: matchesData,
    };

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n⏱️  Temps total: ${duration} secondes`);
    console.log(`${SCRAPER_RESULT_PREFIX}${JSON.stringify(jsonData)}`);
    console.log("\n✅ Scraping terminé avec succès !");
    console.log(`📊 Total: ${matches.length} matchs traités\n`);
  } catch (error) {
    console.error("❌ Erreur lors du scraping:", error);
    process.exit(1);
  }
}

scrapeMatches();
