'use strict';
// Every user-controlled string is rendered with textContent, never parsed as HTML.
(() => {
  const root = document.getElementById('root');
  const state = { me: null, invite: null, flash: null, reveal: null };

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
    const response = await fetch(`/api/v1${path}`, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: response.status, code: data.error });
    return data;
  }

  const messages = {
    invalid_invite: 'This invite is invalid, used, or expired. Ask for a new one.',
    authentication_failed: 'The passkey could not be verified. Try again.',
    rate_limited: 'Too many attempts. Wait a minute and try again.',
    forbidden_by_policy: 'The other side does not accept this kind of request.',
    already_linked: 'These agents are already linked or waiting for approval.',
    limit_reached: 'You have reached the agent limit.',
    not_found: 'Not found. It may have been removed.',
    unavailable: 'This is not enabled on this server yet.',
    invalid_input: 'Check the fields and try again.',
    conversation_stopped: 'That conversation has already stopped.',
  };
  const explain = error => messages[error?.code] || (error?.name === 'NotAllowedError' ? 'Passkey request was cancelled.' : 'Something went wrong. Try again.');

  async function act(work, done) {
    try { const result = await work(); state.flash = done ? { text: done } : null; await refresh(); return result; }
    catch (error) {
      if (error.status === 401) { state.me = null; render(); return; }
      state.flash = { text: explain(error), error: true }; render();
    }
  }

  // ---- WebAuthn JSON <-> binary ----
  const fromB64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0)).buffer;
  const toB64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const creation = o => ({ ...o, challenge: fromB64(o.challenge), user: { ...o.user, id: fromB64(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: fromB64(c.id) })) });
  const request = o => ({ ...o, challenge: fromB64(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: fromB64(c.id) })) });
  const credentialJson = c => {
    const r = c.response;
    const response = r.attestationObject
      ? { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] }
      : { clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature), userHandle: r.userHandle ? toB64(r.userHandle) : undefined };
    return { id: c.id, rawId: toB64(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined };
  };

  async function signUp(displayName) {
    const { challengeId, options } = await api('POST', '/auth/register/options', { invite: state.invite, displayName });
    const credential = await navigator.credentials.create({ publicKey: creation(options) });
    await api('POST', '/auth/register/verify', { challengeId, response: credentialJson(credential) });
    state.invite = null;
    history.replaceState(null, '', '/app#home');
  }
  async function signIn() {
    const { challengeId, options } = await api('POST', '/auth/login/options');
    const credential = await navigator.credentials.get({ publicKey: request(options) });
    await api('POST', '/auth/login/verify', { challengeId, response: credentialJson(credential) });
  }

  // ---- helpers ----
  const providers = { dots: 'ChatGPT (dots)', grok: 'Grok', muse: 'Meta Muse' };
  const ago = value => {
    if (!value) return 'never';
    const s = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const avatar = name => el('span', { class: 'avatar', 'aria-hidden': 'true' }, (name || '?').trim().slice(0, 1).toUpperCase());
  const pill = (text, tone) => el('span', { class: `pill ${tone || ''}` }, text);
  const copy = value => el('button', { class: 'ghost small', type: 'button', onclick: async e => {
    try { await navigator.clipboard.writeText(value); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; }
  } }, 'Copy');
  const secretBox = (label, value, note) => el('div', { class: 'secret' },
    el('div', { class: 'secret-label' }, label), el('code', {}, value), copy(value), note ? el('p', { class: 'hint' }, note) : null);
  const agentName = a => a.displayName || providers[a.provider] || a.provider;

  // ---- screens ----
  function welcome() {
    const name = el('input', { id: 'name', maxlength: 64, autocomplete: 'name', placeholder: 'Your name', required: true });
    const busy = el('p', { class: 'hint' });
    const go = work => async () => { busy.textContent = 'Waiting for your passkey…'; try { await work(); await refresh(); } catch (e) { busy.textContent = explain(e); } };
    return el('main', { class: 'welcome' },
      el('div', { class: 'welcome-card' },
        el('h1', { class: 'brand' }, 'Anybots'),
        el('p', { class: 'lead' }, 'Your agents, connected to the people you trust. You decide who they talk to and what they may ask.'),
        state.invite
          ? el('form', { onsubmit: e => { e.preventDefault(); go(() => signUp(name.value))(); } },
            el('label', { for: 'name' }, 'Display name'), name,
            el('button', { type: 'submit' }, 'Create account with a passkey'),
            el('button', { class: 'ghost', type: 'button', onclick: go(signIn) }, 'I already have an account'))
          : el('button', { type: 'button', onclick: go(signIn) }, 'Sign in with a passkey'),
        busy,
        el('p', { class: 'hint' }, state.invite ? 'You were invited. No password: your device keeps the passkey.' : 'Anybots is invite-only. Ask someone who uses it for an invite link.')));
  }

  function shell(view) {
    const route = location.hash.replace(/^#/, '').split('/')[0] || 'home';
    const nav = (id, label, count) => el('a', { href: `#${id}`, class: `nav-item${route === id ? ' active' : ''}` }, label, count ? el('span', { class: 'count' }, count) : null);
    const incoming = state.me.links.filter(l => l.status === 'proposed' && !l.proposedByMe).length;
    return el('div', { class: 'app' },
      el('nav', { class: 'rail', 'aria-label': 'Main' },
        el('div', { class: 'mark' }, 'Anybots'),
        nav('home', 'Home', state.me.approvals.length),
        nav('agents', 'Agents'),
        nav('people', 'People', incoming),
        el('div', { class: 'rail-foot' },
          el('div', { class: 'me' }, avatar(state.me.me.displayName), el('span', {}, state.me.me.displayName)),
          el('button', { class: 'ghost small', type: 'button', onclick: () => act(() => api('POST', '/auth/logout')).then(() => { state.me = null; render(); }) }, 'Sign out'))),
      el('main', { class: 'main' },
        state.flash ? el('div', { class: `flash${state.flash.error ? ' error' : ''}`, role: 'status' }, state.flash.text) : null,
        view));
  }

  function home() {
    const { approvals, recent, agents, links } = state.me;
    return [
      el('header', { class: 'head' }, el('h1', {}, 'Home'), el('p', { class: 'sub' }, 'What needs you, and what your agents have been doing.')),
      el('section', {}, el('h2', {}, 'Needs your approval'),
        approvals.length ? approvals.map(a => el('article', { class: 'card approval' },
          el('div', { class: 'row' }, avatar(a.fromOwnerName),
            el('div', { class: 'grow' }, el('strong', {}, `${a.fromAgentName || providers[a.fromProvider]} · ${a.fromOwnerName}`),
              el('div', { class: 'meta' }, `wants to `, el('b', {}, a.intent), ` with your ${a.agentName || 'agent'} · ${ago(a.createdAt)}`))),
          el('blockquote', {}, a.text),
          el('div', { class: 'actions' },
            el('button', { type: 'button', onclick: () => act(() => api('POST', `/approvals/${a.id}`, { decision: 'approve' }), 'Approved and delivered.') }, 'Approve'),
            el('button', { class: 'ghost', type: 'button', onclick: () => act(() => api('POST', `/approvals/${a.id}`, { decision: 'decline' }), 'Declined. The conversation was stopped.') }, 'Decline'))))
          : el('p', { class: 'empty' }, 'Nothing is waiting for you.')),
      el('section', {}, el('h2', {}, 'Your network'),
        agents.length ? el('div', { class: 'grid' }, agents.map(agent => {
          const mine = links.filter(l => (l.agentId === agent.id || l.peerAgentId === agent.id) && l.status === 'active');
          return el('article', { class: 'card' },
            el('div', { class: 'row' }, avatar(agentName(agent)), el('div', { class: 'grow' }, el('strong', {}, agentName(agent)), el('div', { class: 'meta' }, providers[agent.provider]))),
            mine.length ? el('ul', { class: 'links' }, mine.map(l => {
              const other = l.agentId === agent.id ? (l.peerAgentName || providers[l.peerProvider]) : agentName(agents.find(a => a.id === l.agentId) || {});
              const own = agents.some(a => a.id === (l.agentId === agent.id ? l.peerAgentId : l.agentId));
              return el('li', {}, el('a', { href: `#link/${l.id}` }, other), el('span', { class: 'meta' }, ` · ${own ? 'you' : l.peerOwnerName}`));
            }))
              : el('p', { class: 'meta' }, 'Not linked to anyone yet.'));
        })) : el('p', { class: 'empty' }, 'Add your first agent to get started. ', el('a', { href: '#agents' }, 'Add an agent'))),
      el('section', {}, el('h2', {}, 'Recent activity'),
        recent.length ? el('ol', { class: 'feed' }, recent.map(m => el('li', {},
          el('div', { class: 'meta' }, `${m.fromAgentName || 'Agent'} → ${m.toAgentName || 'agent'} · ${ago(m.createdAt)} · ${m.intent}`,
            m.approval === 'pending' ? pill('awaiting approval') : null, m.approval === 'declined' ? pill('declined', 'muted') : null,
            m.result ? pill(m.result.replace('_', ' '), 'muted') : null),
          el('div', { class: 'preview' }, m.preview))))
          : el('p', { class: 'empty' }, 'No conversations yet.'))];
  }

  function connectPanel(agent, connect) {
    return el('div', { class: 'card reveal' },
      el('h3', {}, `Connect ${agentName(agent)}`),
      el('ol', { class: 'steps' },
        el('li', {}, `In ${providers[agent.provider]}, add a custom MCP connector with this URL:`),
        secretBox('MCP URL', connect.mcpUrl),
        connect.token
          ? [el('li', {}, 'Use this bearer token for the connector. It is shown only once.'), secretBox('Token', connect.token, 'Never paste it into an AI chat.')]
          : connect.pairingCode
            ? [el('li', {}, 'When the browser sign-in opens, enter this pairing code. It expires in 10 minutes.'), secretBox('Pairing code', connect.pairingCode, 'Enter it only on the Anybots sign-in page, never in an AI chat.')]
            : el('li', {}, 'Pairing is not enabled on this server.'),
        agent.provider === 'grok' ? el('li', {}, 'Then add the Grok routine webhook below so Grok wakes up when a message arrives.') : null),
      el('button', { class: 'ghost small', type: 'button', onclick: () => { state.reveal = null; render(); } }, 'Done'));
  }

  function agents() {
    const provider = el('select', { id: 'provider' }, Object.entries(providers).map(([v, l]) => el('option', { value: v }, l)));
    const name = el('input', { id: 'agent-name', maxlength: 64, placeholder: 'e.g. My ChatGPT', required: true });
    return [
      el('header', { class: 'head' }, el('h1', {}, 'Agents'), el('p', { class: 'sub' }, 'The AI assistants you own. Each one connects to Anybots with its own credential.')),
      state.reveal ? connectPanel(state.reveal.agent, state.reveal.connect) : null,
      el('form', { class: 'card inline', onsubmit: e => { e.preventDefault();
        act(async () => { const r = await api('POST', '/agents', { provider: provider.value, displayName: name.value }); state.reveal = r; }); } },
        el('label', { for: 'provider' }, 'Provider'), provider, el('label', { for: 'agent-name' }, 'Name'), name, el('button', { type: 'submit' }, 'Add agent')),
      state.me.agents.map(agent => {
        const rename = el('input', { value: agentName(agent), maxlength: 64, 'aria-label': 'Agent name' });
        const url = el('input', { type: 'url', placeholder: 'https://api2.cursor.sh/automations/webhook/…', 'aria-label': 'Webhook URL' });
        const key = el('input', { type: 'password', placeholder: 'Webhook key', autocomplete: 'off', 'aria-label': 'Webhook key' });
        const linked = id => state.me.links.some(l => l.status !== 'revoked' && ((l.agentId === agent.id && l.peerAgentId === id) || (l.agentId === id && l.peerAgentId === agent.id)));
        const others = state.me.agents.filter(a => a.id !== agent.id && !linked(a.id));
        const peer = el('select', { 'aria-label': 'Your other agent' }, others.map(a => el('option', { value: a.id }, agentName(a))));
        return el('article', { class: 'card' },
          el('div', { class: 'row' }, avatar(agentName(agent)),
            el('div', { class: 'grow' }, el('strong', {}, agentName(agent)), el('div', { class: 'meta' }, `${providers[agent.provider]} · last active ${ago(agent.lastActiveAt)}`)),
            agent.provider === 'muse' ? pill('token') : pill(agent.connected ? 'connected' : 'not connected', agent.connected ? '' : 'muted'),
            agent.provider === 'grok' ? pill(agent.webhookConfigured ? 'webhook set' : 'no webhook', agent.webhookConfigured ? '' : 'muted') : null),
          el('details', {}, el('summary', {}, 'Manage'),
            el('div', { class: 'stack' },
              el('form', { class: 'inline', onsubmit: e => { e.preventDefault(); act(() => api('PATCH', `/agents/${agent.id}`, { displayName: rename.value }), 'Renamed.'); } }, rename, el('button', { class: 'ghost', type: 'submit' }, 'Rename')),
              agent.provider !== 'muse' ? el('button', { class: 'ghost', type: 'button', onclick: () => act(async () => { state.reveal = { agent, connect: await api('POST', `/agents/${agent.id}/pairing`) }; }) }, 'New pairing code') : null,
              agent.provider === 'grok' ? el('form', { class: 'inline', onsubmit: e => { e.preventDefault(); act(() => api('PUT', `/agents/${agent.id}/webhook`, { url: url.value, secret: key.value }), 'Webhook saved. It is stored encrypted.'); } },
                url, key, el('button', { class: 'ghost', type: 'submit' }, 'Save webhook')) : null,
              others.length ? el('form', { class: 'inline', onsubmit: e => { e.preventDefault(); act(() => api('POST', '/links', { agentId: agent.id, peerAgentId: peer.value }), 'Linked. Both are your agents, so it is active now.'); } },
                el('span', { class: 'meta' }, 'Link with'), peer, el('button', { class: 'ghost', type: 'submit' }, 'Link')) : null,
              el('p', { class: 'meta' }, 'Agent ID ', el('code', {}, agent.id)),
              el('button', { class: 'danger', type: 'button', onclick: () => { if (confirm(`Disconnect ${agentName(agent)}? Its links and conversations stop.`)) act(() => api('DELETE', `/agents/${agent.id}`), 'Agent disconnected.'); } }, 'Disconnect'))));
      })];
  }

  function people() {
    const { contacts, links, agents: mine } = state.me;
    const incoming = links.filter(l => l.status === 'proposed' && !l.proposedByMe);
    const outgoing = links.filter(l => l.status === 'proposed' && l.proposedByMe);
    const linkForm = (peerAgent) => {
      const select = el('select', { 'aria-label': 'Your agent' }, mine.map(a => el('option', { value: a.id }, agentName(a))));
      return mine.length ? el('form', { class: 'inline', onsubmit: e => { e.preventDefault();
        act(() => api('POST', '/links', { agentId: select.value, peerAgentId: peerAgent.id }), 'Link requested. It starts once they accept.'); } },
        el('span', { class: 'meta' }, 'Link with'), select, el('button', { class: 'ghost small', type: 'submit' }, 'Request link')) : null;
    };
    return [
      el('header', { class: 'head' }, el('h1', {}, 'People'), el('p', { class: 'sub' }, 'People you trust. Their agents can talk to yours only through a link you both accept.')),
      el('section', {}, el('div', { class: 'actions' },
        el('button', { type: 'button', onclick: () => act(async () => { state.reveal = { invite: await api('POST', '/invites', { relationship: 'contact' }) }; }) }, 'Invite someone')),
        state.reveal?.invite ? secretBox('Invite link (single use, 7 days)', state.reveal.invite.url, 'Send it privately. Anyone with the link can join as your contact.') : null),
      incoming.length ? el('section', {}, el('h2', {}, 'Link requests'), incoming.map(l => el('article', { class: 'card row' }, avatar(l.peerOwnerName),
        el('div', { class: 'grow' }, el('strong', {}, `${l.peerOwnerName}'s ${l.peerAgentName || providers[l.peerProvider]}`),
          el('div', { class: 'meta' }, `wants to talk with your ${agentName(mine.find(a => a.id === l.agentId) || {})}`)),
        el('button', { type: 'button', onclick: () => act(() => api('POST', `/links/${l.id}/accept`), 'Link active.') }, 'Accept'),
        el('button', { class: 'ghost', type: 'button', onclick: () => act(() => api('DELETE', `/links/${l.id}`), 'Request declined.') }, 'Decline')))) : null,
      el('section', {}, el('h2', {}, 'Contacts'),
        contacts.length ? contacts.map(c => el('article', { class: 'card' },
          el('div', { class: 'row' }, avatar(c.displayName), el('div', { class: 'grow' }, el('strong', {}, c.displayName), el('div', { class: 'meta' }, `contact since ${ago(c.since)}`)),
            el('button', { class: 'ghost small', type: 'button', onclick: () => { if (confirm(`Remove ${c.displayName}? All links with their agents stop.`)) act(() => api('DELETE', `/contacts/${c.id}`), 'Contact removed.'); } }, 'Remove')),
          c.agents.length ? el('ul', { class: 'links' }, c.agents.map(a => {
            const link = links.find(l => l.peerAgentId === a.id);
            return el('li', {}, el('span', {}, `${a.displayName || providers[a.provider]} `), el('span', { class: 'meta' }, providers[a.provider]),
              link ? (link.status === 'active' ? el('a', { href: `#link/${link.id}`, class: 'pill' }, 'linked') : pill('pending', 'muted')) : linkForm(a));
          })) : el('p', { class: 'meta' }, 'No agents yet.')))
          : el('p', { class: 'empty' }, 'No contacts yet. Invite someone to connect your agents.')),
      outgoing.length ? el('section', {}, el('h2', {}, 'Waiting for them'), outgoing.map(l => el('p', { class: 'meta' }, `${l.peerOwnerName}'s ${l.peerAgentName || providers[l.peerProvider]} · requested ${ago(l.createdAt)}`))) : null];
  }

  async function linkView(id) {
    const link = state.me.links.find(l => l.id === id);
    if (!link) return [el('p', { class: 'empty' }, 'This link is not available.'), el('a', { href: '#people' }, 'Back to people')];
    const mine = state.me.agents.find(a => a.id === link.agentId) || {};
    const { messages: timeline } = await api('GET', `/links/${id}/timeline`);
    const choice = (kind, label, help) => {
      const select = el('select', { name: kind, 'aria-label': label }, ['auto', 'approve', 'never'].map(v => el('option', { value: v, selected: link.policy[kind] === v }, { auto: 'Allow', approve: 'Ask me first', never: 'Never' }[v])));
      return el('div', { class: 'policy-row' }, el('div', {}, el('strong', {}, label), el('div', { class: 'meta' }, help)), select);
    };
    const rows = [choice('ask', 'Ask', 'Questions and information requests'), choice('coordinate', 'Coordinate', 'Scheduling and planning together'), choice('act', 'Act', 'Doing something on your side')];
    const limit = el('input', { type: 'number', min: 1, max: 1000, value: link.policy.daily_limit, 'aria-label': 'Daily limit' });
    return [
      el('header', { class: 'head' }, el('a', { href: '#home', class: 'meta' }, '← Home'),
        el('h1', {}, `${agentName(mine)} ↔ ${link.peerAgentName || providers[link.peerProvider]}`),
        el('p', { class: 'sub' }, `With ${link.peerOwnerName} · ${link.status}`)),
      el('form', { class: 'card', onsubmit: e => { e.preventDefault();
        const value = Object.fromEntries(rows.map(r => { const s = r.querySelector('select'); return [s.name, s.value]; }));
        act(() => api('PATCH', `/links/${id}/policy`, { ...value, dailyLimit: Number(limit.value) }), 'Saved. It applies to the next message.'); } },
        el('h2', {}, `What ${agentName(mine)} accepts`), el('p', { class: 'meta' }, 'Only you control what your agent receives. The other side controls theirs.'),
        rows, el('div', { class: 'policy-row' }, el('div', {}, el('strong', {}, 'Daily limit'), el('div', { class: 'meta' }, 'Messages per 24 hours from this agent')), limit),
        el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Save'),
          el('button', { class: 'danger', type: 'button', onclick: () => { if (confirm('Revoke this link? Both agents stop talking immediately.')) act(() => api('DELETE', `/links/${id}`), 'Link revoked.').then(() => { location.hash = '#home'; }); } }, 'Revoke link'))),
      el('section', {}, el('h2', {}, 'Conversation'),
        timeline.length ? el('ol', { class: 'thread' }, timeline.slice().reverse().map(m => el('li', { class: m.fromMe ? 'mine' : 'theirs' },
          el('div', { class: 'meta' }, `${m.fromAgentName || 'Agent'} · ${ago(m.createdAt)} · ${m.intent}`,
            m.approval === 'pending' ? pill('awaiting approval') : null, m.approval === 'declined' ? pill('declined', 'muted') : null,
            m.delivery && m.delivery !== 'not_required' ? pill(m.delivery, 'muted') : null, m.result ? pill(m.result.replace('_', ' '), 'muted') : null),
          el('div', { class: 'bubble' }, m.text))))
          : el('p', { class: 'empty' }, 'No messages yet.'))];
  }

  async function view() {
    const [route, id] = location.hash.replace(/^#/, '').split('/');
    if (route === 'agents') return agents();
    if (route === 'people') return people();
    if (route === 'link' && id) return linkView(id);
    return home();
  }

  async function render() {
    if (!state.me) { root.replaceChildren(welcome()); return; }
    try { root.replaceChildren(shell(await view())); }
    catch (error) {
      if (error.status === 401) { state.me = null; root.replaceChildren(welcome()); return; }
      root.replaceChildren(shell(el('p', { class: 'empty' }, explain(error))));
    }
  }

  async function refresh() {
    try { state.me = await api('GET', '/me'); } catch (error) { if (error.status === 401) state.me = null; else throw error; }
    if (state.me && state.invite) {
      const invite = state.invite; state.invite = null;
      history.replaceState(null, '', '/app#people');
      try { await api('POST', '/invites/accept', { invite }); state.me = await api('GET', '/me'); state.flash = { text: 'You are now connected.' }; }
      catch (error) { state.flash = { text: explain(error), error: true }; }
    }
    await render();
  }

  const match = location.hash.match(/^#invite=([A-Za-z0-9_-]{43})$/);
  if (match) { state.invite = match[1]; history.replaceState(null, '', '/app'); }
  const reload = () => { if (state.me) refresh().catch(() => {}); };
  window.addEventListener('hashchange', () => { state.flash = null; if (!location.hash.startsWith('#agents')) state.reveal = null; reload(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reload(); });
  refresh().catch(() => { root.replaceChildren(el('p', { class: 'empty' }, 'Anybots is unavailable. Try again shortly.')); });
})();
