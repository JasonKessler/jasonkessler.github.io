// Exercise recording lifecycle and attribution with synthetic media, never a live microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function exercise({native = false, publicPage = false} = {}) {
  const elements = new Map();
  const saved = new Map([
    ['debate-room-v1', JSON.stringify({config:{proposition:'Old proposition', names:['Old name']}})],
    ['debate-room-ai-profiles-v1', JSON.stringify({profiles:[['Old name','Old persona']]})],
    ['debate-room-capture-v1', JSON.stringify({enabled:false, localSpeaker:'Old name'})]
  ]);
  const deletedDatabases = [];
  const el = () => ({value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',isConnected:true,dataset:{},append(){},insertAdjacentHTML(){},remove(){},after(){},before(){},insertBefore(){},querySelector(){return null;},addEventListener(){},setAttribute(){},removeAttribute(){},focus(){}});
  const get = id => {if (!elements.has(id)) elements.set(id, el()); return elements.get(id);};
  for (const [id,value] of Object.entries({opening:'2:00',rebuttal:'1:30',closing:'2:00',answer:'1:00',deliberation:'3:00','mod-questions':'2','audience-questions':'1',proposition:'Public transit should be free.',names:'Alex\nJordan\nMorgan\nSam'})) get(id).value=value;
  get('link-timer').checked=true;
  let now=100000, tracksStopped=0, calls=[], microphoneCalls=0;
  const actualDate=Date;
  class FakeDate extends actualDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const blobs=new Map();
  class TestURL extends URL {
    static createObjectURL(blob) {
      const url = URL.createObjectURL(blob);
      blobs.set(url,blob);
      return url;
    }
    static revokeObjectURL(url) {
      blobs.delete(url);
      URL.revokeObjectURL(url);
    }
  }
  class Recorder {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['synthetic audio'],{type:this.mimeType})});queueMicrotask(()=>this.onstop());}}
  const context=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],querySelector:el,createElement:el,addEventListener(){}},window:{addEventListener(){},scrollTo(){}},location:{hostname:publicPage?'jasonkessler.github.io':'127.0.0.1',hash:'',pathname:'/'},localStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},setInterval(){},setTimeout,queueMicrotask,crypto:webcrypto,console,confirm:()=>true,Date:FakeDate,Blob,URL:TestURL,structuredClone,MediaRecorder:Recorder,navigator:{mediaDevices:{async getUserMedia(){microphoneCalls++;return {getTracks:()=>[{stop(){tracksStopped++;}}]};}}},indexedDB:{deleteDatabase:name=>deletedDatabases.push(name)},fetch:async(url,options)=>{calls.push({url,options});const data=url==='/api/health'?{local:true,whisper:true,ffmpeg:true,models:['local:small']}:url==='/api/transcribe'?{text:'People need jobs.',segments:[]}:{summary:'Access matters.',points:[{kind:'claim',point:'Jobs matter.',quote:'People need jobs.'}]};return {ok:true,json:async()=>data};}});
  const bridgeCalls = [];
  if (native) {
    context.window.debateRoomMacApp = true;
    context.atob = atob;
    context.window.webkit = {messageHandlers:{debateAudio:{async postMessage(args) {
      bridgeCalls.push(args);
      if (args.action === 'stop') {
        return {base64: btoa('remote speech'), type: 'audio/mp4', warning: 'The speaker left the call.'};
      }
      if (args.speaker === 'Missing caller') throw new Error('No caller joined as Missing caller.');
      return true;
    }}}};
    context.document.createElement = () => Object.assign(el(), {querySelector: el});
  }
  const source=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source,context);vm.runInContext(fs.readFileSync(path.join(root,'local-ai.js'),'utf8'),context);
  const run=code=>vm.runInContext(code,context);
  assert.deepEqual(deletedDatabases,['debate-room-audio-v1']);
  assert.deepEqual([...saved.keys()],['debate-room-capture-v1']);
  assert.deepEqual(JSON.parse(saved.get('debate-room-capture-v1')),{enabled:false});
  assert.equal(run('round'),null);
  assert.equal(get('proposition').value,'Public transit should be free.');
  if (!native && !publicPage) {
    run(`const originalSetup = getConfig();
      applyConfig({...originalSetup, rolePreferences:[['Alex','moderator'],['Sam','questioner']]});`);
    assert.match(get('role-preferences').innerHTML,/Role for Alex/);
    assert.match(get('role-preferences').innerHTML,/value="questioner"/);
    assert.equal(get('questioner-settings').hidden,false);
    run(`applyConfig({...originalSetup, names:['Alex','Jordan','Morgan'],
      rolePreferences:[['Alex','moderator'],['Jordan','questioner']]});`);
    assert.doesNotMatch(get('role-preferences').innerHTML,/value="questioner"/);
    assert.equal(get('questioner-settings').hidden,true);
    assert.equal(run('drawRoles(getConfig()).questioners.length'),0);
    assert.equal(run('drawRoles(getConfig()).moderator'),'Alex');
    assert.equal(run('new Set(Object.values(drawRoles(getConfig())).slice(0,3)).size'),3);
    run(`applyConfig({...originalSetup, rolePreferences:[['Alex','moderator'],['Sam','questioner']]});`);
    assert.equal(run('drawRoles(getConfig()).moderator'),'Alex');
    assert.equal(run('drawRoles(getConfig()).questioners[0]'),'Sam');
    assert.equal(run(`validate({...getConfig(), rolePreferences:[['Alex','negative'],['Jordan','negative']]})`),false);
    assert.match(get('error').textContent,/Assign only one/);
    assert.equal(run(`validate({...getConfig(), rolePreferences:[['Alex','questioner'],['Sam','questioner']]})`),false);
    assert.match(get('error').textContent,/Leave at least three/);
    assert.equal(run(`drawRoles({...originalSetup, rolePreferences:undefined,
      aiProfiles:[{name:'Jordan',role:'affirmative'},{name:'Sam',role:'judge'}]}).affirmative`),'Jordan');
    run('applyConfig(originalSetup)');
    console.log('PASS: role preferences support human participants, reject conflicts, and preserve legacy AI roles.');
  }
  const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
  await settle();
  await get('setup-form').onsubmit({preventDefault(){}});
  if (publicPage) {
    assert.equal(get('enable-notes').disabled,false);
    await get('enable-notes').onclick();
    assert.equal(microphoneCalls,1);
    now+=2000;
    await get('next').onclick();
    assert.equal(run('round.entries[0].status'),'recorded');
    assert.equal(blobs.size,1);
    await get('edit').onclick();
    assert.equal(blobs.size,0);
    assert.deepEqual([...saved.keys()],['debate-room-capture-v1']);
    await get('setup-form').onsubmit({preventDefault(){}});
    await get('start').onclick();
    assert.equal(microphoneCalls,2);
    await get('stop-recording').onclick();
    assert.equal(calls.length,0);
    console.log('PASS: public browser captures audio now and in later rounds without an AI service.');
    return;
  }
  if (native) {
    run('round.index=4;remaining=60;deadline=null;renderStage()');
    get('record-call').checked = true;
    get('call-local-speaker').value = run('round.stages[4].asker');
    get('call-local-speaker').onchange();
    await get('enable-notes').onclick();
    now+=1500;
    await get('start').onclick();
    now+=2000;
    await get('next').onclick();
    await settle();
    assert.deepEqual(bridgeCalls.map(call => [call.action,call.useLocal]), [
      ['start',true], ['stop',true], ['start',false], ['stop',false]
    ]);
    assert.equal(bridgeCalls[0].speaker,run('round.stages[4].asker'));
    assert.equal(bridgeCalls[2].speaker,run('round.stages[4].speaker'));
    assert.equal(run('round.entries.at(-1).audioWarning'),'The speaker left the call.');
    assert.equal(run('round.entries.at(-1).text'),'People need jobs.');
    run("round.stages[round.index].speaker='Missing caller'");
    await get('start').onclick();
    assert.notEqual(run('deadline'),null);
    assert.match(get('notes-status').textContent,/No caller joined as Missing caller/);
    assert.equal(microphoneCalls,0);
    console.log('PASS: call bridge uses the scheduled questioner and answerer, keeps partial audio, and reports missing callers.');
    return;
  }
  await get('enable-notes').onclick();
  assert.equal(microphoneCalls,1);
  assert.equal(JSON.parse(saved.get('debate-room-capture-v1')).enabled,true);
  await get('start').onclick();assert.equal(microphoneCalls,1);assert.equal(get('stop-recording').disabled,false);assert.equal(run('deadline!==null'),true);
  const first=run('round.stages[0].speaker');now+=1500;
  await get('next').onclick();await settle();
  assert.equal(run('round.index'),1);assert.equal(run('round.entries[0].speaker'),first);assert.equal(run('round.entries[0].turn'),0);assert.equal(run('round.entries[0].text'),'People need jobs.');assert.equal(tracksStopped,1);assert.equal(blobs.size,1);
  // Question audio and the answer must have separate, stable speaker attribution.
  await get('next').onclick();await get('next').onclick();await get('next').onclick();
  assert.equal(run('round.stages[round.index].kind'),'question');
  const asker=run('round.stages[round.index].asker'),answerer=run('round.stages[round.index].speaker');
  await get('record-question').onclick();now+=1600;await get('start').onclick();await settle();
  assert.equal(run('round.entries[1].speaker'),asker);assert.equal(run('round.entries[1].kind'),'question');assert.equal(microphoneCalls,3);now+=2000;
  // Unchecking capture while recording stops the microphone and stays unchecked.
  await get('enable-notes').onclick();await settle();assert.equal(JSON.parse(saved.get('debate-room-capture-v1')).enabled,false);assert.equal(run('round.entries[2].speaker'),answerer);assert.equal(tracksStopped,3);
  await get('start').onclick(); // pause timer
  await get('start').onclick(); // resume with recording disabled
  assert.equal(microphoneCalls,3);
  const notebookMarkup = get('note-entries').innerHTML;
  const questionHeading = 'data-turn="' + (run('round.index') + 1) + '"';
  assert.equal(notebookMarkup.split(questionHeading).length - 1, 1);
  const questionCard = notebookMarkup.slice(notebookMarkup.indexOf(questionHeading)).split('</article>')[0];
  assert.ok(questionCard.includes(run('round.entries[1].id')));
  assert.ok(questionCard.includes(run('round.entries[2].id')));
  // Expiry stops capture automatically; deliberation never starts a microphone.
  await get('start').onclick(); // pause first
  await get('enable-notes').onclick();
  await get('start').onclick();now+=61000;run('syncTime()');await settle();
  assert.equal(tracksStopped,5);assert.equal(get('stop-recording').disabled,true);
  run('round.index=round.stages.length-1;remaining=180;deadline=null;renderStage()');
  await get('start').onclick();assert.equal(microphoneCalls,5);
  run("backToSetup()");
  await get('setup-form').onsubmit({preventDefault(){}});
  await get('start').onclick();
  assert.equal(microphoneCalls,6);
  assert.equal(JSON.parse(saved.get('debate-room-capture-v1')).enabled,true);
  await get('stop-recording').onclick();
  // No endpoint other than loopback-relative local APIs was used.
  assert.ok(calls.every(call=>['/api/health','/api/transcribe','/api/summarize'].includes(call.url)));
  console.log('PASS: timer-linked recording, queued processing, stop on speaker change, separate question/answer attribution, in-session audio playback, microphone shutdown, and disabling capture.');
}
exercise().then(() => exercise({native:true})).then(() => exercise({publicPage:true})).catch(error=>{console.error(error);process.exitCode=1;});
