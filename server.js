/**
 * Minimal proxy server between the dashboard (index.html) and a
 * Moodle-hosted LMS's Web Services REST API.
 *
 * WHY A PROXY AT ALL?
 * 1. Security: your Moodle web service token must never be sent to the
 *    browser. This server holds it in an environment variable and makes
 *    all Moodle calls itself.
 * 2. CORS: Moodle's REST endpoint is on a different origin than wherever
 *    you host index.html. Calling it directly from browser JS will be
 *    blocked by CORS unless you configure $CFG->allowcorsorigins in
 *    Moodle's config.php — even then, exposing the token client-side is
 *    not advisable. A same-origin proxy avoids both problems.
 *
 * SETUP ON THE MOODLE SIDE (as a Moodle admin):
 * 1. Site administration > General > Web services > Enable web services.
 * 2. Site administration > Plugins > Web services > Manage protocols
 *    > enable "REST protocol".
 * 3. Site administration > Plugins > Web services > External services
 *    > create a custom service (or use an existing one), and add the
 *    functions this proxy calls (listed next to each route below).
 * 4. Site administration > Plugins > Web services > Manage tokens
 *    > create a token for a dedicated service-account user (do NOT use
 *    your own admin account's token in production) scoped to the service
 *    from step 3.
 * 5. Put that token in MOODLE_TOKEN below (via environment variable).
 *
 * This file intentionally uses only Node's built-in fetch (Node 18+) and
 * a tiny static file server — no framework required. Swap in Express if
 * you prefer; the Moodle-calling logic is identical either way.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MOODLE_URL = process.env.MOODLE_URL || "https://mylms.example.edu"; // no trailing slash
const MOODLE_TOKEN = process.env.MOODLE_TOKEN || "REPLACE_ME";
const PORT = process.env.PORT || 3000;

// The signed-in user this demo serves. In a real deployment, resolve this
// from your own session/auth layer (e.g. after the student logs into your
// portal, or via Moodle's own login redirect + core_webservice_get_site_info
// to identify who the token's calls are acting as).
const CURRENT_USER_ID = process.env.DEMO_USER_ID || null;

async function callMoodle(wsfunction, params = {}) {
  const url = new URL(`${MOODLE_URL}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", MOODLE_TOKEN);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  const data = await res.json();
  if (data && data.exception) {
    throw new Error(`Moodle error in ${wsfunction}: ${data.message}`);
  }
  return data;
}

/* ---------- Route handlers ---------- */

// GET /api/me
// Moodle functions used: core_webservice_get_site_info
async function handleMe() {
  const info = await callMoodle("core_webservice_get_site_info");
  return {
    userid: info.userid,
    fullname: info.fullname,
    firstname: info.firstname || info.fullname.split(" ")[0],
  };
}

// GET /api/academic-summary
// Moodle functions used: core_enrol_get_users_courses,
//   core_completion_get_activities_completion_status (per course),
//   gradereport_user_get_grade_items (per course)
//
// NOTE ON GPA/CGPA: Moodle has no built-in "GPA" or "CGPA" field — those
// are institution-specific groupings of course grades. The calculation
// below is a placeholder (average of course percentage grades, scaled to
// a 5-point scale) and almost certainly needs to be replaced with your
// institution's actual grading policy/weighting.
async function handleAcademicSummary(userid) {
  const courses = await callMoodle("core_enrol_get_users_courses", { userid });

  let completedUnits = 0;
  let requiredUnits = null; // pull from your SIS/programme config if available
  let gradePercentages = [];

  for (const course of courses) {
    try {
      const completion = await callMoodle("core_completion_get_activities_completion_status", {
        courseid: course.id,
        userid,
      });
      const activities = completion.statuses || [];
      completedUnits += activities.filter(a => a.state === 1 || a.state === 2).length;
    } catch (e) {
      // Course may not track completion — skip silently.
    }

    try {
      const grades = await callMoodle("gradereport_user_get_grade_items", {
        courseid: course.id,
        userid,
      });
      const items = grades.usergrades?.[0]?.gradeitems || [];
      const courseTotal = items.find(i => i.itemtype === "course");
      if (courseTotal && courseTotal.percentageformatted) {
        const pct = parseFloat(courseTotal.percentageformatted);
        if (!Number.isNaN(pct)) gradePercentages.push(pct);
      }
    } catch (e) {
      // Grades may not be released yet for this course — skip.
    }
  }

  const avgPct = gradePercentages.length
    ? gradePercentages.reduce((a, b) => a + b, 0) / gradePercentages.length
    : null;
  // Placeholder 0-100% -> 0-5.0 GPA-scale mapping. Replace with your
  // institution's real grade-to-point table.
  const toGpaScale = pct => (pct === null ? null : Math.round((pct / 100) * 5 * 100) / 100);

  return {
    lastGpa: toGpaScale(avgPct) ?? 0,
    lastGpaDeltaPct: null,   // requires storing/comparing a previous session's figure
    cgpa: toGpaScale(avgPct) ?? 0, // same placeholder calc; replace with real cumulative logic
    cgpaDeltaPct: null,
    completedUnits,
    requiredUnits,
  };
}

// GET /api/transactions
// NOT a Moodle core concept. Wire this to whatever actually handles fees:
//   - A Moodle payment/enrolment plugin's own web service, if it exposes one
//     (core payment API added in Moodle 3.11+ covers gateway config, not a
//     per-user statement — most fee plugins are custom per institution), OR
//   - Your separate SIS/finance system's API/database, called from here.
// This is stubbed to return an empty list so the UI has a real "no data"
// state rather than fake numbers.
async function handleTransactions(userid) {
  return [];
}

/* ---------- Tiny router + static file server ---------- */

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/me") {
      const data = await handleMe();
      return sendJson(res, data);
    }
    if (req.url === "/api/academic-summary") {
      const me = await handleMe();
      const data = await handleAcademicSummary(CURRENT_USER_ID || me.userid);
      return sendJson(res, data);
    }
    if (req.url === "/api/transactions") {
      const me = await handleMe();
      const data = await handleTransactions(CURRENT_USER_ID || me.userid);
      return sendJson(res, data);
    }

    // Static files (index.html, etc.)
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, { error: err.message }, 500);
  }
});

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  const filePath = req.url === "/" ? "/index.html" : req.url;
  const full = path.join(__dirname, filePath);
  fs.readFile(full, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(full);
    const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  });
}

server.listen(PORT, () => {
  console.log(`Student portal running at http://localhost:${PORT}`);
  if (MOODLE_TOKEN === "REPLACE_ME") {
    console.warn("WARNING: set MOODLE_URL and MOODLE_TOKEN environment variables before going live.");
  }
});
