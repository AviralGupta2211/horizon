/* Run: node test/core.test.js */
const assert = require('assert');
const HZ = require('../js/core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}
const NOW = new Date(2026, 10, 15, 9, 0, 0);
const day = (n) => HZ.addDays(NOW, n);

test('island: eight regions, all on land, room to build', () => {
  const T = HZ.terrain();
  assert.strictEqual(T.tilesByRegion.length, 8);
  assert.ok(T.landCount > 750 && T.landCount < 1100, 'land tiles ' + T.landCount);
  T.tilesByRegion.forEach((tiles, k) => assert.ok(tiles.length > 60, HZ.REGION_IDS[k] + ' has ' + tiles.length));
  T.centroid.forEach((c) => assert.ok(T.land[Math.round(c.y) * HZ.N + Math.round(c.x)], 'centroid on land'));
  // no land on the rim of the grid
  for (let i = 0; i < HZ.N; i++) {
    assert.ok(!T.land[i] && !T.land[(HZ.N - 1) * HZ.N + i] && !T.land[i * HZ.N] && !T.land[i * HZ.N + HZ.N - 1], 'rim is water');
  }
});

test('verbatim check: quotes pass, rewording does not', () => {
  const entry = "I think people don't really change, they just get better at hiding it. Also money, honestly, buys back your time.";
  assert.ok(HZ.isVerbatim("people don't really change, they just get better at hiding it", entry));
  assert.ok(HZ.isVerbatim('money, honestly, buys back your time', entry));
  assert.ok(HZ.isVerbatim('People dont really change they just get better at hiding it…', entry.replace("don't", 'dont')));
  assert.ok(!HZ.isVerbatim('Humans are fundamentally static in personality', entry));
  assert.ok(!HZ.isVerbatim('', entry));
});

test('first entry, offline reader: units land in their regions with a move and a door', () => {
  const s = HZ.newState(NOW);
  const text = 'I think the brain is mostly a prediction machine. My father taught me that work should always be finished properly. Why do I avoid hard conversations?';
  const res = HZ.normalizeDaily(HZ.offlineDaily(s, text, NOW), s, text);
  assert.ok(res.units.length >= 2 && res.units.length <= 4);
  res.units.forEach((u) => assert.ok(u.verbatim, 'offline units are quotes: ' + u.text));
  const out = HZ.applyDaily(s, text, res, { now: NOW });
  const T = HZ.terrain();
  out.units.forEach((u) => {
    assert.ok(u.pos, 'placed');
    const idx = u.pos.y * HZ.N + u.pos.x;
    assert.ok(T.land[idx], 'on land');
    assert.strictEqual(HZ.REGION_IDS[T.region[idx]], u.region, 'inside its region');
    assert.strictEqual(u.status, 'yours');
  });
  assert.ok(HZ.MOVES[out.move.kind]);
  assert.ok(out.move.body.length > 10);
  assert.ok(s.meta.door && s.meta.door.text.length > 5, 'door for tomorrow');
  assert.strictEqual(s.entries.length, 1);
  assert.ok(s.units.some((u) => u.type === 'question'));
});

test('model result: refs, links, concept, depth effects, and guesses become outlines', () => {
  const s = HZ.newState(NOW);
  const e1 = 'Good work is mostly about finishing things. Shipping is the only proof.';
  HZ.applyDaily(s, e1, HZ.normalizeDaily({ units: [{ type: 'belief', label: 'Finishing is the work', text: 'Good work is mostly about finishing things', region: 'work', conviction: 4, origin: 'lived' }], move: { kind: 'door', title: 'x', body: 'A question for you about money.', door_region: 'money' }, door: 'What is money for?', door_region: 'money' }, s, e1), { now: NOW });
  const first = s.units[0];
  assert.strictEqual(first.id, 'u2');
  const e2 = 'Last month I pushed a half-built feature live and it taught us more than six weeks of planning. I guess the map is never the place itself.';
  const raw = {
    units: [
      { type: 'story', label: 'Shipping half-built', text: 'I pushed a half-built feature live and it taught us more than six weeks of planning', region: 'work', conviction: 4, origin: 'lived', lens: { language: 0.2, minds: 0.3, places: 0, body: 0.6, sound: 0, vision: 0 } },
      { type: 'belief', label: 'Map is not the place', text: 'the map is never the place itself', region: 'nature', conviction: 2, origin: 'reasoned' },
      { type: 'belief', label: 'Planning is overrated', text: 'Planning is mostly procrastination in disguise', region: 'work', conviction: 3 },
      'garbage', null, { text: '' }
    ],
    links: [{ from: 'new:0', to: first.id, kind: 'example_of' }, { from: 'new:1', to: 'u999', kind: 'same_as' }, { from: 'new:5', to: first.id, kind: 'because' }, { from: 'new:0', to: 'new:0', kind: 'same_as' }],
    move: { kind: 'name_it', title: 'The map is not the territory', body: 'You said "the map is never the place itself". That idea has a name.', refs: ['new:1', 'nope'], concept: { name: 'The map is not the territory', gist: 'A description of a thing is not the thing. Alfred Korzybski coined the phrase in 1931.', disputed_by: 'Some pragmatists reply that we only ever have maps.', about: 'new:1' }, bet: { about: 'new:0', text: 'ignored', due_days: 3 } },
    door: 'Where has a plan of yours been wrong about the ground?', door_region: 'work', take_to_person: 'When did a plan last surprise you?'
  };
  const res = HZ.normalizeDaily(raw, s, e2);
  assert.strictEqual(res.units.length, 3);
  assert.deepStrictEqual(res.units.map((u) => u.verbatim), [true, true, false]);
  assert.strictEqual(res.links.length, 1, 'bad links dropped');
  assert.strictEqual(res.move.bet, null, 'bet ignored on a name_it move');
  const out = HZ.applyDaily(s, e2, res, { now: day(1) });
  assert.strictEqual(out.units[2].status, 'outline');
  assert.strictEqual(first.depth, 2, 'a lived example raises depth to exemplified');
  assert.strictEqual(s.concepts.length, 1);
  assert.strictEqual(s.concepts[0].unit, out.units[1].id);
  assert.ok(s.concepts[0].pos, 'landmark placed');
  assert.deepStrictEqual(out.move.refs, [out.units[1].id]);
  assert.strictEqual(s.entries[1].door, 'What is money for?', 'entry remembers the door it answered');
  assert.ok(s.doors[0].answeredAt, 'old door closed');
  assert.strictEqual(s.meta.door.text, 'Where has a plan of yours been wrong about the ground?');
  // the same concept is never collected twice
  const res2 = HZ.normalizeDaily({ units: [], move: { kind: 'name_it', title: 't', body: 'b', concept: { name: 'the map is not the territory', gist: 'again' } } }, s, 'x');
  assert.strictEqual(res2.move.concept, null);
});

test('junk from the model never breaks the map', () => {
  const s = HZ.newState(NOW);
  [null, undefined, 'text', 42, [], { units: 'no', links: {}, move: 7 }, { units: [{ text: 'a real thought here', region: 'nowhere', type: 'zzz', conviction: 99, lens: 'x' }], move: { kind: 'bet', body: 'b', bet: { about: 'new:0', text: 'By Friday it rains', due_days: 500 } } }].forEach((raw) => {
    const res = HZ.normalizeDaily(raw, s, 'a real thought here and more');
    assert.ok(res.move && res.move.body, 'always a move with a body');
    const out = HZ.applyDaily(s, 'a real thought here and more', res, { now: NOW });
    assert.ok(out.move.id);
  });
  const u = s.units[0];
  assert.ok(HZ.REGION_IDS.includes(u.region) && u.type === 'belief' && u.conviction === 5);
  const m = s.moves[s.moves.length - 1];
  assert.ok(m.betDraft && m.betDraft.dueDays === 30 && m.betDraft.unit === u.id);
});

test('bets: due, held turns a belief to stone, failed cracks it', () => {
  const s = HZ.newState(NOW);
  const t = 'Launches always slip by at least a week. People forgive a late launch if the product is good.';
  const out = HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW), s, t), { now: NOW });
  const [a, b] = out.units;
  const bet1 = HZ.addBet(s, a.id, 'By Friday the launch date will have moved', 5, NOW);
  const bet2 = HZ.addBet(s, b.id, 'Reviews next week will not mention the delay', 9, NOW);
  assert.strictEqual(bet1.due, HZ.dayKey(day(5)));
  assert.strictEqual(HZ.dueBets(s, day(4)).length, 0);
  assert.strictEqual(HZ.dueBets(s, day(5)).length, 1);
  HZ.resolveBet(s, bet1.id, 'held', 'moved by nine days', day(5));
  assert.ok(a.tested && a.depth === 4);
  HZ.resolveBet(s, bet2.id, 'failed', '', day(9));
  assert.ok(b.cracked && !b.tested);
  HZ.revise(s, b.id, 'People forgive a late launch only if you told them early', day(9));
  assert.ok(!b.cracked && b.notes.some((n) => n.k === 'was'));
  const st = HZ.stats(s, day(9));
  assert.strictEqual(st.stone, 1); assert.strictEqual(st.betsHeld, 1); assert.strictEqual(st.betsFailed, 1); assert.strictEqual(st.betsOpen, 0);
});

