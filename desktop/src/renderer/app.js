'use strict';

/**
 * Renderer for the macOS 12 skin. Talks to the main process only through
 * window.llm (see preload). No node, no network.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};

const state = {
    core: null,
    // recommended | installed | settings | runtime:<id>
    view: 'recommended',
    fit: 'all',            // all | fits
    query: '',
    // Per-runtime deep probes, fetched lazily on first visit and cached here
    // so switching back is instant. { [id]: {loading, data, error} }
    details: {},
};

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

const groups = () => state.core?.groups ?? [];
const budget = () => state.core?.budgetGB ?? null;

const gb = (n) => (Number.isFinite(n) ? `${n.toFixed(1).replace(/\.0$/, '')} GB` : '—');

function visible(m) {
    if (state.fit === 'fits' && m.fit !== 'fits') return false;
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return [m.name, m.ref, m.family, m.quant]
        .some((v) => v && String(v).toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ */
/* toast + clipboard                                                   */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1400);
}

async function copy(text, label = 'Copied') {
    if (!text) return;
    await window.llm.copy(text);
    toast(label);
}

/* ------------------------------------------------------------------ */
/* sidebar                                                             */
/* ------------------------------------------------------------------ */

function renderSidebarRuntimes(s) {
    const host = $('#sb-runtimes');
    host.textContent = '';
    for (const r of s.runtimes ?? []) {
        const b = el('button', 'srow');
        b.title = r.blurb;
        const dot = el('span', 'dot');
        if (r.serving) dot.classList.add('ok');
        else if (r.installed) dot.classList.add('warn');
        b.append(dot, el('span', 'nm', r.name));
        // "0.3.0-dev" → "0.3.0"; long semvers stay readable in the 260px rail
        if (r.version) b.append(el('span', 'ct', r.version.split('-')[0].slice(0, 10)));
        b.setAttribute('data-view', `runtime:${r.id}`);
        b.addEventListener('click', () => switchView(`runtime:${r.id}`));
        host.append(b);
    }
    markCurrent();
}

/** Reflect state.view on whichever sidebar row owns it. */
function markCurrent() {
    document.querySelectorAll('.srow[data-view]').forEach((b) => {
        b.setAttribute('aria-current', String(b.dataset.view === state.view));
    });
}

function renderCounts(s) {
    const counts = {
        recommended: (s.groups ?? []).reduce((a, g) => a + g.models.length, 0) || null,
        installed: (s.runtimes ?? []).reduce((a, r) => a + (r.models?.length ?? 0), 0),
    };
    for (const [k, v] of Object.entries(counts)) {
        const n = document.querySelector(`[data-count="${k}"]`);
        if (n) n.textContent = v == null ? '—' : String(v);
    }
}

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

function renderHeader(s) {
    const labels = { recommended: 'Recommended', installed: 'Installed', settings: 'Settings' };
    let heading = labels[state.view];
    if (!heading && state.view.startsWith('runtime:')) {
        const id = state.view.slice(8);
        heading = (s.runtimes ?? []).find((r) => r.id === id)?.name ?? id;
    }
    $('#title').textContent = heading ?? 'LLM Checker';

    const hw = s.hardware;
    const t = s.tally ?? {};
    let sub = 'Scanning…';
    if (s.phase === 'error') sub = 'Scan failed';
    else if (s.phase === 'ready' && hw) {
        const gpu = (hw.gpuModel ?? hw.cpuModel ?? '').replace(/^NVIDIA GeForce\s+/i, '');
        const parts = [gpu, hw.vramGB && `${hw.vramGB} GB`].filter(Boolean).join(' · ');
        const fits = [t.fits && `${t.fits} fit`, t.tight && `${t.tight} tight`, t.over && `${t.over} over`, t.unknown && `${t.unknown} unknown`]
            .filter(Boolean).join(' · ');
        sub = [parts, fits].filter(Boolean).join(' — ');
    }
    $('#subtitle').textContent = sub;

    // The fit filter and search only mean something on the model list.
    $('#seg-fit').style.visibility = state.view === 'recommended' ? 'visible' : 'hidden';
    $('#search').parentElement.style.visibility =
        state.view === 'recommended' || state.view === 'installed' ? 'visible' : 'hidden';
}

