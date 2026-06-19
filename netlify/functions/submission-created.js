// Fires automatically on every VERIFIED Netlify form submission from the
// Wildfield Village landing page (forms: wildfield-hero, wildfield-register).
//
// Pushes the registration into Follow Up Boss via the Events API, which matches
// on email/phone and MERGES into the existing contact — so a new visitor creates
// a lead, and a returning contact updates the same record (no duplicates).
//
// Required env var (set in Netlify): FUB_API_KEY
// Optional env vars: FUB_SYSTEM (defaults below), FUB_SYSTEM_KEY (higher rate limits)

const FUB_BASE = 'https://api.followupboss.com/v1';
const SYSTEM = process.env.FUB_SYSTEM || 'ClaudeCode-RealtorPrabhat';

// Follow-up task for brand-new leads — alternates evenly between Rashi & Manik
// (same routing rule as the GWP intake form).
const ASSIGN_FOLLOWUP_TASK = true;
const FOLLOWUP_USERS = [
  { id: 9, name: 'Rashi' },
  { id: 2, name: 'Manik' },
];

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// Split a single "Full Name" field into first / last.
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

exports.handler = async (event) => {
  const submissionStartedAt = new Date();

  if (!process.env.FUB_API_KEY) {
    console.error('FUB_API_KEY is not set');
    return { statusCode: 500, body: 'FUB_API_KEY missing' };
  }

  // Netlify sends { payload: { data: {...fields}, form_name, ... } }
  let d, formName;
  try {
    const payload = JSON.parse(event.body).payload || {};
    d = payload.data || {};
    formName = payload.form_name || '';
  } catch (err) {
    console.error('Could not parse submission body:', err);
    return { statusCode: 400, body: 'Bad payload' };
  }

  // Only handle the Wildfield forms (ignore anything else on the site).
  if (formName && !/^wildfield/i.test(formName)) {
    return { statusCode: 200, body: 'ignored (not a wildfield form)' };
  }

  // --- Normalise names: register form has first/last, hero form has a single name ---
  let firstName = d.first || '';
  let lastName = d.last || '';
  if (!firstName && !lastName && d.name) {
    const s = splitName(d.name);
    firstName = s.first;
    lastName = s.last;
  }

  const authHeader =
    'Basic ' + Buffer.from(process.env.FUB_API_KEY + ':').toString('base64');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    'X-System': SYSTEM,
  };
  if (process.env.FUB_SYSTEM_KEY) headers['X-System-Key'] = process.env.FUB_SYSTEM_KEY;

  // --- Build the person ---
  const person = {
    firstName,
    lastName,
    tags: ['Wildfield Village Lead', d.product, d.timeline].filter(Boolean),
  };
  if (d.email) person.emails = [{ value: d.email, type: 'home' }];
  if (d.phone) person.phones = [{ value: d.phone, type: 'mobile' }];

  // --- Readable summary for the FUB note ---
  const line = (label, val) => (val ? `• ${label}: ${val}\n` : '');
  const noteBody =
    line('Project', 'Wildfield Village by Solmar (Gore & Mayfield, Caledon)') +
    line('Interested in', d.product) +
    line('Buying timeline', d.timeline) +
    line('Form', formName === 'wildfield-hero' ? 'Hero quick-register' : 'Full registration');

  const eventBody = {
    source: 'Wildfield Village Landing Page',
    system: SYSTEM,
    type: 'Registration',
    message: 'New Wildfield Village VIP registration',
    person,
  };

  // --- 1) Create OR merge the lead via the Events API (dedupes on email/phone) ---
  let personId;
  let isNewPerson = false;
  try {
    const res = await fetch(`${FUB_BASE}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(eventBody),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('FUB /events failed:', res.status, text);
      return { statusCode: 502, body: `FUB error ${res.status}` };
    }
    const parsed = JSON.parse(text);
    personId = parsed.id || parsed.personId || (parsed.person && parsed.person.id);
    const createdAt = parseDate(parsed.created || (parsed.person && parsed.person.created));
    isNewPerson = Boolean(createdAt && createdAt >= new Date(submissionStartedAt.getTime() - 120000));
    console.log('FUB lead saved (created or merged), personId:', personId, 'isNewPerson:', isNewPerson);
  } catch (err) {
    console.error('Error calling FUB /events:', err);
    return { statusCode: 502, body: 'FUB request error' };
  }

  // --- 2) Always write a note with the registration details ---
  if (personId) {
    try {
      const noteRes = await fetch(`${FUB_BASE}/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          personId,
          subject: 'Wildfield Village VIP Registration',
          body: noteBody || 'Registered on the Wildfield Village landing page.',
        }),
      });
      if (!noteRes.ok) console.error('FUB /notes failed:', noteRes.status, await noteRes.text());
      else console.log('Registration note written');
    } catch (err) {
      console.error('Error writing note:', err);
    }
  }

  // --- 3) Follow-up task for brand-new leads only, alternating Rashi/Manik ---
  if (ASSIGN_FOLLOWUP_TASK && personId && isNewPerson) {
    try {
      const due = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // tomorrow

      // Stable per-lead routing: same email always routes to the same assistant.
      const routeKey = d.email || d.phone || `${firstName}${lastName}`;
      let h = 0;
      for (let i = 0; i < routeKey.length; i++) h = (h + routeKey.charCodeAt(i)) % 2;
      const assignee = FOLLOWUP_USERS[h];

      const taskName =
        `Call new Wildfield Village lead: ${firstName} ${lastName}`.trim() +
        (d.product ? ` (${d.product}` : '') +
        (d.product && d.timeline ? ` — ${d.timeline})` : d.product ? ')' : '');

      const taskRes = await fetch(`${FUB_BASE}/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          personId,
          name: taskName,
          type: 'Call',
          dueDate: due,
          assignedUserId: assignee.id,
          isCompleted: false,
        }),
      });
      if (!taskRes.ok) console.error('FUB /tasks failed:', taskRes.status, await taskRes.text());
      else console.log('Follow-up task created for', assignee.name);
    } catch (err) {
      console.error('Error creating follow-up task:', err);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
