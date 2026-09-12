# Audit 07 — Design, UI/UX et Responsive

**Repository :** `https://github.com/brahmiamine/Clubika`
**Périmètre :** code sur `main` au 2026-09-10
**Méthode :** revue statique `globals.css`, `app/components/ui/**`, `layout/**`, 45 `page.tsx`. **Audit statique uniquement — écrans non vérifiés visuellement** : application non démarrée, Playwright non lancé pour captures (CI e2e rouge pour ALS, pas pour le layout). Pas d’axe-core dans le projet.

Référentiel accessibilité : **WCAG 2.2 niveau AA**.

---

## Sommaire

1. [Score](#1-score)
2. [Design System](#2-design-system)
3. [Tokens, branding, logo](#3-tokens-branding-logo)
4. [Inventaire interfaces](#4-inventaire-interfaces)
5. [Audit Desktop / Tablette / Mobile](#5-audit-desktop--tablette--mobile)
6. [Navigation, listes, formulaires, dialogs](#6-navigation-listes-formulaires-dialogs)
7. [Planning, chat, dark mode, PWA](#7-planning-chat-dark-mode-pwa)
8. [Accessibilité WCAG](#8-accessibilité-wcag)
9. [Performance perçue](#9-performance-perçue)
10. [Findings](#10-findings)
11. [Plan de remédiation](#11-plan-de-remédiation)
12. [Definition of Done](#12-definition-of-done)

---

## 1. Score

**Note : 70 / 100**

| Dimension | Poids | Note |
|-----------|------:|-----:|
| Cohérence visuelle | 20 | 15 |
| Responsive | 20 | 14 |
| UX mobile | 20 | 13 |
| Design System | 15 | 12 |
| Accessibilité | 15 | 10 |
| Dark mode / PWA | 10 | 6 |

**Findings :** P0 **0** (aucune fonctionnalité prouvée inaccessible en statique) · P1 **6** · P2 **10** · P3 **6**

Overflow horizontal : **non mesuré** runtime sauf e2e existant à **390px** sur 2 routes planning (`e2e/planning-mobile-responsive.spec.ts`). 320px : `Audit statique uniquement`.

---

## 2. Design System

### Tokens — `app/globals.css`

- `@theme inline` mappe `--background`, `--primary`, `--primary-soft`, `--secondary-soft`, `--destructive`, radius (`:4-48`).
- Palettes light/dark OKLCH (`:50-123`).
- Mobile ≤1023px : boutons `min-height: 44px`, inputs `font-size: 16px` (`:150-166`) — **bonne base WCAG 2.5.8 / iOS zoom**.
- Standalone : `safe-area-inset-top` (`:168-172`).
- `body` `min-width: 320px` + `overflow-x: hidden` (`:137-138`) — **masque** l’overflow plutôt que de le corriger.

### UI (`app/components/ui/**` — 35 fichiers)

Primitives Radix : accordion, alert-dialog, alert, badge, button, card, checkbox, command, dialog, dropdown-menu, input, label, popover, switch, tabs, sonner.

Métier : add-event-dialog, export-*-modal, club/officiel/stade-combobox, contact-list-editor, team-logo.

### Layout (9 fichiers)

`DashboardShell`, `MobileTabBar`, `page-primitives` (`PageContainer`, `PageHeader`, `SectionCard`, `DataList`, `StatusPill`, `StatCard`), `AuthShell`, `Header`.

Providers : `theme-provider.tsx`, `app-theme-sync.tsx` → `applyThemeVariables` (`settings.ts:291-320`), `pwa-provider.tsx`, `auth-provider.tsx`.

**Ne pas inventer un nouveau DS** — l’existant est riche mais **sous-utilisé** (pages qui réimplémentent un header).

---

## 3. Tokens, branding, logo

**Violations tokens (hardcodes) :**
- `StatusPill` emerald/amber (`page-primitives.tsx:211-213`)
- `EventCalendar.tsx:36-39` blue/purple/green/orange
- `ChatConversation.tsx:1141,1220` emerald/sky
- `landing.module.css` palette parallèle `#0055a4`
- `bg-white` plaques logo : `DashboardShell.tsx:107,159,167`, `Header.tsx:199`, `ChatView.tsx:62`, `pwa-provider.tsx:213`

**Logo :**
| Surface | fit | Fallback |
|---------|-----|----------|
| Sidebar | `object-contain` + `bg-white` | aucun si `brandLogo` falsy |
| `TeamLogo` | `object-cover` | icône Users `bg-muted` (`team-logo.tsx:21-40`) |
| Config preview | `object-cover` | — |

Incohérence contain vs cover (UI-009).

Contraste WCAG **non mesuré** (pas de rendu). Plusieurs paires club claire/foncée : `Non exécuté`.

---

## 4. Inventaire interfaces

45 `page.tsx`. Protection : voir audit 00.

| Espace | Pages | Shell | Cohérence primitives |
|--------|------:|-------|----------------------|
| Public/auth | 8 | AuthShell / landing | homogène sauf `plateforme/login` (carte custom) |
| `/club/**` | 24 | DashboardShell | majorité OK ; **exceptions** home, configuration, chat, notifs, users |
| `/mon-planning/**` | 12 | `Header` (pas DashboardShell) | mixte PageHeader |
| `/plateforme` | 1+login | DashboardShell / custom | distinct (OK) |

**Réimplémentations :**
- `club/page.tsx:102-122` header custom
- `club/configuration/page.tsx:32` `<h1>` brut
- `NotificationsView` / `ChatView` : pas de `PageHeader`
- `UsersManagementTab` : SectionCard comme titre de page

---

## 5. Audit Desktop / Tablette / Mobile

### Desktop (1440 / 1280)
Sidebar `lg:fixed` 256px (`DashboardShell.tsx:140`). Active state + logo. Chat unread **absent** de la sidebar (`club/layout.tsx:88-89` notifs only) — UI-013.

### Tablette (1024 / 768)
Breakpoint `lg` : passage drawer + MobileTabBar. Risque de **double chrome** (drawer hamburger + tab bar). Non vérifié visuellement.

### Mobile (430–320) — priorité
- Planning #341 : `PlanningPreparationView.tsx:304` `overflow-x-hidden` ; grille 1 col ; e2e **390px only** sur `/club/planning` + `/controle`.
- `EventCardDrag` icônes `h-7 w-7` / remove `h-3.5` (`:492,603-620`) — sous 44px, classes peuvent gagner sur le media globals.
- AlertDialog `max-w-lg` **sans** `calc(100%-2rem)` (`alert-dialog.tsx:39`) vs Dialog (`dialog.tsx:63`) — risque clip 320px (UI-001, WCAG 1.4.10).
- Chat composer `text-sm` (`ChatConversation.tsx:1464`) vs base 16px — **zoom iOS probable** (UI-002).
- `overflow-x: hidden` body : overflow **non mesuré** sur les autres pages.

Viewports 640/375/320 : **non exercés**.

---

## 6. Navigation, listes, formulaires, dialogs

**MobileTabBar :** 4 items admin / 5 personnel (`MobileTabBar.tsx:34-47`), `z-50`, safe-area, badge chat #343 (test unitaire).
**Header personnel :** icônes `h-9 w-9` (36px desktop), chat **sans** badge unread (`Header.tsx:273`).

**Listes :** DataList (users, archives, invitations, indispos, contrôle, historique) = bon pattern mobile stack (`page-primitives.tsx:150`). Notifications = cards. Pas de `<table>` interactive (export print only).

**Formulaires :** `Input` `text-base md:text-sm` (`input.tsx:11`) OK iOS. Chat textarea `text-sm` KO. Labels Radix fréquents ; quelques `<select>` nus.

**Dialogs :** Radix focus trap + Escape (Dialog). AlertDialog Escape souvent désactivé (confirm). Add-event `max-h-[90vh]`. Export PDF/CSV : `export-modal-layout.ts` (bon). Export iCal plus faible (`export-ical-modal.tsx:136`). Close `sr-only` « Close » anglais (`dialog.tsx:75`) — WCAG 3.1.2.

---

## 7. Planning, chat, dark mode, PWA

**Planning :** préparation mobile-first récente (#341). Densité EventCardDrag élevée. Statuts via `StatusPill` non tokenisés.

**Chat :** panes fixed `z-30/40`, lightbox `z-[60]`. Toolbar messages `opacity-0 group-hover` (`ChatConversation.tsx:1224`) — **cachée au toucher** (2.1.1). URLs longues linkifiées.

**Dark mode :** plaques `bg-white` ; landing hors tokens ; PWA `background_color: '#ffffff'` (`lib/pwa/branding.ts:56`). `--destructive-foreground` manquant dans globals alors que classes l’utilisent.

**PWA :** `app/manifest.ts` standalone ; `appleWebApp.capable` (`layout.tsx:38-42`) ; safe-area tab bar + composer.

---

## 8. Accessibilité WCAG

| Finding | Critère |
|---------|---------|
| AlertDialog bords 320px | **1.4.10 Reflow** |
| Composer `text-sm` zoom iOS | **1.4.4 Resize** (UX) |
| StatusPill couleurs emerald | **1.4.3 Contrast** (à mesurer) |
| Icon-only sans nom | **4.1.2 Name, Role, Value** |
| Cible `h-3.5` EventCardDrag | **2.5.8 Target Size (Minimum)** |
| Toolbar hover-only | **2.1.1 Keyboard** / discoverability |
| LoadingSpinner sans live region | **4.1.3 Status Messages** (`loading-spinner.tsx:12-18`) |
| « Close » EN | **3.1.2 Language of Parts** |
| Dual `h1` Header + PageHeader | **1.3.1 / 2.4.6** |
| Focus ring boutons | **2.4.7** plutôt OK |
| TeamLogo `alt={name}` | **1.1.1** OK |

`Non exécuté — audit manuel uniquement` pour axe-core.

---

## 9. Performance perçue

Pas de skeletons (spinner remplace le contenu → saut de layout). `next/font` Geist : bon pour CLS polices. Dimensions logo explicites `h-* w-*` : OK si respectées.

---

## 10. Findings

### P1
- **UI-001** AlertDialog overflow 320px — `alert-dialog.tsx:39` — WCAG 1.4.10
- **UI-002** Chat composer `text-sm` — `ChatConversation.tsx:1464` — 1.4.4
- **UI-003** StatusPill hors tokens — `page-primitives.tsx:211-213` — 1.4.3
- **UI-004** Icon-only sans `aria-label` (EventCardDrag `:620`, invitations copy `:70`, CRUD config) — 4.1.2
- **UI-005** Cible minuscule remove badge — `EventCardDrag.tsx:492` — 2.5.8
- **UI-006** Dual nav Header vs DashboardShell + unread chat seulement tab bar — 3.2.3

### P2
- **UI-007** Pages hors PageHeader (club home, configuration)
- **UI-008** `bg-white` logos vs dark mode
- **UI-009** object-cover vs contain
- **UI-010** EventCalendar couleurs type hardcodées
- **UI-011** Pas de skeletons
- **UI-012** Toolbar chat hover-only — 2.1.1
- **UI-013** Sidebar sans badge chat
- **UI-014** `--destructive-foreground` absent
- **UI-015** Dialog close « Close »
- **UI-016** e2e overflow 390px only, pas 320, pas dialogs/chat

### P3
- **UI-017** Landing DS parallèle
- **UI-018** PWA background toujours blanc
- **UI-019** plateforme/login ≠ AuthShell
- **UI-020** Export iCal hors layout partagé
- **UI-021** Pas d’axe-core
- **UI-022** LoadingSpinner non annoncé

**Non-findings :** 44px globals mobile ; DataList stack ; export PDF layout #317 ; badge chat testé #343.

---

## 11. Plan de remédiation

**Quick wins :** inset AlertDialog ; `text-base` composer ; `aria-label` icon-only ; StatusPill → tokens ; badge chat sidebar/Header.

**Structurel :** unifier shells admin/personnel ; étendre e2e overflow à 320 + dialogs + chat ; axe-core sur 5 pages clés ; skeletons planning / mon-planning.

---

## 12. Definition of Done

- [x] Routes principales listées ; preuve visuelle **explicitement impossible** (app non rendue) sauf e2e 390px planning
- [x] Findings a11y citent WCAG 2.2
- [x] Overflow : mesuré en e2e à 390px planning ; **non mesuré** ailleurs
- [ ] Captures `/audits/assets/design/**` — **non produites** (contrainte runtime)

**Cause racine UI :** deux chrome (DashboardShell vs Header) + tokens contourés pour les statuts + media-query 44px combattue par utility classes denses du planning.
