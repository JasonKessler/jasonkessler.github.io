'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const form = $('join-room');
  const match = /^#([a-z0-9-]{1,63}\.trycloudflare\.com)\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!match || !window.crypto?.subtle || !window.WebSocket) {
    $('instruction').textContent = match
      ? 'Open this link in a browser that supports secure connections.'
      : 'Ask the host for a browser guest link, then open the full link.';
    return;
  }
  const invite = {
    url: 'wss://' + match[1] + '/guest',
    key: DebateGuestChannel.decode(match[2].replace(/-/g, '+').replace(/_/g, '/') + '=')
  };
  form.hidden = false;
  let channel, name, resume, retryTimer, retries = 0, available = false;
  let roundID, approved = false, ended = false;
  const status = text => { $('connection').textContent = text; };

  function setCall(enabled) {
    if (enabled && !available) $('status').textContent = 'Choose what to share, then join the call.';
    if (!enabled && available) window.debateCallReceive({kind:'availability', enabled:false});
    available = enabled;
    $('call').hidden = !enabled;
    $('call-wait').hidden = enabled;
  }

  window.debateCallSend = signal => {
    if (approved && available) channel?.send({kind:'callSignal', callSignal:signal});
  };

  function connect() {
    status(resume ? 'Reconnecting…' : 'Connecting to the host…');
    const next = new DebateGuestChannel(invite, () => {
      next.send({kind:'join', name, resume, callVersion:1});
      if (!resume) status('Waiting for the host to approve you…');
    }, message => {
      if (channel !== next) return;
      switch (message.kind) {
        case 'approved':
          approved = true;
          resume = message.resume;
          retries = 0;
          $('welcome').hidden = true;
          $('room').hidden = false;
          $('call-wait').textContent = 'Waiting for the host to open the call.';
          status('Connected');
          break;
        case 'snapshot':
          if (approved && message.notebook) displayNotebook(message.notebook);
          break;
        case 'paused':
          status('The host paused notebook updates.');
          break;
        case 'resumed':
          status('Connected');
          break;
        case 'callEvent':
          if (!approved || !message.callEvent) return;
          if (message.callEvent.kind === 'availability') setCall(message.callEvent.enabled === true);
          else if (available) window.debateCallReceive(message.callEvent);
          break;
        case 'ended':
          end('The host ended the debate. You can still read the notebook.');
          break;
        case 'rejected':
          end('The host declined or removed this guest.');
          break;
      }
    }, () => {
      if (channel !== next || ended) return;
      approved = false;
      setCall(false);
      if (++retries <= 5) {
        status('Connection lost. Reconnecting…');
        retryTimer = setTimeout(connect, Math.min(retries, 4) * 1000);
      } else {
        end('Couldn’t reach the host. Check your connection or ask for a new link.');
      }
    });
    channel = next;
  }

  function end(message) {
    ended = true;
    approved = false;
    clearTimeout(retryTimer);
    channel?.close();
    channel = null;
    resume = undefined;
    setCall(false);
    $('call-wait').textContent = 'The call is closed.';
    $('leave-room').hidden = true;
    status(message);
    if ($('room').hidden) form.querySelector('button').disabled = false;
  }

  form.onsubmit = event => {
    event.preventDefault();
    name = $('name').value.trim();
    if (!name) return;
    form.querySelector('button').disabled = true;
    ended = false;
    retries = 0;
    connect();
  };
  $('leave-room').onclick = () => end('You left the debate. You can still read the notebook.');
  window.addEventListener('pagehide', () => {
    clearTimeout(retryTimer);
    window.debateCallClose();
    channel?.close();
  });

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function displayNotebook(notebook) {
    const notes = $('notes');
    const top = notes.getBoundingClientRect().top;
    const sameRound = roundID === notebook.roundID;
    const anchor = sameRound && [...notes.querySelectorAll('article')]
      .find(article => article.getBoundingClientRect().bottom > top);
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const oldScroll = sameRound ? notes.scrollTop : 0;
    const open = sameRound ? new Set([...notes.querySelectorAll('details[open]')].map(node => node.dataset.entry)) : new Set();
    const sections = new Map();
    const fragment = document.createDocumentFragment();
    fragment.append(element('h3', notebook.proposition));
    for (const entry of notebook.entries) {
      const key = String(entry.turn ?? entry.id);
      if (!sections.has(key)) {
        const section = element('article');
        section.append(element('h4', entry.turn ? `Turn ${entry.turn} · ${entry.turnTitle || entry.stage}` : entry.stage));
        sections.set(key, section);
        section.dataset.turn = key;
        fragment.append(section);
      }
      const section = sections.get(key);
      section.append(element('strong', entry.speaker));
      if (entry.summary) section.append(element('p', entry.summary));
      if (entry.points.length) {
        const list = element('ul');
        for (const point of entry.points) {
          const item = element('li', point.point);
          if (point.quote) item.append(element('blockquote', point.quote));
          list.append(item);
        }
        section.append(list);
      }
      if (entry.text) {
        const details = element('details');
        details.dataset.entry = entry.id;
        details.open = open.has(entry.id);
        details.append(element('summary', 'Transcript'), element('p', entry.text));
        section.append(details);
      }
    }
    if (!sections.size) fragment.append(element('p', 'No turns have been published yet.'));
    $('turn').textContent = notebook.currentTurn;
    notes.replaceChildren(fragment);
    const current = anchor && sections.get(anchor.dataset.turn);
    notes.scrollTop = oldScroll;
    if (current) notes.scrollTop += current.getBoundingClientRect().top - top - offset;
    roundID = notebook.roundID;
  }
})();