/* ------------------------------------------------------------------ */
/* content blocks                                                      */
/* ------------------------------------------------------------------ */

function modelRow(m) {
    const row = el('div', 'row');
    if (!visible(m)) row.style.display = 'none';
    if (m.fit === 'over') row.classList.add('dis');

    const fitIndicator = el('span', `fit ${m.fit}`);
    fitIndicator.title = m.fit === 'unknown' ? 'Memory compatibility unknown' : `Memory: ${m.fit}`;
    fitIndicator.setAttribute('aria-label', fitIndicator.title);
    row.append(fitIndicator);

    const info = el('div', 'info');
    const t1 = el('div', 't1', m.name);
    if (m.params || m.quant) t1.append(el('span', null, [m.params, m.quant].filter(Boolean).join(' · ')));
    info.append(t1);
    if (m.context?.limited) info.append(el('div', 't2', m.context.native ? `Context limited to ${m.context.effective.toLocaleString()} tokens` : 'Native context unverified'));
    if (m.purpose) info.append(el('div', 't2', m.purpose));
    row.append(info);

    // Provenance chip. A measured score and an estimated one must never look
    // like the same kind of number — 77% of the catalog is estimated.
    const q = m.quality ?? { measured: false };
    const chip = el('span', `prov ${q.measured ? 'meas' : 'est'}`);
    if (q.measured) {
        chip.textContent = q.sizeUnknown ? 'measured · family' : 'measured';
        chip.title = [
            `${q.metric} = ${q.rawScore}`,
            `source: ${q.source}`,
            q.independent ? 'independently run' : 'vendor self-reported',
            q.sizeUnknown ? 'the board published no size, so this scores the family, not this exact build' : null,
            'benchmarks are run at fp16; a quantization penalty is applied',
        ].filter(Boolean).join('\n');
    } else {
        chip.textContent = 'estimated';
        chip.title = `No benchmark for this model. Quality inferred from ${q.basis ?? 'parameter count'}.`;
    }
    row.append(chip);

    row.append(el('span', 'sz', gb(m.sizeGB)));

    const btn = el('button', 'btn', 'Install');
    btn.title = m.commands?.pull ?? '';
    if (m.fit === 'over' || !m.commands?.pull) btn.disabled = true;
    btn.addEventListener('click', () =>
        copy(m.commands?.pull ?? m.commands?.run, 'Install command copied'));
    row.append(btn);
    return row;
}

function phasesBlock(s) {
    const p = el('div', 'phases');
    const order = [
        ['hardware', 'Detecting hardware'],
        ['runtimes', 'Probing local runtimes'],
        ['models', 'Scoring the catalog'],
    ];
    const reached = { idle: -1, hardware: 0, runtimes: 1, models: 2, ready: 3, error: 3 }[s.phase] ?? -1;
    order.forEach(([key, label], i) => {
        const row = el('div', `phase ${i < reached ? 'done' : i === reached ? 'busy' : ''}`);
        row.append(el('i'), el('span', null, label));
        const t = s.timings?.[key];
        if (Number.isFinite(t)) row.append(el('span', 't', `${(t / 1000).toFixed(1)} s`));
        p.append(row);
    });
    return p;
}

/* ---------------- views ---------------- */

function viewRecommended(host, s) {
    if (s.phase !== 'ready') { host.append(phasesBlock(s)); return; }
    for (const g of groups()) {
        const shown = g.models.filter(visible);
        if (!shown.length && (state.query || state.fit !== 'all')) continue;
        host.append(el('div', 'gtitle', `${g.label} — ${g.evaluated ? g.evaluated.toLocaleString() : ''} evaluated`));
        const grp = el('div', 'group');
        g.models.forEach((m) => grp.append(modelRow(m)));
        host.append(grp);
    }
}