test('going deeper: explain, exemplify, answer a challenge', () => {
  const s = HZ.newState(NOW);
  const t = 'Most of what looks like talent is somebody who stayed with it longer.';
  const u = HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW), s, t), { now: NOW }).units[0];
  HZ.explain(s, u.id, 'Because every expert I know was bad at it for years first', NOW);
  assert.strictEqual(u.depth, 1);
  const story = HZ.exemplify(s, u.id, 'My guitar teacher could not hold a chord for his whole first year', NOW);
  assert.strictEqual(u.depth, 2); assert.strictEqual(story.type, 'story'); assert.ok(story.pos);
  assert.ok(Math.hypot(story.pos.x - u.pos.x, story.pos.y - u.pos.y) < 5, 'the example sits near what it supports');
  HZ.answerChallenge(s, u.id, HZ.normalizeChallenge({ who: 'Francis Galton', argument: 'Ability is largely inherited.', question: 'What about prodigies?' }), 'Prodigies still practise more than anyone', NOW);
  assert.strictEqual(u.depth, 3);
  assert.strictEqual(HZ.linksOf(s, u.id).length, 1);
  assert.ok(HZ.normalizeChallenge(null).offline);
});

test('sixty days of use: no shared tiles, fog only ever clears, documents round-trip', () => {
  const s = HZ.newState(NOW);
  const bank = [
    'I think people mostly want to be seen. My mother always said trust takes years to build.',
    'Money is just stored time. Markets reward patience more than cleverness.',
    'Good design should feel obvious after the fact. I remember when we shipped the first sign-up flow and nobody needed help.',
    'Maybe death is what makes any of this matter. Why do I care so much about legacy?',
    'Music is the closest thing I know to a shared mind. Travel should change what you think is normal.',
    'Cities are machines for meeting strangers. The government never moves as fast as culture does.',
    'The brain is not a camera, it is a guess. Evolution does not care whether we are happy.',
    'I never feel more like myself than when I am building something. Sleep is not optional for clear thinking.'
  ];
  let prevFog = 0;
  for (let d = 0; d < 60; d++) {
    const t = bank[d % bank.length] + ' Day ' + d + ' thought number ' + (d * 7) + ' about ' + ['walls', 'rivers', 'songs', 'debts', 'votes', 'atoms', 'gods', 'games'][d % 8] + ' matters to me.';
    HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, day(d)), s, t), { now: day(d) });
    const fog = HZ.fogCleared(s);
    assert.ok(fog >= prevFog - 1e-9 && fog <= 1, 'fog cleared goes up: ' + fog);
    prevFog = fog;
  }
  const seen = {};
  s.units.forEach((u) => { const k = u.pos.x + ',' + u.pos.y; assert.ok(!seen[k], 'tile used twice ' + k); seen[k] = 1; });
  const st = HZ.stats(s, day(59));
  assert.strictEqual(st.days, 60); assert.strictEqual(st.run, 60);
  assert.ok(st.structures > 60, 'structures ' + st.structures); // repeated sentences are not placed twice
  assert.ok(st.fog > 0.25 && st.fog < 1, 'fog cleared after 60 days: ' + st.fog.toFixed(2));
  assert.ok(s.doors.filter((x) => !x.answeredAt).length <= 6);
  const docs = HZ.toDocs(s);
  assert.ok(Object.keys(docs).length >= 8);
  Object.keys(docs).forEach((id) => { assert.ok(/^[A-Za-z0-9_]+$/.test(id)); assert.ok(JSON.stringify(docs[id]).length < 200000, id + ' is small enough for one document'); });
  const back = HZ.fromDocs(JSON.parse(JSON.stringify(docs)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(s)));
  const imported = HZ.importState(HZ.exportState(s, NOW));
  assert.strictEqual(imported.units.length, s.units.length);
  console.log('        after 60 days: ' + st.structures + ' structures, ' + Math.round(st.fog * 100) + '% fog cleared, ' + Object.keys(docs).length + ' documents');
});

