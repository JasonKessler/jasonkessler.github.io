'use strict';

(() => {
  if (window.debateRoomMacApp !== true) return;

  const profiles = new Map();
  let model = '';
  let inFlight = false;
  let draft = null;
  let currentStage = null;

  const setup = document.createElement('details');
  setup.innerHTML = `
    <summary>AI participants</summary>
    <label for="debate-model">Local debate model</label>
    <select id="debate-model"></select>
    <p class="hint" id="debate-model-status" role="status"></p>
    <button type="button" class="small" id="refresh-debate-models">Refresh models</button>
    <div id="ai-profile-list"></div>`;
  $('people-hint').after(setup);

  const panel = document.createElement('section');
  panel.className = 'rec-panel';
  panel.style.textAlign = 'left';
  panel.hidden = true;
  panel.innerHTML = `
    <h3>AI participant</h3>
    <div id="ai-question-field" hidden>
      <label for="ai-human-question">Question to answer</label>
      <textarea id="ai-human-question" maxlength="1600" placeholder="Type the question, or use the saved question transcript."></textarea>
    </div>
    <div class="rec-actions" id="ai-turn-actions"></div>
    <p class="hint" id="ai-turn-status" role="status"></p>
    <p id="ai-accepted-question" class="hint" hidden></p>
    <div id="ai-turn-text" class="entry-transcript" hidden></div>`;
  $('verdict').before(panel);

  const officials = document.createElement('section');
  officials.className = 'rec-panel';
  officials.style.textAlign = 'left';
  officials.hidden = true;
  officials.innerHTML = `
    <h3 id="ai-officials-title"></h3>
    <p id="ai-officials-intro" class="hint"></p>
    <div class="rec-actions" id="ai-officials-actions"></div>`;
  $('verdict').before(officials);

  const deliberation = document.createElement('section');
  deliberation.className = 'rec-panel';
  deliberation.style.textAlign = 'left';
  deliberation.hidden = true;
  deliberation.innerHTML = `
    <h3>AI deliberation</h3>
    <p class="hint" id="ai-deliberation-status" role="status"></p>
    <div class="rec-actions" id="ai-deliberation-actions"></div>
    <div id="ai-deliberation-ballots"></div>`;
  $('verdict').before(deliberation);
  let judging = null;
  let deliberationMessage = '';

  const originalConfig = getConfig;
  getConfig = function () {
    const config = originalConfig();
    config.aiProfiles = config.names.filter(name => profiles.has(name))
      .map(name => ({name, persona: profiles.get(name)}));
    config.debateModel = model;
    return config;
  };

  function setupProfiles() {
    const list = $('ai-profile-list');
    list.replaceChildren();
    for (const name of new Set(originalConfig().names)) {
      const row = document.createElement('div');
      row.className = 'ai-profile';
      const label = document.createElement('label');
      label.className = 'check';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = profiles.has(name);
      label.append(toggle, name);
      const persona = document.createElement('textarea');
      persona.maxLength = 2000;
      persona.placeholder = 'Personality and debate style';
      persona.rows = 2;
      persona.setAttribute('aria-label', `Personality and debate style for ${name}`);
      persona.value = profiles.get(name) ?? '';
      persona.hidden = !toggle.checked;
      toggle.addEventListener('change', () => {
        if (toggle.checked) profiles.set(name, persona.value);
        else profiles.delete(name);
        persona.hidden = !toggle.checked;
      });
      persona.addEventListener('input', () => {
        profiles.set(name, persona.value);
      });
      row.append(label, persona);
      list.append(row);
    }
  }

  async function loadModels() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Could not connect to the local service.');
      const health = await response.json();
      if (!health.models?.length) throw new Error(health.error || 'Install a local text model in Ollama.');
      const select = $('debate-model');
      select.replaceChildren(...health.models.map(name => new Option(name, name)));
      if (!health.models.includes(model)) model = health.models[0];
      select.value = model;
      $('debate-model-status').textContent = '';
    } catch (error) {
      $('debate-model-status').textContent = error.message;
    }
  }

  $('refresh-debate-models').onclick = loadModels;
  $('debate-model').onchange = event => {
    model = event.target.value;
  };
  $('names').addEventListener('input', setupProfiles);
  setupProfiles();
  loadModels();

  function profileFor(name) {
    return round?.config.aiProfiles?.find(profile => profile.name === name);
  }

  window.debateRoomIsAI = name => Boolean(profileFor(name));
  const voice = window.webkit?.messageHandlers?.debateVoice;
  function stopVoice() { voice?.postMessage(''); }

  function entries() { return round?.entries ?? []; }

  function accepted(turn, kind) {
    const stage = round.stages[turn];
    const speaker = kind === 'question' ? stage.asker : stage.speaker;
    return entries().find(entry => entry.turn === turn && entry.kind === kind && entry.isAI
      && entry.speaker === speaker && entry.text);
  }

  function button(title, click, primary = false) {
    const element = document.createElement('button');
    element.className = primary ? 'small primary' : 'small';
    element.textContent = title;
    element.onclick = click;
    return element;
  }

  function showText(text) {
    $('ai-turn-text').hidden = !text;
    $('ai-turn-text').textContent = text || '';
  }

  function updateTurn() {
    const stage = round?.stages[round.index];
    updateOfficials(stage);
    if (currentStage !== stage) {
      currentStage = stage;
      draft = null;
      deliberationMessage = '';
      $('ai-human-question').value = '';
      $('ai-turn-status').textContent = '';
      stopVoice();
    }
    updateDeliberation(stage);
    if (stage && stage.kind !== 'deliberation') {
      const name = participant => participant + (profileFor(participant) ? ' (AI)' : '');
      $('speaker').textContent = stage.asker
        ? `${name(stage.asker)} asks → ${name(stage.speaker)} answers`
        : name(stage.speaker);
    } else if (stage?.kind === 'deliberation') {
      const panel = [round.roles.moderator, ...round.roles.questioners].filter(name => !profileFor(name));
      $('speaker').textContent = panel.join(', ') || 'Human host';
    }
    const asker = stage?.asker && profileFor(stage.asker);
    const speaker = stage && stage.kind !== 'deliberation' && profileFor(stage.speaker);
    panel.hidden = !asker && !speaker;
    if (panel.hidden) return;
    const actions = $('ai-turn-actions');
    actions.replaceChildren();
    const readyQuestion = accepted(round.index, 'question');
    const readySpeech = accepted(round.index, 'speech');
    $('ai-question-field').hidden = !(speaker && stage.asker && !asker && !readySpeech);
    const questionText = $('ai-accepted-question');
    questionText.hidden = !readyQuestion || (!draft && !readySpeech);
    questionText.textContent = readyQuestion ? `${stage.asker} asked: ${readyQuestion.text}` : '';
    if (draft) {
      showText(draft.result.speech);
      const chainAnswer = draft.kind === 'question' && speaker;
      const useLabel = chainAnswer ? 'Use question & draft AI answer' : 'Use this turn';
      actions.append(
        button(useLabel, async () => {
          acceptDraft();
          if (chainAnswer) await generate('speech', speaker);
        }, true),
        button('Discard draft', () => {
          draft = null;
          $('ai-turn-status').textContent = '';
          updateTurn();
        })
      );
      return;
    }
    const newest = readySpeech ?? readyQuestion;
    showText(newest?.text);
    if (readyQuestion) actions.append(button('Read question aloud', () => speak(readyQuestion.text)));
    else if (asker) actions.append(button('Draft AI question', () => generate('question', asker), true));
    if (readySpeech) actions.append(button('Read speech aloud', () => speak(readySpeech.text)));
    else if (speaker && (!asker || readyQuestion)) {
      actions.append(button(stage.asker ? 'Draft AI answer' : 'Draft AI speech',
                            () => generate('speech', speaker), true));
    }
    if (voice && newest) {
      actions.append(button('Stop voice', stopVoice));
    }
    if (inFlight) for (const control of actions.children) control.disabled = true;
  }

  function announce(stage) {
    const {moderator} = round.roles;
    if (stage.kind === 'deliberation') {
      return `The speeches are complete. Judges, you have ${fmt(stage.seconds)} to deliberate.`;
    }
    const introduction = round.index === 0
      ? `Welcome. I’m ${moderator}, your AI moderator. The motion is: ${round.config.proposition}. ` : '';
    const instruction = stage.kind === 'question'
      ? `${stage.asker}, please ask your question. ${stage.speaker}, you have ${fmt(stage.seconds)} to answer.`
      : `${stage.speaker}, the floor is yours for the ${stage.title.toLowerCase()}. Your time is ${fmt(stage.seconds)}.`;
    return introduction + instruction;
  }

  function updateOfficials(stage) {
    const moderator = stage && profileFor(round.roles.moderator);
    officials.hidden = !moderator;
    if (!moderator) return;
    const line = announce(stage);
    $('ai-officials-title').textContent = `${moderator.name} · AI moderator`;
    $('ai-officials-intro').textContent = line;
    const title = stage.kind === 'deliberation' ? 'Announce deliberation' : 'Announce this turn';
    $('ai-officials-actions').replaceChildren(button(title, () => speak(line), true));
  }

  const outcomes = {affirmative: 'Affirmative', negative: 'Negative', draw: 'Draw', abstain: 'Abstain'};

  function judgePanel(target) {
    const people = [target.roles.moderator, ...target.roles.questioners].map(profileFor).filter(Boolean);
    return people.length ? people : [{name: 'Neutral AI judge', persona: 'Evenhanded and concise.'}];
  }

  function debateRecord(target) {
    return (target.entries ?? []).flatMap(entry => {
      const side = ['affirmative', 'negative'].find(role => target.roles[role] === entry.speaker);
      if (!side || !entry.text?.trim() || entry.kind === 'question' ||
          target.stages[entry.turn]?.kind === 'deliberation') return [];
      return [{
        id: entry.id, side, stage: `Turn ${entry.turn + 1} · ${entry.stage}`,
        text: entry.text.trim().slice(0, 1800), turn: entry.turn,
      }];
    }).sort((a, b) => a.turn - b.turn);
  }

  function recommendation(ballots, judgeCount) {
    if (ballots.length !== judgeCount) return null;
    const count = {affirmative: 0, negative: 0, draw: 0, abstain: 0};
    for (const ballot of ballots) count[ballot.vote]++;
    const decided = ballots.length - count.abstain;
    return ['affirmative', 'negative', 'draw'].find(outcome => count[outcome] > decided / 2) ?? null;
  }

  function updateDeliberation(stage) {
    deliberation.hidden = stage?.kind !== 'deliberation';
    if (deliberation.hidden) return;
    const judges = judgePanel(round);
    const record = debateRecord(round);
    const key = JSON.stringify(record);
    const ballots = round.aiDeliberation?.key === key ? round.aiDeliberation.ballots : [];
    const chosen = recommendation(ballots, judges.length);
    const complete = new Set(record.map(entry => entry.side)).size === 2;
    const actions = $('ai-deliberation-actions');
    actions.replaceChildren();
    const list = $('ai-deliberation-ballots');
    list.replaceChildren();
    for (const ballot of ballots) {
      const item = document.createElement('article');
      item.className = 'entry';
      const heading = document.createElement('h3');
      heading.textContent = `${ballot.judge} · ${outcomes[ballot.vote]}`;
      const reason = document.createElement('p');
      reason.textContent = ballot.reason;
      item.append(heading, reason);
      for (const citation of ballot.citations) {
        const quote = document.createElement('blockquote');
        quote.textContent = `${outcomes[citation.side]} · ${citation.stage}: “${citation.quote}”`;
        item.append(quote);
      }
      list.append(item);
    }
    const verdictText = chosen ? `Recommendation: ${outcomes[chosen]}.`
      : ballots.length === judges.length ? 'The judges reached no majority.' : '';
    $('ai-deliberation-status').textContent = !complete ? 'Add notebook remarks for both debaters first.'
      : [`${ballots.length} of ${judges.length} ballots.`, verdictText, deliberationMessage].filter(Boolean).join(' ');
    if (!round.winner && ballots.length < judges.length) {
      const run = button(ballots.length ? 'Finish AI deliberation' : 'Start AI deliberation',
                         () => deliberate(round, judges, record, key), true);
      run.disabled = !complete || Boolean(judging);
      actions.append(run);
    }
    if (chosen && !round.winner && !judging) {
      const target = round;
      actions.append(button('Record AI verdict', () => {
        if (target !== round || round.winner || JSON.stringify(debateRecord(round)) !== key) return;
        deadline = null;
        remaining = 0;
        touched = true;
        round.winner = chosen;
        snapshot();
        renderStage();
      }, true));
    }
  }

  async function deliberate(target, judges, record, key) {
    if (judging || target.winner || target !== round) return;
    const selectedModel = target.config.debateModel || model;
    if (!selectedModel) {
      deliberationMessage = 'Choose a local model in setup first.';
      updateDeliberation(target.stages[target.index]);
      return;
    }
    const stillCurrent = () => target === round && !target.winner &&
      target.stages[target.index].kind === 'deliberation' && JSON.stringify(debateRecord(target)) === key;
    if (!stillCurrent()) return;
    if (target.aiDeliberation?.key !== key) target.aiDeliberation = {key, ballots: []};
    const ballots = target.aiDeliberation.ballots;
    judging = target;
    try {
      for (const judge of judges) {
        if (ballots.some(ballot => ballot.judge === judge.name)) continue;
        deliberationMessage = `${judge.name} is reviewing the record locally…`;
        updateDeliberation(target.stages[target.index]);
        const response = await fetch('/api/debate-ballot', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({model: selectedModel, persona: judge.persona,
            proposition: target.config.proposition, record})
        });
        const ballot = await response.json();
        if (!stillCurrent()) {
          deliberationMessage = 'The record changed. Start a fresh deliberation.';
          return;
        }
        if (!response.ok) throw new Error(`${judge.name}: ${ballot.error || 'Could not return a ballot.'}`);
        ballots.push({...ballot, judge: judge.name});
      }
      deliberationMessage = '';
    } catch (error) {
      deliberationMessage = error.message;
    } finally {
      judging = null;
      updateDeliberation(round?.stages[round.index]);
    }
  }

  window.debateRoomRefreshDeliberation = () => updateDeliberation(round?.stages[round.index]);

  function speak(text) {
    if (!voice) {
      $('ai-turn-status').textContent = 'Read the speech on screen.';
      return;
    }
    voice.postMessage(text);
  }

  function notebookSources(target, turn, kind) {
    const stage = target.stages[turn];
    const focus = kind === 'question' ? stage.speaker
      : stage.side === 'affirmative' ? target.roles.negative : target.roles.affirmative;
    const prior = (target.entries ?? []).filter(entry => entry.text?.trim() &&
      (entry.turn < turn || (entry.turn === turn && kind === 'speech' && entry.kind === 'question')))
      .sort((a, b) => a.turn - b.turn);
    const openings = prior.filter(entry => target.stages[entry.turn]?.kind === 'opening');
    const focused = prior.filter(entry => entry.speaker === focus && entry.kind !== 'question').slice(-4);
    const selected = [...new Set([...openings.slice(0, 4), ...focused, ...prior.slice(-10)])]
      .slice(0, 18).sort((a, b) => a.turn - b.turn);
    return selected.map(entry => ({
      turn: entry.turn + 1,
      stage: entry.stage,
      speaker: entry.speaker,
      side: ['affirmative', 'negative'].find(side => target.roles[side] === entry.speaker) || null,
      kind: entry.kind,
      text: entry.text.trim().slice(0, 700),
      points: (entry.notes?.points ?? []).slice(0, 4).map(point => ({
        kind: point.kind, text: point.point.slice(0, 250),
      })),
    }));
  }

  async function generate(kind, profile) {
    if (inFlight || draft || !round) return;
    const target = round;
    const turn = target.index;
    const stage = target.stages[turn];
    const selectedModel = target.config.debateModel || model;
    if (!selectedModel) {
      $('ai-turn-status').textContent = 'Start Ollama and choose a local model in setup.';
      return;
    }
    inFlight = true;
    $('ai-turn-status').textContent = 'Checking the debate notebook for this turn…';
    updateTurn();
    try {
      const answering = kind === 'speech' && Boolean(stage.asker);
      await window.debateRoomAwaitNotebook?.(answering && !profileFor(stage.asker));
      if (round !== target || round.index !== turn || stage !== currentStage) return;
      let question = '';
      const typedQuestion = answering && !profileFor(stage.asker) ? $('ai-human-question').value.trim() : '';
      if (answering) {
        const aiQuestion = profileFor(stage.asker) && accepted(turn, 'question');
        const recorded = entries().findLast(entry =>
          entry.turn === turn && entry.kind === 'question' && entry.speaker === stage.asker && entry.text);
        question = (aiQuestion ? aiQuestion.text : typedQuestion || recorded?.text) ?? '';
        if (!question) throw new Error('Record or type the question before generating an answer.');
      }
      const notebook = notebookSources(target, turn, kind);
      if (stage.kind === 'rebuttal' && !notebook.some(entry =>
        entry.side && entry.side !== stage.side && entry.kind !== 'question')) {
        throw new Error('Add the opposing debater’s remarks to the notebook before drafting this rebuttal.');
      }
      $('ai-turn-status').textContent = `Generating ${profile.name}’s turn from the notebook…`;
      const response = await fetch('/api/debate-turn', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: selectedModel,
          role: kind === 'question' ? 'questioner' : stage.side,
          stage: stage.title,
          speaker: profile.name,
          persona: profile.persona,
          proposition: target.config.proposition,
          seconds: stage.seconds,
          addressee: kind === 'question' ? stage.speaker : stage.asker,
          question, notebook,
          turnKind: kind === 'question' ? 'question' : answering ? 'answer' : stage.kind
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The local model could not generate a turn.');
      if (round !== target || round.index !== turn || stage !== currentStage) return;
      draft = {kind, result, profile, target, turn, typedQuestion};
      $('ai-turn-status').textContent = 'Review this draft. Use it to add it to the notebook.';
    } catch (error) {
      if (round === target && round.index === turn) $('ai-turn-status').textContent = error.message;
    } finally {
      inFlight = false;
      updateTurn();
    }
  }

  function acceptDraft() {
    if (!draft || draft.target !== round || draft.turn !== round.index) return;
    const {kind, result, profile, typedQuestion} = draft;
    const stage = round.stages[round.index];
    if (typedQuestion && !entries().some(entry => entry.turn === round.index && entry.kind === 'question'
      && entry.speaker === stage.asker && entry.text.trim() === typedQuestion)) {
      window.debateRoomAddTypedQuestion(stage.asker, stage.speaker, typedQuestion);
    }
    window.debateRoomAddAITurn(kind, profile.name,
      kind === 'question' ? `Question to ${stage.speaker}` : stage.title, result);
    draft = null;
    $('ai-turn-status').textContent = 'Saved to the notebook as an AI turn.';
    updateTurn();
  }

  const originalRenderStage = renderStage;
  renderStage = function () {
    originalRenderStage();
    updateTurn();
    if (remaining === 0) stopVoice();
  };

  const start = $('start').onclick;
  $('start').onclick = async () => {
    if (deadline !== null) stopVoice();
    await start();
  };
  for (const id of ['reset', 'edit', 'finish']) {
    const action = $(id).onclick;
    $(id).onclick = async () => {
      await action();
      if (id === 'reset' || !round) stopVoice();
      updateTurn();
    };
  }


  const busy = window.debateRoomIsBusy;
  window.debateRoomIsBusy = () => inFlight || Boolean(judging) || Boolean(draft) || Boolean(busy?.());
  if (round) updateTurn();
})();
