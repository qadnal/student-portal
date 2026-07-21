/**
 * Minimal proxy server between the dashboard (index.html) and a
 * Moodle-hosted LMS's Web Services REST API.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MOODLE_URL = process.env.MOODLE_URL || "https://mylms.example.edu"; // no trailing slash
const MOODLE_TOKEN = process.env.MOODLE_TOKEN || "REPLACE_ME";
const PORT = process.env.PORT || 3000;

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

function withToken(fileUrl) {
  if (!fileUrl) return null;
  const sep = fileUrl.includes("?") ? "&" : "?";
  return `${fileUrl}${sep}token=${MOODLE_TOKEN}`;
}

/* ---------- Route handlers ---------- */

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
    // core_user_get_users_by_field fallback
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

async function handleAcademicSummary(userid) {
  const courses = await callMoodle("core_enrol_get_users_courses", { userid });

  let completedUnits = 0;
  let requiredUnits = null; 
  let gradePercentages = [];

  for (const course of courses) {
    try {
      const completion = await callMoodle("core_completion_get_activities_completion_status", {
        courseid: course.id,
        userid,
      });
      const activities = completion.statuses || [];
      completedUnits += activities.filter(a => a.state === 1 || a.state === 2).length;
    } catch (e) {}

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
    } catch (e) {}
  }

  const avgPct = gradePercentages.length
    ? gradePercentages.reduce((a, b) => a + b, 0) / gradePercentages.length
    : null;

  const toGpaScale = pct => (pct === null ? null : Math.round((pct / 100) * 5 * 100) / 100);

  return {
    lastGpa: toGpaScale(avgPct) ?? 0,
    lastGpaDeltaPct: null,
    cgpa: toGpaScale(avgPct) ?? 0,
    cgpaDeltaPct: null,
    completedUnits,
    requiredUnits,
  };
}

async function handleCourses(userid) {
  const courses = await callMoodle("core_enrol_get_users_courses", { userid });
  const result = [];

  for (const course of courses) {
    let completionByCmid = {};
    try {
      const completion = await callMoodle("core_completion_get_activities_completion_status", {
        courseid: course.id,
        userid,
      });
      for (const s of completion.statuses || []) completionByCmid[s.cmid] = s;
    } catch (e) {}

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
              : null,
            url: m.url || null,
          })),
        }))
        .filter(sec => sec.activities.length);
    } catch (e) {}

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
          itemType: gi.itemtype,
          itemModule: gi.itemmodule || null,
          percentage: Number.isNaN(pct) ? null : pct,
          grade: gi.gradeformatted && gi.gradeformatted !== "-" ? gi.gradeformatted : null,
          feedback: stripHtml(gi.feedback),
        };
        if (gi.itemtype === "course") courseTotal = entry;
        else items.push(entry);
      }
    } catch (e) {}

    result.push({
      courseId: course.id,
      courseName: course.fullname,
      courseTotal,
      items,
    });
  }

  return result;
}

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
    return [];
  }
}

async function handleTransactions(userid) {
  return [];
}

/* ---------- Tiny router + static file server ---------- */

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight request
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "https://mylms.phiz.com.ng";
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  try {
    if (req.url === "/api/me") {
      const data = await handleMe();
      return sendJson(req, res, data);
    }
    if (req.url === "/api/academic-summary") {
      const me = await handleMe();
      const data = await handleAcademicSummary(CURRENT_USER_ID || me.userid);
      return sendJson(req, res, data);
    }
    if (req.url === "/api/transactions") {
      const me = await handleMe();
      const data = await handleTransactions(CURRENT_USER_ID || me.userid);
      return sendJson(req, res, data);
    }
    if (req.url === "/api/courses") {
      const me = await handleMe();
      const data = await handleCourses(CURRENT_USER_ID || me.userid);
      return sendJson(req, res, data);
    }
    if (req.url === "/api/grades") {
      const me = await handleMe();
      const data = await handleGrades(CURRENT_USER_ID || me.userid);
      return sendJson(req, res, data);
    }
    if (req.url === "/api/exams") {
      const me = await handleMe();
      const data = await handleExams(CURRENT_USER_ID || me.userid);
      return sendJson(req, res, data);
    }

    // Static files (index.html, etc.)
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(req, res, { error: err.message }, 500);
  }
});

function sendJson(req, res, obj, status = 200) {
  const origin = req.headers.origin || "https://mylms.phiz.com.ng";
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
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
