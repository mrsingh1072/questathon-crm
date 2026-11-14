const app=document.querySelector('#app'), status=document.querySelector('#status'), sync=document.querySelector('#sync');
const esc=s=>String(s??'Unknown').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const evidence=x=>`<span class="source">Source: ${esc(x||'not recorded')}</span>`;
function list(items, render, empty='No evidence has been stored yet.'){return items?.length?`<ul>${items.map(render).join('')}</ul>`:`<p class="unknown">${empty}</p>`}
function card(id, title, body){return `<article id="${id}"><h3>${title}</h3>${body}</article>`}
function account(a){const t=document.querySelector('#account').content.cloneNode(true);t.querySelector('h2').textContent=a.name;t.querySelector('.source').textContent=`Account source: ${a.evidence}`;
  const deals=list(a.deals,d=>`<li><strong>${esc(d.name||d.title||d.id||'Unnamed deal')}</strong><br>${list((Object.entries(d).filter(([,v])=>typeof v==='number')),([k,v])=>`${esc(k)}: ${esc(v)} ${evidence(d.id||a.evidence)}`,'No backed numeric value recorded.')}${evidence(d.id||a.evidence)}</li>`,'No deal records stored.');
  const power=list(a.people,p=>`<li><strong>${esc(p.name)}</strong><br>Decides: ${esc(p.decision)} · Pays: ${esc(p.payer)} · Uses: ${esc(p.user)} · Blocks: ${esc(p.blocker)}<br>Relationship: ${esc(p.relationship)} ${evidence(p.source)}</li>`,'No stakeholder role evidence recorded.');
  const actions=list(a.actions,x=>`<li><strong>${x.rank}. ${esc(x.action)}</strong><br>Owner: ${esc(x.owner)} · Date: ${esc(x.date)} · Deal impact: ${esc(x.impact)} ${evidence(x.source)}</li>`,'No safe ranked actions can be derived from stored evidence.');
  const deadlines = list(a.deadlines, deadline => `<li>${esc(typeof deadline === 'object' ? JSON.stringify(deadline) : deadline)} ${evidence(deadline?.id || a.evidence)}</li>`, 'No deadlines recorded.');
  const risks=list(a.risks,x=>`<li>${esc(x.text)}<br>Turns bad: ${esc(x.turnsBad)} ${evidence(x.source)}</li>`,'No explicit risk evidence recorded.');
  const unknowns=list(a.unknowns,x=>`<li><strong>${esc(x.question)}</strong><br>Why it matters: ${esc(x.why)}<br>Ask: ${esc(x.ask)} ${evidence(x.source)}</li>`,'Unknown: the source data has not recorded explicit gaps or an owner to resolve them.');
  t.querySelector('.grid').innerHTML=card('book','What is the book worth?',deals)+card('people','Who holds the power?',power)+card('actions','What do you do first?',actions)+card('risks','What is about to go wrong?',risks+'<h4>Deadlines</h4>'+deadlines)+card('unknowns','What do you still not know?',unknowns);t.querySelector('pre').textContent=JSON.stringify({account:a.raw,paperwork:a.paperwork},null,2);return t;}
function signals(d){const raw=d.signals?.data?.signals||d.signals?.data?.events||d.signals?.data||[];const items=Array.isArray(raw)?raw:[raw];return items.length?`<section class="events"><h2>Live event feed</h2>${list(items,x=>`<li>${esc(x.text||x.title||JSON.stringify(x))} ${evidence(x.id||x.record_id||'get_signals')}</li>`)}</section>`:''}
const picker = document.querySelector('#accounts');
const navigation = document.querySelector('#sections');
const feed = document.querySelector('#signals');
let accounts = [];
let lastView = '';
let syncing = false;
let refreshing = false;

function renderAccount() {
  const selected = accounts[Number(picker.value)];
  const view = JSON.stringify(selected);
  if (selected && view === lastView) return;
  const wasOpen = app.querySelector('details')?.open;
  lastView = view;
  navigation.hidden = !selected;
  if (!selected) {
    app.innerHTML = '<section class="empty"><h2>Waiting for account evidence</h2><p>Account records will appear after the server syncs.</p></section>';
    return;
  }
  app.replaceChildren(account(selected));
  app.querySelector('details').open = Boolean(wasOpen);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error('Dashboard unavailable');
    const data = await response.json();
    const previous = accounts[Number(picker.value)]?.id;
    const previousOptions = JSON.stringify(accounts.map(a => [a.id, a.name]));
    accounts = data.accounts;
    if (previousOptions !== JSON.stringify(accounts.map(a => [a.id, a.name])) || accounts.length === 0) {
      picker.replaceChildren(...accounts.map((a, index) => new Option(a.name, index)));
      if (!accounts.length) picker.add(new Option('No accounts yet', ''));
      picker.value = String(Math.max(0, accounts.findIndex(a => a.id === previous)));
    }
    picker.disabled = accounts.length === 0;
    sync.disabled = syncing || !data.configured || Boolean(data.rateLimitSeconds);
    status.textContent = !data.configured ? 'Server sync is unavailable.' : data.rateLimitSeconds
      ? `Live · Next sync available in ${data.rateLimitSeconds}s` : 'Live · Evidence sync available';
    renderAccount();
    const events = signals(data);
    if (feed.dataset.view !== events) {
      feed.innerHTML = events;
      feed.dataset.view = events;
    }
  } catch {
    status.textContent = 'Connection unavailable · Retrying automatically';
    sync.disabled = true;
    if (!lastView) app.innerHTML = '<section class="empty"><h2>Account data unavailable</h2><p>The dashboard will reconnect automatically.</p></section>';
  } finally {
    refreshing = false;
    app.setAttribute('aria-busy', 'false');
  }
}

picker.addEventListener('change', renderAccount);
sync.addEventListener('click', async () => {
  syncing = true;
  sync.disabled = true;
  try {
    const response = await fetch('/api/sync', { method: 'POST' });
    if (!response.ok) throw new Error('Sync failed');
  } catch {
    syncing = false;
    await refresh();
    status.textContent = 'Sync did not complete · The dashboard will retry loading';
    return;
  }
  syncing = false;
  await refresh();
});
refresh();
setInterval(refresh, 15000);
