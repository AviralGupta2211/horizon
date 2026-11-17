/* A lived-in world for visual checks: a few weeks of entries with depth, bets, a rift and a concept. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../js/core.js'));
  else root.HZFixture = factory(root.HZ);
})(typeof self !== 'undefined' ? self : this, function (HZ) {
  return function build(days) {
    var NOW = new Date(2026, 10, 15, 9, 0, 0), s = HZ.newState(HZ.addDays(NOW, -days));
    var bank = [
      'I think people mostly want to be seen. My mother always said trust takes years to build and seconds to lose.',
      'Money is just stored time. Markets reward patience more than cleverness, I am fairly sure of that.',
      'Good design should feel obvious after the fact. I remember when we shipped the first sign-up flow and nobody needed help.',
      'Maybe death is what makes any of this matter. Why do I care so much about legacy?',
      'Music is the closest thing I know to a shared mind. Travel should change what you think is normal.',
      'Cities are machines for meeting strangers. The government never moves as fast as culture does.',
      'The brain is not a camera, it is a guess. Evolution does not care whether we are happy.',
      'I never feel more like myself than when I am building something. Sleep is not optional for clear thinking.',
      'Talent is mostly somebody who stayed with it longer. A team should argue in the open, never in corridors.',
      'Power definitely hides in who gets to set the agenda. I once watched a founder lose a company by avoiding one conversation.',
      'A good life is being useful to a few people who know you well. I wonder whether freedom and belonging can ever fully coexist?',
      'Mountains make my problems the right size. Games teach rules better than lectures do.'
    ];
    for (var d = 0; d < days; d++) {
      var t = bank[d % bank.length] + (d >= bank.length ? ' On day ' + d + ' I noticed that ' + ['walls', 'rivers', 'songs', 'debts', 'votes', 'atoms', 'gods', 'games'][d % 8] + ' shape more of my thinking than I admit.' : '');
      var when = HZ.addDays(NOW, d - days + 1);
      HZ.applyDaily(s, t, HZ.normalizeDaily(HZ.offlineDaily(s, t, when), s, t), { now: when });
    }
    var yours = s.units.filter(function (u) { return u.status === 'yours'; });
    function pick(i) { return yours[i % yours.length]; }
    HZ.explain(s, pick(0).id, 'Because every time someone felt ignored, they left', NOW);
    HZ.exemplify(s, pick(0).id, 'A customer once told me the only thing she remembered was that someone knew her name', NOW);
    HZ.explain(s, pick(2).id, 'It compounds, and you cannot hurry it', NOW);
    HZ.answerChallenge(s, pick(4).id, { who: 'Dieter Rams', argument: 'Obvious is not the same as good.' }, 'Obvious is the floor, not the ceiling', NOW);
    HZ.explain(s, pick(4).id, 'Nobody reads instructions', NOW); HZ.exemplify(s, pick(4).id, 'The sign-up flow had no help text at all and support tickets dropped', NOW);
    var b1 = HZ.addBet(s, pick(3).id, 'By Friday the patient fund will have beaten the clever one this quarter', 3, HZ.addDays(NOW, -5));
    HZ.resolveBet(s, b1.id, 'held', '', NOW);
    HZ.addBet(s, pick(6).id, 'Within a week I will meet someone new in the city without trying', 6, NOW);
    var b3 = HZ.addBet(s, pick(9).id, 'The policy will lag the trend by a year', 2, HZ.addDays(NOW, -4));
    HZ.resolveBet(s, b3.id, 'failed', '', NOW);
    if (yours.length > 12) {
      s.links.push({ id: 'lx1', a: pick(1).id, b: pick(11).id, kind: 'contradicts', at: HZ.iso(NOW), state: 'open' });
      s.links.push({ id: 'lx2', a: pick(5).id, b: pick(8).id, kind: 'same_as', at: HZ.iso(NOW) });
    }
    var cu = pick(7);
    s.concepts.push({ id: 'cx1', name: 'Predictive processing', gist: 'The brain constantly predicts its inputs and corrects itself with what the senses report.', disputed: 'Critics say the theory is flexible enough to fit any result.', unit: cu.id, at: HZ.iso(NOW), pos: HZ.placeNear(s, cu.pos, 1, 2, 'cx1') });
    var out = s.units[s.units.length - 2]; if (out) out.status = 'outline';
    return s;
  };
});
