# Student Portal (Moodle-backed)

A dashboard UI (`index.html`) plus a small Node proxy (`server.js`) that
fetches real data from a Moodle-hosted LMS via its Web Services REST API.

## Files

- `index.html` — the dashboard UI (sidebar nav, GPA/CGPA cards, completed
  units, announcement banner, recent transactions). Calls `/api/...`
  endpoints only — it never talks to Moodle directly.
- `server.js` — a minimal Node server that (a) serves `index.html` and
  (b) proxies three endpoints to Moodle's REST web service, holding your
  Moodle token server-side.
- `package.json` — run with `npm start`.

## 1. Configure Moodle to allow this

As a Moodle site administrator:

1. **Site administration → General → Web services → Enable web services.**
2. **Site administration → Plugins → Web services → Manage protocols** —
   enable **REST protocol**.
3. **Site administration → Plugins → Web services → External services** —
   create a custom service and add these functions to it:
   - `core_webservice_get_site_info`
   - `core_enrol_get_users_courses`
   - `core_completion_get_activities_completion_status`
   - `gradereport_user_get_grade_items`
   - `core_user_get_users_by_field` (richer profile: photo, email,
     institution/department, city/country, bio — optional, profile just
     shows less if you skip it)
   - `core_course_get_contents` (per-course topic/activity breakdown on the
     Courses view — optional, course cards just show the progress bar
     without the expandable activity list if you skip it)
   - `mod_quiz_get_quizzes_by_courses` (powers the **Manage Exams** view — optional,
     that view degrades to an empty state if you skip this one)
4. **Site administration → Plugins → Web services → Manage tokens** —
   create a token for a **dedicated service-account user**, scoped to the
   service you just created. Don't use a personal admin token in
   production — if it's ever exposed, someone can call the API as that
   admin.
5. Confirm the service-account user is enrolled in (or has appropriate
   permissions to read) the courses you want to report on.

## 2. Run the proxy

```bash
npm install    # no dependencies currently, but keeps this future-proof
MOODLE_URL="https://your-moodle-site.example.com" \
MOODLE_TOKEN="your-token-here" \
npm start
```

Then open `http://localhost:3000`.

## 3. Sidebar navigation

All five sidebar links (Dashboard, Courses, Grades, Payments, Deferments,
Manage Exams) now switch between real views client-side — clicking one
toggles which `<div class="view">` is visible and lazy-loads that view's
data the first time it's opened. What's actually wired up:

| Nav item | Backed by | Notes |
|---|---|---|
| Dashboard | `/api/me`, `/api/academic-summary`, `/api/transactions` | Same as before |
| Courses | `/api/courses` (new) | Enrolled courses with real photo, summary, start/end dates, progress bar, and an expandable topic/activity list with per-activity completion state |
| Grades | `/api/grades` (new) | Full per-course breakdown: the overall course grade AND every individual assignment/quiz/item underneath it, with feedback text where Moodle has it |
| Payments | `/api/transactions` | Fuller version of the dashboard's transactions table |
| Manage Exams | `/api/exams` (new) | Lists quizzes via `mod_quiz_get_quizzes_by_courses`; shows an honest empty state if that function isn't enabled on your web service |
| Deferments | — | **Intentionally not wired up.** Not a Moodle concept — shows an explanatory empty state instead of fake data. Point it at your registrar/SIS API and add an `/api/deferments` route the same way the others are done. |

Also, `/api/me` now pulls your real profile photo, email, institution/department,
city/country, and bio via `core_user_get_users_by_field` (with a graceful
fallback to initials-only if that function isn't added to the service).

## 4. What's real vs. placeholder right now

| Dashboard element | Data source | Status |
|---|---|---|
| Student name / avatar initials | `core_webservice_get_site_info` | Wired up |
| Completed course units | `core_completion_get_activities_completion_status` per enrolled course | Wired up |
| "Minimum units required" | — | **Placeholder.** Moodle doesn't store a programme's required-unit count; pull this from your student information system (SIS) or hardcode per programme. |
| Last GPA / Cumulative GPA | `gradereport_user_get_grade_items` per course, averaged | **Placeholder calculation.** Moodle has no native GPA/CGPA concept — the proxy currently averages each course's percentage grade and rescales to a 5-point band. Replace `handleAcademicSummary()` in `server.js` with your institution's actual grade-to-point table and cumulative-weighting rules (e.g. credit-hour weighting, only counting completed sessions, etc.). |
| GPA "vs last session" delta | — | **Not implemented.** Requires storing a snapshot of each session's GPA somewhere (Moodle doesn't version this) so a comparison is possible. |
| Recent Transactions | — | **Stubbed to empty.** Moodle core has no per-student payment ledger. If you use a fee/enrolment plugin, check whether it exposes its own web service function and call that instead. Otherwise, point `handleTransactions()` at your actual payments/finance system's API. |
| "Go to Class" button | — | Currently links to `/my-course.html`; point it at your Moodle course URL or dashboard (`{MOODLE_URL}/my/`). |

## 5. Hosting

`index.html` and `server.js` can be deployed together on any Node-capable
host (a VPS, Render, Railway, etc.) or behind your existing web server as
a reverse-proxied Node process. If you'd rather host `index.html` as a
static file separately (e.g. on a CDN) and run the proxy elsewhere, update
`API_BASE` near the top of the `<script>` block in `index.html` to point
at the proxy's full URL, and make sure the proxy sends appropriate CORS
headers for your static host's origin.

## 6. Security notes

- Never ship `MOODLE_TOKEN` to the browser. It only ever lives in the
  proxy's environment variables.
- The demo currently resolves "who is the current user" via the token's
  own identity (`core_webservice_get_site_info`) or a hardcoded
  `DEMO_USER_ID`. In a real multi-student deployment, add your own
  login/session layer in front of the proxy so each browser session maps
  to the correct Moodle `userid` — don't let one token/session serve every
  student's data indiscriminately.
