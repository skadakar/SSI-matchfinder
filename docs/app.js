'use strict';

// ─── COLUMN DEFINITIONS ──────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'date',                label: 'Date',         defaultVisible: true,  sortable: true  },
  { key: 'endDate',             label: 'End date',     defaultVisible: false, sortable: true  },
  { key: 'name',                label: 'Match',        defaultVisible: true,  sortable: true  },
  { key: 'organizer',           label: 'Club',         defaultVisible: true,  sortable: true  },
  { key: 'discipline',          label: 'Discipline',   defaultVisible: true,  sortable: true  },
  { key: 'level',               label: 'Level',        defaultVisible: false, sortable: true  },
  { key: 'country',             label: 'Country',      defaultVisible: true,  sortable: true  },
  { key: 'county',              label: 'County',       defaultVisible: true,  sortable: true  },
  { key: 'region',              label: 'Region',       defaultVisible: true,  sortable: true  },
  { key: 'registrationDeadline',label: 'Reg. deadline',defaultVisible: false, sortable: true  },
  { key: 'registrationStarts',  label: 'Reg. opens',   defaultVisible: false, sortable: true  },
  { key: 'participants',        label: 'Participants', defaultVisible: true,  sortable: true  },
  { key: 'registration',        label: 'Registration', defaultVisible: true,  sortable: false },
];

const DEFAULT_COLS      = COLUMNS.filter(c => c.defaultVisible).map(c => c.key);
const DEFAULT_SORT      = 'date';

const FILTERABLE_COLS = new Set(['organizer', 'discipline', 'level', 'country', 'county', 'region', 'registration']);
const DEFAULT_DIR       = 'asc';
const TODAY = new Date().toISOString().slice(0, 10);

const DEFAULT_COUNTRIES = ['NOR', 'SWE'];

// Norwegian county (fylke) → traditional region.
// Includes both current (2024+) and pre-2024 merged county names.
const NOR_COUNTY_TO_REGION = {
  'Oslo': 'Østlandet', 'Akershus': 'Østlandet', 'Østfold': 'Østlandet',
  'Buskerud': 'Østlandet', 'Innlandet': 'Østlandet',
  'Vestfold': 'Østlandet', 'Telemark': 'Østlandet',
  'Viken': 'Østlandet', 'Vestfold og Telemark': 'Østlandet',   // pre-2024 names
  'Agder': 'Sørlandet',
  'Rogaland': 'Vestlandet', 'Vestland': 'Vestlandet', 'Møre og Romsdal': 'Vestlandet',
  'Trøndelag': 'Midt-Norge', 'Sør-Trøndelag': 'Midt-Norge', 'Nord-Trøndelag': 'Midt-Norge',
  'Nordland': 'Nord-Norge', 'Troms og Finnmark': 'Nord-Norge',
  'Troms': 'Nord-Norge', 'Finnmark': 'Nord-Norge',
};
const NOR_REGION_ORDER = ['Østlandet', 'Sørlandet', 'Vestlandet', 'Midt-Norge', 'Nord-Norge'];

/** Maps a match's raw county to a display region (NOR → region, SWE → normalized county). */
function countyToRegion(m) {
  if (!m.county) return '';
  if (m.country === 'NOR') return NOR_COUNTY_TO_REGION[m.county] || m.county;
  // Sweden: strip trailing " läns" / "s lán" / " lán" suffix Nominatim adds
  return m.county.replace(/\s+l[aä]ns?$/i, '').trim() || m.county;
}

// ─── APP STATE ────────────────────────────────────────────────────────────────

let allMatches  = [];
let map         = null;
let markerLayer = null;

let state = buildDefaultState();

