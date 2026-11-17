/* A stand-in for the model, for tests. It answers the app's prompts the way a model would: quotes of the
   entry, one reworded guess, links to existing ids, and a move kind that rotates. Used in the page by
   test/mock-claude.js (the Claude runtime stand-in) and in Node by test/fake-api.js (the API stand-in). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.__fakeModel = factory;
})(typeof self !== 'undefined' ? self : this, function (HZ) {
  var turn = 0;
  function between(prompt) { var m = /"""\n([\s\S]*?)\n"""\s*$/.exec(prompt); return m ? m[1] : ''; }
  function fakeDaily(prompt) {
    var entry = between(prompt), isExp = prompt.indexOf('THE INTERVIEW') !== -1;
    // a real model judges this from the whole entry; the stand-in uses the same short phrase list as the built-in reader
    if (HZ.looksLikeCrisis(entry) && prompt.indexOf('is not about them being at risk') === -1) return { care: true, units: [], links: [], move: { kind: 'door', title: 'This sounds very heavy', body: 'I am taking what you wrote seriously. Please reach someone you trust today, or a crisis line. If you might act on it, call your local emergency number now.', refs: [] }, door: '', take_to_person: '' };
    var source = isExp ? entry.split('\n').filter(function (l) { return l.indexOf('A: ') === 0; }).map(function (l) { return l.slice(3); }).join(' ') : entry;
    var sents = source.split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 12; }).slice(0, 3);
    var existing = (prompt.match(/^u[0-9a-z]+ \|/gm) || []).map(function (s) { return s.split(' ')[0]; });
    var probe = HZ.newState();
    var units = sents.map(function (s) { var o = HZ.offlineDaily(probe, s).units[0] || { type: 'belief', region: 'self', conviction: 3, origin: 'unknown', lens: {} }; return { type: o.type, label: HZ.makeLabel(s), text: s.replace(/[.!?]+$/, ''), region: o.region, conviction: o.conviction, origin: o.origin, lens: o.lens }; });
    if (units.length) units.push({ type: 'belief', label: 'An unstated assumption', text: 'Underneath this is the assumption that effort is always rewarded', region: 'meaning', conviction: 3, origin: 'reasoned', lens: { language: 0.8, minds: 0.2, places: 0, body: 0, sound: 0, vision: 0 } });
    var links = existing.length && units.length ? [{ from: 'new:0', to: existing[0], kind: turn % 2 ? 'contradicts' : 'because' }] : [];
    var kinds = ['bet', 'name_it', 'rift', 'counter', 'bridge', 'door'], kind = kinds[turn % kinds.length]; turn++;
    if ((kind === 'rift' || kind === 'bridge') && !existing.length) kind = 'counter';
    var move = { kind: kind, title: { bet: 'Put it to a test', name_it: 'This has a name', rift: 'These two pull apart', counter: 'The case against', bridge: 'You have said this before', door: 'A region still under fog' }[kind], body: 'You said "' + (units[0] ? units[0].text : entry.slice(0, 60)) + '". Here is what follows from that, in plain words. It is one thing to say it and another to see it hold.', refs: units.length ? ['new:0'].concat(existing.slice(0, 1)) : [], concept: null, bet: null, door_region: 'meaning' };
    if (kind === 'name_it') move.concept = { name: ['Survivorship bias', 'The map is not the territory', 'Dichotomy of control'][Math.floor(turn / 6) % 3], gist: 'We judge by the cases that made it through and forget the ones that did not.', disputed_by: 'Some statisticians say the term is overused for ordinary selection effects.', about: 'new:0' };
    if (kind === 'bet') move.bet = { about: 'new:0', text: 'By next Friday, at least one thing I expected to slip will have slipped', due_days: 7 };
    return { units: units, links: links, move: move, door: 'What would change your mind about this?', door_region: 'meaning', take_to_person: 'When did you last change your mind about something that mattered?' };
  }
  function answer(prompt) {
    if (prompt.indexOf('JOB 1.') !== -1) return fakeDaily(prompt);
    if (prompt.indexOf('strongest opposing view') !== -1) return { who: 'Daniel Kahneman', argument: 'What feels like insight is often a story built after the fact. Confidence tracks how coherent the story is, not how true it is.', question: 'How would you know if you were wrong here?' };
    if (prompt.indexOf('five-minute interview') !== -1) return { questions: ['What is the first thing that comes to mind here?', 'Tell me about one time it mattered.', 'What did you believe about it at twenty?', 'What do you avoid thinking about here?', 'What would you bet on?'] };
    if (prompt.indexOf('PERSON B') !== -1) return { shared: { a: 0, b: 0, note: 'You both think people are slow to change, though you get there differently.', ask: 'What is one thing each of you has actually changed your mind about?' }, disagreement: { a: 1, b: 4, note: 'One of you treats money as time, the other as proof.', ask: 'What would you each do with a year of free time?' }, door: { region: 'nature', note: 'Neither of you has said anything about how the physical world works.', ask: 'What is something about nature that still surprises you both?' } };
    return {};
  }
  return { answer: answer };
});