function viewInstalled(host, s) {
    for (const r of s.runtimes ?? []) {
        host.append(el('div', 'gtitle',
            `${r.name} — ${r.serving ? 'serving' : r.installed ? 'installed' : 'not installed'}`));
        const grp = el('div', 'group');

        if (r.models?.length) {
            for (const m of r.models) {
                const row = el('div', 'row');
                row.append(el('span', 'fit fits'));
                const info = el('div', 'info');
                info.append(el('div', 't1', m.ref));
                if (m.quant || m.params) {
                    info.append(el('div', 't2', [m.params, m.quant].filter(Boolean).join(' · ')));
                }
                row.append(info);
                row.append(el('span', 'sz', m.sizeBytes ? gb(m.sizeBytes / 1e9) : ''));
                grp.append(row);
            }
        } else if (r.installed) {
            // Installed but nothing loaded — offering an install command here
            // would contradict the status it sits under.
            const row = el('div', 'row');
            const info = el('div', 'info');
            info.append(el('div', 't1', r.serving ? 'Running — no models loaded' : 'Installed — not running'));
            info.append(el('div', 't2', r.blurb));
            row.append(info);
            grp.append(row);
        } else {
            const cmd = el('div', 'cmd');
            cmd.append(el('code', null, r.installCommand));
            const b = el('button', 'btn sec', 'Copy');
            b.addEventListener('click', () => copy(r.installCommand, 'Install command copied'));
            cmd.append(b);
            grp.append(cmd);
        }
        host.append(grp);
    }
}

async function viewSettings(host, s) {
    const hw = s.hardware ?? {};
    const rows = [
        ['Graphics card', hw.gpuModel],
        ['Video memory', hw.vramGB && `${hw.vramGB} GB`],
        ['Backend', hw.backend],
        ['CUDA', hw.cudaVersion && `${hw.cudaVersion} · driver ${hw.driver ?? '—'}`],
        ['Processor', hw.cpuModel],
        ['Cores', hw.cores && `${hw.cores}${hw.physicalCores ? ` (${hw.physicalCores} physical)` : ''}`],
        ['Instruction set', hw.simd],
        ['System memory', hw.ramGB && `${hw.ramGB} GB`],
        ['Tier', hw.tier],
        ['Largest model', hw.maxModelGB && `${hw.maxModelGB} GB`],
        ['Fingerprint', hw.fingerprint],
        ['Platform', `${hw.platform ?? ''} ${hw.arch ?? ''}`.trim() || null],
    ].filter(([, v]) => v);

    host.append(el('div', 'gtitle', 'Detected hardware'));
    const grp = el('div', 'group');
    for (const [k, v] of rows) {
        const row = el('div', 'kv');
        row.append(el('span', 'k', k), el('span', 'v', String(v)));
        grp.append(row);
    }
    host.append(grp);

    host.append(el('div', 'gtitle', 'Actions'));
    const act = el('div', 'group');
    const row = el('div', 'row');
    const info = el('div', 'info');
    info.append(el('div', 't1', 'Rescan this machine'));
    info.append(el('div', 't2', 'Re-detect hardware, runtimes and the catalog'));
    row.append(info);
    const b = el('button', 'btn', 'Rescan');
    b.addEventListener('click', async () => {
        toast('Rescanning…');
        try { await window.llm.scan(); } catch { toast('Scan failed'); }
    });
    row.append(b);
    act.append(row);
    host.append(act);

    // Real actions, not commands to copy. The app exists so none of this
    // needs a terminal, so each one runs in-process and renders its result
    // right here.
    host.append(el('div', 'gtitle', 'Tools'));
    const adv = el('div', 'group');
    let actions = [];
    try { actions = await window.llm.listActions(); } catch { /* rendered empty below */ }

    for (const a of actions) {
        const row = el('div', 'row');
        const inf = el('div', 'info');
        inf.append(el('div', 't1', a.label));
        inf.append(el('div', 't2', `${a.blurb} · ${a.estimate}`));
        row.append(inf);

        const btn = el('button', 'btn', a.destructive ? 'Run…' : 'Run');
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            const original = btn.textContent;
            btn.textContent = 'Running…';
            const out = await window.llm.runAction(a.id);
            btn.disabled = false;
            btn.textContent = original;

            // Replace any previous result for this action.
            row.nextElementSibling?.classList.contains('result') && row.nextElementSibling.remove();
            const res = el('div', 'row result');
            if (!out.ok) {
                res.append(el('div', 'info', `Failed: ${out.error}`));
            } else if (out.kind === 'table') {
                const box = el('div', 'info');
                const tbl = el('table', 'mini');
                const head = el('tr');
                out.columns.forEach((c) => head.append(el('th', null, c)));
                tbl.append(head);
                out.rows.forEach((r) => {
                    const tr = el('tr');
                    r.forEach((c) => tr.append(el('td', null, String(c))));
                    tbl.append(tr);
                });
                box.append(tbl);
                res.append(box);
            } else {
                res.append(el('div', 'info', out.text ?? 'Done.'));
            }
            row.after(res);
            toast(`${a.label} — ${out.ms} ms`);
        });
        row.append(btn);
        adv.append(row);
    }
    host.append(adv);

    host.append(el('div', 'gtitle', 'About'));
    const about = el('div', 'group');
    try {
        const inf = await window.llm.appInfo();
        for (const [k, v] of [
            ['Version', inf.version],
            ['Electron', inf.electron],
            ['Node', inf.node],
            ['Platform', `${inf.platform} ${inf.arch}`],
        ]) {
            const kv = el('div', 'kv');
            kv.append(el('span', 'k', k), el('span', 'v', String(v)));
            about.append(kv);
        }
    } catch { /* about block is best-effort */ }
    host.append(about);
}

