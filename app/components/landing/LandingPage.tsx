'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import styles from './landing.module.css';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { homePathForAccessRole } from '@/lib/auth/roles';
import { isStandaloneDisplay } from '@/lib/pwa/display-mode';

interface Feature {
  num: string;
  title: string;
  copy: string;
}

interface Role {
  tag: string;
  name: string;
  copy: string;
}

interface SecurityItem {
  title: string;
  copy: string;
}

interface FaqItem {
  q: string;
  a: string;
}

const NAV_LINKS = [
  { href: '#fonctionnalites', label: 'Fonctionnalités' },
  { href: '#roles', label: 'Rôles' },
  { href: '#securite', label: 'Sécurité' },
  { href: '#faq', label: 'FAQ' },
];

const FEATURES: Feature[] = [
  {
    num: '01',
    title: 'Planning unifié',
    copy: 'Matchs officiels synchronisés par scraping, matchs amicaux, entraînements et plateaux. Vues carte, liste et calendrier, événements récurrents, duplication et modèles, avec un cycle clair brouillon → publié → modifié → annulé.',
  },
  {
    num: '02',
    title: 'Affectations & échanges',
    copy: "Affectation des arbitres, encadrants et accompagnateurs avec identité stable. Acceptation ou refus motivé, échanges entre utilisateurs validés par un administrateur, auto-affectation qui tient compte des indisponibilités, conflits et charge.",
  },
  {
    num: '03',
    title: 'Pilotage opérationnel',
    copy: "Dashboard administrateur avec alertes, charge, météo et historique. Suivi présent / excusé / absent / remplacé, statistiques de couverture et d'équité.",
  },
  {
    num: '04',
    title: 'Notifications multicanal',
    copy: 'In-app, Web Push sur smartphone via la PWA, email et WhatsApp — avec des préférences de canal et d\'urgence propres à chaque utilisateur.',
  },
];

const ROLES: Role[] = [
  {
    tag: 'Écriture',
    name: 'Administrateur',
    copy: "Seul rôle d'écriture : planning, référentiels, utilisateurs, invitations, dashboard et configuration du club.",
  },
  {
    tag: 'Terrain',
    name: 'Arbitre',
    copy: 'Ses affectations publiées, ses disponibilités, ses préférences et ses échanges, en lecture seule.',
  },
  {
    tag: 'Terrain',
    name: 'Encadrant',
    copy: 'Suivi de ses événements, de ses disponibilités et des espaces événement auxquels il est affecté.',
  },
  {
    tag: 'Terrain',
    name: 'Accompagnateur',
    copy: 'Un espace dédié à ses propres affectations, sans accès aux données des autres membres.',
  },
];

const CHAT_FACTS: string[] = [
  'Conversations privées entre deux utilisateurs actifs du même club.',
  'Un chat attaché à chaque événement publié, lisible par tous les affectés.',
  'Canaux de groupe créés par un administrateur, avec liste de participants.',
  'Reprise après reconnexion, déduplication des messages, accusés ✓ envoyé / ✓✓ lu.',
];