test('broken saved data is repaired, not fatal', () => {
  assert.strictEqual(HZ.importState('not json'), null);
  assert.strictEqual(HZ.importState('{"app":"other"}'), null);
  const s = HZ.repair({ meta: null, units: [{ id: 'u1', text: 'kept', region: 'mars', pos: { x: 0, y: 0 } }, { nope: 1 }, null], links: [{ id: 'l1', a: 'u1', b: 'gone', kind: 'same_as' }], doors: [{ id: 'd1', text: 'q', region: 'x' }], moves: [{ id: 'm1', kind: '??' }] });
  assert.strictEqual(s.units.length, 1);
  assert.ok(s.units[0].pos && HZ.terrain().land[s.units[0].pos.y * HZ.N + s.units[0].pos.x]);
  assert.strictEqual(s.links.length, 0);
  assert.strictEqual(s.moves[0].kind, 'door');
  assert.strictEqual(HZ.fromDocs({}), null);
});

test('sharing and overlay', () => {
  const s = HZ.newState(NOW);
  const t = 'People do not change much after thirty. Money buys back your time. A good life is being useful to a few people.';
  HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW), s, t), { now: NOW });
  const share = HZ.buildShare(s, HZ.REGION_IDS, NOW);
  assert.ok(share.units.length >= 2);
  const mine = HZ.normalizeShare(share).units, theirs = HZ.normalizeShare(HZ.EXAMPLE_PARTNER).units;
  assert.strictEqual(theirs.length, 12);
  const off = HZ.offlineOverlay(mine, theirs);
  assert.ok(off.shared && off.shared.ask);
  const good = HZ.normalizeOverlay({ shared: { a: 0, b: 0, note: 'n', ask: 'Do you both mean it?' }, disagreement: { a: 77, b: 0, ask: 'x' }, door: { region: 'play', ask: 'What do you find beautiful?' } }, mine, theirs);
  assert.ok(good.shared && !good.disagreement && good.door.region === 'play');
  assert.ok(HZ.normalizeOverlay('nonsense', mine, theirs).offline);
  assert.strictEqual(HZ.normalizeShare({ units: 'x' }), null);
  assert.ok(HZ.overlayPrompt(mine, theirs).includes('PERSON B'));
});

