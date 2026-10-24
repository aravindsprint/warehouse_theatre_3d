/* Warehouse Theatre 3D — opt-in "Get updates" card.
   Shown only to System Managers, only when the publisher has switched sign-ups on
   (api/updates.UPDATES_SITE), never on the first visit, and never again once sent or
   declined. Nothing is sent unless the user ticks the box and presses Send. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, addCSS } = core;
  const { defineComponent, reactive, computed } = Vue;

  addCSS('wtf-updates-style', `
.wtf-upd{position:absolute;right:14px;bottom:40px;z-index:40;width:312px;max-width:calc(100% - 28px);background:var(--wt-bg2);border:1px solid var(--wt-border);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);padding:14px 14px 12px;color:var(--wt-text);animation:wtf-upd-in .25s ease-out}
@keyframes wtf-upd-in{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
.wtf-upd h3{font-size:13px;font-weight:800;margin:0 26px 4px 0}
.wtf-upd p{font-size:11px;color:var(--wt-text2);line-height:1.5;margin:0 0 10px}
.wtf-upd .wtf-x{position:absolute;top:10px;right:10px}
.wtf-upd-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wtf-upd-row .wtf-field{margin-bottom:8px}
.wtf-upd label.wtf-upd-ok{display:flex;gap:8px;align-items:flex-start;font-size:10.5px;color:var(--wt-text2);line-height:1.45;margin:2px 0 10px;cursor:pointer}
.wtf-upd label.wtf-upd-ok input{margin-top:2px;accent-color:var(--wt-accent);flex-shrink:0}
.wtf-upd-site{font-family:ui-monospace,Menlo,monospace;color:var(--wt-text);word-break:break-all}
.wtf-upd-b{display:flex;gap:6px;align-items:center}
.wtf-upd-b .wtf-btn-pri{flex:1}
.wtf-upd-links{display:flex;justify-content:space-between;margin-top:8px}
.wtf-upd-links button{background:none;border:0;color:var(--wt-text3);font-size:10px;cursor:pointer;padding:2px 0}
.wtf-upd-links button:hover{color:var(--wt-text)}
@media (max-width:600px){.wtf-upd{right:8px;left:8px;width:auto;bottom:56px}}
`);

  const VISITS_KEY = 'wt3d:visits';
  const s = reactive({ open: false, info: null, form: { name: '', email: '', company: '', phone: '' }, consent: false, busy: false, error: '', done: false });

  function visits() {
    try { const n = (parseInt(localStorage.getItem(VISITS_KEY), 10) || 0) + 1; localStorage.setItem(VISITS_KEY, String(n)); return n; }
    catch (e) { return 2; }
  }

  let checked = false;
  bus.on('group-selected', async () => {
    if (checked) return;
    checked = true;
    if (!store.canEdit) return;               // System Managers only
    if (visits() < 2) return;                 // never on the first visit
    try {
      const info = await core.api('updates', 'get_signup_state', {});
      if (!info || !info.show) return;
      s.info = info;
      Object.assign(s.form, info.prefill || {});
      setTimeout(() => { s.open = true; }, 4000);   // let the map settle first
    } catch (e) { /* never get in the way of the app */ }
  });

  async function send() {
    s.error = '';
    if (!s.form.name.trim()) { s.error = 'Please enter your name.'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.form.email.trim())) { s.error = 'Please enter a valid email address.'; return; }
    if (!s.consent) { s.error = 'Please tick the box to agree first.'; return; }
    s.busy = true;
    try {
      await core.api('updates', 'submit_signup', Object.assign({}, s.form, { consent: 1 }), true);
      s.done = true;
      setTimeout(() => { s.open = false; }, 3500);
    } catch (e) { s.error = e.message; }
    finally { s.busy = false; }
  }
  async function dismiss(never) {
    s.open = false;
    try { await core.api('updates', 'dismiss_signup', { never: never ? 1 : 0 }, true); } catch (e) {}
  }

  const UpdatesCard = defineComponent({
    name: 'WtfUpdatesCard',
    setup() {
      const siteShort = computed(() => String((s.info && s.info.site_url) || '').replace(/^https?:[/][/]/, ''));
      return { s, send, dismiss, store, siteShort };
    },
    template: `
      <form v-if="s.open && store.curView !== 'health'" class="wtf-upd" role="dialog" aria-labelledby="wtf-upd-t" @submit.prevent="send">
        <button type="button" class="wtf-x" aria-label="Not now" @click="dismiss(false)">✕</button>
        <template v-if="s.done">
          <h3 id="wtf-upd-t">Thanks, you're on the list</h3>
          <p>You'll hear about new features and tips. Reply to any email to unsubscribe.</p>
        </template>
        <template v-else>
          <h3 id="wtf-upd-t">Get Warehouse Theatre updates</h3>
          <p>New features, setup tips and direct help from the developer. Free, a few emails a year.</p>
          <div v-if="s.error" class="wtf-err" role="alert">{{s.error}}</div>
          <div class="wtf-upd-row">
            <div class="wtf-field"><label for="wtf-upd-n">Name</label><input id="wtf-upd-n" class="wtf-inp" v-model="s.form.name" autocomplete="name" required/></div>
            <div class="wtf-field"><label for="wtf-upd-e">Email</label><input id="wtf-upd-e" class="wtf-inp" v-model="s.form.email" type="email" autocomplete="email" required/></div>
          </div>
          <div class="wtf-upd-row">
            <div class="wtf-field"><label for="wtf-upd-c">Company <span class="wtf-muted">optional</span></label><input id="wtf-upd-c" class="wtf-inp" v-model="s.form.company" autocomplete="organization"/></div>
            <div class="wtf-field"><label for="wtf-upd-p">Phone <span class="wtf-muted">optional</span></label><input id="wtf-upd-p" class="wtf-inp" v-model="s.form.phone" type="tel" autocomplete="tel"/></div>
          </div>
          <label class="wtf-upd-ok"><input type="checkbox" v-model="s.consent"/>
            <span>Send these details and this site's address (<span class="wtf-upd-site">{{siteShort}}</span>) to the app's developer, Aravind G, for updates and replies. No stock or business data is sent. You can unsubscribe any time.</span></label>
          <div class="wtf-upd-b"><button type="submit" class="wtf-btn wtf-btn-pri" :disabled="s.busy">{{ s.busy ? 'Sending…' : 'Send' }}</button></div>
          <div class="wtf-upd-links">
            <button type="button" @click="dismiss(false)">Not now</button>
            <button type="button" @click="dismiss(true)">Don't ask again</button>
          </div>
        </template>
      </form>`,
  });
  ext.overlays.push(UpdatesCard);

  core.updates = { open: () => { s.open = true; }, state: s };
});

})();
