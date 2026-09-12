# Planning Complete Operations Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Clubika with the remaining collaboration, availability, resource, productivity, notification, analytics, sharing, calendar, weather and post-event workflows after the P0 planning operations.

**Architecture:** Keep the four existing event stores as the source of schedule truth and add normalized planning-support entities for cross-event capabilities. Reuse `PlanningEventSnapshot`, stable `personType/personId` identity, the existing notification service/PWA push channel and the existing audit log; expose bounded authenticated APIs and focused admin/personal pages instead of embedding unrelated concerns in event payloads.

**Tech Stack:** Next.js 16 / React 19 / TypeScript strict / TypeORM 0.3 + MariaDB / Vitest / existing Tailwind + Radix UI / existing Web Push PWA.

## Global Constraints

- Preserve the merged P0 workflow: draft/published/modified/cancelled, assignment responses, replacement, reminders, attendance and auto-assignment.
- Preserve stable person identity and never authorize personal operations by display name alone when a stable link exists.
- Superadmin/admin may manage organization-wide planning; personal roles may only manage their own responses/preferences and collaboration they are entitled to see.
- Reuse current PWA push and in-app notifications; optional email/WhatsApp delivery must be configurable and must never be required for core planning operation.
- No real credentials, provider tokens or public-share tokens may be committed or logged.
- Every write affecting planning state must be auditable.
- External weather/routing failures must degrade gracefully and never block core planning writes.

---

### Task 1: Availability campaigns, personal preferences, refusal reasons and standby lists

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Modify: `types/match.ts`
- Modify: `app/lib/planning/assignment-suggestions.ts`
- Create: `app/lib/planning/advanced-rules.ts`
- Create: `app/api/availability-requests/route.ts`
- Create: `app/api/availability-requests/[id]/respond/route.ts`
- Create: `app/api/me/planning-preferences/route.ts`
- Create: `app/api/planning/waitlist/route.ts`
- Modify: `app/api/me/assignments/respond/route.ts`
- Create: `app/disponibilites/page.tsx`
- Create: `app/preferences-planning/page.tsx`
- Test: `app/lib/planning/assignment-suggestions.test.ts`
- Test: `app/lib/planning/advanced-rules.test.ts`

**Interfaces:**
- Produces `PersonPlanningPreference`, `AvailabilityRequest`, `AvailabilityResponse`, assignment `declineReason/declineComment`, and event-role standby candidates.
- `buildAssignmentSuggestions()` consumes preferences and weights preferred category/day/time while retaining availability/conflict hard gates.

- [ ] Add focused failing preference-scoring test and record RED.
- [ ] Add persistence/entities and APIs with ownership/RBAC checks.
- [ ] Require a bounded refusal reason on decline while preserving optional comment.
- [ ] Add standby ordering and promotion endpoint; never erase declined assignment history.
- [ ] Add admin availability campaign UI and personal preference/response UI.
- [ ] Run focused tests then `pnpm run type-check`.

### Task 2: Event collaboration, documents, tasks and post-event reports

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Create: `app/api/planning/events/[eventType]/[eventId]/collaboration/route.ts`
- Create: `app/api/planning/events/[eventType]/[eventId]/attachments/route.ts`
- Create: `app/api/planning/attachments/[id]/route.ts`
- Create: `app/api/planning/events/[eventType]/[eventId]/reports/route.ts`
- Create: `app/planning/evenement/[eventType]/[eventId]/page.tsx`
- Test: `app/lib/planning/collaboration-policy.test.ts`

**Interfaces:**
- Comments contain author identity and immutable timestamps.
- Tasks contain label, assignee user/person, due time and done metadata.
- Attachments store bounded binary content (max 5 MiB), sanitized filename, MIME type and uploader.
- Reports contain structured incident/note text and author; admins may read all, assigned participants may submit after event start.

- [ ] Add policy tests for event visibility and write permissions.
- [ ] Add comments/tasks CRUD and audit writes.
- [ ] Add attachment upload/download/delete with size and content-type gates.
- [ ] Add post-event report workflow.
- [ ] Add event workspace UI.
- [ ] Run focused tests and integration checks.

### Task 3: Resources, transport and travel-time feasibility

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Create: `app/lib/planning/resources.ts`
- Create: `app/lib/planning/travel.ts`
- Create: `app/api/planning/resources/route.ts`
- Create: `app/api/planning/resource-bookings/route.ts`
- Create: `app/api/planning/transport/route.ts`
- Create: `app/api/planning/travel/route.ts`
- Modify: `app/lib/planning/assignment-suggestions.ts`
- Create: `app/planning/ressources/page.tsx`
- Test: `app/lib/planning/resources.test.ts`
- Test: `app/lib/planning/travel.test.ts`

**Interfaces:**
- Resource types: terrain, vestiaire, vehicule, materiel, autre.
- Resource booking uses real event start/end and rejects overlapping exclusive bookings.
- Transport plan records departure point/time, driver, seats and passengers.
- Routing uses configurable OSRM-compatible endpoint with timeout; missing coordinates/routing failure returns `unknown`, not a false conflict.

- [ ] Add overlap and routing-degradation RED tests.
- [ ] Implement resource catalog/bookings and conflict checks.
- [ ] Implement transport plan CRUD.
- [ ] Add travel feasibility data to assignment suggestions when coordinates exist.
- [ ] Add admin resource/transport UI.
- [ ] Run focused tests.

### Task 4: Templates, duplication, bulk actions and saved filters

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Create: `app/lib/planning/productivity.ts`
- Create: `app/api/planning/templates/route.ts`
- Create: `app/api/planning/duplicate/route.ts`
- Create: `app/api/planning/bulk/route.ts`
- Create: `app/api/planning/saved-filters/route.ts`
- Create: `app/planning/outils/page.tsx`
- Test: `app/lib/planning/productivity.test.ts`

