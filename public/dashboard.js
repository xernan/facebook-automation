// CARD MAX dashboard (this PC only). Applicants list, the Default Form (same sections and automations as the
// card app's form: zip from city, barangay list, office area code, name on card from the name, spouse only when
// married), print, and settings. All text English.
const TOKEN = window.TOKEN;
let S = null;
let view = 'list';
let open = null;
let ADDR = null;
let LISTS = null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const msg = (t) => {
  const m = $('#msg');
  m.textContent = t;
  m.style.display = 'block';
  setTimeout(() => (m.style.display = 'none'), 3500);
};
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const file = (f, n) => '/file?folder=' + encodeURIComponent(f) + '&name=' + encodeURIComponent(n);

async function load() {
  S = await (await fetch('/api/state')).json();
  if (open) open = S.applicants.find((a) => a.folder === open.folder) || null;
  render();
}
document.querySelectorAll('nav button').forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.v;
      open = null;
      document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    }),
);

function render() {
  const a = $('#app');
  if (view === 'settings') return renderSettings(a);
  if (view === 'form' && open) return renderForm(a);
  if (open) return renderOne(a);
  if (view === 'archive') return renderArchive(a);
  if (view === 'marketing') return renderMarketing(a);
  // Main page: this month's applicants only; earlier months are in Archive.
  const cm = S.stats.current_month;
  const mine = new Set(cm.weeks.flatMap((w) => w.folders));
  const rows = S.applicants.filter((r) => mine.has(r.folder));
  const w = S.stats.this_week;
  a.innerHTML =
    `<div class="card"><div class="row2"><h3 style="margin:0">This week</h3><span class="muted">${esc(w.start)} to ${esc(w.end)}</span></div>` +
    goalBar('Target', w.complete, w.target, w.pct_target, w.target_reached) +
    goalBar('Quota', w.complete, w.quota, w.pct_quota, w.reached) +
    `<div class="stats"><div class="stat"><b>${w.complete}</b>Complete applications</div><div class="stat"><b>${w.ready}</b>Ready (nothing to check)</div><div class="stat"><b>${w.printed}</b>Printed</div><div class="stat"><b>${S.flow.waiting || 0}</b>In chat now</div></div></div>` +
    funnelCard(S.funnel) +
    weeksTable(cm, 'This month') +
    `<div class="card"><table><tr><th>Completed</th><th>Name</th><th>Mobile</th><th>PDFs</th><th>Flags</th><th>To check</th><th>Printed</th><th>Bank result</th></tr>` +
    (rows.length
      ? rows
          .map(
            (r, i) =>
              `<tr class="row" data-i="${i}"><td>${esc(r.completed_at.slice(0, 16).replace('T', ' '))}</td><td><b>${esc(r.name || '(no name yet)')}</b></td><td>${esc(r.mobile)}</td><td>${esc(r.banks_with_pdf)}</td><td>${r.flags ? `<span class="pill warn">${esc(r.flags)}</span>` : ''}</td><td>${r.missing_list.length} item(s)</td><td>${r.printed ? '<span class="pill ok">Yes</span>' : '<span class="pill warn">No</span>'}</td><td>${resultPill(r.result)}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="8" class="muted">No applicants yet. Finished Messenger applications show up here.</td></tr>') +
    '</table></div>';
  a.querySelectorAll('tr.row').forEach(
    (t) =>
      (t.onclick = () => {
        open = rows[+t.dataset.i];
        render();
      }),
  );
}

const resultPill = (x) => (x === 'Approved' ? '<span class="pill ok">Approved</span>' : x === 'Declined' ? '<span class="pill bad">Declined</span>' : '<span class="pill warn">Pending</span>');

// Goal with %: "4 / 10 · 40%" and a bar.
const goalPill = (n, goal, p, done) => `<span class="pill ${done ? 'ok' : 'warn'}">${n} / ${goal} · ${p}%</span>`;
const goalBar = (label, n, goal, p, done) =>
  `<div class="row2" style="margin-top:8px"><b style="min-width:60px">${label}</b><span>${n} / ${goal}</span><b style="margin-left:auto">${p}%</b>${done ? '<span class="pill ok">Reached</span>' : `<span class="muted">${Math.max(goal - n, 0)} to go</span>`}</div><div class="bar"><i class="${done ? 'done' : ''}" style="width:${Math.min(100, p)}%"></i></div>`;

// Funnel: chats → qualified → complete → approved, this week / this month / all time.
function funnelCard(f) {
  if (!f) return '';
  const cols = [f.this_week, f.this_month, f.all_time];
  const row = (label, get, hint) => `<tr><td>${label}${hint ? ` <span class="muted">${hint}</span>` : ''}</td>${cols.map((c) => `<td>${get(c)}</td>`).join('')}</tr>`;
  return (
    `<div class="card"><h3>Funnel</h3><table><tr><th></th><th>This week</th><th>This month</th><th>All time</th></tr>` +
    row('Chats started', (c) => `<b>${c.started}</b>`) +
    row('Qualified', (c) => `${c.qualified} <span class="muted">(${c.pct_qualified}%)</span>`, 'has a card, answering') +
    row('Complete applications', (c) => `<b>${c.complete}</b> <span class="muted">(${c.pct_complete}%)</span>`, '% of chats') +
    row('No credit card yet', (c) => c.no_card) +
    row('Said no / stopped', (c) => c.said_no) +
    row('Already has all our banks', (c) => c.all_banks) +
    row('Still in chat', (c) => c.in_progress) +
    row('Approved by the bank', (c) => `<b>${c.approved}</b> <span class="muted">(${c.pct_approved}% of decided)</span>`) +
    row('Declined / pending', (c) => `${c.declined} / ${c.pending}`) +
    `</table></div>`
  );
}

function sourceCard(f) {
  const rows = f?.by_source || [];
  return (
    `<div class="card"><h3>Where applicants come from</h3>` +
    (rows.length
      ? `<table><tr><th>Source</th><th>Complete</th><th>Share</th><th>Approved</th><th>Approval rate</th></tr>${rows
          .map((r) => `<tr><td>${esc(r.source)}</td><td><b>${r.complete}</b></td><td>${r.share_pct}%</td><td>${r.approved}</td><td>${r.pct_approved}%</td></tr>`)
          .join('')}</table>`
      : '<p class="muted">No applicants yet. Set "Where they came from" on each applicant page.</p>') +
    `</div>`
  );
}

const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });

function weeksTable(m, title) {
  return (
    `<div class="card"><h3>${esc(title)} · ${esc(monthName(m.month))}</h3><table><tr><th>Week</th><th>Complete</th><th>Target</th><th>Quota</th><th>Ready</th><th>Printed</th></tr>` +
    m.weeks
      .slice()
      .reverse()
      .map(
        (w) =>
          `<tr><td>${esc(w.start)} to ${esc(w.end)}</td><td><b>${w.complete}</b></td><td>${goalPill(w.complete, w.target, w.pct_target, w.target_reached)}</td><td>${goalPill(w.complete, w.quota, w.pct_quota, w.reached)}</td><td>${w.ready}</td><td>${w.printed}</td></tr>`,
      )
      .join('') +
    `<tr><td><b>Month total</b></td><td><b>${m.complete}</b></td><td>${goalPill(m.complete, m.target, m.pct_target, m.complete >= m.target)}</td><td>${goalPill(m.complete, m.quota, m.pct_quota, m.complete >= m.quota)}</td><td><b>${m.ready}</b></td><td><b>${m.printed}</b></td></tr></table></div>`
  );
}

// Archive: every earlier month with its weeks and the applicants in each week.
function renderArchive(a) {
  const byFolder = new Map(S.applicants.map((r) => [r.folder, r]));
  const months = S.stats.archive;
  a.innerHTML = months.length
    ? months
        .map(
          (m, mi) =>
            weeksTable(m, 'Archive') +
            `<div class="card"><table><tr><th>Week</th><th>Name</th><th>Mobile</th><th>PDFs</th><th>Printed</th></tr>${m.weeks
              .slice()
              .reverse()
              .flatMap((w) =>
                w.folders.map((f) => {
                  const r = byFolder.get(f);
                  return r
                    ? `<tr class="row" data-f="${esc(f)}"><td class="muted">${esc(w.start)}</td><td><b>${esc(r.name || '(no name yet)')}</b></td><td>${esc(r.mobile)}</td><td>${esc(r.banks_with_pdf)}</td><td>${r.printed ? '<span class="pill ok">Yes</span>' : '<span class="pill warn">No</span>'}</td></tr>`
                    : '';
                }),
              )
              .join('')}</table></div>`,
        )
        .join('')
    : '<div class="card muted">No archived months yet. Each month moves here when the next month starts.</div>';
  a.querySelectorAll('tr[data-f]').forEach(
    (t) =>
      (t.onclick = () => {
        open = byFolder.get(t.dataset.f);
        render();
      }),
  );
}

function renderOne(a) {
  const r = open;
  a.innerHTML =
    `<p><button class="btn sec" id="back">← All applicants</button></p><div class="card"><div class="row2"><h2 style="margin:0">${esc(r.name || '(no name yet)')}</h2><span class="muted">${esc(r.mobile)} · ${esc(r.email)}</span>` +
    `<span style="margin-left:auto" class="row2"><button class="btn" id="edit">Open Default Form</button><button class="btn" id="pall">Print all</button><button class="btn sec" id="mark">${r.printed ? 'Mark not printed' : 'Mark printed'}</button></span></div>` +
    `<p class="muted">Has cards: ${esc(r.existing_cards)}${r.flags ? ` · <span class="pill warn">${esc(r.flags)}</span>` : ''}</p></div>` +
    `<div class="grid"><div class="card"><b>Files</b><ul>${r.files
      .map((f) => `<li><a href="${file(r.folder, f)}" target="_blank">${esc(f)}</a>${f.toLowerCase().endsWith('.pdf') ? ` <button class="btn sec" data-p="${esc(f)}">Print</button>` : ''}</li>`)
      .join('')}</ul></div>` +
    `<div class="card"><b>To check before submitting</b><ul>${r.missing_list.map((m) => `<li>${esc(m)}</li>`).join('')}</ul><b>Defaults used</b><ul>${r.defaults_list
      .map((m) => `<li class="muted">${esc(m)}</li>`)
      .join('')}</ul></div>` +
    `<div class="card"><b>Bank result</b><label for="o_result">Result</label><select id="o_result">${['Pending', 'Approved', 'Declined']
      .map((x) => `<option${x === r.result ? ' selected' : ''}>${x}</option>`)
      .join('')}</select><label for="o_card">Approved card (e.g. Metrobank Titanium)</label><input id="o_card" maxlength="60" value="${esc(r.approved_card)}">` +
    `<label for="o_source">Where they came from</label><select id="o_source">${['Unknown', 'Page post', 'Group', 'Referral', 'Old client', 'Friend or family', 'Other']
      .map((x) => `<option${x === (r.source || 'Unknown') ? ' selected' : ''}>${x}</option>`)
      .join('')}</select>` +
    `<label><input type="checkbox" id="o_proof" style="min-width:0"${r.proof_ok ? ' checked' : ''}> Client said OK to a thank-you post (first-name initial only, no ID, card or photo)</label>` +
    `<p><button class="btn" id="o_save">Save result</button></p></div></div>`;
  $('#back').onclick = () => {
    open = null;
    render();
  };
  $('#edit').onclick = () => {
    view = 'form';
    render();
  };
  $('#pall').onclick = async () => {
    try {
      await post('/api/print', { folder: r.folder });
      msg('Sent to the printer');
      load();
    } catch (e) {
      msg(e.message);
    }
  };
  $('#o_save').onclick = async () => {
    const result = $('#o_result').value;
    const card = $('#o_card').value.trim();
    if (result === 'Approved' && !card) return msg('Type the approved card first.');
    try {
      await post('/api/outcome', { folder: r.folder, result, card, proof_ok: $('#o_proof').checked, source: $('#o_source').value });
      msg('Saved');
      load();
    } catch (e) {
      msg(e.message);
    }
  };
  $('#mark').onclick = async () => {
    await post('/api/printed', { folder: r.folder, printed: !r.printed });
    msg('Saved');
    load();
  };
  a.querySelectorAll('[data-p]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await post('/api/print', { folder: r.folder, name: b.dataset.p });
          msg('Sent to the printer');
        } catch (e) {
          msg(e.message);
        }
      }),
  );
}

// ---- Default Form ---------------------------------------------------------------------------------------------
const provinces = () => Object.keys(ADDR || {});
const citiesOf = (prov) => Object.keys(ADDR?.[prov]?.cities || {});
const cityInfo = (prov, city) => {
  if (ADDR?.[prov]?.cities?.[city]) return ADDR[prov].cities[city];
  // City typed without (or with a differently written) province: look it up everywhere.
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const p of provinces()) for (const [c, info] of Object.entries(ADDR[p].cities)) if (n(c) === n(city)) return { ...info, province: p };
  return null;
};

function field(id, label, value, opts = {}) {
  const list = opts.list ? ` list="${opts.list}"` : '';
  const type = opts.type || 'text';
  const hint = opts.hint ? `<div class="muted" style="font-size:12px">${esc(opts.hint)}</div>` : '';
  return `<div><label for="${id}">${esc(label)}${opts.req ? ' *' : ''}</label><input id="${id}" type="${type}" value="${esc(value)}"${list}>${hint}</div>`;
}
function select(id, label, value, options, req) {
  return `<div><label for="${id}">${esc(label)}${req ? ' *' : ''}</label><select id="${id}"><option value=""></option>${options
    .map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`)
    .join('')}</select></div>`;
}
const datalist = (id, items) => `<datalist id="${id}">${items.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;

async function renderForm(a) {
  if (!ADDR) {
    const r = await (await fetch('/api/address')).json();
    ADDR = r.address;
    LISTS = r.lists;
  }
  const r = open;
  const res = await fetch('/api/form?folder=' + encodeURIComponent(r.folder));
  const j = await res.json();
  if (!res.ok) {
    a.innerHTML = `<p><button class="btn sec" id="back">← Back</button></p><div class="card">${esc(j.error)}</div>`;
    $('#back').onclick = () => {
      view = 'list';
      render();
    };
    return;
  }
  const f = j.form;
  const h = f.home || {};
  const c = f.company || {};
  const married = f.civil_status === 'Married';
  a.innerHTML =
    `<p class="row2"><button class="btn sec" id="back">← ${esc(r.name || 'Applicant')}</button><span class="muted">Default Form · changes make the bank PDFs again</span><button class="btn" id="save" style="margin-left:auto">Save and update PDFs</button></p>` +
    `<div class="card"><h3>Personal Info</h3><div class="fgrid">` +
    field('first_name', 'First name', f.first_name, { req: 1 }) +
    field('middle_name', 'Middle name', f.middle_name) +
    field('last_name', 'Last name', f.last_name, { req: 1 }) +
    field('suffix', 'Suffix', f.suffix) +
    field('name_on_card', 'Name to appear on card', f.name_on_card, { hint: 'Auto-filled from the name. You can edit it.' }) +
    field('birthday', 'Birthday', f.birthday, { type: 'date', req: 1 }) +
    select('gender', 'Gender', f.gender, ['Male', 'Female'], 1) +
    field('nationality', 'Nationality', f.nationality || 'Filipino', { req: 1 }) +
    field('birth_town', 'Place of birth', f.birth_town, { req: 1 }) +
    select('civil_status', 'Civil status', f.civil_status, ['Single', 'Married', 'Separated', 'Widowed'], 1) +
    `<div id="spouse_wrap"${married ? '' : ' hidden'}>${field('spouse_name', 'Spouse full name', f.spouse_name, { req: 1 })}</div>` +
    field('mother_maiden_name', "Mother's full maiden name", f.mother_maiden_name, { req: 1 }) +
    field('email', 'Email', f.email, { type: 'email', req: 1 }) +
    field('mobile', 'Mobile number', f.mobile, { req: 1 }) +
    field('home_phone', 'Home phone', f.home_phone) +
    field('tin_number', 'TIN', f.tin_number, { hint: 'Auto-filled when a TIN shows on the ID they sent. Otherwise ask them by call or text and type it here.' }) +
    field('gsis_sss_number', 'SSS / GSIS number', f.gsis_sss_number) +
    `</div></div>` +
    `<div class="card"><h3>Address</h3><div class="fgrid">` +
    field('h_street', 'House no. / street', h.street, { req: 1 }) +
    field('h_province', 'Province', h.province, { list: 'dl_prov', req: 1 }) +
    field('h_city', 'City / municipality', h.city, { list: 'dl_hcity', req: 1 }) +
    field('h_barangay', 'Barangay', h.barangay, { list: 'dl_hbrgy', req: 1 }) +
    field('h_zip', 'Zip code', h.zip, { hint: 'Auto-filled from the city.', req: 1 }) +
    select('home_ownership', 'Home ownership', f.home_ownership, ['Owned', 'Rented', 'Mortgaged', 'Living with parents']) +
    field('years_of_stay', 'Years of stay', f.years_of_stay) +
    `</div><p class="muted">Permanent address: same as present address.</p></div>` +
    `<div class="card"><h3>Employment</h3><div class="fgrid">` +
    field('employer', 'Employer / business name', f.employer, { req: 1 }) +
    field('position', 'Occupation / position', f.position, { req: 1 }) +
    field('department', 'Department / nature of business', f.department) +
    field('industry', 'Industry', f.industry, { list: 'dl_ind' }) +
    select('employment_type', 'Employment type', f.employment_type, ['Private Sector', 'Government', 'Self-employed']) +
    field('length_of_service', 'Years with present employer', f.length_of_service) +
    field('total_years_working', 'Total years of working', f.total_years_working) +
    field('date_hired', 'Date hired', f.date_hired, { type: 'date' }) +
    field('gross_income', 'Gross annual income', f.gross_income, { hint: 'Only what the applicant declared.' }) +
    field('c_street', 'Company street / building / floor', c.street) +
    field('c_province', 'Company province', c.province, { list: 'dl_prov' }) +
    field('c_city', 'Company city / municipality', c.city, { list: 'dl_ccity' }) +
    field('c_barangay', 'Company barangay', c.barangay, { list: 'dl_cbrgy' }) +
    field('c_zip', 'Company zip code', c.zip, { hint: 'Auto-filled from the city.' }) +
    field('employer_phone', 'Business / office number', f.employer_phone, { hint: 'From our directory or a real public listing. Never guess the number.' }) +
    `<div><label>&nbsp;</label><button class="btn sec" id="findphone" type="button">Find number</button></div>` +
    `</div></div>` +
    `<div class="card"><h3>References</h3><div class="fgrid">` +
    field('ref_name', 'Reference full name', f.ref_name) +
    field('ref_relationship', 'Relationship', f.ref_relationship) +
    field('ref_mobile', 'Reference mobile', f.ref_mobile) +
    `</div></div>` +
    `<div class="card"><h3>Other Credit Cards</h3><div class="fgrid">` +
    field('other_card_company', 'Card company', f.other_card_company) +
    field('other_card_number', 'Card number', f.other_card_number, { hint: 'Rule: "Refuse to give". Never ask for the number.' }) +
    `</div></div>` +
    `<div class="card"><h3>To check before submitting</h3><ul id="missing">${(j.missing || []).map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` +
    datalist('dl_prov', provinces()) +
    datalist('dl_hcity', []) +
    datalist('dl_hbrgy', []) +
    datalist('dl_ccity', []) +
    datalist('dl_cbrgy', []) +
    datalist('dl_ind', LISTS.industries);

  const v = (id) => $('#' + id).value.trim();
  const setList = (id, items) => ($('#' + id).innerHTML = items.map((x) => `<option value="${esc(x)}">`).join(''));

  // Address automations (card app): city list per province, barangays per city, zip (and area code) from the city.
  function wireAddress(p, prov, city, brgy, zip, cityList, brgyList, onCity) {
    const refresh = () => {
      setList(cityList, citiesOf(v(prov)));
      const info = cityInfo(v(prov), v(city));
      setList(brgyList, info?.barangays || []);
      return info;
    };
    $('#' + prov).oninput = refresh;
    $('#' + city).onchange = () => {
      const info = refresh();
      if (info) {
        if (info.zip) $('#' + zip).value = info.zip;
        if (info.province && !v(prov)) $('#' + prov).value = info.province;
        onCity?.(info);
      }
    };
    refresh();
  }
  wireAddress('h', 'h_province', 'h_city', 'h_barangay', 'h_zip', 'dl_hcity', 'dl_hbrgy');
  wireAddress('c', 'c_province', 'c_city', 'c_barangay', 'c_zip', 'dl_ccity', 'dl_cbrgy', (info) => {
    // Area code only: the number itself must come from a real source.
    const ph = $('#employer_phone');
    if (info.areaCode && !ph.value.trim()) ph.value = `(${info.areaCode}) `;
    findPhone(true);
  });

  // Office number from our directory of real numbers (same company, same branch city).
  async function findPhone(quiet) {
    if (!v('employer') || !v('c_city')) return quiet || msg('Enter the employer and company city first.');
    const r = await fetch('/api/phone?employer=' + encodeURIComponent(v('employer')) + '&city=' + encodeURIComponent(v('c_city')));
    const j = await r.json().catch(() => ({}));
    if (j.phone) {
      $('#employer_phone').value = j.phone;
      $('#employer_phone').classList.remove('missing');
      msg('Found in our directory (' + j.source + ')');
    } else if (!quiet) msg('Not in our directory yet. Look it up (company site or Google Maps) and type it; Save keeps it for next time.');
  }
  $('#findphone').onclick = () => findPhone(false);

  // Name on card follows the name until edited by hand.
  let cardManual = !!f.name_on_card && f.name_on_card !== autoCardName(f.first_name, f.middle_name, f.last_name);
  $('#name_on_card').oninput = () => (cardManual = true);
  for (const id of ['first_name', 'middle_name', 'last_name'])
    $('#' + id).oninput = () => {
      if (!cardManual) $('#name_on_card').value = autoCardName(v('first_name'), v('middle_name'), v('last_name'));
    };
  $('#civil_status').onchange = () => ($('#spouse_wrap').hidden = v('civil_status') !== 'Married');

  // Red = still empty. Required (*) fields and the ones the missing list names.
  const MARK = ['first_name', 'last_name', 'birthday', 'gender', 'nationality', 'birth_town', 'civil_status', 'mother_maiden_name', 'email', 'mobile',
    'h_street', 'h_province', 'h_city', 'h_barangay', 'h_zip', 'employer', 'position', 'department', 'industry', 'employment_type',
    'c_street', 'c_province', 'c_city', 'c_barangay', 'c_zip', 'employer_phone', 'length_of_service', 'gross_income', 'tin_number', 'gsis_sss_number'];
  const markEmpty = () => {
    for (const id of MARK) $('#' + id).classList.toggle('missing', !v(id) || /^\(\d+\)\s*$/.test(v(id)));
    $('#spouse_name').classList.toggle('missing', v('civil_status') === 'Married' && !v('spouse_name'));
  };
  a.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', markEmpty));
  a.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', markEmpty));
  markEmpty();

  $('#back').onclick = () => {
    view = 'list';
    render();
  };
  $('#save').onclick = async () => {
    const opt = (x) => (x === '' ? undefined : x);
    const form = {
      ...f,
      first_name: opt(v('first_name')),
      middle_name: opt(v('middle_name')),
      last_name: opt(v('last_name')),
      suffix: opt(v('suffix')),
      name_on_card: opt(v('name_on_card')),
      birthday: opt(v('birthday')),
      gender: opt(v('gender')),
      nationality: opt(v('nationality')),
      birth_town: opt(v('birth_town')),
      civil_status: opt(v('civil_status')),
      spouse_name: opt(v('spouse_name')),
      mother_maiden_name: opt(v('mother_maiden_name')),
      email: opt(v('email')),
      mobile: opt(v('mobile')),
      home_phone: opt(v('home_phone')),
      tin_number: opt(v('tin_number')),
      gsis_sss_number: opt(v('gsis_sss_number')),
      home: { ...h, street: opt(v('h_street')), province: opt(v('h_province')), city: opt(v('h_city')), barangay: opt(v('h_barangay')), zip: opt(v('h_zip')), zip_sure: true },
      home_ownership: opt(v('home_ownership')),
      years_of_stay: opt(v('years_of_stay')),
      employer: opt(v('employer')),
      position: opt(v('position')),
      department: opt(v('department')),
      industry: opt(v('industry')),
      employment_type: opt(v('employment_type')),
      length_of_service: opt(v('length_of_service')),
      total_years_working: opt(v('total_years_working')),
      date_hired: opt(v('date_hired')),
      gross_income: opt(v('gross_income')),
      company: { ...c, street: opt(v('c_street')), province: opt(v('c_province')), city: opt(v('c_city')), barangay: opt(v('c_barangay')), zip: opt(v('c_zip')), zip_sure: true },
      employer_phone: opt(v('employer_phone').replace(/^\(\d+\)\s*$/, '')),
      ref_name: opt(v('ref_name')),
      ref_relationship: opt(v('ref_relationship')),
      ref_mobile: opt(v('ref_mobile')),
      other_card_company: opt(v('other_card_company')),
      other_card_number: opt(v('other_card_number')),
    };
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return msg('Check the email address.');
    try {
      const out = await post('/api/form', { folder: r.folder, form });
      $('#missing').innerHTML = out.missing.map((m) => `<li>${esc(m)}</li>`).join('');
      msg('Saved. PDFs updated: ' + out.pdfs.join(', '));
      load();
    } catch (e) {
      msg(e.message);
    }
  };
}
const autoCardName = (fn, mn, ln) => [fn, mn ? mn[0] + '.' : '', ln].filter(Boolean).join(' ').toUpperCase();

// Marketing: bank results, thank-you posts (only with the client's OK), how our posts do, and a rule check for drafts.
async function renderMarketing(a, fresh) {
  a.innerHTML = '<div class="card muted">Loading…</div>';
  let m;
  try {
    m = await (await fetch('/api/marketing' + (fresh ? '?fresh=1' : ''))).json();
  } catch {
    a.innerHTML = '<div class="card muted">No internet connection</div>';
    return;
  }
  const p = m.page || {};
  const n = (x) => Number(x || 0);
  const posts = p.posts || [];
  const avg = posts.length ? (posts.reduce((t, x) => t + n(x.reactions) + n(x.comments) + n(x.shares), 0) / posts.length).toFixed(1) : '0';
  a.innerHTML =
    `<div class="card"><h3>Bank results</h3><div class="stats"><div class="stat"><b>${m.counts.approved}</b>Approved</div><div class="stat"><b>${m.counts.pending}</b>Pending</div><div class="stat"><b>${m.counts.declined}</b>Declined</div><div class="stat"><b>${m.proof.filter((x) => x.draft).length}</b>Ready for a thank-you post</div></div>` +
    `<p class="muted">Set the result on each applicant's page. A thank-you post needs the client's OK and shows the first-name initial only.</p></div>` +
    sourceCard(S.funnel) +
    `<div class="card"><h3>Thank-you posts</h3>${
      m.proof.length
        ? `<table><tr><th>Name</th><th>Card</th><th>Client OK</th><th>Draft</th></tr>${m.proof
            .map(
              (x, i) =>
                `<tr><td>${esc(x.name)}</td><td>${esc(x.card)}</td><td>${x.proof_ok ? '<span class="pill ok">Yes</span>' : '<span class="pill warn">Ask first</span>'}</td><td>${
                  x.draft ? `<pre style="white-space:pre-wrap;margin:0;font:inherit">${esc(x.draft)}</pre><button class="btn sec" data-copy="${i}">Copy</button>` : '<span class="muted">Needs the client OK and the card name</span>'
                }</td></tr>`,
            )
            .join('')}</table>`
        : '<p class="muted">No approved applicants yet.</p>'
    }</div>` +
    `<div class="card"><h3>Check a draft post</h3><p class="muted">Paste a post before publishing. It uses the same rules the system uses (Meta Community Standards, engagement bait, approval claims).</p><textarea id="draft" rows="5" maxlength="5000" style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px"></textarea><p><button class="btn" id="check">Check</button> <span id="checkres"></span></p></div>` +
    `<div class="card"><div class="row2"><h3 style="margin:0">Our posts</h3><span class="muted">Average engagement per post: ${avg}</span><button class="btn sec" id="refresh" style="margin-left:auto">Refresh</button></div>${
      !p.configured
        ? '<p class="muted">Facebook is not connected on this PC, so post results are not shown.</p>'
        : p.error
          ? `<p class="muted">${esc(p.error)}</p>`
          : `<table><tr><th>Date</th><th>Post</th><th>Reactions</th><th>Comments</th><th>Shares</th><th>Flags</th></tr>${posts
              .map(
                (x) =>
                  `<tr><td>${esc(String(x.created_time).slice(0, 10))}</td><td>${x.permalink_url ? `<a href="${esc(x.permalink_url)}" target="_blank" rel="noreferrer">${esc(x.text.slice(0, 90) || '(no text)')}</a>` : esc(x.text.slice(0, 90))}</td><td>${n(x.reactions)}</td><td>${n(x.comments)}</td><td>${n(x.shares)}</td><td>${x.duplicate ? '<span class="pill warn">Posted twice</span> ' : ''}${x.problem ? `<span class="pill bad">${esc(x.problem)}</span>` : ''}</td></tr>`,
              )
              .join('')}</table>` +
            `<h3 style="margin-top:14px">Scheduled</h3>${
              (p.scheduled || []).length
                ? `<table><tr><th>When</th><th>Post</th><th>Flags</th></tr>${p.scheduled
                    .map((x) => `<tr><td>${esc(new Date(x.when).toLocaleString('en-PH'))}</td><td>${esc(x.text.slice(0, 120))}</td><td>${x.problem ? `<span class="pill bad">${esc(x.problem)}</span>` : '<span class="pill ok">OK</span>'}</td></tr>`)
                    .join('')}</table>`
                : '<p class="muted">Nothing scheduled.</p>'
            }`
    }</div>`;
  a.querySelectorAll('[data-copy]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(m.proof[Number(b.dataset.copy)].draft);
          msg('Copied');
        } catch {
          msg('Select the text and copy it by hand.');
        }
      }),
  );
  $('#refresh').onclick = () => renderMarketing(a, true);
  $('#check').onclick = async () => {
    const text = $('#draft').value.trim();
    if (!text) return msg('Paste a post first.');
    try {
      const r = await post('/api/check', { text });
      $('#checkres').innerHTML = r.problem ? `<span class="pill bad">Do not post: ${esc(r.problem)}</span>` : '<span class="pill ok">OK to post</span>';
    } catch (e) {
      msg(e.message);
    }
  };
}