test('film, lens, expedition, prompts', () => {
  const s = HZ.newState(NOW);
  assert.strictEqual(HZ.buildFilm(s, NOW), null);
  const t = 'I see the whole plan as a picture before I can say it. Music tells me what I feel before I know. My team trusts me more when I admit what I do not know.';
  HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW), s, t), { now: NOW });
  const film = HZ.buildFilm(s, NOW);
  assert.ok(film.length >= 4 && film[0].k === 'wide' && film[film.length - 1].k === 'wide');
  const diet = HZ.lensDiet(s);
  assert.strictEqual(diet.length, 6);
  assert.ok(Math.abs(diet.reduce((a, b) => a + b.share, 0) - 1) < 1e-6);
  const input = HZ.lensExport(s);
  const imp = { source: 'tribe-v2', units: {} }; imp.units[input.units[0].id] = { language: 0.1, minds: 0.2, places: 0.9, body: 0, sound: 0, vision: 0.4 };
  assert.strictEqual(HZ.applyLensImport(s, imp), 1);
  assert.strictEqual(HZ.dominantLens(HZ.unitById(s, input.units[0].id)), 'places');
  assert.strictEqual(s.meta.lensSource, 'tribe-v2');
  assert.strictEqual(HZ.normalizeExpedition({ questions: ['a?', 'b?', 'c?', 'd?', 'e?', 'f?'] }, 'money').length, 5);
  assert.strictEqual(HZ.normalizeExpedition(null, 'money').length, 5);
  assert.ok(HZ.expeditionTranscript(['q1', 'q2'], ['yes', '']).includes('A: yes'));
  const p = HZ.dailyPrompt(s, 'hello world', { now: NOW });
  assert.ok(p.includes('"""\nhello world\n"""') && p.includes('ITEMS ALREADY ON THEIR MAP') && p.includes('u2 |'));
  assert.ok(p.length < 12000, 'prompt size ' + p.length);
  assert.ok(HZ.challengePrompt(s.units[0]).includes(s.units[0].text));
  assert.ok(HZ.expeditionPrompt(s, 'meaning').includes('Meaning'));
});