/**
 * One renderer for all six runtime pages. Each runtime supplies its own
 * `sections` from the main process, so the shape stays uniform while the
 * content is specific — an honest empty state where a runtime has nothing,
 * never a padded row.
 */
function viewRuntime(host, s, id) {
    const summary = (s.runtimes ?? []).find((r) => r.id === id);
    const entry = state.details[id];
    const d = entry?.data;

    // Status is known from the cheap scan, so it paints before the deep probe.
    const src = d ?? summary;
    if (!src) { host.append(el('div', 'gtitle', 'Unknown runtime')); return; }

    host.append(el('div', 'gtitle', 'Status'));
    const st = el('div', 'group');
    const statusRows = [
        ['State', src.serving ? 'Running' : src.installed ? 'Installed, not running' : 'Not installed'],
        ['Version', src.version],
        ['Formats', (src.formats ?? []).join(', ')],
        ['Endpoint', src.endpoint],
    ].filter(([, v]) => v);
    for (const [k, v] of statusRows) {
        const row = el('div', 'kv');
        row.append(el('span', 'k', k), el('span', 'v', String(v)));
        st.append(row);
    }
    host.append(st);

    if (!src.installed) {
        host.append(el('div', 'gtitle', 'Install'));
        const g = el('div', 'group');
        const cmd = el('div', 'cmd');
        cmd.append(el('code', null, src.installCommand));
        const b = el('button', 'btn sec', 'Copy');
        b.addEventListener('click', () => copy(src.installCommand, 'Install command copied'));
        cmd.append(b);
        g.append(cmd);
        host.append(g);
        return;
    }

    if (entry?.loading && !d) {
        host.append(el('div', 'gtitle', 'Details'));
        const g = el('div', 'group');
        const row = el('div', 'row');
        row.append(el('div', 'info', 'Probing this runtime…'));
        g.append(row);
        host.append(g);
        return;
    }

    if (entry?.error) {
        const e = el('div', 'errbox');
        e.append(el('b', null, 'Could not read this runtime'), document.createTextNode(entry.error));
        host.append(e);
    }

    // Sections come straight from the runtime's own probeDetails().
    for (const sec of d?.sections ?? []) {
        host.append(el('div', 'gtitle', sec.title));
        const g = el('div', 'group');
        if (sec.rows?.length) {
            for (const r of sec.rows) {
                const row = el('div', 'kv');
                row.append(el('span', 'k', r.label), el('span', 'v', String(r.value)));
                if (r.hint) row.title = r.hint;
                g.append(row);
            }
        } else {
            const row = el('div', 'row');
            row.append(el('div', 'info', sec.empty ?? 'Nothing to show.'));
            g.append(row);
        }
        host.append(g);
    }

    const models = d?.models ?? summary?.models ?? [];
    host.append(el('div', 'gtitle', `Models — ${models.length}`));
    const mg = el('div', 'group');
    if (models.length) {
        for (const m of models) {
            const row = el('div', 'row');
            row.append(el('span', `fit ${m.loaded ? 'fits' : ''}`.trim()));
            const info = el('div', 'info');
            info.append(el('div', 't1', m.ref ?? m.name));
            const meta = [m.params, m.quant, m.family, m.contextLength && `${m.contextLength} ctx`]
                .filter(Boolean).join(' · ');
            if (meta) info.append(el('div', 't2', meta));
            row.append(info);
            if (m.sizeBytes) row.append(el('span', 'sz', gb(m.sizeBytes / 1e9)));
            mg.append(row);
        }
    } else {
        const row = el('div', 'row');
        row.append(el('div', 'info',
            src.serving ? 'Running, but no models loaded.' : 'No models found for this runtime.'));
        mg.append(row);
    }
    host.append(mg);

    host.append(el('div', 'gtitle', 'Actions'));
    const ag = el('div', 'group');
    for (const a of d?.actions ?? []) {
        const row = el('div', 'cmd');
        const info = el('div', 'info');
        info.append(el('div', 't1', a.label));
        row.append(info);
        if (a.command) row.append(el('code', null, a.command));
        const b = el('button', 'btn sec', 'Copy');
        b.addEventListener('click', () => copy(a.command, 'Copied'));
        row.append(b);
        ag.append(row);
    }
    const refresh = el('div', 'row');
    const ri = el('div', 'info');
    ri.append(el('div', 't1', 'Re-probe this runtime'));
    ri.append(el('div', 't2', 'Runs the deep checks again'));
    refresh.append(ri);
    const rb = el('button', 'btn', entry?.loading ? 'Probing…' : 'Refresh');
    if (entry?.loading) rb.disabled = true;
    rb.addEventListener('click', () => loadRuntimeDetails(id, { force: true }));
    refresh.append(rb);
    ag.append(refresh);
    host.append(ag);
}