function buildDefaultState() {
  return {
    view:       'map',
    q:          '',
    discipline: [],
    level:      [],
    organizer:  [],
    countries:  [...DEFAULT_COUNTRIES],
    regions:    [],
    broadRegions: [],
    newMatch:    false,
    newMatchDays: 7,
    regOpen:    true,
    from:       '',
    to:         '',
    cols:       [...DEFAULT_COLS],
    sort:       DEFAULT_SORT,
    dir:        DEFAULT_DIR,
  };
}

// ─── URL ←→ STATE ─────────────────────────────────────────────────────────────

function readStateFromURL() {
  const p = new URLSearchParams(location.search);
  const colsParam = p.get('cols');
  return {
    view:       p.get('view')       || 'map',
    q:          p.get('q')          || '',
    discipline: p.get('discipline') ? p.get('discipline').split(',').filter(Boolean) : [],
    level:      p.get('level')      ? p.get('level').split(',').filter(Boolean)      : [],
    organizer:  p.get('organizer')  ? p.get('organizer').split(',').filter(Boolean)  : [],
    countries:  p.get('countries')  ? p.get('countries').split(',').filter(Boolean) : [...DEFAULT_COUNTRIES],
    regions:    p.get('regions')    ? p.get('regions').split(',').filter(Boolean)    : [],
    broadRegions: p.get('broad')    ? p.get('broad').split(',').filter(Boolean)       : [],
    newMatch:    p.get('newMatch') === '1',
    newMatchDays: p.has('newMatchDays') ? Math.min(14, Math.max(1, parseInt(p.get('newMatchDays'), 10))) : 7,
    regOpen:    p.has('regOpen') ? p.get('regOpen') !== '0' : true,
    from:       p.get('from') || '',
    to:         p.get('to')         || '',
    cols:       colsParam ? colsParam.split(',').filter(Boolean) : [...DEFAULT_COLS],
    sort:       p.get('sort')       || DEFAULT_SORT,
    dir:        p.get('dir')        || DEFAULT_DIR,
  };
}

function writeStateToURL() {
  const p = new URLSearchParams();
  if (state.view !== 'map')                         p.set('view',       state.view);
  if (state.q)                                      p.set('q',          state.q);
  if (state.discipline.length)                      p.set('discipline', state.discipline.join(','));
  if (state.level.length)                           p.set('level',      state.level.join(','));
  if (state.organizer.length)                       p.set('organizer',  state.organizer.join(','));
  if (!countriesMatchDefault(state.countries))      p.set('countries',  state.countries.join(','));
  if (state.regions.length)                         p.set('regions',    state.regions.join(','));
  if (state.broadRegions.length)                    p.set('broad',      state.broadRegions.join(','));
  if (state.newMatch)                               p.set('newMatch',   '1');
  if (state.newMatch && state.newMatchDays !== 7)   p.set('newMatchDays', String(state.newMatchDays));
  if (!state.regOpen)                                p.set('regOpen',    '0');
  if (state.from)                                    p.set('from',       state.from);
  if (state.to)                                     p.set('to',         state.to);
  if (!colsMatchDefault(state.cols))                p.set('cols',       state.cols.join(','));
  if (state.sort !== DEFAULT_SORT)                  p.set('sort',       state.sort);
  if (state.dir  !== DEFAULT_DIR)                   p.set('dir',        state.dir);

  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function colsMatchDefault(cols) {
  return JSON.stringify([...cols].sort()) === JSON.stringify([...DEFAULT_COLS].sort());
}

function countriesMatchDefault(countries) {
  return JSON.stringify([...countries].sort()) === JSON.stringify([...DEFAULT_COUNTRIES].sort());
}

// ─── FILTERING + SORTING ──────────────────────────────────────────────────────

function applyFilters(matches) {
  const q = state.q.toLowerCase();
  return matches.filter(m => {
    if (q && ![m.name, m.organizer, m.city, m.venue].some(
      f => (f || '').toLowerCase().includes(q)
    )) return false;
    if (state.countries.length && m.country && !state.countries.includes(m.country)) return false;
    if (state.regions.length && m.county && !state.regions.includes(m.county)) return false;
    if (state.broadRegions.length) {
      const r = countyToRegion(m);
      if (r && !state.broadRegions.includes(r)) return false;
    }
    if (state.newMatch) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - state.newMatchDays);
      if (!m.firstSeen || m.firstSeen < cutoff.toISOString().slice(0, 10)) return false;
    }
    if (state.discipline.length && !state.discipline.includes(m.discipline)) return false;
    if (state.level.length      && !state.level.includes(m.level))           return false;
    if (state.organizer.length  && !state.organizer.includes(m.organizer))   return false;
    if (state.regOpen && m.registrationOpen !== true)                        return false;
    if (state.from       && m.date < state.from)                         return false;
    if (state.to         && m.date > state.to)                           return false;
    return true;
  });
}

