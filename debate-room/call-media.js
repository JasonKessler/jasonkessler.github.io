'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const send = message => window.debateCallSend(message);
  const peers = new Map();
  const pending = [];
  let selfID, stream, config, localTile;
  let joining = false, joined = false, captureAttempt = 0;
  let recording;

  function finishRecording(reason) {
    if (!recording || recording.recorder.state === 'inactive') return;
    if (reason) recording.warning = reason;
    recording.recorder.stop();
  }

  window.debateCallRecord = async ({action, speaker, useLocal}) => {
    if (action === 'start') {
      if (recording) throw new Error('Finish the current call recording first.');
      if (!joined) throw new Error('Join the video call on this Mac first.');
      const matches = [...peers.values()].filter(peer => peer.name === speaker);
      if (!useLocal && matches.length !== 1) {
        throw new Error(matches.length
          ? 'More than one caller is named ' + speaker + '. Use unique debate names when joining.'
          : 'No caller joined as ' + speaker + '. Use the exact debate name when joining.');
      }
      const peer = useLocal ? null : matches[0];
      const track = useLocal ? stream.getAudioTracks()[0] : peer.audioTrack;
      if (!track || !track.enabled || track.muted || track.readyState !== 'live') {
        throw new Error('No live microphone track for ' + speaker + '. Check the call microphone and connection.');
      }
      const input = new MediaStream([track]);
      const options = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(input, {audioBitsPerSecond: 32000, ...(options && {mimeType:options})});
      const chunks = [];
      const started = performance.now();
      let complete;
      const done = new Promise(resolve => { complete = resolve; });
      const interrupted = () => finishRecording('The call audio connection ended during this turn.');
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (recording?.recorder === recorder) recording.warning = 'The call recorder was interrupted.'; };
      recorder.onstop = () => {
        track.removeEventListener('ended', interrupted);
        complete({blob: new Blob(chunks, {type: recorder.mimeType}), duration: (performance.now() - started) / 1000});
      };
      recorder.start(1000);
      recording = {recorder, peer, done, warning: ''};
      track.addEventListener('ended', interrupted, {once:true});
      return true;
    }
    const active = recording;
    if (!active) throw new Error('No call recording was started.');
    finishRecording();
    try {
      const {blob, duration} = await active.done;
      if (blob.size > 24 * 1024 * 1024) throw new Error('This call recording is too large to save.');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the call recording.'));
        reader.readAsDataURL(blob);
      });
      return {base64: data.slice(data.indexOf(',') + 1), type: blob.type, duration, warning: active.warning || ''};
    } finally {
      if (recording === active) recording = null;
    }
  };

  function setStatus(text) { $('status').textContent = text; }
  function controls() {
    $('join').disabled = joining;
    $('join').hidden = joined;
    $('cameraOption').hidden = $('micOption').hidden = joined;
    $('relay').hidden = joined;
    if (!joined) $('enableAudio').hidden = true;
    $('leave').hidden = !joined && !joining;
    $('mute').hidden = !joined || !stream?.getAudioTracks().length;
    $('pauseVideo').hidden = !joined || !stream?.getVideoTracks().length;
  }

  $('enableAudio').onclick = () => {
    $('enableAudio').hidden = true;
    for (const peer of peers.values()) play(peer.tile.video);
  };

  function play(video) {
    video.play().catch(error => {
      if (error.name === 'NotAllowedError' && joined) $('enableAudio').hidden = false;
    });
  }

  function makeTile(name, local) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const stage = document.createElement('div');
    stage.className = 'stage';
    const placeholder = document.createElement('span');
    placeholder.textContent = 'Camera off';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local;
    video.hidden = true;
    stage.append(placeholder, video);
    const caption = document.createElement('div');
    caption.className = 'caption';
    const title = document.createElement('span');
    title.className = 'name';
    title.textContent = name;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = local ? 'This device' : 'Connecting';
    caption.append(title, state);
    tile.append(stage, caption);
    $('participants').append(tile);
    return {tile, video, state};
  }

  function stop(notify = true) {
    const wasActive = joining || joined;
    captureAttempt++;
    joining = joined = false;
    selfID = null;
    pending.length = 0;
    finishRecording('The call ended during this turn.');
    for (const peer of peers.values()) peer.connection.close();
    peers.clear();
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    localTile = null;
    $('participants').replaceChildren();
    controls();
    if (notify && wasActive) send({kind:'leave'});
  }

  $('join').onclick = async () => {
    if (joining || joined) return;
    const attempt = ++captureAttempt;
    joining = true;
    controls();
    setStatus('Joining the call…');
    const iceServers = [{urls:'stun:stun.l.google.com:19302'}];
    const relay = $('turnURL').value.trim();
    try {
      if (relay) {
        if (!/^turns?:[^\s]+$/i.test(relay)) throw new Error('Enter a TURN URL beginning with turn: or turns:.');
        iceServers.push({urls:relay, username:$('turnUser').value, credential:$('turnPassword').value});
      }
      config = {iceServers};
      const video = $('camera').checked;
      const audio = $('mic').checked;
      const media = (video || audio)
        ? await navigator.mediaDevices.getUserMedia({
            video: video ? {width:{ideal:640,max:960}, height:{ideal:360,max:540}, frameRate:{ideal:24,max:30}} : false,
            audio: audio ? {echoCancellation:true, noiseSuppression:true} : false
          })
        : new MediaStream();
      if (attempt !== captureAttempt) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      $('mute').textContent = 'Mute mic';
      $('pauseVideo').textContent = 'Pause camera';
      localTile = makeTile('You', true);
      localTile.video.srcObject = stream;
      localTile.video.hidden = !video;
      send({kind:'join'});
      setTimeout(() => {
        if (attempt === captureAttempt && joining) {
          stop();
          setStatus('Call setup timed out. Check that the host is still sharing, then try again.');
        }
      }, 12000);
    } catch (error) {
      if (attempt !== captureAttempt) return;
      stop();
      setStatus(error.message + ' You can uncheck camera and microphone to listen only.');
    }
  };

  $('leave').onclick = () => { stop(); setStatus('You left the call.'); };
  $('mute').onclick = () => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    if (!track.enabled && recording && !recording.peer) finishRecording('The local call microphone was muted during this turn.');
    $('mute').textContent = track.enabled ? 'Mute mic' : 'Unmute mic';
  };
  $('pauseVideo').onclick = () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('pauseVideo').textContent = track.enabled ? 'Pause camera' : 'Resume camera';
    if (localTile) localTile.video.hidden = !track.enabled;
  };

  function transmit(peer, kind, value) {
    send({kind, to:peer.id, value:JSON.stringify(value)});
  }

  function serialize(peer, task) {
    peer.work = peer.work.then(async () => {
      if (peers.get(peer.id) === peer) await task();
    }).catch(() => {
      if (peers.get(peer.id) === peer) peer.tile.state.textContent = 'Connection failed · rejoin to retry';
    });
  }

  function configureSender(sender) {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings[0].maxBitrate = 750000;
    sender.setParameters(parameters).catch(() => {});
  }

  function createPeer(item) {
    const connection = new RTCPeerConnection(config);
    const peer = {id:item.id, name:item.name, connection, tile:makeTile(item.name,false), work:Promise.resolve(), candidates:[]};
    const remote = new MediaStream();
    peer.tile.video.srcObject = remote;
    connection.ontrack = ({track}) => {
      remote.addTrack(track);
      if (track.kind === 'audio') peer.audioTrack = track;
      if (track.kind === 'video') {
        peer.tile.video.hidden = track.muted;
        track.onunmute = () => { peer.tile.video.hidden = false; };
        track.onmute = () => { peer.tile.video.hidden = true; };
      }
      play(peer.tile.video);
    };
    connection.onconnectionstatechange = () => {
      const messages = {new:'Connecting',connecting:'Connecting',connected:'Connected',
        disconnected:'Interrupted',failed:'Connection failed · check TURN',closed:'Left'};
      peer.tile.state.textContent = messages[connection.connectionState] || 'Connecting';
    };
    connection.onicecandidate = event => {
      if (event.candidate && peers.get(peer.id) === peer) {
        transmit(peer, 'ice', event.candidate.toJSON());
      }
    };
    peers.set(item.id, peer);
    if (selfID < item.id) serialize(peer, async () => {
      for (const kind of ['audio', 'video']) {
        const track = stream.getTracks().find(track => track.kind === kind);
        if (track) connection.addTrack(track, stream);
        else connection.addTransceiver(kind, {direction:'recvonly'});
      }
      await connection.setLocalDescription(await connection.createOffer());
      for (const sender of connection.getSenders()) if (sender.track?.kind === 'video') configureSender(sender);
      transmit(peer, 'offer', connection.localDescription);
    });
  }

  function reconcile(event) {
    if ((!joining && !joined) || !stream || !event.peers?.some(item => item.id === event.selfID)) return;
    selfID = event.selfID;
    joined = true;
    joining = false;
    controls();
    const others = event.peers.filter(item => item.id !== selfID);
    for (const [id, peer] of peers) {
      if (!others.some(item => item.id === id)) {
        if (recording?.peer === peer) finishRecording('The speaker left the call during this turn.');
        peer.connection.close();
        peer.tile.tile.remove();
        peers.delete(id);
      }
    }
    for (const item of others) if (!peers.has(item.id)) createPeer(item);
    for (const event of pending.splice(0)) receiveSignal(event);
    setStatus(others.length ? 'In call · ' + (others.length + 1) + ' participants' : 'In call · waiting for others');
  }

  function receiveSignal(event) {
    if ((!joining && !joined) || !event.signal) return;
    const peer = peers.get(event.from);
    if (!peer) {
      if (pending.length < 64) pending.push(event);
      return;
    }
    serialize(peer, async () => {
      const connection = peer.connection;
      const signal = event.signal;
      const value = JSON.parse(signal.value);
      if (signal.kind === 'ice') {
        if (connection.remoteDescription) await connection.addIceCandidate(value);
        else if (peer.candidates.length < 128) peer.candidates.push(value);
        return;
      }
      if (value.type !== signal.kind || !['offer','answer'].includes(value.type)) return;
      await connection.setRemoteDescription(value);
      for (const candidate of peer.candidates.splice(0)) await connection.addIceCandidate(candidate).catch(() => {});
      if (value.type === 'offer') {
        for (const transceiver of connection.getTransceivers()) {
          const track = stream.getTracks().find(track => track.kind === transceiver.receiver.track.kind);
          if (track) {
            await transceiver.sender.replaceTrack(track);
            transceiver.direction = 'sendrecv';
            if (track.kind === 'video') configureSender(transceiver.sender);
          }
        }
        await connection.setLocalDescription(await connection.createAnswer());
        transmit(peer, 'answer', connection.localDescription);
      }
    });
  }

  window.debateCallReceive = event => {
    if (event.kind === 'roster') reconcile(event);
    else if (event.kind === 'signal') receiveSignal(event);
    else if (event.kind === 'error' || (event.kind === 'availability' && !event.enabled)) {
      stop(false);
      setStatus(event.message || 'The sharing connection ended.');
    }
  };
  window.debateCallClose = () => stop(false);
})();
