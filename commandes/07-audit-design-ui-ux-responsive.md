# Commande — Audit Design, UI/UX et Responsive

Réalise un **audit complet et approfondi du design, de l'UI/UX, du responsive, du dark mode, de la PWA et de l'accessibilité** du projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

## Objectif

Détecter toutes les incohérences visuelles et ergonomiques : Design System, couleurs, typographie, spacing, alignements, composants, navigation, formulaires, listes/tableaux, dialogs, drawers, boutons, états interactifs, desktop, tablette, mobile, dark mode, branding dynamique, PWA et accessibilité.

Je ne veux pas un audit superficiel basé uniquement sur les classes Tailwind. Lorsque l'environnement le permet, lance réellement l'application (`pnpm dev` / `pnpm build && pnpm start`) et utilise Playwright pour inspecter les écrans, avec captures d'écran comme preuves.

## Référentiel accessibilité

Utilise WCAG 2.2 niveau AA comme référentiel explicite. Pour chaque finding d'accessibilité, cite le critère WCAG concerné (ex. 1.4.3 Contraste minimum, 2.5.8 Taille de la cible, 4.1.2 Nom, rôle, valeur).

## Design System existant

Analyse en priorité :

- `app/globals.css` ;
- `app/components/ui/**` ;
- `app/components/layout/**` ;
- primitives de page et composants de navigation ;
- providers/thème ;
- fonctions liées aux couleurs personnalisées du club.

Identifie les composants de référence réellement présents : PageContainer, PageHeader, SectionCard, DataList/DataRow/DataCell, StatusPill, StatCard, DashboardShell, MobileTabBar, Button, Card, Badge, Dialog, Input, Select, Tabs, etc.

Ne crée pas un nouveau Design System : vérifie d'abord si celui qui existe est utilisé correctement.

## Tokens et branding

Analyse background, foreground, card, border, primary, secondary, soft variants, muted, destructive, radius et dark mode.

Recherche les couleurs hardcodées (`#`, `rgb`, `blue-*`, `indigo-*`, etc.) et détermine si elles doivent suivre les tokens dynamiques du club.

