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

// Strips HTML tags/entities from Moodle's rich-text fields (course summaries,
// grade feedback, user profile "description") so the UI gets plain text.
function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim() || null;
}

// Moodle file URLs (avatars, course images, attachments) require the web
// service token appended as a query param to be viewable outside a logged-in
// browser session.
function withToken(fileUrl) {
  if (!fileUrl) return null;
  const sep = fileUrl.includes("?") ? "&" : "?";
  return `${fileUrl}${sep}token=${MOODLE_TOKEN}`;
}

/* ---------- Route handlers ---------- */

// GET /api/me
// Moodle functions used: core_webservice_get_site_info,
//   core_user_get_users_by_field (richer profile — optional, degrades
//   gracefully if not added to the web service)
async function handleMe() {
  const info = await callMoodle("core_webservice_get_site_info");

  let profile = {};
  try {
    const users = await callMoodle("core_user_get_users_by_field", {
      field: "id",
      "values[0]": info.userid,
    });
    profile = users?.[0] || {};
  } catch (e) {
    // core_user_get_users_by_field not enabled on the service — fine, we
    // just fall back to what core_webservice_get_site_info already gave us.
  }

  return {
    userid: info.userid,
    fullname: info.fullname,
    firstname: info.firstname || info.fullname.split(" ")[0],
    email: profile.email || null,
    department: profile.department || null,
    institution: profile.institution || null,
    city: profile.city || null,
    country: profile.country || null,
    bio: stripHtml(profile.description),
    profileImageUrl: withToken(profile.profileimageurl || info.userpictureurl),
    lastAccess: profile.lastaccess ? profile.lastaccess * 1000 : null,
    firstAccess: profile.firstaccess ? profile.firstaccess * 1000 : null,
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

// GET /api/courses
// Moodle functions used: core_enrol_get_users_courses,
//   core_completion_get_activities_completion_status (per course),
//   core_course_get_contents (per course — sections/activities)
async function handleCourses(userid) {
  const courses = await callMoodle("core_enrol_get_users_courses", { userid });
  const result = [];

  for (const course of courses) {
    // Per-activity completion state, keyed by course-module id.
    let completionByCmid = {};
    try {
      const completion = await callMoodle("core_completion_get_activities_completion_status", {
        courseid: course.id,
        userid,
      });
      for (const s of completion.statuses || []) completionByCmid[s.cmid] = s;
    } catch (e) {
      // Course may not have completion tracking enabled — leave empty.
    }

    // Full section/activity structure so the UI can show more than just a
    // completed-count — actual topic and activity names.
    let sections = [];
    try {
      const contents = await callMoodle("core_course_get_contents", { courseid: course.id });
      sections = (contents || [])
        .map(sec => ({
          name: sec.name,
          activities: (sec.modules || []).map(m => ({
            id: m.id,
            name: m.name,
            modname: m.modname,
            completed: completionByCmid[m.id]
              ? (completionByCmid[m.id].state === 1 || completionByCmid[m.id].state === 2)
              : null, // null = completion not tracked for this activity
            url: m.url || null,
          })),
        }))
        .filter(sec => sec.activities.length);
    } catch (e) {
      // core_course_get_contents not enabled, or course has restricted access.
    }

    const totalActivities = Object.keys(completionByCmid).length
      || sections.reduce((n, s) => n + s.activities.length, 0);
    const completedActivities = Object.values(completionByCmid).filter(s => s.state === 1 || s.state === 2).length;

    const overviewImage = course.overviewfiles && course.overviewfiles[0]
      ? withToken(course.overviewfiles[0].fileurl)
      : null;

    result.push({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      summary: stripHtml(course.summary),
      imageUrl: overviewImage,
      startDate: course.startdate ? course.startdate * 1000 : null,
      endDate: course.enddate && course.enddate > 0 ? course.enddate * 1000 : null,
      // Moodle 3.6+ can report an authoritative course-level progress % directly;
      // fall back to our own activity-count math when it's not present.
      progressPct: typeof course.progress === "number"
        ? Math.round(course.progress)
        : (totalActivities ? Math.round((completedActivities / totalActivities) * 100) : null),
      completedActivities,
      totalActivities,
      sections,
      courseUrl: `${MOODLE_URL}/course/view.php?id=${course.id}`,
    });
  }

  return result;
}

// GET /api/grades
// Moodle functions used: core_enrol_get_users_courses,
//   gradereport_user_get_grade_items (per course)
// gradereport_user_get_grade_items returns EVERY gradeable item in a course
// (each assignment, quiz, etc.) plus a synthetic "course" item for the
// overall total — we now surface all of it instead of only the total.
async function handleGrades(userid) {
  const courses = await callMoodle("core_enrol_get_users_courses", { userid });
  const result = [];

  for (const course of courses) {
    let courseTotal = null;
    let items = [];
    try {
      const grades = await callMoodle("gradereport_user_get_grade_items", {
        courseid: course.id,
        userid,
      });
      const gradeitems = grades.usergrades?.[0]?.gradeitems || [];

      for (const gi of gradeitems) {
        const pct = gi.percentageformatted ? parseFloat(gi.percentageformatted) : null;
        const entry = {
          itemName: gi.itemname || (gi.itemtype === "course" ? course.fullname : "Item"),
          itemType: gi.itemtype,       // "course" or "mod"
          itemModule: gi.itemmodule || null, // e.g. "assign", "quiz", "forum"
          percentage: Number.isNaN(pct) ? null : pct,
          grade: gi.gradeformatted && gi.gradeformatted !== "-" ? gi.gradeformatted : null,
          feedback: stripHtml(gi.feedback),
        };
        if (gi.itemtype === "course") courseTotal = entry;
        else items.push(entry);
      }
    } catch (e) {
      // Grades may not be released yet for this course, or the report isn't
      // enabled — leave courseTotal/items empty rather than failing the page.
    }

    result.push({
      courseId: course.id,
      courseName: course.fullname,
      courseTotal,
      items,
    });
  }

  return result;
}

// GET /api/exams
// Moodle function used: mod_quiz_get_quizzes_by_courses
// NOTE: this function is NOT in the README's original list of functions to
// add to the custom web service. If you want this view to show real data,
// add mod_quiz_get_quizzes_by_courses to the service in Site administration
// > Plugins > Web services > External services. Until then this returns an
// empty list rather than failing the whole page.
async function handleExams(userid) {
  let courses;
  try {
    courses = await callMoodle("core_enrol_get_users_courses", { userid });
  } catch (e) {
    return [];
  }
  const courseids = courses.map(c => c.id);
  if (!courseids.length) return [];

  try {
    const data = await callMoodle("mod_quiz_get_quizzes_by_courses", { courseids });
    return (data.quizzes || []).map(q => ({
      id: q.id,
      name: q.name,
      courseId: q.course,
      timeopen: q.timeopen || null,
      timeclose: q.timeclose || null,
      quizUrl: `${MOODLE_URL}/mod/quiz/view.php?id=${q.coursemodule}`,
    }));
  } catch (e) {
    // Function not enabled on the service, or no quizzes exist — empty is fine.
    return [];
  }
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
    if (req.url === "/api/courses") {
      const me = await handleMe();
      const data = await handleCourses(CURRENT_USER_ID || me.userid);
      return sendJson(res, data);
    }
    if (req.url === "/api/grades") {
      const me = await handleMe();
      const data = await handleGrades(CURRENT_USER_ID || me.userid);
      return sendJson(res, data);
    }
    if (req.url === "/api/exams") {
      const me = await handleMe();
      const data = await handleExams(CURRENT_USER_ID || me.userid);
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