function sortMatches(matches) {
  const key = state.sort;
  const dir = state.dir === 'asc' ? 1 : -1;
  return [...matches].sort((a, b) => {
    const va = String(a[key] ?? '').toLowerCase();
    const vb = String(b[key] ?? '').toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

// ─── MAP ──────────────────────────────────────────────────────────────────────

function initMap() {
  // Default view: Scandinavia
  map = L.map('map').setView([62, 15], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  markerLayer = L.markerClusterGroup({ chunkedLoading: true });
  map.addLayer(markerLayer);
}

function renderMap(matches) {
  markerLayer.clearLayers();

  const located = matches.filter(m => m.lat != null && m.lng != null);

  for (const m of located) {
    const regBadge = m.registrationOpen === true
      ? '<span class="reg-open">Registration open</span>'
      : m.registrationOpen === false
        ? '<span class="reg-closed">Registration closed</span>'
        : '';

    const dateStr = m.endDate && m.endDate !== m.date
      ? `${formatDate(m.date)} – ${formatDate(m.endDate)}`
      : formatDate(m.date);

    const meta = [m.organizer, m.discipline, m.level].filter(l => l && l !== '--').map(escHtml).join(' · ');

    let participantsTxt = '';
    if (m.participants != null) {
      const max = m.maxParticipants;
      participantsTxt = (max && max > 0) ? `${m.participants} / ${max}` : String(m.participants);
      if (m.waitingCount && m.waitingCount > 0) participantsTxt += ` (+${m.waitingCount} waiting)`;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const regOpens = m.registrationStarts && m.registrationStarts > todayStr && m.registrationOpen !== true
      ? formatDate(m.registrationStarts) : '';

    const popup = `
      <div class="popup">
        <div class="popup-title">${escHtml(m.name)}</div>
        <div class="popup-meta">${meta}</div>
        <div class="popup-date">${dateStr}</div>
        ${m.city          ? `<div class="popup-city">${escHtml(m.city)}${m.country ? ', ' + escHtml(m.country) : ''}</div>` : ''}
        ${regBadge        ? `<div>${regBadge}</div>` : ''}
        ${regOpens        ? `<div class="popup-reg-dl">Reg. opens: ${regOpens}</div>` : ''}
        ${m.registrationDeadline ? `<div class="popup-reg-dl">Deadline: ${formatDate(m.registrationDeadline)}</div>` : ''}
        ${participantsTxt ? `<div class="popup-participants">${participantsTxt}</div>` : ''}
        ${m.url           ? `<div><a href="${m.url}" target="_blank" rel="noopener noreferrer">View on SSI →</a></div>` : ''}
      </div>`;

    L.marker([m.lat, m.lng]).bindPopup(popup, { maxWidth: 280 }).addTo(markerLayer);
  }

  if (located.length > 0) {
    try {
      map.fitBounds(markerLayer.getBounds(), { padding: [40, 40], maxZoom: 10 });
    } catch (_) { /* ignore if bounds is empty */ }
  }
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

function renderColToggles() {
  const container = document.getElementById('col-toggles');
  container.innerHTML = '';

  for (const col of COLUMNS) {
    const label = document.createElement('label');
    label.className = 'col-toggle';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = col.key;
    cb.checked = state.cols.includes(col.key);

    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.cols.includes(col.key)) state.cols.push(col.key);
      } else {
        state.cols = state.cols.filter(k => k !== col.key);
      }
      writeStateToURL();
      render();
    });

    label.appendChild(cb);
    label.append(' ' + col.label);
    container.appendChild(label);
  }
}

function renderTableHeader() {
  const tr = document.getElementById('table-header');
  tr.innerHTML = '';

  for (const col of COLUMNS) {
    if (!state.cols.includes(col.key)) continue;

    const th = document.createElement('th');
    th.textContent   = col.label;
    th.dataset.key   = col.key;

    if (col.sortable) {
      th.className = 'sortable';
      if (state.sort === col.key) th.classList.add(state.dir);

      th.addEventListener('click', () => {
        if (state.sort === col.key) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = col.key;
          state.dir  = 'asc';
        }
        writeStateToURL();
        render();
      });
    }

    tr.appendChild(th);
  }
}

function getCellFilterValue(key, m) {
  switch (key) {
    case 'organizer':    return m.organizer || null;
    case 'discipline':   return m.discipline || null;
    case 'level':        return (m.level && m.level !== '--') ? m.level : null;
    case 'country':      return m.country || null;
    case 'county':       return m.county || null;
    case 'region':       return countyToRegion(m) || null;
    case 'registration': return m.registrationOpen === true ? 'open' : null;
    default:             return null;
  }
}

function isCellActive(key, m) {
  switch (key) {
    case 'organizer':    return state.organizer.includes(m.organizer);
    case 'discipline':   return state.discipline.includes(m.discipline);
    case 'level':        return !!(m.level && m.level !== '--' && state.level.includes(m.level));
    case 'country':      return !countriesMatchDefault(state.countries) && state.countries.includes(m.country);
    case 'county':       return !!(m.county && state.regions.includes(m.county));
    case 'region':       return !!(countyToRegion(m) && state.broadRegions.includes(countyToRegion(m)));
    case 'registration': return m.registrationOpen === true && state.regOpen;
    default:             return false;
  }
}

function toggleCellFilter(key, m) {
  function toggle(arr, val) {
    const i = arr.indexOf(val);
    if (i === -1) arr.push(val); else arr.splice(i, 1);
  }
  switch (key) {
    case 'organizer':   toggle(state.organizer, m.organizer); break;
    case 'discipline':  if (m.discipline) toggle(state.discipline, m.discipline); break;
    case 'level': {
      const l = m.level && m.level !== '--' ? m.level : null;
      if (l) toggle(state.level, l);
      break;
    }
    case 'country':
      if (!m.country) break;
      if (state.countries.length === 1 && state.countries[0] === m.country) {
        state.countries = [...DEFAULT_COUNTRIES];
      } else {
        state.countries = [m.country];
      }
      break;
    case 'county':
      if (m.county) toggle(state.regions, m.county);
      break;
    case 'region': {
      const r = countyToRegion(m);
      if (r) toggle(state.broadRegions, r);
      break;
    }
    case 'registration':
      state.regOpen = !state.regOpen;
      break;
  }
  syncFilterInputs();
  writeStateToURL();
  render();
}

function renderTableBody(matches) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';

  for (const m of matches) {
    const tr = document.createElement('tr');
    for (const col of COLUMNS) {
      if (!state.cols.includes(col.key)) continue;
      const td = document.createElement('td');
      appendCellContent(td, col.key, m);
      if (FILTERABLE_COLS.has(col.key) && getCellFilterValue(col.key, m) !== null) {
        td.classList.add('filterable');
        if (isCellActive(col.key, m)) td.classList.add('filter-active');
        td.addEventListener('click', () => toggleCellFilter(col.key, m));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function appendCellContent(td, key, m) {
  switch (key) {
    case 'date':
      td.textContent = formatDate(m.date);
      break;
    case 'endDate':
      td.textContent = formatDate(m.endDate);
      break;
    case 'name':
      if (m.url) {
        const a = document.createElement('a');
        a.href   = m.url;
        a.target = '_blank';
        a.rel    = 'noopener noreferrer';
        a.textContent = m.name;
        td.appendChild(a);
      } else {
        td.textContent = m.name;
      }
      break;
    case 'organizer':
      td.textContent = m.organizer;
      break;
    case 'discipline':
      td.textContent = m.discipline;
      break;
    case 'level':
      td.textContent = (m.level && m.level !== '--') ? m.level : '';
      break;
    case 'county':
      td.textContent = m.county || '';
      break;
    case 'region':
      td.textContent = countyToRegion(m);
      break;
    case 'registration': {
      const span = document.createElement('span');
      if (m.registrationOpen === true) {
        span.className   = 'reg-open';
        span.textContent = 'Open';
      } else if (m.registrationOpen === false) {
        span.className   = 'reg-closed';
        span.textContent = 'Closed';
      } else {
        span.textContent = '—';
      }
      td.appendChild(span);
      break;
    }
    case 'registrationDeadline':
      td.textContent = formatDate(m.registrationDeadline);
      break;
    case 'registrationStarts':
      td.textContent = formatDate(m.registrationStarts);
      break;
    case 'participants': {
      if (m.participants == null) { td.textContent = '—'; break; }
      const max  = m.maxParticipants;
      const wait = m.waitingCount;
      let text   = String(m.participants);
      if (max && max > 0) {
        text = `${m.participants}\u202f/\u202f${max}`;
        const ratio = m.participants / max;
        if (ratio >= 0.9) td.classList.add('capacity-critical');
        else if (ratio >= 0.6) td.classList.add('capacity-warning');
      }
      // Build tooltip
      const parts = [max && max > 0 ? `${m.participants} registered out of ${max} spots` : `${m.participants} registered`];
      if (wait && wait > 0) parts.push(`${wait} on the waiting list`);
      td.title = parts.join(' · ');
      td.textContent = text;
      if (wait && wait > 0) {
        td.classList.add('capacity-critical');
        const sm = document.createElement('small');
        sm.className   = 'waiting';
        sm.textContent = ` +${wait}`;
        td.appendChild(sm);
      }
      break;
    }
    default:
      td.textContent = m[key] ?? '';
  }
}

function renderTable(matches) {
  renderColToggles();
  renderTableHeader();
  renderTableBody(matches);
}

// ─── FILTER UI ────────────────────────────────────────────────────────────────

function populateCountryDropdown() {
  const countries = [...new Set(allMatches.map(m => m.country).filter(Boolean))].sort();
  const panel = document.getElementById('country-panel');
  panel.innerHTML = '';
  for (const c of countries) {
    const lbl = document.createElement('label');
    const cb  = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = c;
    cb.checked = state.countries.includes(c);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.countries.includes(c)) state.countries.push(c);
      } else {
        state.countries = state.countries.filter(x => x !== c);
      }
      updateCountryBtn();
      writeStateToURL();
      render();
    });
    lbl.appendChild(cb);
    lbl.append(' ' + c);
    panel.appendChild(lbl);
  }
  updateCountryBtn();
}

