'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import styles from './landing.module.css';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { homePathForAccessRole } from '@/lib/auth/roles';
import {
  LANDING_CHAT_FACTS,
  LANDING_CHAT_INTRO,
  LANDING_FAQ_ITEMS,
  LANDING_FEATURES,
  LANDING_FOOTER_NOTE,
  LANDING_ROLES,
  LANDING_SECURITY_ITEMS,
} from '@/lib/compliance/public-claims';
import { isStandaloneDisplay } from '@/lib/pwa/display-mode';

const NAV_LINKS = [
  { href: '#fonctionnalites', label: 'Fonctionnalités' },
  { href: '#roles', label: 'Rôles' },
  { href: '#securite', label: 'Sécurité' },
  { href: '#faq', label: 'FAQ' },
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
              <p className={styles.statValue}>AES-256-GCM</p>
              <p className={styles.statLabel}>Texte des messages et mots de passe SMTP, si la clé applicative est définie</p>
            </div>
          </div>
        </section>

        <section id="fonctionnalites" className={styles.section}>
          <span className={styles.kicker}>Ce que fait Clubika</span>
          {LANDING_FEATURES.map((item) => (
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
            {LANDING_ROLES.map((role) => (
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
            <p className={styles.chatCopy}>{LANDING_CHAT_INTRO}</p>
          </div>
          <div className={styles.chatFacts}>
            {LANDING_CHAT_FACTS.map((fact) => (
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
            {LANDING_SECURITY_ITEMS.map((item) => (
              <div key={item.title} className={styles.securityCard}>
                <h3 className={styles.securityTitle}>{item.title}</h3>
                <p className={styles.securityCopy}>{item.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className={styles.faqSection}>
          <span className={styles.kicker}>Questions fréquentes</span>
          {LANDING_FAQ_ITEMS.map((item, index) => {
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
          amateurs. {LANDING_FOOTER_NOTE}
        </div>
      </footer>
    </div>
  );
}
