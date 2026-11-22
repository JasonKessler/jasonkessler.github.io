/* Optional local-only speech capture and grounded argument notebook. */
'use strict';
(() => {
  const macApp = window.debateRoomMacApp === true;
  const callAudio = macApp && window.webkit?.messageHandlers?.debateAudio;
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const captureKey = 'debate-room-capture-v1';
  let captureSettings = {};
  try {
    const saved = JSON.parse(localStorage.getItem(captureKey));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) captureSettings = saved;
  } catch {}
  let connected = false, enabled = captureSettings.enabled === true, recorder = null, starting = false;

  function saveCaptureSettings() {
    captureSettings.enabled = enabled;
    captureSettings.linkTimer = $('link-timer').checked;
    if (callAudio) captureSettings.videoCall = $('record-call').checked;
    try { localStorage.setItem(captureKey, JSON.stringify(captureSettings)); } catch {}
  }
  let capturing = null, queue = Promise.resolve(), jobs = 0, dbPromise;
  const urls = new Map(), busy = new Set();
  const e = esc;
  const banner = document.createElement('section');
  banner.className = 'local-banner';
  banner.innerHTML = `<button type="button" id="open-local">${local ? 'Refresh local AI' : 'Open local AI mode'}</button>
    <p id="local-connection" class="hint" role="status">${local ? 'Checking local AI…' : 'Requires the local launcher on a Mac.'}</p>`;
  $('setup-form').after(banner);
  const notebook = document.createElement('section');
  notebook.className = 'notebook';
  notebook.innerHTML = `
    <div class="notebook-head"><h2>Debate notebook</h2>
      <button id="session-local" ${local?'hidden':''}>Open local AI</button>
      <button id="reconnect-notes" ${local?'':'hidden'}>Reconnect local AI</button>
    </div>
    <div class="rec-panel" id="notebook-capture-options">
      <label for="notes-model">Model <select id="notes-model" aria-label="Local summarization model"></select></label>
      <label class="upload-label">Upload audio<input id="upload-audio" type="file" accept="audio/*,video/webm" disabled></label>
    </div>
    <details id="manual-details">
      <summary>Add transcript</summary>
      <div class="manual-grid">
        <div><label for="manual-speaker">Participant</label><select id="manual-speaker"></select></div>
        <div><label for="manual-stage">Context</label><input id="manual-stage" maxlength="200"></div>
      </div>
      <label for="manual-text">Transcript</label><textarea id="manual-text" maxlength="30000"></textarea>
      <button id="add-transcript">Save transcript</button>
    </details>
    <p class="hint" id="notebook-storage" role="status"></p><div id="note-entries"></div>`;
  $('session').append(notebook);
  const audioControls = document.createElement('section');
  audioControls.className = 'rec-panel';
  audioControls.setAttribute('aria-label', 'Audio capture');
  audioControls.innerHTML = `
    <div class="rec-actions">
      <button id="enable-notes" type="button" aria-pressed="false" disabled>Enable audio capture</button>
      <button id="record-turn" type="button" disabled>Record speaker</button>
      <button id="record-question" type="button" hidden disabled>Record question</button>
      <button id="stop-recording" type="button" class="accent" disabled>Stop recording</button>
    </div>
    <div class="rec-options" id="capture-settings">
      <label class="check"><input id="link-timer" type="checkbox" checked> Record with timer</label>
      ${callAudio ? `<label class="check"><input id="record-call" type="checkbox"> Record from video call</label>
        <label for="call-local-speaker" id="call-local-label" hidden>Speaker on this Mac
          <select id="call-local-speaker"></select>
        </label>` : ''}
    </div>
    <p class="hint" id="capture-target"></p>
    <p class="ai-status" id="notes-status" role="status" aria-live="polite">${local?'Checking local AI…':'Audio stays in this browser. Local AI mode can transcribe its own recordings.'}</p>`;
  $('speaker').after(audioControls);
  $('link-timer').checked = captureSettings.linkTimer !== false;
  $('link-timer').onchange = saveCaptureSettings;
  if (callAudio) {
    $('record-call').checked = captureSettings.videoCall === true;
    $('record-call').onchange = () => { saveCaptureSettings(); updateControls(); };
    $('call-local-speaker').onchange = () => {
      captureSettings.localSpeaker = $('call-local-speaker').value;
      saveCaptureSettings();
    };
  }
  $('reconnect-notes').onclick=connect;
  function status(text, error = false) { $('notes-status').textContent = recorder&&capturing&&!stopping ? `Recording ${capturing.entry.speaker} · ${capturing.entry.stage}` : text; $('notes-status').className = 'ai-status' + (recorder&&!stopping?' recording-light':error?' entry-error':''); }
  function save() { if (!round) return; window.debateRoomRefreshDeliberation?.(); try { localStorage.setItem(KEY, JSON.stringify({config: getConfig(), round, sound: $('sound').checked})); } catch { $('notebook-storage').textContent = 'Local storage is unavailable. Changes may not survive a refresh.'; } }
  function markUsed() { if(round){touched=true;round.touched=true;$('reshuffle').hidden=true;} }
  function entryList() { return round ? (round.entries ??= []) : []; }
  function notebookTurns() {
    if (!round) return [];
    const groups = new Map();
    for (const entry of entryList()) {
      if (!groups.has(entry.turn)) groups.set(entry.turn, []);
      groups.get(entry.turn).push(entry);
    }
    const through = Math.max(round.notebookThrough ?? 0, round.index);
    for (let index = 0; index <= through; index++) {
      if (!groups.has(index)) groups.set(index, []);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b).map(([index, contributions]) => ({
      turn: index + 1,
      title: round.stages[index]?.title ?? 'Debate turn',
      contributions: contributions.sort((a, b) => Number(b.kind === 'question') - Number(a.kind === 'question')),
    }));
  }

  function newEntry(target, kind, speaker, context) { return {id:crypto.randomUUID(),kind,speaker,stage:context,turn:target.index,created:new Date().toISOString(),text:'',segments:[],notes:null,status:'queued',error:''}; }
  function openDB() { return dbPromise ??= new Promise((resolve,reject)=>{const request=indexedDB.open('debate-room-audio-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('audio');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
  async function audioPut(id,blob) { const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
  async function audioGet(id) { const db=await openDB();return new Promise((resolve,reject)=>{const request=db.transaction('audio').objectStore('audio').get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
  async function request(path,body,binary=false) { const response=await fetch(path,{method:'POST',headers:{'Content-Type':binary?'application/octet-stream':'application/json'},body:binary?body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Local processing failed.');return data; }
  function contextFor(target) { return (target.entries||[]).filter(x=>x.text).slice(-10).map(x=>({speaker:x.speaker,stage:x.stage,transcript:x.text.slice(0,2200)})); }
  function enqueue(target,entry,task) { jobs++;busy.add(entry.id);status('Processing locally. The debate can continue while notes are prepared.');queue=queue.catch(()=>{}).then(async()=>{try{await task();entry.error='';entry.status='done';}catch(error){entry.status='error';entry.error=error.message;}finally{jobs--;busy.delete(entry.id);if(target===round){save();render();status(jobs?`${jobs} turn${jobs===1?'':'s'} waiting for local processing.`:entry.error?'Local processing failed. Open the entry to retry; your transcript and recording are kept.':'Notes updated. Review the transcript and supporting quotes.');}}});return queue; }
  async function summarize(target,entry) { if(!entry.text.trim()){entry.notes={summary:'No clear speech detected.',points:[]};return;}entry.status='extracting points';if(target===round)render();entry.notes=await request('/api/summarize',{text:entry.text,proposition:target.config.proposition,speaker:entry.speaker,stage:entry.stage,context:contextFor(target).filter(x=>!(x.speaker===entry.speaker&&x.transcript===entry.text.slice(0,2200))),model:$('notes-model').value}); }
  async function processAudio(target,entry,blob) { entry.status='transcribing';if(target===round)render();const result=await request('/api/transcribe',blob,true);entry.text=result.text;entry.segments=result.segments;entry.transcriptionModel=result.model;if(target===round){save();render();}await summarize(target,entry); }
  async function connect() { if(!local)return;try{const response=await fetch('/api/health');if(!response.ok)throw new Error('Start the local launcher to use AI.');const health=await response.json();if(!health.local)throw new Error('Start the local launcher to use AI.');connected=health.whisper&&health.ffmpeg&&health.models?.length>0;$('notes-model').innerHTML=(health.models||[]).map(m=>`<option value="${e(m)}">${e(m)}</option>`).join('');let message=connected?(enabled?'Audio capture enabled. Ready for the next turn.':'Local Whisper and Ollama are ready.'):health.error||(!health.whisper?'Whisper is missing. Run the launcher to install it.':'FFmpeg is missing. Install it, then reconnect.');$('local-connection').textContent=message;$('local-connection').className='hint'+(connected?' ai-connected':'');status(message,!connected);updateControls();}catch(error){connected=false;$('local-connection').textContent='Start the local launcher, then reconnect.';status(error.message,true);updateControls();} }
  function canCapture() {
    if (callAudio && $('record-call').checked) return true;
    return typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  function updateControls() {
    if (callAudio) {
      $('record-call').disabled = Boolean(recorder || starting);
      $('call-local-label').hidden = !$('record-call').checked;
      $('call-local-speaker').disabled = Boolean(recorder || starting);
    }
    const stage = round?.stages[round.index];
    const available = canCapture();
    const canRecord = available && enabled && stage && !recorder && !starting && stage.kind !== 'deliberation';
    $('enable-notes').disabled = !available && !enabled;
    $('enable-notes').setAttribute('aria-pressed', String(enabled));
    $('enable-notes').textContent = enabled ? 'Disable audio capture' : 'Enable audio capture';
    $('capture-settings').hidden = !enabled && !callAudio;
    $('record-turn').disabled = !canRecord || Boolean(window.debateRoomIsAI?.(stage?.speaker));
    $('record-question').hidden = stage?.kind !== 'question';
    $('record-question').disabled = !canRecord || Boolean(window.debateRoomIsAI?.(stage?.asker));
    $('stop-recording').disabled = !recorder;
    $('upload-audio').disabled = !connected || !enabled || !!recorder || starting || stage?.kind === 'deliberation';
    $('capture-target').textContent = stage?.kind === 'question'
      ? `Question by ${stage.asker} · Answer by ${stage.speaker}` : '';
    $('notes-model').disabled = !connected || jobs > 0 || !!recorder;
    $('link-timer').disabled = !!recorder;
  }
  async function saveRecording({target, entry, started}, {blob, warning, duration}) {
    entry.duration = duration ?? (Date.now() - started) / 1000;
    if (!blob.size || entry.duration <= .3) {
      status(warning || 'Recording was too short or contained no audio. Try again.', true);
      return;
    }
    entry.audioType = blob.type;
    entry.audioWarning = warning;
    (target.entries ??= []).push(entry);
    try {
      await audioPut(entry.id, blob);
    } catch {
      entry.audioWarning = [warning, 'Audio could not be saved in browser storage.']
        .filter(Boolean).join(' ');
    }
    urls.set(entry.id, URL.createObjectURL(blob));
    if (connected) enqueue(target, entry, () => processAudio(target, entry, blob));
    else {
      entry.status = 'recorded';
      status('Audio saved. Open the turn in the notebook to listen.');
    }
    if (target === round) { save(); render(); }
  }

  function micCapture(media) {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    const active = new MediaRecorder(media, mimeType ? {mimeType} : {});
    const chunks = [];
    let warning = '';
    const done = new Promise(resolve => {
      active.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      active.onerror = () => { warning = 'The microphone recorder was interrupted.'; };
      active.onstop = () => {
        media.getTracks().forEach(track => track.stop());
        resolve({blob: new Blob(chunks, {type: active.mimeType}), warning});
        stop();
      };
    });
    active.start(1000);
    return () => {
      if (active.state !== 'inactive') active.stop();
      return done;
    };
  }

  async function record(kind='speech') {
    if (!enabled || !round || recorder || starting) return false;
    if (!canCapture()) {
      status('Audio capture is unavailable in this browser. Check microphone support and permissions.', true);
      return false;
    }
    const target = round, stage = target.stages[target.index];
    const speaker = kind === 'question' ? stage.asker : stage.speaker;
    if (stage.kind === 'deliberation' || window.debateRoomIsAI?.(speaker)) return false;
    const entry = newEntry(target, kind, speaker, kind === 'question' ? `Question to ${stage.speaker} · ${stage.title}` : stage.title);
    const fromCall = callAudio && $('record-call').checked;
    let media;
    starting = true;
    updateControls();
    try {
      if (fromCall) {
        const args = {speaker, useLocal: $('call-local-speaker').value === speaker};
        await callAudio.postMessage({...args, action: 'start'});
        recorder = async () => {
          const result = await callAudio.postMessage({...args, action: 'stop'});
          const bytes = Uint8Array.from(atob(result.base64), character => character.charCodeAt(0));
          return {blob: new Blob([bytes], {type: result.type}), warning: result.warning, duration: result.duration};
        };
      } else {
        media = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: false});
        if (round !== target || round.index !== entry.turn || !enabled) {
          media.getTracks().forEach(track => track.stop());
          return false;
        }
        recorder = micCapture(media);
      }
      capturing = {target, entry, started: Date.now()};
      if (round !== target || round.index !== entry.turn || !enabled) {
        await stop();
        return false;
      }
      markUsed();
      entry.status = 'recording';
      status(`Recording ${entry.speaker} · ${entry.stage}`);
      return true;
    } catch (error) {
      media?.getTracks().forEach(track => track.stop());
      status((fromCall ? 'Call recording could not start. ' : 'Microphone could not start. ') + error.message, true);
      return false;
    } finally {
      starting = false;
      updateControls();
    }
  }

  let stopping;
  async function stop() {
    if (!recorder) return;
    if (!stopping) {
      let stoppingError;
      stopping = Promise.resolve().then(async () => {
        try {
          await saveRecording(capturing, await recorder());
        } catch (error) {
          stoppingError = 'Could not save the recording. ' + error.message;
        } finally {
          recorder = capturing = null;
          stopping = null;
          updateControls();
          if (stoppingError) status(stoppingError, true);
        }
      });
    }
    await stopping;
  }
  let manualRound=null,manualTurn=null;
  function renderContribution(entry, people) {
    return `<section class="turn-contribution" data-entry="${e(entry.id)}"><div class="entry-head"><div><span class="eyebrow">${e(entry.kind==='question'?'Question':entry.stage)}</span><h3>${e(entry.speaker)}${entry.isAI?' <span class="tag">AI</span>':''}</h3></div><span class="tag">${e(busy.has(entry.id)?entry.status:entry.status==='queued'||entry.status==='transcribing'||entry.status==='extracting points'?'Interrupted · retry':entry.status)}</span></div><p class="entry-info">${new Date(entry.created).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}${entry.duration?' · '+Math.round(entry.duration)+' seconds of audio':''}</p>${entry.error?`<p class="entry-error">${e(entry.error)}</p>`:''}${entry.audioWarning?`<p class="entry-error">${e(entry.audioWarning)}</p>`:''}${entry.notes?`<p class="entry-summary">${e(entry.notes.summary)}</p><ul class="entry-points">${entry.notes.points.map(p=>`<li><span class="tag">${e(p.kind)}</span> ${e(p.point)}<blockquote>“${e(p.quote)}”</blockquote></li>`).join('')}</ul>${entry.notes.omitted?'<p class="hint">Some points were omitted because their quotes did not match the transcript.</p>':''}`:''}<details><summary>Transcript, attribution & recording</summary><label for="speaker-${e(entry.id)}">Participant</label><select id="speaker-${e(entry.id)}" data-action="speaker" ${busy.has(entry.id)?'disabled':''}>${people.map(name=>`<option ${name===entry.speaker?'selected':''}>${e(name)}</option>`).join('')}</select><label for="text-${e(entry.id)}" style="margin-top:12px">Transcript · edit to correct mistakes</label><textarea id="text-${e(entry.id)}" maxlength="30000" ${busy.has(entry.id)?'disabled':''}>${e(entry.text)}</textarea><div class="pill-row"><button class="small" data-action="save" ${busy.has(entry.id)?'disabled':''}>Save correction</button><button class="small" data-action="retry" ${!connected||busy.has(entry.id)?'disabled':''}>${entry.text?'Extract points again':'Retry transcription'}</button></div><div data-audio></div></details></section>`;
  }

  function render() {
    if (!round) return;
    updateControls();
    if ((round.notebookThrough ?? -1) < round.index) {
      round.notebookThrough = round.index;
      save();
    }
    const people = round.config.names;
    if (callAudio) {
      const ownSpeaker = captureSettings.localSpeaker;
      $('call-local-speaker').innerHTML = '<option value="">Nobody (listen-only)</option>' +
        people.map(name => `<option>${e(name)}</option>`).join('');
      $('call-local-speaker').value = people.includes(ownSpeaker) ? ownSpeaker : '';
    }
    const selectedSpeaker = $('manual-speaker').value;
    $('manual-speaker').innerHTML = people.map(name => `<option>${e(name)}</option>`).join('');
    $('manual-speaker').value = manualRound === round && manualTurn === round.index && people.includes(selectedSpeaker)
      ? selectedSpeaker : round.stages[round.index].speaker;
    manualRound = round;
    manualTurn = round.index;
    $('manual-stage').placeholder = round.stages[round.index].title;

    const turns = notebookTurns();
    $('note-entries').innerHTML = turns.map(turn => `
      <article class="entry" data-turn="${turn.turn}">
        <h3>Turn ${turn.turn} · ${e(turn.title)}</h3>
        ${turn.contributions.length
          ? turn.contributions.map(entry => renderContribution(entry, people)).join('')
          : '<p class="hint">No transcript or points captured for this turn.</p>'}
      </article>`).join('');

    for (const entry of entryList()) {
      if (urls.has(entry.id)) {
        attachAudio(entry.id, urls.get(entry.id));
      } else {
        audioGet(entry.id).then(blob => {
          if (blob && round?.entries?.some(item => item.id === entry.id)) {
            const url = urls.get(entry.id) || URL.createObjectURL(blob);
            urls.set(entry.id, url);
            attachAudio(entry.id, url);
          }
        }).catch(() => {});
      }
    }
  }
  function attachAudio(id,url) { const article=$('note-entries').querySelector(`[data-entry="${id}"]`);if(!article)return;const slot=article.querySelector('[data-audio]');if(!slot.firstChild){const audio=document.createElement('audio');audio.controls=true;audio.setAttribute('controlslist','nodownload');audio.preload='none';audio.src=url;slot.append(audio);} }
  $('note-entries').addEventListener('change',event=>{if(event.target.dataset.action==='speaker'){const entry=entryList().find(x=>x.id===event.target.closest('[data-entry]').dataset.entry);entry.speaker=event.target.value;entry.notes=null;entry.status='edited';save();status('Speaker corrected. Extract points again to update the notes.');}});
  $('note-entries').addEventListener('click',async event=>{const button=event.target.closest('button[data-action]');if(!button)return;const article=button.closest('[data-entry]'),entry=entryList().find(x=>x.id===article.dataset.entry),target=round;if(!entry)return;const action=button.dataset.action;if(busy.has(entry.id))return;entry.text=article.querySelector('textarea').value.trim();entry.notes=null;entry.status='edited';save();if(action==='save'){render();status('Transcript saved. Extract points again to update the notes.');}else if(entry.text)enqueue(target,entry,()=>summarize(target,entry));else {const blob=await audioGet(entry.id).catch(()=>null);if(blob)enqueue(target,entry,()=>processAudio(target,entry,blob));else status('No saved recording. Paste a transcript or upload the audio again.',true);}render();});
  $('enable-notes').onclick = async () => {
    enabled = !enabled;
    saveCaptureSettings();
    if (!enabled) {
      await stop();
      status('Audio capture disabled.');
    } else {
      const stage = round?.stages[round.index];
      const kind = stage?.kind === 'question' && deadline === null && !window.debateRoomIsAI?.(stage.asker)
        ? 'question' : 'speech';
      status('Audio capture enabled for this and later rounds.');
      if (remaining > 0) await record(kind);
    }
    updateControls();
  };
  $('record-turn').onclick=()=>record();$('record-question').onclick=()=>record('question');$('stop-recording').onclick=stop;
  $('upload-audio').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file||!round||!enabled)return;if(file.size>40*1024*1024)return status('Choose audio under 40 MB.',true);const target=round,s=round.stages[round.index],entry=newEntry(target,'speech',s.speaker,s.title);entry.audioType=file.type;entryList().push(entry);markUsed();try{await audioPut(entry.id,file);}catch{entry.audioWarning='Recording could not be saved in browser storage.';}urls.set(entry.id,URL.createObjectURL(file));save();enqueue(target,entry,()=>processAudio(target,entry,file));render();};
  $('add-transcript').onclick=()=>{if(!round)return;const text=$('manual-text').value.trim();if(!text)return status('Enter a transcript first.',true);const target=round,stage=round.stages[round.index],speaker=$('manual-speaker').value;const kind=stage.kind==='question'&&speaker===stage.asker?'question':'typed';const title=kind==='question'?`Question to ${stage.speaker}`:stage.title;const entry=newEntry(target,kind,speaker,$('manual-stage').value.trim()||title);entry.text=text;entry.status='saved';entryList().push(entry);markUsed();$('manual-text').value='';$('manual-stage').value='';save();if(connected)enqueue(target,entry,()=>summarize(target,entry));render();};
  function openLocal(){if(local){connect();return;}const transferred=round?structuredClone(round):null;if(transferred&&deadline!==null){transferred.remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));transferred.deadline=null;}const payload={config:getConfig(),round:transferred,sound:$('sound').checked};const destination=new URL('http://127.0.0.1:18766/');destination.hash=encodeURIComponent(JSON.stringify(payload));location.href=destination.href;}
  $('open-local').onclick=openLocal;$('session-local').onclick=openLocal;
  // Timer hooks finalize audio before changing speaker; processing runs in a queue.
  const originalStart=$('start').onclick;
  let transition=false;
  const stopButton=$('stop-recording').onclick;$('stop-recording').onclick=async()=>{if(transition||starting)return;transition=true;try{await stopButton();}finally{transition=false;}};
  $('start').onclick=async()=>{if(transition||starting)return;transition=true;try{const pausing=deadline!==null;if(recorder&&(pausing||capturing?.entry.kind==='question'))await stop();if(!recorder&&!pausing&&enabled&&$('link-timer').checked&&round.stages[round.index].kind!=='deliberation'&&!window.debateRoomIsAI?.(round.stages[round.index].speaker)){await record();}originalStart();}finally{transition=false;}};
  for(const id of ['next','previous','reset','edit','finish','reshuffle']){const original=$(id).onclick;$(id).onclick=async()=>{if(transition||starting)return;transition=true;try{await stop();original();render();}finally{transition=false;}};}
  const originalSubmit=$('setup-form').onsubmit;$('setup-form').onsubmit=event=>{originalSubmit(event);render();};
  const originalRender=renderStage;renderStage=function(){originalRender();if(notebook.isConnected&&round){updateControls();if(remaining===0&&recorder)stop();}};
  if (macApp) {
    window.debateRoomAwaitNotebook = async (stopQuestionRecording) => {
      if (stopQuestionRecording && recorder && capturing?.entry.kind === 'question') await stop();
      if (jobs) await queue;
    };
    window.debateRoomAddTypedQuestion = (speaker, addressee, text) => {
      const entry = newEntry(round, 'question', speaker, `Question to ${addressee}`);
      entry.text = text;
      entry.status = 'saved';
      entryList().push(entry);
    };
    window.debateRoomAddAITurn = (kind, speaker, stage, result) => {
      const entry = newEntry(round, kind, speaker, stage);
      entry.isAI = true;
      entry.text = result.speech;
      entry.notes = result.notes;
      entry.status = 'done';
      entryList().push(entry);
      markUsed();
      save();
      render();
      return entry;
    };
    const roundIDs = new WeakMap();
    window.debateRoomSharedNotebook = (includeTranscript) => {
      if (!round) return null;
      if (!roundIDs.has(round)) roundIDs.set(round, crypto.randomUUID());
      const stage = round.stages[round.index];
      const entries = notebookTurns().flatMap(turn => turn.contributions
        .filter(entry => entry.notes || (includeTranscript && entry.text))
        .map(entry => ({
          turn: turn.turn,
          turnTitle: turn.title,
          id: entry.id,
          stage: entry.stage,
          speaker: entry.speaker + (entry.isAI ? ' (AI)' : ''),
          text: includeTranscript ? entry.text || null : null,
          summary: entry.notes?.summary ?? null,
          points: (entry.notes?.points ?? []).map(({kind, point, quote}) => ({
            kind, point, quote: includeTranscript ? quote : null
          }))
        })));
      return JSON.stringify({
        roundID: roundIDs.get(round),
        proposition: round.config.proposition,
        currentTurn: round.winner
          ? (round.winner === 'draw' ? 'Verdict: Draw' : 'Winner: ' + round.roles[round.winner])
          : stage.kind === 'question'
            ? stage.asker + ' asks · ' + stage.speaker + ' answers'
            : stage.title + ' · ' + stage.speaker,
        entries
      });
    };
  }
  if (macApp) window.debateRoomIsBusy = () => !!recorder || jobs > 0 || starting;
  window.addEventListener('beforeunload',event=>{if(recorder||jobs||starting){event.preventDefault();event.returnValue='Recording or local processing is still in progress.';}});
  if(local&&location.hash){try{const imported=JSON.parse(decodeURIComponent(location.hash.slice(1)));if(imported.config&&Array.isArray(imported.config.names)){applyConfig(imported.config);$('sound').checked=imported.sound!==false;if(imported.round&&Array.isArray(imported.round.stages)&&imported.round.stages[imported.round.index]){round=imported.round;remaining=round.remaining;deadline=null;touched=!!round.touched;round.deadline=null;showRound();}else{round=null;$('session').hidden=true;$('setup').hidden=false;persist();}save();estimate();}history.replaceState(null,'',location.pathname);}catch{status('Could not transfer setup. Enter it on the local page.',true);}}
  if(round){render();for(const entry of entryList())if(['queued','transcribing','extracting points'].includes(entry.status))entry.status='interrupted';}
  if(local)connect();
})();