function updateCountryBtn() {
  const btn = document.getElementById('country-btn');
  const n   = state.countries.length;
  if (n === 0) {
    btn.textContent = 'All countries';
    btn.classList.remove('has-selection');
  } else if (n <= 4) {
    btn.textContent = [...state.countries].sort().join(', ');
    btn.classList.add('has-selection');
  } else {
    btn.textContent = `${n} countries`;
    btn.classList.add('has-selection');
  }
}

function populateDropdowns() {
  populateCountryDropdown();

  // Disciplines
  const disciplines = [...new Set(allMatches.map(m => m.discipline).filter(Boolean))].sort();
  const dSel = document.getElementById('filter-discipline');
  dSel.innerHTML = '';
  for (const d of disciplines) {
    const opt = document.createElement('option');
    opt.value       = d;
    opt.textContent = d;
    dSel.appendChild(opt);
  }

  // Levels
  const levels = [...new Set(allMatches.map(m => m.level).filter(l => l && l !== '--'))].sort();
  const lSel = document.getElementById('filter-level');
  lSel.innerHTML = '';
  for (const l of levels) {
    const opt = document.createElement('option');
    opt.value = l; opt.textContent = l;
    lSel.appendChild(opt);
  }

  // On mobile expand both selects so all options are visible without inner scroll
  if (window.matchMedia('(max-width: 720px)').matches) {
    dSel.size = dSel.options.length || 1;
    lSel.size = lSel.options.length || 1;
  }
}