function renderSettings(a) {
  const s = S.settings;
  const o = S.cardOptions;
  const sel = (id, opts, val) =>
    `<select id="${id}"><option value="">(none)</option>${opts.map((x) => `<option${x === val ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
  a.innerHTML =
    `<div class="card"><h3>Agent</h3><label>Agent name</label><input id="agent_name" value="${esc(s.agent_name)}"><label>Agent code</label><input id="agent_code" value="${esc(s.agent_code)}"></div>` +
    `<div class="card"><h3>Card to apply for (per bank)</h3><div class="row2"><div><label>Metrobank</label>${sel('cc_metrobank', o.metrobank || [], s.card_choice.metrobank)}</div><div><label>EastWest</label>${sel('cc_eastwest', o.eastwest || [], s.card_choice.eastwest)}</div><div><label>China Bank</label>${sel('cc_chinabank', o.chinabank || [], s.card_choice.chinabank)}</div></div></div>` +
    `<div class="card"><h3>Printing</h3><label>Printer</label>${sel('printer', S.printers, s.printer)}<label><input type="checkbox" id="auto_print" style="min-width:0"${s.auto_print ? ' checked' : ''}> Print new complete applications automatically (PC must be on)</label>${S.acrobat ? '' : '<p class="pill warn">Adobe Acrobat not found: printing will not work</p>'}</div>` +
    `<div class="card"><h3>Text on the forms</h3><div class="row2"><div><label>Answer size (pt, 0 = fit each box)</label><input id="text_uniform_size" type="number" step="0.5" min="0" max="20" value="${s.text_uniform_size}"></div><div><label><input type="checkbox" id="text_bold" style="min-width:0"${s.text_bold ? ' checked' : ''}> Bold</label></div></div></div>` +
    `<div class="card"><h3>Weekly goals</h3><div class="row2"><div><label>Target per week (what we aim for now)</label><input id="weekly_target" type="number" min="1" max="1000" step="1" value="${s.weekly_target}"></div><div><label>Quota per week (the real goal)</label><input id="weekly_quota" type="number" min="1" max="1000" step="1" value="${s.weekly_quota}"></div>` +
    `<div><label>Week starts on</label><select id="week_start_day">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}"${i === s.week_start_day ? ' selected' : ''}>${d}</option>`).join('')}</select></div></div></div>` +
    '<button class="btn" id="save">Save settings</button>' +
    `<div class="card" style="margin-top:14px"><h3>Test mode</h3><p class="muted">While test mode is on, the bots (Messenger and comment replies) answer only the people listed below. Turn it off only for the launch.</p>` +
    `<label><input type="checkbox" id="tm_on" style="min-width:0"${S.testMode.on ? ' checked' : ''}> Test mode on</label>` +
    `<label for="tm_ids">Tester ids or test comment ids (one per line)</label><textarea id="tm_ids" rows="3" style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px">${esc(S.testMode.ids.join(String.fromCharCode(10)))}</textarea>` +
    `<p><button class="btn" id="tm_save">Save test mode</button> ${S.testMode.on ? '<span class="pill warn">On: only testers get replies</span>' : '<span class="pill ok">Off: everyone gets replies</span>'}</p></div>` +
    `<div class="card" style="margin-top:14px"><h3>Office numbers directory</h3><p class="muted">Real numbers only: found online (with the link) or typed by you in a Default Form. Used for the next client from the same company and city.</p>` +
    (S.phonebook.length
      ? `<table><tr><th>Company</th><th>City</th><th>Number</th><th>Source</th><th></th></tr>${S.phonebook
          .map((e, i) => `<tr><td>${esc(e.company)}</td><td>${esc(e.city)}</td><td>${esc(e.phone)}</td><td class="muted">${/^https?:\/\//.test(e.source) ? `<a href="${esc(e.source)}" target="_blank" rel="noreferrer">link</a>` : esc(e.source)}</td><td><button class="btn sec" data-del="${i}">Remove</button></td></tr>`)
          .join('')}</table>`
      : '<p class="muted">Empty for now.</p>') +
    `</div>`;
  a.querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const e = S.phonebook[Number(b.dataset.del)];
        if (!confirm(`Remove ${e.company} (${e.city})?`)) return;
        try {
          await post('/api/phonebook/remove', { company: e.company, city: e.city });
          msg('Removed');
          load();
        } catch (err) {
          msg(err.message);
        }
      }),
  );
  $('#tm_save').onclick = async () => {
    const on = $('#tm_on').checked;
    const ids = $('#tm_ids').value.split(/\s+/).filter(Boolean);
    if (ids.some((x) => !/^\d{1,25}$/.test(x))) return msg('Tester ids are numbers only.');
    if (!on && !confirm('Turn test mode off? Everyone who messages or comments will get automated replies.')) return;
    try {
      await post('/api/testmode', { on, ids });
      msg('Test mode saved');
      load();
    } catch (e) {
      msg(e.message);
    }
  };
  $('#save').onclick = async () => {
    const v = (id) => $('#' + id).value;
    const body = {
      ...s,
      agent_name: v('agent_name'),
      agent_code: v('agent_code'),
      printer: v('printer'),
      auto_print: $('#auto_print').checked,
      text_bold: $('#text_bold').checked,
      text_uniform_size: Number(v('text_uniform_size')),
      weekly_quota: Number(v('weekly_quota')),
      weekly_target: Number(v('weekly_target')),
      week_start_day: Number(v('week_start_day')),
      card_choice: Object.fromEntries(['metrobank', 'eastwest', 'chinabank'].map((b) => [b, v('cc_' + b)]).filter(([, x]) => x)),
    };
    if (!Number.isInteger(body.weekly_quota) || body.weekly_quota < 1 || body.weekly_quota > 1000) return msg('Weekly quota must be a whole number from 1 to 1000.');
    if (!Number.isInteger(body.weekly_target) || body.weekly_target < 1 || body.weekly_target > 1000) return msg('Weekly target must be a whole number from 1 to 1000.');
    try {
      await post('/api/settings', body);
      msg('Settings saved');
      load();
    } catch (e) {
      msg(e.message);
    }
  };
}

load();
setInterval(() => {
  if (view === 'list' && !open) load();
}, 15000);
