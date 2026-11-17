// Exercise recording lifecycle and attribution with synthetic media, never a live microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const elements = new Map();
const el = () => ({value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',isConnected:true,dataset:{},append(){},after(){},before(){},insertBefore(){},querySelector(){return null;},addEventListener(){},setAttribute(){},removeAttribute(){},focus(){}});
const get = id => {if (!elements.has(id)) elements.set(id, el()); return elements.get(id);};
for (const [id,value] of Object.entries({opening:'2:00',rebuttal:'1:30',closing:'2:00',answer:'1:00',deliberation:'3:00','mod-questions':'2','audience-questions':'1',proposition:'Public transit should be free.',names:'Alex\nJordan\nMorgan\nSam'})) get(id).value=value;
get('link-timer').checked=true;
let now=100000, tracksStopped=0, calls=[], microphoneCalls=0;
const actualDate=Date;
class FakeDate extends actualDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const blobs=new Map();
const db={transaction(){const tx={};tx.objectStore=()=>({put(blob,id){blobs.set(id,blob);queueMicrotask(()=>tx.oncomplete?.());},get(id){const r={};queueMicrotask(()=>{r.result=blobs.get(id);r.onsuccess?.();});return r;}});return tx;}};
class Recorder {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['synthetic audio'],{type:this.mimeType})});queueMicrotask(()=>this.onstop());}}
const context=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],querySelector:el,createElement:el,addEventListener(){}},window:{addEventListener(){},scrollTo(){}},location:{hostname:'127.0.0.1',hash:'',pathname:'/'},localStorage:{getItem:()=>null,setItem(){}},setInterval(){},setTimeout,queueMicrotask,crypto:webcrypto,console,confirm:()=>true,Date:FakeDate,Blob,URL,structuredClone,MediaRecorder:Recorder,navigator:{mediaDevices:{async getUserMedia(){microphoneCalls++;return {getTracks:()=>[{stop(){tracksStopped++;}}]};}}},indexedDB:{open(){const r={};queueMicrotask(()=>{r.result=db;r.onsuccess?.();});return r;}},fetch:async(url,options)=>{calls.push({url,options});const data=url==='/api/health'?{local:true,whisper:true,ffmpeg:true,models:['local:small']}:url==='/api/transcribe'?{text:'People need jobs.',segments:[]}:{summary:'Access matters.',points:[{kind:'claim',point:'Jobs matter.',quote:'People need jobs.'}]};return {ok:true,json:async()=>data};}});
const source=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(source,context);vm.runInContext(fs.readFileSync(path.join(root,'local-ai.js'),'utf8'),context);
const run=code=>vm.runInContext(code,context);
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
(async()=>{
  await settle();
  await get('setup-form').onsubmit({preventDefault(){}});
  get('enable-notes').checked=true;await get('enable-notes').onchange();
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
  get('enable-notes').checked=false;await get('enable-notes').onchange();await settle();assert.equal(get('enable-notes').checked,false);assert.equal(run('round.entries[2].speaker'),answerer);assert.equal(tracksStopped,3);
  await get('start').onclick(); // pause timer
  await get('start').onclick(); // resume with recording disabled
  assert.equal(microphoneCalls,3);
  // Expiry stops capture automatically; deliberation never starts a microphone.
  await get('start').onclick(); // pause first
  get('enable-notes').checked=true;await get('enable-notes').onchange();
  await get('start').onclick();now+=61000;run('syncTime()');await settle();
  assert.equal(tracksStopped,4);assert.equal(get('stop-recording').disabled,true);
  run('round.index=round.stages.length-1;remaining=180;deadline=null;renderStage()');
  await get('start').onclick();assert.equal(microphoneCalls,4);
  // No endpoint other than loopback-relative local APIs was used.
  assert.ok(calls.every(call=>['/api/health','/api/transcribe','/api/summarize'].includes(call.url)));
  console.log('PASS: timer-linked recording, queued processing, stop on speaker change, separate question/answer attribution, local audio persistence, microphone shutdown, and disabling capture.');
})().catch(error=>{console.error(error);process.exitCode=1;});