const VIEWS = { recommended: viewRecommended, installed: viewInstalled, settings: viewSettings };

function renderContent() {
    const host = $('#content');
    host.textContent = '';
    const s = state.core;
    if (!s) return;

    if (s.phase === 'error') {
        const e = el('div', 'errbox');
        e.append(el('b', null, 'The scan could not finish'), document.createTextNode(s.error ?? ''));
        host.append(e);
        return;
    }
    if (state.view.startsWith('runtime:')) {
        viewRuntime(host, s, state.view.slice(8));
        return;
    }
    (VIEWS[state.view] ?? viewRecommended)(host, s);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function switchView(view) {
    state.view = view;
    markCurrent();
    renderHeader(state.core ?? {});
    renderContent();

    // Opening a runtime page triggers its deep probe the first time only.
    const id = view.startsWith('runtime:') ? view.slice(8) : null;
    if (id && !state.details[id]) loadRuntimeDetails(id);
}

async function loadRuntimeDetails(id, { force = false } = {}) {
    if (state.details[id]?.loading) return;
    if (state.details[id]?.data && !force) return;
    state.details[id] = { loading: true, data: state.details[id]?.data ?? null, error: null };
    if (state.view === `runtime:${id}`) renderContent();
    try {
        const data = await window.llm.runtimeDetails(id);
        state.details[id] = { loading: false, data, error: null };
    } catch (err) {
        state.details[id] = { loading: false, data: null, error: err?.message ?? String(err) };
    }
    if (state.view === `runtime:${id}`) renderContent();
}

function apply(s) {
    state.core = s;
    renderSidebarRuntimes(s);
    renderCounts(s);
    renderHeader(s);
    renderContent();
}

document.addEventListener('DOMContentLoaded', async () => {
    // Platform chrome: macOS keeps native traffic lights; everywhere else the
    // window is frameless, so show our own controls (top-right, line glyphs).
    if (window.llm.platform === 'darwin') {
        document.body.classList.add('mac');
    } else {
        const ctl = document.getElementById('winctl');
        ctl.hidden = false;
        document.getElementById('w-min').addEventListener('click', () => window.llm.winMinimize());
        document.getElementById('w-max').addEventListener('click', () => window.llm.winMaximize());
        document.getElementById('w-close').addEventListener('click', () => window.llm.winClose());
    }

    window.llm.onState(apply);
    apply(await window.llm.snapshot());

    document.querySelectorAll('.srow[data-view]').forEach((b) => {
        b.addEventListener('click', () => switchView(b.dataset.view));
    });

    document.querySelectorAll('#seg-fit button').forEach((b) => {
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-fit button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
            b.setAttribute('aria-pressed', 'true');
            state.fit = b.dataset.fit;
            renderContent();
        });
    });

    $('#search').addEventListener('input', (ev) => {
        state.query = ev.target.value.trim();
        renderContent();
    });
});