function syncFilterInputs() {
  document.getElementById('filter-search').value     = state.q;
  document.getElementById('filter-from').value       = state.from;
  document.getElementById('filter-to').value         = state.to;
  document.getElementById('filter-reg-open').checked = state.regOpen;
  document.getElementById('filter-new-match').checked = state.newMatch;
  document.getElementById('new-match-slider').value   = state.newMatchDays;
  document.getElementById('new-match-days-label').textContent = state.newMatchDays;
  document.getElementById('new-match-slider-wrap').hidden     = !state.newMatch;

  const dSel = document.getElementById('filter-discipline');
  for (const opt of dSel.options) {
    opt.selected = state.discipline.includes(opt.value);
  }
  document.getElementById('clear-discipline').hidden = state.discipline.length === 0;

  const lSel = document.getElementById('filter-level');
  for (const opt of lSel.options) {
    opt.selected = state.level.includes(opt.value);
  }
  document.getElementById('clear-level').hidden = state.level.length === 0;

  // Mobile filter toggle badge
  const dot = document.querySelector('#filter-toggle-btn .filter-active-dot');
  if (dot) dot.hidden = !(state.discipline.length || state.level.length || state.regions.length || state.organizer.length || state.q || state.from || state.to || state.newMatch);

  document.querySelectorAll('#country-panel input[type=checkbox]').forEach(cb => {
    cb.checked = state.countries.includes(cb.value);
  });
  updateCountryBtn();
}

