import {
  buildStationOperationalStatus, stationOperationalStatusLabel
} from './station-operational-status.js';

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class StationOperationalDialog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.context = null;
    this.handleKeydown = event => {
      if (event.key === 'Escape' && this.hasAttribute('open')) this.hide();
    };
  }

  connectedCallback() {
    if (this.shadowRoot.childElementCount) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { color-scheme:light dark; font-family:Arial,"Noto Sans Hebrew",sans-serif; }
        .layer { position:fixed; inset:0; z-index:1200; display:grid; place-items:center; padding:14px; background:rgba(5,8,15,.8); direction:rtl; }
        .layer[hidden] { display:none; }
        .panel { width:min(540px,100%); padding:20px; border:1px solid light-dark(#d7dee9,#374151); border-radius:16px; background:light-dark(#fff,#151923); color:light-dark(#111827,#f3f4f6); box-shadow:0 24px 70px rgba(0,0,0,.35); }
        .head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
        h2 { margin:0; font-size:21px; }
        .subtitle { margin:5px 0 0; color:light-dark(#64748b,#9ca3af); font-size:12px; }
        .close { width:34px; height:34px; flex:0 0 auto; border:0; border-radius:50%; background:light-dark(#e5e7eb,#293142); color:inherit; font-size:22px; cursor:pointer; }
        .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:18px; }
        .field { min-height:76px; display:grid; align-content:center; gap:5px; padding:12px; border:1px solid light-dark(#d7dee9,#374151); border-radius:11px; background:light-dark(#f8fafc,#0d111a); }
        .field span { color:light-dark(#64748b,#9ca3af); font-size:11px; }
        .field strong { font-size:17px; }
        .status { display:inline-flex; width:max-content; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; font-size:12px; }
        .status::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
        .status.running { color:#22c55e; background:rgba(34,197,94,.12); }
        .status.stopped { color:#f59e0b; background:rgba(245,158,11,.12); }
        .status.not_started { color:light-dark(#64748b,#9ca3af); background:rgba(148,163,184,.12); }
        .warning { margin-top:12px; padding:10px 12px; border:1px solid rgba(239,68,68,.4); border-radius:10px; background:rgba(239,68,68,.09); color:#ef4444; font-size:12px; }
        .footer { display:flex; justify-content:flex-end; margin-top:16px; }
        .done { padding:9px 15px; border:0; border-radius:9px; background:#2563eb; color:white; font-weight:800; cursor:pointer; }
        @media (max-width:440px) { .grid { grid-template-columns:1fr; } }
      </style>
      <div class="layer" hidden role="dialog" aria-modal="true" aria-labelledby="title">
        <section class="panel">
          <div class="head"><div><h2 id="title"></h2><p class="subtitle" id="subtitle"></p></div><button class="close" type="button" aria-label="סגירה">×</button></div>
          <div class="grid" id="details"></div>
          <div class="warning" id="warning" hidden></div>
          <div class="footer"><button class="done" type="button">סגור</button></div>
        </section>
      </div>`;
    const layer = this.shadowRoot.querySelector('.layer');
    layer.addEventListener('click', event => { if (event.target === layer) this.hide(); });
    this.shadowRoot.querySelector('.close').addEventListener('click', () => this.hide());
    this.shadowRoot.querySelector('.done').addEventListener('click', () => this.hide());
  }

  show(context) {
    this.context = { ...(context || {}) };
    this.render();
    this.shadowRoot.querySelector('.layer').hidden = false;
    this.setAttribute('open', '');
    document.addEventListener('keydown', this.handleKeydown);
    this.shadowRoot.querySelector('.close').focus();
  }

  refresh({ races, nowMs = Date.now() } = {}) {
    if (!this.context || !this.hasAttribute('open')) return;
    this.context = { ...this.context, ...(Array.isArray(races) ? { races } : {}), nowMs };
    this.render();
  }

  hide() {
    this.shadowRoot.querySelector('.layer').hidden = true;
    this.removeAttribute('open');
    document.removeEventListener('keydown', this.handleKeydown);
  }

  render() {
    if (!this.context) return;
    const snapshot = buildStationOperationalStatus(this.context);
    const team = Number(snapshot.team) || snapshot.team;
    const stationName = this.context.stationName || `תחנה ${Number(snapshot.stationId) || snapshot.stationId}`;
    const route = String(this.context.routeNumber || '').trim();
    const schedule = String(this.context.scheduledLabel || '').trim();
    this.shadowRoot.querySelector('#title').textContent = `${stationName} · צוות ${team}`;
    this.shadowRoot.querySelector('#subtitle').textContent = [
      schedule, route ? `מסלול ${route}` : ''
    ].filter(Boolean).join(' · ') || 'פרטי תחנה תפעוליים';
    const roundLabel = snapshot.status === 'running' ? 'סבב פעיל'
      : snapshot.totalRoundCount ? 'סבב אחרון' : 'סבב';
    this.shadowRoot.querySelector('#details').innerHTML = `
      <div class="field"><span>מצב התחנה</span><strong class="status ${escapeHtml(snapshot.status)}">${escapeHtml(stationOperationalStatusLabel(snapshot))}</strong></div>
      <div class="field"><span>${roundLabel}</span><strong>${snapshot.currentRound || '—'}</strong></div>
      <div class="field"><span>סבבים שהושלמו</span><strong>${snapshot.completedRoundCount}</strong></div>
      <div class="field"><span>סך כל הסבבים שנפתחו</span><strong>${snapshot.totalRoundCount}</strong></div>`;
    const warning = this.shadowRoot.querySelector('#warning');
    warning.hidden = !snapshot.hasConcurrentRaces;
    warning.textContent = snapshot.hasConcurrentRaces
      ? `אזהרה: בתחנה קיימים ${snapshot.activeRaceCount} סבבים פעילים במקביל.` : '';
  }
}

if (!customElements.get('station-operational-dialog')) {
  customElements.define('station-operational-dialog', StationOperationalDialog);
}