**Interfaces:**
- Templates store event type plus reusable safe payload defaults without IDs/status timestamps.
- Duplicate creates new IDs and shifts dates by explicit day offset; assignments default to empty unless `copyAssignments=true`.
- Bulk supports publish/draft/cancel/remind over max 100 explicit event references and returns per-item success/failure.
- Saved filters are user-owned JSON filter definitions.

- [ ] Add tests for ID/date transformation and partial bulk success.
- [ ] Implement templates and duplication.
- [ ] Implement bounded bulk mutation endpoint.
- [ ] Implement saved filters.
- [ ] Add productivity UI.
- [ ] Run focused tests.

### Task 5: Multichannel notification preferences

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Modify: `app/lib/notifications/service.ts`
- Create: `app/api/me/notification-preferences/route.ts`
- Create: `app/parametres-notifications/page.tsx`
- Modify: `README.md`
- Test: `app/lib/notifications/service.test.ts`

**Interfaces:**
- Per-user channel switches: inApp, push, email, whatsapp; urgency threshold and event types.
- In-app remains the durable source unless the user disables it explicitly; push/email/WhatsApp are best-effort secondary channels.
- Optional WhatsApp webhook uses `NOTIFICATION_WHATSAPP_WEBHOOK_URL` and bearer token; no provider dependency is added.

- [ ] Add channel-selection tests.
- [ ] Persist preferences and enforce them in notification delivery.
- [ ] Add optional WhatsApp webhook delivery.
- [ ] Add settings UI and deployment documentation.
- [ ] Run focused tests.

### Task 6: Weekend operations, analytics, fairness and readable history

**Files:**
- Create: `app/lib/planning/analytics.ts`
- Create: `app/api/planning/analytics/route.ts`
- Create: `app/api/planning/weekend/route.ts`
- Create: `app/api/planning/history/route.ts`
- Modify: `app/api/dashboard/superadmin/route.ts`
- Modify: `app/dashboard/page.tsx`
- Create: `app/planning/week-end/page.tsx`
- Create: `app/planning/statistiques/page.tsx`
- Test: `app/lib/planning/analytics.test.ts`

**Interfaces:**
- Analytics: acceptance rate, attendance rate, average response delay, replacement rate, missing coverage, workload distribution and fairness coefficient.
- Weekend view groups visible events chronologically with readiness status and actionable blockers.
- History translates audit records into human-readable change entries.

- [ ] Add analytics formula tests.
- [ ] Implement analytics/weekend/history services.
- [ ] Extend dashboard with weekend and planning-health summary.
- [ ] Add detailed weekend/statistics pages.
- [ ] Run focused tests.

### Task 7: Public sharing, exports and calendar integrations

**Files:**
- Modify: `app/lib/db/schemas.ts`
- Create: `app/api/planning/shares/route.ts`
- Create: `app/api/public/planning/[token]/route.ts`
- Create: `app/api/planning/export/route.ts`
- Create: `app/planning/partage/page.tsx`
- Modify: `app/mon-calendrier/page.tsx`
- Test: `app/lib/planning/public-share.test.ts`

**Interfaces:**
- Public share uses random high-entropy token; only SHA-256 hash is persisted; share has expiry and scope/filter.
- Public projection strips phone numbers, person IDs, private comments, audit data and reports.
- Export supports CSV and print-friendly HTML from the same filtered planning projection.
- Calendar page exposes copyable webcal subscription plus Google Calendar and Outlook subscription/deep-link helpers based on existing personal iCal.

- [ ] Add redaction/token tests.
- [ ] Implement share create/revoke/read.
- [ ] Implement CSV/print export.
- [ ] Add public-sharing UI and calendar integration helpers.
- [ ] Run focused tests.

### Task 8: Weather, navigation and final verification

**Files:**
- Create: `app/lib/planning/weather.ts`
- Create: `app/api/planning/weather/route.ts`
- Modify: `app/dashboard/page.tsx`
- Modify: `app/components/layout/Header.tsx`
- Modify: `app/components/layout/MobileTabBar.tsx`
- Modify: `README.md`
- Test: `app/lib/planning/weather.test.ts`

**Interfaces:**
- Weather uses Open-Meteo-compatible endpoints, short timeout and no key; request accepts event ref, derives venue/address, and returns forecast or unavailable.
- Dashboard only shows severe/relevant weather alerts for upcoming outdoor events; weather failure never changes planning status.

- [ ] Add weather parser/degradation tests.
- [ ] Implement weather endpoint and dashboard alert integration.
- [ ] Add navigation to all new admin/personal pages without breaking mobile PWA navigation.
- [ ] Run `pnpm run lint`, `pnpm run type-check`, `pnpm run test`, `pnpm run build` on the PR head.
- [ ] Review final diff for RBAC, IDOR, secret exposure, upload handling, SSRF and public-data leakage.
- [ ] Update PR body with exact verification outcomes and anything requiring production credentials/configuration.

## Product decisions resolved for this implementation

- Availability campaign responses support `available`, `unavailable`, and `partial` with optional time window/comment.
- Declines require one of `work`, `injury`, `travel`, `other_assignment`, `personal`, `other`, plus optional comment.
- Attachments are stored in MariaDB and capped at 5 MiB because Railway filesystem persistence is not assumed.
- Bulk operations return partial success instead of rolling back unrelated event failures.
- WhatsApp is optional/best-effort behind a configurable webhook; core notifications remain functional without it.
- Travel/weather integrations use public configurable providers and degrade to `unknown`/unavailable rather than block planning.
- Public planning shares are read-only, expiring and privacy-redacted.