test('removing a unit takes its links and open bets with it', () => {
  const s = HZ.newState(NOW);
  const t = 'Cities are machines for meeting strangers. Strangers are where new ideas come from.';
  const out = HZ.applyDaily(s, t, HZ.normalizeDaily({ units: [{ text: 'Cities are machines for meeting strangers', region: 'society' }, { text: 'Strangers are where new ideas come from', region: 'people' }], links: [{ from: 'new:1', to: 'new:0', kind: 'because' }], move: { kind: 'bridge', body: 'b', refs: ['new:0', 'new:1'] } }, s, t), { now: NOW });
  assert.strictEqual(out.units[0].depth, 1);
  HZ.addBet(s, out.units[0].id, 'x happens', 3, NOW);
  HZ.removeUnit(s, out.units[0].id);
  assert.strictEqual(s.units.length, 1); assert.strictEqual(s.links.length, 0); assert.strictEqual(s.bets.length, 0);
  assert.deepStrictEqual(s.moves[0].refs, [out.units[1].id]);
});

test('share codes: round trip, any alphabet, junk refused', () => {
  const s = HZ.newState(NOW);
  const t = 'Cities are machines for meeting strangers. Música y café: la vida es breve — “carpe diem”. 日本語の文も大丈夫です 😀 and it survives.';
  HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW), s, t), { now: NOW });
  const share = HZ.buildShare(s, HZ.REGION_IDS, NOW), code = HZ.encodeShare(share, '  Zoë  Ωmega ');
  assert.ok(/^hz1\.[A-Za-z0-9_-]+$/.test(code), 'only characters that survive any chat app');
  const back = HZ.decodeShare(code);
  assert.strictEqual(back.name, 'Zoë Ωmega');
  assert.deepStrictEqual(back.units, HZ.normalizeShare(share).units);
  assert.deepStrictEqual(HZ.decodeShare('  ' + code.slice(0, 30) + '\n ' + code.slice(30) + '  ').units, back.units, 'line breaks added by a chat app do not matter');
  assert.strictEqual(HZ.decodeShare(HZ.encodeShare(share, '')).name, 'A friend');
  ['', 'hello', 'hz1.', 'hz1.!!!!', 'hz1.AAAA', 'hz2.' + code.slice(4), code.slice(0, 40), 'hz1.' + 'A'.repeat(500000), null, 42].forEach((junk) => assert.strictEqual(HZ.decodeShare(junk), null, 'refused: ' + String(junk).slice(0, 20)));
  // a code is somebody else's text: whatever is inside is clipped and typed like any other share
  const hostile = HZ.decodeShare(HZ.encodeShare({ at: 'x', regions: ['nope', 'work'], units: [{ l: 'L'.repeat(500), t: 'T'.repeat(5000), ty: 'virus', r: 'nowhere', d: 99, c: -5 }, { t: '' }, 7] }, 'N'.repeat(500)));
  assert.strictEqual(hostile.units.length, 1);
  assert.ok(hostile.units[0].t.length <= 240 && hostile.units[0].l.length <= 48 && hostile.name.length <= 40);
  assert.deepStrictEqual([hostile.units[0].ty, hostile.units[0].r, hostile.units[0].d, hostile.units[0].c, hostile.regions], ['belief', 'self', 4, 1, ['work']]);
});