function bindFilterEvents() {
  function on(id, event, fn) {
    document.getElementById(id).addEventListener(event, fn);
  }

  on('filter-search', 'input', e => {
    state.q = e.target.value.trim();
    writeStateToURL();
    render();
  });

  // Country dropdown
  const countryBtn   = document.getElementById('country-btn');
  const countryPanel = document.getElementById('country-panel');
  countryBtn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = countryPanel.hidden;
    countryPanel.hidden = !opening;
    countryBtn.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('country-wrap').contains(e.target)) {
      countryPanel.hidden = true;
      countryBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Region dropdown — removed from sidebar; filter-active state kept for click-to-filter in table rows

  on('filter-reg-open', 'change', e => {
    state.regOpen = e.target.checked;
    writeStateToURL();
    render();
  });

  on('filter-new-match', 'change', e => {
    state.newMatch = e.target.checked;
    document.getElementById('new-match-slider-wrap').hidden = !state.newMatch;
    writeStateToURL();
    render();
  });

  on('new-match-slider', 'input', e => {
    state.newMatchDays = parseInt(e.target.value, 10);
    document.getElementById('new-match-days-label').textContent = state.newMatchDays;
    writeStateToURL();
    render();
  });

  on('filter-discipline', 'change', () => {
    const sel = document.getElementById('filter-discipline');
    state.discipline = Array.from(sel.selectedOptions).map(o => o.value);
    writeStateToURL();
    render();
  });

  on('filter-level', 'change', () => {
    const sel = document.getElementById('filter-level');
    state.level = Array.from(sel.selectedOptions).map(o => o.value);
    writeStateToURL();
    render();
  });

  on('clear-discipline', 'click', () => {
    state.discipline = [];
    writeStateToURL();
    render();
  });

  on('clear-level', 'click', () => {
    state.level = [];
    writeStateToURL();
    render();
  });

  const filterToggleBtn = document.getElementById('filter-toggle-btn');
  filterToggleBtn.addEventListener('click', () => {
    const panel = document.getElementById('filters');
    const open  = panel.classList.toggle('open');
    filterToggleBtn.classList.toggle('active', open);
    filterToggleBtn.setAttribute('aria-expanded', String(open));
  });

  on('filter-from', 'change', e => {
    state.from = e.target.value;
    writeStateToURL();
    render();
  });

  on('filter-to', 'change', e => {
    state.to = e.target.value;
    writeStateToURL();
    render();
  });

  on('btn-reset', 'click', () => {
    Object.assign(state, { q: '', discipline: [], level: [], organizer: [], countries: [...DEFAULT_COUNTRIES], regions: [], regOpen: true, from: TODAY, to: '' });
    syncFilterInputs();
    writeStateToURL();
    render();
  });

  on('btn-copy-link', 'click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const btn = document.getElementById('btn-copy-link');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(() => {
      prompt('Copy this link:', location.href);
    });
  });
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

function bindTabEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      writeStateToURL();
      activateView();
      render();
    });
  });
}

function activateView() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.id === `view-${state.view}`);
  });
  if (state.view === 'map' && map) {
    // Leaflet needs a nudge after the element becomes visible
    setTimeout(() => map.invalidateSize(), 50);
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function render() {
  const filtered = applyFilters(allMatches);
  const sorted   = sortMatches(filtered);

  const located = filtered.filter(m => m.lat != null).length;
  const locNote = state.view === 'map' && located < filtered.length
    ? ` (${filtered.length - located} without coordinates hidden from map)`
    : '';

  document.getElementById('match-count').textContent =
    `${filtered.length} of ${allMatches.length} matches${locNote}`;

  syncFilterInputs();

  if (state.view === 'map') {
    renderMap(sorted);
  } else {
    renderTable(sorted);
  }
}

const THEMES = ['light', 'dark', 'gruvbox'];

function initTheme() {
  // The <head> inline script already applied the saved/preferred theme.
  updateThemeButton();
  document.getElementById('btn-theme').addEventListener('click', () => {
    const cur  = document.documentElement.dataset.theme;
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    updateThemeButton();
  });
}

function updateThemeButton() {
  const theme = document.documentElement.dataset.theme;
  const btn   = document.getElementById('btn-theme');
  const map   = {
    light:   { icon: '🌙', label: 'Switch to dark mode'    },
    dark:    { icon: '🟡', label: 'Switch to Gruvbox theme' },
    gruvbox: { icon: '☀',  label: 'Switch to light mode'   },
  };
  const { icon, label } = map[theme] || map.light;
  btn.textContent = icon;
  btn.title       = label;
  btn.setAttribute('aria-label', label);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    // Force local-noon to avoid UTC-offset date shifts
    return new Date(dateStr.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return dateStr; }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  state = readStateFromURL();

  initTheme();
  initMap();
  bindFilterEvents();
  bindTabEvents();
  activateView();

  try {
    const res = await fetch('data/matches.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allMatches = Array.isArray(data.matches) ? data.matches : [];

    if (data.generated) {
      document.getElementById('last-updated').textContent =
        'Updated ' + new Date(data.generated).toLocaleString();
    }

    populateDropdowns();
    syncFilterInputs();
    render();
  } catch (err) {
    document.getElementById('match-count').textContent =
      'Failed to load match data: ' + err.message;
    console.error('Failed to load match data:', err);
  }
}

init();
