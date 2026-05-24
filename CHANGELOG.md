# Changelog

All notable changes to Teamly are documented here.

Format: [Semantic Versioning](https://semver.org/). Structure: `Added / Fixed / Changed / Removed`.

---

## v1.2.0 — 2026-05-25

### Added
- End-to-end test suite (Playwright + TypeScript) — 28 tests across all four roles covering login, dashboard, clock, leave, WFH, claims, approvals, admin, and account flows; runs against an isolated `test.db` on a dedicated port, so the dev/prod database is never touched

---

## v1.1.0 — 2026-05-05

### Added
- Employee email notification on leave, WFH, and claim approval/rejection — status badge and rejection reason included
- WFH submission now sends a notification email to the assigned approver (HOD)
- Self-service password change — `PUT /api/auth/change-password`; validates current password via bcrypt before updating
- **Account** tab in dashboard for employees to change their own password
- `favicon.svg` — teal background, white "T"; linked in all pages
- Styled 404 fallback page with back-to-login link
- Session expiry handling — any 401 response clears the JWT and redirects to login with a "session expired" banner
- Public holidays now support a `region` column (`MY`, `UK`, `ALL`) — leave day counting excludes holidays matching the user's timezone region
- Rate limiting on `POST /api/auth/login` — 10 attempts per 15 minutes per IP

### Fixed
- Removed `GET /api/auth/users` public endpoint — login page now uses a plain username text input instead of a dropdown, eliminating user enumeration

---

## v1.0.0 — 2026-05-01

### Added
- Clock in/out with optional GPS and note; duplicate punch prevention; configurable window; late detection per employee timezone
- Annual leave (AL) with dual-bucket balance (carry-forward + current year), 5-day advance notice, blackout date enforcement
- Approved AL cancellation — employee can cancel ≥3 days before start; balance refunded; approver notified
- Sick leave with mandatory MC attachment (base64 image/PDF)
- Emergency, Comp Off, and Unpaid Leave (UPL) with mandatory reason fields
- Work From Home (WFH) — max 2 days/week quota, 24-hour advance notice, per-date conflict detection
- Expense Claims — receipt attachment, category-based, multi-stage approval flow (Pending → Payment Pending → Paid)
- Email approval workflow — one-click approve/reject links in approver emails via tokenized URLs
- Role-based access control — `superadmin`, `hod`, `approver_a`, `user`
- Admin console: Users, AL Balances, Claims, Tracking (table + month + week calendar), Public Holidays, Blackout Dates, CSV Export, DB Reset
- Super Admin override on any request at any time; AL balance auto-corrected
- Team Calendar — visual overview of approved and pending leave/WFH for all staff
- Approvals tab for HODs and approvers directly in the dashboard
- 8AM cron job — emails HOD on the first day of an employee's approved AL
- Force password reset flag — new users set their own password on first login
- Health check endpoint (`GET /health`) for uptime monitors

<!-- auto: [2026-05-25 01:47] Modified: .github\CODEOWNERS -->

<!-- auto: [2026-05-25 01:47] Modified: .github\workflows\ci.yml -->

<!-- auto: [2026-05-25 01:52] Modified: .gitignore -->