const SECURITY_ITEMS: SecurityItem[] = [
  {
    title: 'Chiffrement au repos',
    copy: 'Messages de chat et mots de passe SMTP chiffrés en AES-256-GCM.',
  },
  {
    title: 'Partage public maîtrisé',
    copy: 'Seul le SHA-256 du lien de partage est enregistré ; les données exposées se limitent au calendrier.',
  },
  {
    title: 'Isolation par club',
    copy: "Chaque enregistrement est isolé par clubId, avec contrôle d'accès à chaque lecture et écriture.",
  },
  {
    title: 'Export sans risque',
    copy: "Export CSV protégé contre l'injection de formules tableur.",
  },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    q: 'Clubika gère-t-il plusieurs clubs ?',
    a: "Oui. Chaque club dispose de ses propres données, réglages et administrateurs, isolés les uns des autres. Un compte plateforme distinct supervise l'ensemble des clubs.",
  },
  {
    q: "Quels rôles existent dans l'application ?",
    a: "Quatre rôles : administrateur (seul rôle d'écriture) puis arbitre, encadrant et accompagnateur, des rôles terrain en lecture seule sur leurs propres affectations.",
  },
  {
    q: "Comment fonctionnent les échanges d'affectations ?",
    a: "Un utilisateur propose un échange, la personne visée l'accepte, puis un administrateur valide le remplacement — avec revalidation des disponibilités et des conflits avant toute approbation.",
  },
  {
    q: 'Peut-on exporter ou partager le planning ?',
    a: 'Oui : export CSV, vue imprimable et export PDF, abonnement iCal et liens publics temporaires de 1 à 90 jours.',
  },
  {
    q: 'Quelles notifications reçoivent les utilisateurs ?',
    a: 'In-app, Web Push via la PWA, email SMTP et WhatsApp, selon les préférences de canal et d\'urgence de chacun.',
  },
];

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [standaloneLaunch, setStandaloneLaunch] = useState(false);
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();

  const closeMenu = () => setMenuOpen(false);

  // « Commencer » aiguille selon la session : visiteur anonyme → /login ;
  // administrateur → espace club ; dirigeant → son planning personnel.
  const startHref = user ? homePathForAccessRole(user.accessRole) : '/login';

  useEffect(() => {
    setStandaloneLaunch(isStandaloneDisplay());
  }, []);

  useEffect(() => {
    if (!standaloneLaunch || isLoading) return;
    router.replace(user ? homePathForAccessRole(user.accessRole) : '/login');
  }, [standaloneLaunch, isLoading, user, router]);

  if (standaloneLaunch) {
    return null;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.container}>
          <nav className={styles.nav}>
            <span className={styles.brand}>
              <Image src="/branding/clubika-icon.png" alt="" width={32} height={32} className={styles.brandMark} priority />
              Clubika
            </span>

            <div className={styles.desktopNav}>
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} className={styles.navLink}>
                  {link.label}
                </a>
              ))}
              <Link href={startHref} className={`${styles.btn} ${styles.btnOnBlue}`}>
                Commencer
              </Link>
            </div>

            <button
              type="button"
              aria-label="Menu"
              aria-expanded={menuOpen}
              data-open={menuOpen}
              className={styles.menuButton}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className={styles.bar} />
              <span className={styles.bar} />
              <span className={styles.bar} />
            </button>
          </nav>

          <div className={`${styles.mobilePanel} ${menuOpen ? styles.mobilePanelOpen : ''}`}>
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} onClick={closeMenu} className={styles.mobileLink}>
                {link.label}
              </a>
            ))}
            <Link
              href={startHref}
              onClick={closeMenu}
              className={`${styles.btn} ${styles.btnAccent} ${styles.btnBlock}`}
            >
              Commencer
            </Link>
          </div>
        </div>
      </header>

      <div className={styles.container}>
        <section className={styles.hero}>
          <p className={styles.heroKicker}>Football amateur</p>
          <h1 className={styles.heroTitle}>
            <span className={styles.block}>Le planning de votre club,</span>
            <span className={`${styles.block} ${styles.accentText}`}>enfin sous contrôle.</span>
          </h1>
          <p className={styles.heroCopy}>
            Matchs, entraînements et plateaux ; affectations des arbitres, encadrants et
            accompagnateurs ; disponibilités, échanges, chat et notifications. Clubika
            réunit tout ce qu&apos;un club de football amateur doit piloter au quotidien, dans
            une seule application.
          </p>
          <div className={styles.heroActions}>
            <Link href={startHref} className={`${styles.btn} ${styles.btnAccent}`}>
              Commencer
            </Link>
            <a href="#fonctionnalites" className={`${styles.btn} ${styles.btnGhost}`}>
              Voir les fonctionnalités
            </a>
          </div>
        </section>

        <section aria-label="Clubika en chiffres" className={styles.stats}>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <p className={styles.statValue}>4 rôles</p>
              <p className={styles.statLabel}>Administrateur, arbitre, encadrant, accompagnateur</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statValue}>48h · J-3 · J-1</p>
              <p className={styles.statLabel}>Relances automatiques avant chaque échéance</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statValue}>1–90 jours</p>
              <p className={styles.statLabel}>Durée des liens de partage public du planning</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statValue}>AES-256</p>
              <p className={styles.statLabel}>Chiffrement des messages et mots de passe SMTP</p>
            </div>
          </div>
        </section>

        <section id="fonctionnalites" className={styles.section}>
          <span className={styles.kicker}>Ce que fait Clubika</span>
          {FEATURES.map((item) => (
            <div key={item.num} className={styles.featureRow}>
              <p className={styles.featureNum}>
                <span className={styles.dot} />
                {item.num}
              </p>
              <h3 className={styles.featureTitle}>{item.title}</h3>
              <p className={styles.featureCopy}>{item.copy}</p>
            </div>
          ))}
        </section>

        <section id="roles" className={styles.section}>
          <span className={styles.kicker}>Un espace pour chaque rôle</span>
          <div className={styles.rolesGrid}>
            {ROLES.map((role) => (
              <div key={role.name} className={styles.roleCard}>
                <span className={`${styles.tag} ${styles.tagAccent}`}>{role.tag}</span>
                <h3 className={styles.roleName}>{role.name}</h3>
                <p className={styles.roleCopy}>{role.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.chatSection}>
          <div>
            <span className={styles.kicker}>Chat temps réel</span>
            <h2 className={styles.chatTitle}>
              Une messagerie pensée pour le club, pas un canal en plus.
            </h2>
            <p className={styles.chatCopy}>
              Conversations privées, chat par événement visible de tous les affectés, canaux de
              groupe créés par un administrateur. Messages persistés, accusés de lecture, envoi
              de photos, GIF, vidéos et audio — le tout chiffré au repos et isolé par club.
            </p>
          </div>
          <div className={styles.chatFacts}>
            {CHAT_FACTS.map((fact) => (
              <div key={fact} className={styles.chatFact}>
                <span className={styles.dot} />
                <p>{fact}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="securite" className={styles.section}>
          <span className={styles.kicker}>Sécurité &amp; confidentialité</span>
          <div className={styles.securityGrid}>
            {SECURITY_ITEMS.map((item) => (
              <div key={item.title} className={styles.securityCard}>
                <h3 className={styles.securityTitle}>{item.title}</h3>
                <p className={styles.securityCopy}>{item.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className={styles.faqSection}>
          <span className={styles.kicker}>Questions fréquentes</span>
          {FAQ_ITEMS.map((item, index) => {
            const isOpen = openFaq === index;
            return (
              <div key={item.q} className={styles.faqItem}>
                <button
                  type="button"
                  className={styles.faqButton}
                  aria-expanded={isOpen}
                  onClick={() => setOpenFaq((current) => (current === index ? -1 : index))}
                >
                  <span>{item.q}</span>
                  <span className={styles.faqIcon}>{isOpen ? '–' : '+'}</span>
                </button>
                {isOpen && <p className={styles.faqAnswer}>{item.a}</p>}
              </div>
            );
          })}
        </section>
      </div>

      <section className={styles.ctaBand}>
        <div className={styles.ctaContainer}>
          <h3 className={styles.ctaTitle}>
            <span className={styles.block}>Prêt à professionnaliser</span>
            <span className={styles.block}>le planning de votre club ?</span>
          </h3>
          <div className={styles.ctaActions}>
            <Link href={startHref} className={`${styles.btn} ${styles.btnAccent}`}>
              Commencer
            </Link>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <Image src="/branding/clubika-icon.png" alt="" width={18} height={18} className={styles.footerMark} />
          Clubika — planning, affectations et communication pour les clubs de football
          amateurs.
        </div>
      </footer>
    </div>
  );
}