test('crisis check: plain first-person phrases are caught; negations and figures of speech are not', () => {
  ['I want to kill myself', 'Some days I just want to die.', 'I have been thinking about suicide a lot', 'I feel suicidal', 'I don’t want to be here anymore', 'everyone would be better off without me', 'I see no reason to live', 'sometimes I think about ending my life', 'I have started to self-harm again', 'I wish I were dead']
    .forEach((t) => assert.ok(HZ.looksLikeCrisis(t), 'caught: ' + t));
  ['I do not want to die without building something', 'I never want to die', 'Nobody wants to die alone', 'I wanted to die of embarrassment', 'I think about suicide rates in cities and what they say about loneliness', 'I should cut myself some slack', 'I keep hurting myself by overcommitting', 'Deadlines are killing me', 'This plan is dead on arrival', '']
    .forEach((t) => assert.ok(!HZ.looksLikeCrisis(t), 'left alone: ' + t));
});

test('a crisis is answered, never mapped', () => {
  const s = HZ.newState(NOW), t = 'Work is fine I guess. Some days I want to end my life. My father always said finish what you start.';
  const off = HZ.offlineDaily(s, t, NOW);
  assert.strictEqual(off.care, true); assert.deepStrictEqual(off.units, []);
  const res = HZ.normalizeDaily(off, s, t);
  assert.strictEqual(res.care, true); assert.deepStrictEqual(res.units, []); assert.ok(res.move.body.includes('someone you trust'));
  assert.ok(!res.move.bet && !res.move.concept && !res.door && !res.takeTo, 'no game furniture');
  // the person says it is not about them: the built-in reader then reads it like anything else
  const plain = HZ.normalizeDaily(HZ.offlineDaily(s, t, NOW, { noCare: true }), s, t);
  assert.ok(!plain.care && plain.units.length >= 2);
  // from a model: the flag wins over anything else in the reply, and its own words are used
  const m = HZ.normalizeDaily({ care: true, units: [{ text: 'Some days I want to end my life' }], links: [], move: { kind: 'bet', title: 'I hear you', body: 'That sounds heavy. Please reach someone today.', bet: { about: 'new:0', text: 'x', due_days: 3 } }, door: 'A question', take_to_person: 'Another' }, s, t);
  assert.strictEqual(m.care, true); assert.deepStrictEqual(m.units, []);
  assert.deepStrictEqual([m.move.kind, m.move.title, m.move.body, m.move.bet, m.door, m.takeTo], ['door', 'I hear you', 'That sounds heavy. Please reach someone today.', null, '', '']);
  assert.strictEqual(HZ.normalizeDaily({ care: true }, s, t).move.body, HZ.CARE.body, 'an empty caring reply falls back to the fixed words');
  assert.ok(!HZ.normalizeDaily({ care: 'true', units: [{ text: 'Work is fine I guess' }], move: { kind: 'door', body: 'x' } }, s, t).care, 'only a real true counts');
  assert.strictEqual(s.entries.length, 0, 'nothing was applied to the map in any of this');
  const p = HZ.dailyPrompt(s, t, { now: NOW });
  assert.ok(p.includes('"care":false') && p.includes('Set "care": true at the top level'));
  const p2 = HZ.dailyPrompt(s, t, { now: NOW, notAtRisk: true });
  assert.ok(p2.includes('says this entry is not about them being at risk') && !p2.includes('Set "care": true at the top level'));
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : ''));