Teste plusieurs couleurs primaire/secondaire (au moins une paire claire et une paire foncée/saturée) et vérifie contraste (ratio WCAG mesuré, pas estimé à l'œil), états actifs, cards, boutons, menus, planning et dark mode.

## Logo

Vérifie le logo club dans sidebar, header desktop/mobile, pages, configuration et exports : ratio, taille, `object-fit`, fallback, logo horizontal/vertical/transparent/absent.

## Inventaire des interfaces

Parcours récursivement toutes les routes `app/**/page.tsx` et leurs composants : public/auth, `/club/**`, `/mon-planning/**`, `/plateforme/**` et toutes les autres routes réelles.

Pour chaque page vérifie structure, largeur, containers, titre, actions, alignements, padding/margin/gap, hiérarchie typographique et cohérence avec les pages similaires.

## Primitives partagées

Recherche les pages qui réimplémentent localement un PageHeader, SectionCard, status badge, KPI card ou liste responsive déjà disponible.

Pour chaque duplication, cite route, fichier, implémentation actuelle et composant partagé recommandé. Ne mutualise pas des interfaces métier réellement différentes.

## Responsive

Lorsque possible, teste au minimum :

- 1440 ;
- 1280 ;
- 1024 ;
- 768 ;
- 640 ;
- 430 ;
- 390 ;
- 375 ;
- 320 px.

Priorité forte : 320–430 px.

Vérifie automatiquement `document.documentElement.scrollWidth <= window.innerWidth` et identifie tout responsable d'overflow.

Analyse les usages de width/min-width/max-width/height fixes, grids rigides, `nowrap`, `truncate`, `fixed`, `absolute` et overflow uniquement lorsqu'ils ont un impact réel.

## DashboardShell et navigation

Analyse desktop : sidebar, largeur, active state, logo, navigation, scrolling.

Analyse mobile : topbar, hamburger, drawer, overlay, fermeture, focus, z-index, safe area.

Analyse MobileTabBar : 4/5 items selon rôle, labels, icônes, badges, route active, safe-area-bottom, espace réservé et contenu potentiellement masqué.

Vérifie la cohérence Header + Drawer + MobileTabBar et les différences admin/dirigeant/plateforme.

## Listes et tableaux

Analyse événements, planning, utilisateurs, archives, invitations, notifications, indisponibilités et toute liste réelle.

Sur mobile, ne considère pas « table desktop réduite » ou scroll horizontal systématique comme une solution suffisante. Évalue DataList, lignes empilées, cards ou scroll justifié selon le contenu.

Les informations essentielles et actions importantes doivent rester accessibles.

## Planning

Analyse préparation, matchs, affectations, statuts et actions. Vérifie lisibilité des équipes, date, heure, compétition, terrain, arbitre, encadrant et accompagnateur sur desktop/tablette/mobile.

## Chat

Analyse liste conversations, messages, composer, scroll, unread, mentions et header. Sur mobile, teste petit viewport, clavier, dernier message, MobileTabBar, longues URLs et messages longs.

## Formulaires

Analyse Input, Select, Combobox, Checkbox, Switch, textarea, date/time, upload, couleurs, invitations, profil, événement, indisponibilité.

Sur mobile : hauteur, touch targets, labels, erreurs, clavier, zoom involontaire (taille de police minimale 16px sur les champs pour éviter le zoom iOS Safari), scroll et submit accessible.

## Dialogs / Drawers / Dropdowns

Teste particulièrement création/édition événement, export PDF/CSV, invitation, suppression, configuration et indisponibilités à 320/375/390/430 px.

Vérifie largeur, max-height, scroll interne, footer, boutons, keyboard, focus (trap focus dans la modale), fermeture (Escape, clic extérieur), z-index et débordement viewport.

## Boutons et icônes

Compare taille, hauteur, variants, ordre, destructive/primary/secondary/ghost et boutons d'actions similaires (par exemple Actualiser/Export).

Les boutons icon-only doivent avoir touch target suffisant (44×44 px minimum, critère WCAG 2.5.8) et `aria-label` lorsque nécessaire.

## États

Vérifie default, hover, focus, active, selected, disabled, loading, success, error, empty state et skeleton. Aucun comportement mobile important ne doit dépendre uniquement du hover.

## Dark mode

Teste les principales interfaces en light/dark, avec plusieurs couleurs de club. Vérifie texte, backgrounds, borders, inputs, dialogs, menus, badges, planning, chat et contrastes.

## Accessibilité

Vérifie, avec référence WCAG 2.2 AA pour chaque point : contraste, labels, aria, alt, heading hierarchy, keyboard (navigation complète au clavier, pas de piège), focus visible, dialogs, icon-only buttons et touch targets (~44×44 sur mobile pour les actions importantes).

Lorsque l'environnement le permet, exécute un outil automatisé (axe-core via Playwright, ou équivalent déjà présent dans le projet) sur les pages principales et cite les violations remontées. Sinon, marque `Non exécuté — audit manuel uniquement`.

## PWA

Analyse standalone, safe-area-top/bottom, fixed headers/footers, orientation portrait/paysage et interaction avec MobileTabBar.

## Performance perçue

Vérifie la présence de skeletons/loaders sur les écrans à chargement serveur, l'absence de layout shift visible lors du chargement des données (CLS), et le temps de premier rendu utile pour les pages principales (planning, mon-planning) lorsque mesurable localement.

## Playwright et screenshots

Lorsque l'application est exécutable, utilise Playwright pour parcourir les routes principales aux viewports indiqués.

Conserve uniquement les screenshots utiles comme preuves dans :

`/audits/assets/design/desktop/`
`/audits/assets/design/tablet/`
`/audits/assets/design/mobile/`

Nomme-les clairement, par exemple `club-planning-390-overflow.png`.

Si une page ne peut pas être rendue, marque `Audit statique uniquement — écran non vérifié visuellement`.

## Findings

Utilise `UI-001`, `UI-002`, etc.

Format : priorité, route, viewport, fichier/composant, observation, preuve/screenshot, critère WCAG le cas échéant, impact, cause racine et correction recommandée.

P0 : fonctionnalité inaccessible ; P1 : overflow/navigation/contraste/action importante ; P2 : incohérence/responsive imparfait ; P3 : cosmétique/polish.

Ne crée pas de finding sur une simple préférence esthétique.

## Score

Donne une note `/100` : cohérence visuelle 20, responsive 20, UX mobile 20, Design System 15, accessibilité 15, dark mode/PWA 10.

Crée des sections séparées Audit Mobile, Audit Tablette, Audit Desktop et Incohérences Design System.

## Rapport

Crée ou remplace :

`/audits/07-design-ui-ux-responsive.md`

Inclure sommaire, résumé exécutif, Design System, inventaire interfaces, findings, desktop/tablette/mobile, navigation, listes, formulaires, dialogs, planning, chat, notifications, branding, dark mode, PWA, accessibilité (avec correspondance WCAG), performance perçue, causes racines, score détaillé et plan de remédiation.

## Definition of Done

- [ ] chaque route principale est testée à au moins un breakpoint desktop et un breakpoint mobile (320–430 px), avec preuve ou mention explicite d'impossibilité ;
- [ ] chaque finding d'accessibilité cite un critère WCAG 2.2 ;
- [ ] la vérification d'overflow horizontal est faite (mesurée ou explicitement marquée non vérifiée) sur les pages principales ;
- [ ] les captures d'écran produites sont référencées depuis le rapport, pas seulement déposées dans `/audits/assets/design/**`.

## Contraintes

- ne modifie aucun composant ni CSS produit ;
- ne modifie ni API, ni DB ;
- ne crée ni issue ni PR ;
- seuls `/audits/**` et `/audits/assets/design/**` peuvent être modifiés.

## Fin de tâche

Présente score `/100`, P0/P1/P2/P3, 10 problèmes UI/UX majeurs, problèmes mobile séparés, causes racines, plan de remédiation et fichiers/preuves créés.

Arrête-toi après cet audit.
