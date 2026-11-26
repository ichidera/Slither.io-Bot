/* Slither.io Trainer Panel
 * ------------------------------------------------------------------
 * Injects a small control panel into an already-running slither.io tab
 * and steers the snake that is currently on screen.
 *
 * It never launches a browser, never navigates, never clicks Play and
 * never reconnects. If there is no live snake, it waits or arms for the
 * next run that the user starts manually.
 *
 * Usage: open https://slither.io, start a run, then paste this file in
 * the DevTools console (or install trainer.user.js with Tampermonkey).
 * Click "Take over". Click "Release" (or Alt+Shift+X) to give control
 * back immediately.
 *
 * The panel lives in a shadow root so the game's CSS cannot reach it.
 * While takeover is active it:
 *   - writes window.xm / window.ym (screen-centre offsets);
 *   - writes window.slither.wmd (boost) and window.wmd for older clients;
 *   - temporarily replaces the game's mouse/touch handlers;
 *   - blocks game input events outside the panel.
 * On release it restores the handlers it replaced.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  if (window.__slitherTrainer && window.__slitherTrainer.version) {
    console.info('[trainer] already installed');
    return;
  }

  var VERSION = '0.2.1';
  var STORAGE_KEY = 'slitherTrainer.settings.v1';
  var TAU = Math.PI * 2;

  // ---- planner tunables ------------------------------------------------
  // The planner is a risk-adjusted expected-value search. Survival is a hard
  // constraint; growth and kills are scored only on paths that stay clear.
  var TUNE = {
    HORIZON: 1.4,          // rollout seconds
    STEPS: 15,             // rollout samples
    CONTROL_LAG: 0.24,     // server/control delay before a new turn applies
    EMERGENCY_LAG: 0.04,   // panic turn when a head-on collision is imminent
    TURN_RATE: 4.125,      // rad/s, matches the client's base turn rate
    SPEED_MULT: 31.25,     // world units/s per sp unit
    SPEED_MIN: 120,
    BOOST_SPEED: 430,
    COARSE_N: 24,          // headings over the full circle
    FINE_N: 14,            // headings around the previous choice
    FINE_SPAN: 0.85,       // radians
    ULTRA_N: 8,            // final local refinement around the winner
    ULTRA_SPAN: 0.20,      // radians
    THREAT_RANGE: 2400,    // detect every visible snake inside this radius
    THREAT_POINTS: 64,     // local body points kept per enemy
    THREAT_TOTAL: 460,     // global body-point budget for 60 fps
    HEAD_MARGIN: 26,
    HEAD_TURN_RATE: 2.2,   // how fast an enemy is assumed to turn at us
    HEAD_PREDICT: 0.42,    // seconds of enemy-head motion used by the rollout
    HUNT_HEAD_TURN: 0.6,   // target noses are assumed to keep their line longer
    HEAD_WEIGHT: 2.2,      // clearance reward for keeping away from a nose
    ESCAPE_BIAS: 20,       // directional nudge toward the committed escape line
    SELF_SKIP: 95,         // do not treat our own neck as an obstacle
    SELF_POINTS: 120,      // local self body points kept
    BODY_HALF: 14.5,       // rendered half-width at sc = 1
    WALL_MARGIN: 360,
    WALL_HARD: 80,
    FOOD_RANGE: 900,
    FOOD_REACH: 280,
    FOOD_POINTS: 48,
    FOOD_RADAR_POINTS: 90,
    FOOD_WEIGHT: 18,
    FOOD_LANE_WEIGHT: 7,
    CORPSE_RADIUS: 280,
    CORPSE_MS: 10000,
    CORPSE_WEIGHT: 8,
    DANGER_CLEAR: 18,
    BOOST_CLEAR: 10,
    BOOST_MS: 340,
    BOOST_COOLDOWN: 1300,
    CUT_BOOST_MS: 260,
    CUT_BOOST_COOLDOWN: 4200,
    PREV_BONUS: 10,
    RADAR_RANGE: 2000,
    HUNT_MIN_LEN: 18,
    HUNT_MAX_RATIO: 0.85,
    HUNT_MIN_DIST: 90,
    HUNT_MAX_DIST: 760,
    HUNT_CROWD_RADIUS: 520,
    HUNT_MAX_CROWD: 1,
    HUNT_LOCK_MS: 3200,
    HUNT_STANDOFF: 90,
    HUNT_BONUS: 90,
    CHASE_BONUS: 220,
    HUNT_BODY_BONUS: 65,
    HUNT_FOOD_SCALE: 0.35,
    HUNT_CLEAR_CAP: 26,
    SAFE_BONUS: 2000,
    UNSAFE_PENALTY: 2000
  };

  var DEFAULT_SETTINGS = {
    safety: 18,
    foodPull: 1,
    hunt: true,
    aggression: 1,
    radarRange: 2000,
    boostEscape: true,
    autoArm: true,
    x: null,
    y: null
  };

  // ---- small helpers ---------------------------------------------------
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function normAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }

  function angleDiff(target, current) {
    return normAngle(target - current);
  }

  function dist2(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return dx * dx + dy * dy;
  }

  function fmt(v) {
    return (v === null || v === undefined || !isFinite(v)) ? '\u2013' : String(Math.round(v));
  }

  function loadSettings() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (e) {}
    var s = {};
    for (var k in DEFAULT_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) {
        s[k] = (saved[k] === undefined) ? DEFAULT_SETTINGS[k] : saved[k];
      }
    }
    s.safety = clamp(num(s.safety, DEFAULT_SETTINGS.safety), 4, 40);
    s.foodPull = clamp(num(s.foodPull, DEFAULT_SETTINGS.foodPull), 0, 2);
    s.hunt = (s.hunt === undefined) ? DEFAULT_SETTINGS.hunt : !!s.hunt;
    s.aggression = clamp(num(s.aggression, DEFAULT_SETTINGS.aggression), 0, 2);
    s.radarRange = clamp(num(s.radarRange, DEFAULT_SETTINGS.radarRange), 800, TUNE.THREAT_RANGE);
    s.boostEscape = !!s.boostEscape;
    s.autoArm = !!s.autoArm;
    s.x = (s.x === null || s.x === undefined || s.x === '') ? null : num(s.x, null);
    s.y = (s.y === null || s.y === undefined || s.y === '') ? null : num(s.y, null);
    return s;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        safety: state.settings.safety,
        foodPull: state.settings.foodPull,
        hunt: state.settings.hunt,
        aggression: state.settings.aggression,
        radarRange: state.settings.radarRange,
        boostEscape: state.settings.boostEscape,
        autoArm: state.settings.autoArm,
        x: state.settings.x,
        y: state.settings.y
      }));
    } catch (e) {}
  }

  // ---- state -----------------------------------------------------------
  var state = {
    settings: loadSettings(),
    takeover: false,
    armed: false,
    hidden: false,
    minimized: false,
    sessionId: null,
    mode: 'idle',
    heading: 0,
    clearance: null,
    threats: 0,
    boost: false,
    fps: 0,
    frames: 0,
    fpsAt: 0,
    lastUiAt: 0,
    lastRadarAt: 0,
    boostUntil: 0,
    boostCooldownUntil: 0,
    cutBoostCooldownUntil: 0,
    chaseUntil: 0,
    escapeHeading: null,
    escapeThreatId: null,
    escapeUntil: 0,
    danger: 0,
    nearest: null,
    huntTargetId: null,
    huntTarget: null,
    huntUntil: 0,
    kills: 0,
    corpse: null,
    deadIds: {},
    snapshot: null
  };

  // ---- game-state readers ---------------------------------------------
  function liveSelf() {
    var me = window.slither;
    if (!me) return null;
    if (num(me.id, -1) <= 0) return null;
    if (!window.playing) return null;
    if (!isFinite(num(me.xx, NaN)) || !isFinite(num(me.yy, NaN))) return null;
    return me;
  }

  function displayScore(me) {
    try {
      var k = Math.max(0, Math.floor(num(me.sct, 0) + num(me.rsc, 0)));
      var fam = num(me.fam, 0);
      var a = window.fpsls ? num(window.fpsls[k], 0) : 0;
      var b = window.fmlts ? num(window.fmlts[k], 1) : 1;
      if (!a || !b) return null;
      return Math.floor((a + fam / b - 1) * 15 - 5);
    } catch (e) {
      return null;
    }
  }

  function arenaInfo() {
    var a = num(window.flux_grd, 0);
    var b = num(window.real_flux_grd, 0);
    var r = Infinity;
    if (a > 100) r = Math.min(r, a);
    if (b > 100) r = Math.min(r, b);
    if (!isFinite(r)) r = 4500;
    var c = num(window.grd, 16384);
    return { cx: c, cy: c, r: r };
  }

  function snakeRadius(s) {
    var sc = clamp(num(s.sc, 1), 0.5, 8);
    return TUNE.BODY_HALF * sc;
  }

  // Bounded max-heap of body candidates. The heap keeps the closest
  // THREAT_POINTS points per snake without sorting or retaining the rest.
  function bodyHeapPush(heap, item) {
    heap.push(item);
    var i = heap.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (heap[parent].d2 >= item.d2) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  }

  function bodyHeapReplace(heap, item) {
    heap[0] = item;
    var i = 0;
    for (;;) {
      var left = i * 2 + 1;
      var right = left + 1;
      var largest = i;
      if (left < heap.length && heap[left].d2 > heap[largest].d2) largest = left;
      if (right < heap.length && heap[right].d2 > heap[largest].d2) largest = right;
      if (largest === i) break;
      var tmp = heap[i];
      heap[i] = heap[largest];
      heap[largest] = tmp;
      i = largest;
    }
  }

  function collectThreats(me, now) {
    now = now || performance.now();
    var points = [];
    var heads = [];
    var snakes = [];
    var bodies = {};
    var bodyNear = {};
    var meId = String(me.id);
    var range = TUNE.THREAT_RANGE;
    var range2 = range * range;
    var bodyRange2 = (range * 1.05) * (range * 1.05);
    var list = Array.isArray(window.slithers) ? window.slithers : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s === me || String(s.id) === meId) continue;
      if (num(s.id, -1) <= 0) continue;
      var sx = num(s.xx, NaN);
      var sy = num(s.yy, NaN);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      var d2 = dist2(sx, sy, me.xx, me.yy);
      var headNear = d2 <= range2;
      if (!headNear && !Array.isArray(s.pts)) continue;

      // A visible death is the only reliable kill confirmation. It also
      // creates a short-lived feast site, because a large snake drops a lot
      // of food around its head.
      if (s.dead) {
        var deadKey = String(s.id);
        if (!state.deadIds[deadKey]) {
          state.deadIds[deadKey] = 1;
          if (String(state.huntTargetId) === deadKey || d2 < 900 * 900) {
            state.kills++;
            state.corpse = {
              x: sx, y: sy, until: now + TUNE.CORPSE_MS, source: 'kill'
            };
          }
        }
        continue;
      }

      var r = snakeRadius(s);
      var ang = num(s.ang, 0);
      var speed = Math.max(0, num(s.sp, 0)) * TUNE.SPEED_MULT;
      var boost = !!(s.wmd || s.md) || speed > 300;
      var headR = r + TUNE.HEAD_MARGIN + Math.min(20, speed * 0.045);
      if (headNear) {
        var head = {
          x: sx, y: sy, r: headR, head: true, id: s.id,
          d: Math.sqrt(d2), ang: ang, speed: speed, boost: boost,
          sct: Math.max(0, num(s.sct, 0)), sc: clamp(num(s.sc, 1), 0.5, 8),
          s: s
        };
        heads.push(head);
        // The head is also a static obstacle at its current position. The
        // moving prediction below covers the near future; keeping the current
        // capsule closes the gap at t=0.
        points.push({ x: sx, y: sy, r: headR, head: true, id: s.id, hunt: false });
        snakes.push({
          id: String(s.id), head: head, d: head.d, sct: head.sct,
          sc: head.sc, speed: speed, boost: boost, x: sx, y: sy,
          ang: ang, r: headR, s: s
        });
      }

      // Keep the closest local body points. A long snake can cross the
      // player while its head is outside the threat radius, so body
      // collection is independent of head distance. The bounded max-heap
      // guarantees that the nearest points survive the per-snake budget even
      // when a long trail coils through the area hundreds of points deep.
      var pts = Array.isArray(s.pts) ? s.pts : [];
      var heap = [];
      var nearD2 = Infinity;
      for (var j = pts.length - 1; j >= 0; j--) {
        var p = pts[j];
        if (!p || p.dying) continue;
        var px = num(p.xx, NaN);
        var py = num(p.yy, NaN);
        if (!isFinite(px) || !isFinite(py)) continue;
        var pd2 = dist2(px, py, me.xx, me.yy);
        if (pd2 > bodyRange2) continue;
        if (pd2 < nearD2) nearD2 = pd2;
        if (heap.length < TUNE.THREAT_POINTS) {
          bodyHeapPush(heap, { x: px, y: py, d2: pd2 });
        } else if (pd2 < heap[0].d2) {
          bodyHeapReplace(heap, { x: px, y: py, d2: pd2 });
        }
      }
      if (heap.length) {
        heap.sort(function (a, b) { return a.d2 - b.d2; });
        var body = [];
        for (var k = 0; k < heap.length; k++) {
          body.push({
            x: heap[k].x, y: heap[k].y, r: r + 3,
            head: false, id: s.id, hunt: false
          });
        }
        var key = String(s.id);
        bodies[key] = body;
        bodyNear[key] = nearD2;
      }
    }
    return {
      points: points,
      headPoints: points,
      heads: heads,
      snakes: snakes,
      bodies: bodies,
      bodyNear: bodyNear
    };
  }

  // Build the body obstacle list for one planner tick. The selected target
  // gets its body points first, then the remaining bodies are added nearest
  // first. This prevents a crowded scene from silently dropping the body of
  // the snake the planner is actually hunting.
  function buildBodyPoints(threats, targetId) {
    var out = [];
    var ids = [];
    var seen = {};
    var id;
    if (targetId !== null && targetId !== undefined && threats.bodies[targetId]) {
      ids.push(targetId);
      seen[targetId] = true;
    }
    var rest = [];
    for (id in threats.bodies) {
      if (!Object.prototype.hasOwnProperty.call(threats.bodies, id)) continue;
      if (seen[id]) continue;
      rest.push(id);
    }
    rest.sort(function (a, b) {
      var da = threats.bodyNear[a];
      var db = threats.bodyNear[b];
      if (da === undefined) da = Infinity;
      if (db === undefined) db = Infinity;
      return da - db;
    });
    ids = ids.concat(rest);
    for (var i = 0; i < ids.length && out.length < TUNE.THREAT_TOTAL; i++) {
      var body = threats.bodies[ids[i]];
      for (var j = 0; j < body.length && out.length < TUNE.THREAT_TOTAL; j++) {
        out.push(body[j]);
      }
    }
    return out;
  }

  function collectSelfBody(me) {
    var pts = Array.isArray(me.pts) ? me.pts : [];
    var r = snakeRadius(me);
    var out = [];
    if (!pts.length) return out;
    var skip2 = TUNE.SELF_SKIP * TUNE.SELF_SKIP;
    var range2 = 1400 * 1400;
    // Walk from the head end so a coiled snake is covered close to the
    // head first. Every local point is kept (no stride holes).
    for (var i = pts.length - 1; i >= 0 && out.length < TUNE.SELF_POINTS; i--) {
      var p = pts[i];
      if (!p || p.dying) continue;
      var px = num(p.xx, NaN);
      var py = num(p.yy, NaN);
      if (!isFinite(px) || !isFinite(py)) continue;
      var d2 = dist2(px, py, me.xx, me.yy);
      if (d2 < skip2 || d2 > range2) continue;
      out.push({ x: px, y: py, r: r + 2, head: false, self: true });
    }
    return out;
  }

  function collectFoods(me, range, limit) {
    range = clamp(num(range, TUNE.FOOD_RANGE), 200, TUNE.THREAT_RANGE * 1.1);
    limit = Math.max(8, Math.floor(num(limit, TUNE.FOOD_POINTS)));
    var list = Array.isArray(window.foods) ? window.foods : [];
    var range2 = range * range;
    var out = [];
    var corpse = state.corpse && performance.now() < state.corpse.until ? state.corpse : null;
    var corpse2 = TUNE.CORPSE_RADIUS * TUNE.CORPSE_RADIUS;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var fx = num(f.xx, NaN);
      var fy = num(f.yy, NaN);
      if (!isFinite(fx) || !isFinite(fy)) continue;
      var d2 = dist2(fx, fy, me.xx, me.yy);
      if (d2 > range2) continue;
      var sz = Math.max(1, num(f.sz, 1));
      // A normal pellet is a small snack; a big corpse pellet is worth a
      // detour. This is deliberately super-linear in size.
      var w = 0.6 + Math.min(14, sz * 0.9);
      var isCorpse = !!(corpse && dist2(fx, fy, corpse.x, corpse.y) < corpse2);
      if (isCorpse) w *= TUNE.CORPSE_WEIGHT;
      out.push({ x: fx, y: fy, sz: sz, w: w, d2: d2, corpse: isCorpse });
    }
    // Rank by distance discounted by value, so a nearby feast does not get
    // buried under a cloud of one-point pellets.
    out.sort(function (a, b) {
      return (a.d2 / (1 + a.w * 0.35)) - (b.d2 / (1 + b.w * 0.35));
    });
    return out.slice(0, limit);
  }

  function detectCorpse(foods, now) {
    if (state.corpse && now < state.corpse.until) return;
    var big = [];
    for (var i = 0; i < foods.length; i++) {
      var f = foods[i];
      if (f.sz >= 6 && f.d2 < 1300 * 1300) big.push(f);
    }
    if (big.length < 5) return;
    var best = null;
    for (var c = 0; c < big.length; c++) {
      var count = 0;
      var total = 0;
      for (var k = 0; k < big.length; k++) {
        if (dist2(big[c].x, big[c].y, big[k].x, big[k].y) < TUNE.CORPSE_RADIUS * TUNE.CORPSE_RADIUS) {
          count++;
          total += big[k].sz;
        }
      }
      if (count >= 5 && total >= 55 && (!best || total > best.total)) {
        best = { x: big[c].x, y: big[c].y, total: total, count: count };
      }
    }
    if (best) {
      state.corpse = {
        x: best.x, y: best.y, until: now + TUNE.CORPSE_MS, source: 'cluster'
      };
      state.lastKillAt = now;
    }
  }

  // ---- planner ---------------------------------------------------------
  function angleBlend(a, b, t) {
    t = clamp(t, 0, 1);
    var x = Math.cos(a) * (1 - t) + Math.cos(b) * t;
    var y = Math.sin(a) * (1 - t) + Math.sin(b) * t;
    return Math.atan2(y, x);
  }

  function chooseHuntSide(me, target, arena, heads) {
    var centerAng = Math.atan2(arena.cy - me.yy, arena.cx - me.xx);
    function scoreSide(sign) {
      var a = target.ang + sign * Math.PI / 2;
      var score = Math.cos(angleDiff(a, centerAng)) * 0.8;
      for (var i = 0; i < heads.length; i++) {
        var h = heads[i];
        if (String(h.id) === String(target.id)) continue;
        var d = Math.sqrt(dist2(me.xx, me.yy, h.x, h.y));
        if (d > 900) continue;
        var ha = Math.atan2(h.y - me.yy, h.x - me.xx);
        score -= Math.max(0, Math.cos(angleDiff(a, ha))) * (1 - d / 900) * 1.5;
      }
      return score;
    }
    return scoreSide(1) >= scoreSide(-1) ? 1 : -1;
  }

  // Time-to-collision model. This is what stops the trainer from treating
  // every visible head as a reason to flee. A head that is moving away or
  // passing wide is not a threat, even if it is close.
  function assessDanger(me, threats, arena, excludeId) {
    var heads = threats.heads;
    var level = 0;
    var urgent = false;
    var nearest = null;
    var crowd = 0;
    var chaseThreat = false;
    var selfSpeed = Math.max(TUNE.SPEED_MIN, num(me.sp, 5.5) * TUNE.SPEED_MULT);
    var selfAng = num(me.ang, 0);
    var svx = Math.cos(selfAng) * selfSpeed;
    var svy = Math.sin(selfAng) * selfSpeed;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      if (excludeId !== undefined && excludeId !== null && String(h.id) === String(excludeId)) continue;
      var dx = h.x - me.xx;
      var dy = h.y - me.yy;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (!nearest || d < nearest.d) {
        nearest = {
          x: h.x, y: h.y, d: d, ang: h.ang, speed: h.speed,
          sct: h.sct, boost: h.boost, id: h.id
        };
      }
      if (d < 620) crowd++;
      if (d > TUNE.THREAT_RANGE) continue;
      var nx = dx / Math.max(1, d);
      var ny = dy / Math.max(1, d);
      var evx = Math.cos(h.ang) * h.speed;
      var evy = Math.sin(h.ang) * h.speed;
      var rvx = evx - svx;
      var rvy = evy - svy;
      var dot = nx * rvx + ny * rvy;
      var closing = -dot;
      var cpa = d;
      var ttc = Infinity;
      var rel2 = rvx * rvx + rvy * rvy;
      if (rel2 > 1) {
        cpa = Math.sqrt(Math.max(0, d * d - dot * dot));
        if (closing > 10) ttc = d / closing;
      }
      var t = 0;
      if (closing > 15 && ttc < 1.35) {
        t += ((1.35 - ttc) / 1.35) * clamp(1 - cpa / 520, 0, 1);
      }
      if (d < 260) t += ((260 - d) / 260) * 0.55;
      // A faster snake sitting behind us is a real threat even when the
      // instantaneous closing speed is low: it can follow and eventually
      // catch up. React before it is already on our tail.
      var toEnemy = Math.atan2(dy, dx);
      var behind = Math.cos(angleDiff(toEnemy, selfAng)) < -0.25;
      if (behind && h.speed > selfSpeed * 1.03 && d < 1000) {
        chaseThreat = true;
        var catchT = d / Math.max(1, h.speed - selfSpeed);
        var chase = clamp(1 - catchT / 30, 0, 1) * 0.55 +
          clamp(1 - d / 1000, 0, 1) * 0.25;
        if (chase > t) t = chase;
      }
      if (h.boost) t *= 1.3;
      if (h.sct > num(me.sct, 0) * 1.15) t *= 1.12;
      if (t > level) level = t;
      if (t > 0.62) urgent = true;
      if (closing > 30 && cpa < 80 && ttc < 0.95) urgent = true;
      if (d < 130) urgent = true;
    }
    if (crowd > 3) level += (crowd - 3) * 0.12;
    if (crowd > 6) urgent = true;
    var wd = Math.sqrt(dist2(me.xx, me.yy, arena.cx, arena.cy));
    var wall = arena.r - wd;
    if (wall < TUNE.WALL_MARGIN + 200) {
      level += ((TUNE.WALL_MARGIN + 200 - wall) / (TUNE.WALL_MARGIN + 200)) * 0.55;
    }
    if (wall < TUNE.WALL_MARGIN) urgent = true;
    return {
      level: clamp(level, 0, 1.5), urgent: urgent, nearest: nearest,
      crowd: crowd, wall: wall, chase: chaseThreat
    };
  }

  function selectHuntTarget(me, threats, arena, now) {
    if (!state.settings.hunt || state.settings.aggression <= 0) {
      state.huntTargetId = null;
      state.huntTarget = null;
      return null;
    }
    var selfLen = Math.max(0, num(me.sct, 0));
    if (selfLen < TUNE.HUNT_MIN_LEN) {
      state.huntTargetId = null;
      state.huntTarget = null;
      return null;
    }
    var selfSpeed = Math.max(TUNE.SPEED_MIN, num(me.sp, 5.5) * TUNE.SPEED_MULT);
    var byId = {};
    var i;
    for (i = 0; i < threats.snakes.length; i++) {
      byId[threats.snakes[i].id] = threats.snakes[i];
    }
    var current = state.huntTargetId ? byId[String(state.huntTargetId)] : null;
    if (current && now < state.huntUntil && current.d < TUNE.HUNT_MAX_DIST * 1.3 &&
        current.sct <= selfLen * 0.95) {
      state.huntTarget = current;
      return current;
    }

    var aggression = clamp(num(state.settings.aggression, 1), 0, 2);
    var maxRatio = TUNE.HUNT_MAX_RATIO + (aggression - 1) * 0.12;
    var maxDist = TUNE.HUNT_MAX_DIST * (0.85 + aggression * 0.15);
    var maxCrowd = TUNE.HUNT_MAX_CROWD + (aggression > 1.5 ? 1 : 0);
    var best = null;
    for (i = 0; i < threats.snakes.length; i++) {
      var s = threats.snakes[i];
      if (s.sct < 4 || s.sct > selfLen * maxRatio) continue;
      if (s.d < TUNE.HUNT_MIN_DIST || s.d > maxDist) continue;
      if (s.boost && s.d > 260) continue;
      var crowd = 0;
      for (var k = 0; k < threats.heads.length; k++) {
        var h = threats.heads[k];
        if (String(h.id) === s.id) continue;
        if (dist2(h.x, h.y, s.x, s.y) < TUNE.HUNT_CROWD_RADIUS * TUNE.HUNT_CROWD_RADIUS) crowd++;
      }
      if (crowd > maxCrowd) continue;
      var targetWall = arena.r - Math.sqrt(dist2(s.x, s.y, arena.cx, arena.cy));
      if (targetWall < 360) continue;
      var toTarget = Math.atan2(s.y - me.yy, s.x - me.xx);
      var away = Math.cos(angleDiff(s.ang, toTarget));
      // A smaller snake running directly away at the same speed cannot be
      // caught without a risky boost. Ignore it and look for a crossing.
      if (away > 0.55 && s.speed >= selfSpeed * 0.9) continue;
      var ratio = s.sct / Math.max(1, selfLen);
      var score = 50 + s.sct * 1.4 + (maxDist - s.d) * 0.045 -
        ratio * 28 - crowd * 26 - (s.boost ? 35 : 0);
      score += Math.cos(angleDiff(toTarget, me.ang)) * 10;
      score *= 0.75 + aggression * 0.25;
      if (!best || score > best.score) {
        best = {
          id: s.id, head: s.head, d: s.d, sct: s.sct, sc: s.sc,
          speed: s.speed, boost: s.boost, x: s.x, y: s.y, ang: s.ang,
          r: s.head.r, s: s.s, score: score
        };
      }
    }
    if (best) {
      state.huntTargetId = best.id;
      state.huntUntil = now + TUNE.HUNT_LOCK_MS;
      state.huntTarget = best;
      return best;
    }
    state.huntTargetId = null;
    state.huntTarget = null;
    return null;
  }

  function evaluatePath(me, targetHeading, ctx) {
    var steps = TUNE.STEPS;
    var dt = TUNE.HORIZON / steps;
    var lagSteps = (ctx.emergency ? TUNE.EMERGENCY_LAG : TUNE.CONTROL_LAG) / dt;
    var turnRate = TUNE.TURN_RATE *
      clamp(num(me.scang, 1), 0.13, 1.2) *
      clamp(num(me.spang, 1), 0.7, 1.25);
    var maxTurn = turnRate * dt;
    var startAng = num(me.ang, 0);
    var preAng = num(me.eang, state.heading);
    var x = num(me.xx, 0);
    var y = num(me.yy, 0);
    var h = startAng;
    var minClear = 999;
    var minWall = 999;
    var score = 0;
    var path = [];
    var obstacles = ctx.obstacles;
    var heads = ctx.heads;
    var arena = ctx.arena;
    var selfR = ctx.selfR;
    var safety = ctx.safety;
    var speed = ctx.speed;
    var i;
    var j;

    for (i = 1; i <= steps; i++) {
      var desired = (i <= lagSteps) ? preAng : targetHeading;
      h += clamp(angleDiff(desired, h), -maxTurn, maxTurn);
      x += Math.cos(h) * speed * dt;
      y += Math.sin(h) * speed * dt;
      path.push(x, y);
      var early = 1 - ((i - 1) / steps) * 0.55;

      for (j = 0; j < obstacles.length; j++) {
        var o = obstacles[j];
        var dx = x - o.x;
        var dy = y - o.y;
        var rr = o.r + selfR + safety;
        var clear = Math.sqrt(dx * dx + dy * dy) - rr;
        if (clear < minClear) minClear = clear;
        if (clear < 0) score += clear * 70 * early;
        else {
          var ow = o.hunt ? 0.30 : 1;
          var clearCap = o.hunt ? TUNE.HUNT_CLEAR_CAP : 150;
          score += Math.min(clear, clearCap) * 2.1 * ow * early;
        }
        // A hunt must not buy a cut with a scrape. The capped reward above
        // keeps target avoidance from dominating, but below the normal
        // danger margin the target becomes a hard safety constraint again.
        if (o.hunt && clear < TUNE.DANGER_CLEAR) {
          score -= (TUNE.DANGER_CLEAR - clear) * 220 * early;
        }
      }

      // Moving heads are predicted separately. Fixed ghost dots create
      // holes between samples; a continuous time-to-collision capsule is
      // much more reliable for dodging and for cutting across a nose.
      for (j = 0; j < heads.length; j++) {
        var hd = heads[j];
        var t = i * dt;
        // Predict only the next fraction of a second. Extrapolating a
        // chasing head across the whole rollout makes every escape path
        // look doomed and causes the trainer to turn into the chaser.
        var predT = Math.min(t, TUNE.HEAD_PREDICT);
        var ha = hd.ang;
        if (hd.d < 900 && predT > 0.05) {
          var toMe = Math.atan2(me.yy - hd.y, me.xx - hd.x);
          var headTurn = hd.hunt ? TUNE.HUNT_HEAD_TURN : TUNE.HEAD_TURN_RATE;
          ha += clamp(angleDiff(toMe, hd.ang),
            -headTurn * predT, headTurn * predT);
        }
        var hx = hd.x + Math.cos(ha) * hd.speed * predT;
        var hy = hd.y + Math.sin(ha) * hd.speed * predT;
        var hClear = Math.sqrt(dist2(x, y, hx, hy)) - (hd.r + selfR + safety);
        if (hClear < minClear) minClear = hClear;
        if (hClear < 0) score += hClear * 80 * early;
        else {
          var hw = hd.hunt ? 0.55 : TUNE.HEAD_WEIGHT;
          var hCap = hd.hunt ? TUNE.HUNT_CLEAR_CAP : 140;
          score += Math.min(hClear, hCap) * hw * early;
        }
        if (hd.hunt && hClear < TUNE.DANGER_CLEAR) {
          score -= (TUNE.DANGER_CLEAR - hClear) * 160 * early;
        }
      }

      var wd = Math.sqrt(dist2(x, y, arena.cx, arena.cy));
      var wall = arena.r - wd - TUNE.WALL_MARGIN - safety;
      if (wall < minWall) minWall = wall;
      if (wall < 0) score += wall * 60 * early;
      else score += Math.min(wall, 260) * 0.35 * early;

      // Do not let the rollout coil back through the path it just made.
      if (me.sct >= 8) {
        var selfFutureR = selfR * 2 + 10;
        for (var q = 0; q + 1 < path.length - 8; q += 2) {
          var selfD = Math.sqrt(dist2(x, y, path[q], path[q + 1]));
          if (selfD < selfFutureR) score += (selfD - selfFutureR) * 140 * early;
        }
      }
    }

    var foodScore = 0;
    if (ctx.foods.length && state.settings.foodPull > 0) {
      for (var p = 0; p + 1 < path.length; p += 2) {
        var px = path[p];
        var py = path[p + 1];
        var decay = 1.2 - 0.6 * (p / path.length);
        for (var f = 0; f < ctx.foods.length; f++) {
          var food = ctx.foods[f];
          var fd2 = dist2(px, py, food.x, food.y);
          if (fd2 < TUNE.FOOD_REACH * TUNE.FOOD_REACH) {
            var fd = Math.sqrt(fd2);
            foodScore += food.w * (1 - fd / TUNE.FOOD_REACH) * decay;
          }
        }
      }
      foodScore *= state.settings.foodPull;
      var foodScale = ctx.huntTarget ? TUNE.HUNT_FOOD_SCALE : 1;
      score += foodScore * TUNE.FOOD_WEIGHT * foodScale;

      // A lane bonus makes distant food visible to the planner instead of
      // only rewarding food that happens to be within reach of the rollout.
      var lane = 0;
      for (var lf = 0; lf < ctx.foods.length; lf++) {
        var lfood = ctx.foods[lf];
        var lfd = Math.sqrt(lfood.d2);
        if (lfd >= TUNE.FOOD_RANGE) continue;
        var la = Math.atan2(lfood.y - me.yy, lfood.x - me.xx);
        var align = Math.cos(angleDiff(targetHeading, la));
        if (align > 0.2) lane += lfood.w * align * (1 - lfd / TUNE.FOOD_RANGE);
      }
      lane *= state.settings.foodPull;
      score += lane * TUNE.FOOD_LANE_WEIGHT * foodScale;
      foodScore += lane;
    }

    var huntScore = 0;
    var ht = ctx.huntTarget;
    if (ht && ctx.aggression > 0) {
      var htX = ht.x;
      var htY = ht.y;
      var htAng = ht.ang;
      var htSpeed = ht.speed;
      var td = Math.max(1, ht.d);
      var toT = Math.atan2(htY - me.yy, htX - me.xx);
      var standoff = clamp(TUNE.HUNT_STANDOFF + ht.sct * 1.6, 100, 210);
      var desiredHunt;
      if (ctx.maneuver === 'cut') {
        desiredHunt = htAng + ctx.huntSide * Math.PI / 2;
        desiredHunt = angleBlend(desiredHunt, toT, clamp((td - 260) / 600, 0, 0.45));
      } else if (ctx.maneuver === 'chase') {
        // A slower snake running away leaves its body directly in our path.
        // Aim for a lead point beside its nose so we overtake alongside it
        // instead of rear-ending its tail, then cut across when we are ahead.
        var chaseLead = clamp(td / Math.max(180, ctx.speed + htSpeed), 0.25, 1.6);
        var sideOff = ht.r + selfR + safety + 30;
        var chaseX = htX + Math.cos(htAng) * htSpeed * chaseLead -
          Math.sin(htAng) * sideOff * ctx.huntSide;
        var chaseY = htY + Math.sin(htAng) * htSpeed * chaseLead +
          Math.cos(htAng) * sideOff * ctx.huntSide;
        desiredHunt = Math.atan2(chaseY - me.yy, chaseX - me.xx);
      } else if (ctx.maneuver === 'coil') {
        var ux = Math.cos(toT);
        var uy = Math.sin(toT);
        var tx = -uy * ctx.huntSide;
        var ty = ux * ctx.huntSide;
        var radial = clamp((td - standoff) / 240, -0.9, 1.0);
        desiredHunt = Math.atan2(ty + uy * radial * 1.15, tx + ux * radial * 1.15);
      } else {
        var leadT = clamp(td / Math.max(180, ctx.speed + htSpeed), 0.2, 1.1);
        var leadX = htX + Math.cos(htAng) * htSpeed * leadT;
        var leadY = htY + Math.sin(htAng) * htSpeed * leadT;
        desiredHunt = Math.atan2(leadY - me.yy, leadX - me.xx);
      }
      var huntAlign = Math.cos(angleDiff(targetHeading, desiredHunt));
      var huntBonus = ctx.maneuver === 'chase' ? TUNE.CHASE_BONUS : TUNE.HUNT_BONUS;
      huntScore += huntAlign * huntBonus * ctx.aggression;

      var endX = path[path.length - 2];
      var endY = path[path.length - 1];
      var endD = Math.sqrt(dist2(endX, endY, htX, htY));
      if (endD > standoff) {
        huntScore += clamp(1 - (endD - standoff) / 520, 0, 1) * 22 * ctx.aggression;
      } else if (endD < standoff * 0.7) {
        huntScore -= (standoff * 0.7 - endD) * 0.9 * ctx.aggression;
      }

      // Body-trap model: the target dies if its head reaches our body.
      // Our head must stay clear, but our trailing body is a weapon.
      var hitR = ht.sc * TUNE.BODY_HALF + selfR + 8;
      var trap = 0;
      for (var tt = 0.2; tt <= 1.3; tt += 0.22) {
        var px = htX + Math.cos(htAng) * htSpeed * tt;
        var py = htY + Math.sin(htAng) * htSpeed * tt;
        var minD = 999;
        for (var q = 0; q < ctx.selfBody.length; q++) {
          var sd = Math.sqrt(dist2(px, py, ctx.selfBody[q].x, ctx.selfBody[q].y));
          if (sd < minD) minD = sd;
        }
        for (var qp = 0; qp + 1 < path.length; qp += 2) {
          var pd = Math.sqrt(dist2(px, py, path[qp], path[qp + 1]));
          if (pd < minD) minD = pd;
        }
        if (minD < hitR) trap += 1;
        else if (minD < hitR + 90) trap += 1 - (minD - hitR) / 90;
      }
      huntScore += trap * TUNE.HUNT_BODY_BONUS * ctx.aggression;
      score += huntScore;
    }

    // If there is a real threat, bias toward the escape vector. Otherwise
    // the trainer is free to farm or hunt instead of running constantly.
    if (ctx.escape && ctx.nearest) {
      var away = ctx.evadeHeading;
      if (away === null || away === undefined) {
        away = Math.atan2(me.yy - ctx.nearest.y, me.xx - ctx.nearest.x);
      }
      var escapeWeight = TUNE.ESCAPE_BIAS * clamp(num(ctx.danger && ctx.danger.level, 0), 0, 1);
      score += Math.cos(angleDiff(targetHeading, away)) * escapeWeight;
    }
    if (ctx.danger && ctx.danger.wall < TUNE.WALL_MARGIN + 220) {
      var toCenter = Math.atan2(arena.cy - me.yy, arena.cx - me.xx);
      score += Math.cos(angleDiff(targetHeading, toCenter)) * 14;
    }

    // Prefer continuing in roughly the current direction. This is what
    // stops the planner from oscillating between two equally safe paths.
    score += Math.cos(angleDiff(targetHeading, startAng)) * 4;
    score += Math.cos(angleDiff(targetHeading, state.heading)) * TUNE.PREV_BONUS;

    if (minClear >= 0 && minWall >= 0) score += TUNE.SAFE_BONUS;
    else score -= TUNE.UNSAFE_PENALTY;

    return {
      score: score,
      minClear: minClear,
      minWall: minWall,
      foodScore: foodScore,
      huntScore: huntScore,
      path: path
    };
  }

  function nearestHead(me, heads) {
    var best = null;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var d = Math.sqrt(dist2(me.xx, me.yy, h.x, h.y));
      if (!best || d < best.d) best = { x: h.x, y: h.y, d: d };
    }
    return best;
  }

  function choosePlan(me, threats, selfBody, foods, arena, now) {
    var selfR = snakeRadius(me);
    var safety = state.settings.safety;
    var baseSpeed = Math.max(TUNE.SPEED_MIN, num(me.sp, 5.5) * TUNE.SPEED_MULT);
    var speed = state.boost ? TUNE.BOOST_SPEED : baseSpeed;
    var base = num(me.ang, state.heading);
    var prev = isFinite(state.heading) ? state.heading : base;
    var candidates = [];
    var i;

    var danger = assessDanger(me, threats, arena);
    if (danger.chase) state.chaseUntil = now + 1600;
    var chaseActive = now < state.chaseUntil;
    if (chaseActive) danger.level = Math.max(danger.level, 0.62);
    state.danger = danger.level;
    state.nearest = danger.nearest;
    if (state.corpse && now >= state.corpse.until) state.corpse = null;
    detectCorpse(foods, now);

    var target = selectHuntTarget(me, threats, arena, now);
    var modeDanger = danger;
    if (target) {
      // Ignore the target itself when deciding whether hunting is safe.
      // Otherwise an incoming smaller snake would always look like danger,
      // and the trainer would flee instead of cutting across its nose.
      modeDanger = assessDanger(me, threats, arena, target.id);
      if (modeDanger.urgent || modeDanger.level > 0.58) {
        target = null;
        state.huntTarget = null;
        state.huntTargetId = null;
      } else {
        var toT = Math.atan2(target.y - me.yy, target.x - me.xx);
        var facing = Math.cos(angleDiff(target.ang, toT));
        var along = (target.x - me.xx) * Math.cos(target.ang) +
          (target.y - me.yy) * Math.sin(target.ang);
        if (target.d < 340 && along < -30) target.maneuver = 'cut';
        else if (target.d < 420 && facing < -0.1) target.maneuver = 'cut';
        else if (facing > 0.3) target.maneuver = 'chase';
        else if (target.d < 460) target.maneuver = 'coil';
        else target.maneuver = 'hunt';
        target.huntSide = chooseHuntSide(me, target, arena, threats.heads);
        var fromTarget = Math.atan2(me.yy - target.y, me.xx - target.x);
        var lateral = Math.sin(angleDiff(fromTarget, target.ang));
        if (target.maneuver === 'chase') {
          // Approach from the side we are already on. Aiming across the
          // target's body makes the planner treat its own tail as a wall and
          // settle into a parallel chase that never closes the distance.
          if (Math.abs(lateral) > 0.15) target.huntSide = lateral > 0 ? 1 : -1;
        } else if (target.maneuver === 'cut' && Math.abs(lateral) > 0.15) {
          // Cross toward the target's path, not away from it.
          target.huntSide = lateral > 0 ? -1 : 1;
        }
        state.huntTarget = target;
      }
    }
    if (chaseActive) {
      modeDanger.level = Math.max(modeDanger.level, 0.62);
      if (target) {
        target = null;
        state.huntTarget = null;
        state.huntTargetId = null;
      }
    }

    var targetKey = target ? String(target.id) : null;
    var bodyPoints = buildBodyPoints(threats, targetKey);
    threats.bodyPoints = bodyPoints;
    for (i = 0; i < threats.points.length; i++) {
      threats.points[i].hunt = !!targetKey && String(threats.points[i].id) === targetKey;
    }
    for (i = 0; i < bodyPoints.length; i++) {
      bodyPoints[i].hunt = !!targetKey && String(bodyPoints[i].id) === targetKey;
    }
    for (i = 0; i < threats.heads.length; i++) {
      threats.heads[i].hunt = !!targetKey && String(threats.heads[i].id) === targetKey;
    }

    var evadeHeading = null;
    if (modeDanger.nearest && (modeDanger.urgent || modeDanger.level > 0.55)) {
      var near = modeDanger.nearest;
      var nearId = String(near.id);
      var needNew = state.escapeHeading === null || now >= state.escapeUntil ||
        state.escapeThreatId !== nearId;
      if (needNew) {
        var away = Math.atan2(me.yy - near.y, me.xx - near.x);
        var toCenter = Math.atan2(arena.cy - me.yy, arena.cx - me.xx);
        var left = away + Math.PI / 2;
        var right = away - Math.PI / 2;
        var centerSide = Math.cos(angleDiff(left, toCenter)) >= Math.cos(angleDiff(right, toCenter)) ? 1 : -1;
        var enemyFromMe = Math.atan2(near.y - me.yy, near.x - me.xx);
        var lateral = Math.sin(angleDiff(enemyFromMe, base));
        var side = Math.abs(lateral) > 0.2 ? (lateral > 0 ? -1 : 1) : centerSide;
        var isBehind = Math.cos(angleDiff(enemyFromMe, base)) < -0.2;
        // Commit to one escape line for about a second. Recomputing the
        // away vector every frame makes the snake spiral, which lets a
        // faster chaser cut the inside of the turn.
        state.escapeHeading = isBehind ? away + side * 0.95 : away;
        state.escapeThreatId = nearId;
        state.escapeUntil = now + 1100;
      }
      evadeHeading = state.escapeHeading;
    } else {
      state.escapeHeading = null;
      state.escapeThreatId = null;
      state.escapeUntil = 0;
    }

    var ctx = {
      obstacles: threats.points.concat(bodyPoints, selfBody),
      heads: threats.heads,
      foods: foods,
      arena: arena,
      selfR: selfR,
      selfBody: selfBody,
      safety: safety,
      speed: speed,
      huntTarget: target,
      maneuver: target ? target.maneuver : null,
      huntSide: target ? target.huntSide : 1,
      aggression: clamp(num(state.settings.aggression, 1), 0, 2),
      escape: modeDanger.urgent || modeDanger.level > 0.55,
      emergency: !!(danger.urgent && danger.nearest && danger.nearest.d < 340),
      danger: modeDanger,
      nearest: modeDanger.nearest || danger.nearest,
      evadeHeading: evadeHeading
    };

    for (i = 0; i < TUNE.COARSE_N; i++) {
      candidates.push(base + (i * TAU) / TUNE.COARSE_N);
    }
    for (i = 0; i < TUNE.FINE_N; i++) {
      var t = TUNE.FINE_N === 1 ? 0.5 : i / (TUNE.FINE_N - 1);
      candidates.push(prev + (t - 0.5) * TUNE.FINE_SPAN);
    }
    candidates.push(base);

    var best = null;
    for (i = 0; i < candidates.length; i++) {
      var h = candidates[i];
      var res = evaluatePath(me, h, ctx);
      if (!best || res.score > best.score) {
        best = {
          heading: h,
          score: res.score,
          minClear: res.minClear,
          minWall: res.minWall,
          foodScore: res.foodScore,
          huntScore: res.huntScore,
          path: res.path
        };
      }
    }
    if (!best) return null;

    // Second pass: refine the winner with a narrow fan. This gives much
    // finer steering than the coarse circle without paying for it globally.
    var refineCenter = best.heading;
    for (i = 0; i < TUNE.ULTRA_N; i++) {
      var u = TUNE.ULTRA_N === 1 ? 0.5 : i / (TUNE.ULTRA_N - 1);
      var uh = refineCenter + (u - 0.5) * TUNE.ULTRA_SPAN;
      var ures = evaluatePath(me, uh, ctx);
      if (ures.score > best.score) {
        best = {
          heading: uh,
          score: ures.score,
          minClear: ures.minClear,
          minWall: ures.minWall,
          foodScore: ures.foodScore,
          huntScore: ures.huntScore,
          path: ures.path
        };
      }
    }

    var mode = 'cruise';
    if (best.minClear < 0 || modeDanger.urgent) mode = 'escape';
    else if (modeDanger.level > 0.55) mode = 'danger';
    else if (target) mode = target.maneuver;
    else if (state.corpse && state.settings.foodPull > 0) mode = 'feast';
    else if (best.foodScore > 0.5) mode = 'farm';

    // A hunt that is already scraping a body is not a hunt; it is a
    // survival problem. Drop the target and let clearance lead.
    if (target && best.minClear < TUNE.DANGER_CLEAR) {
      mode = 'danger';
      target = null;
      state.huntTarget = null;
      state.huntTargetId = null;
    }

    var boost = now < state.boostUntil;
    if (boost && best.minWall < 60) {
      boost = false;
      state.boostUntil = 0;
    }
    if (!boost && state.settings.boostEscape && now > state.boostCooldownUntil) {
      if (mode === 'escape' && best.minClear < TUNE.BOOST_CLEAR &&
          best.minWall > 60 && num(me.sct, 0) >= 12) {
        var nearest = modeDanger.nearest || danger.nearest;
        if (nearest && nearest.d < 380) {
          var away = Math.atan2(me.yy - nearest.y, me.xx - nearest.x);
          if (Math.cos(angleDiff(best.heading, away)) > 0.25) {
            state.boostUntil = now + TUNE.BOOST_MS;
            state.boostCooldownUntil = now + TUNE.BOOST_MS + TUNE.BOOST_COOLDOWN;
            boost = true;
          }
        }
      }
    }
    // Gated cut-off boost. This is only for a smaller, isolated target and
    // only when the current path is clear; it is never used to chase food.
    if (!boost && target && state.settings.boostEscape &&
        now > state.cutBoostCooldownUntil && mode === 'cut' &&
        target.d > 170 && target.d < 500 && num(me.sct, 0) >= 30 &&
        best.minClear > 20 && best.minWall > 120) {
      var cutTo = Math.atan2(target.y - me.yy, target.x - me.xx);
      if (Math.cos(angleDiff(best.heading, cutTo)) > 0.05) {
        state.boostUntil = now + TUNE.CUT_BOOST_MS;
        state.cutBoostCooldownUntil = now + TUNE.CUT_BOOST_MS + TUNE.CUT_BOOST_COOLDOWN;
        boost = true;
      }
    }

    return {
      heading: best.heading,
      minClear: best.minClear,
      minWall: best.minWall,
      foodScore: best.foodScore,
      huntScore: best.huntScore,
      mode: mode,
      boost: boost,
      threatCount: threats.heads.length,
      target: target,
      danger: modeDanger,
      path: best.path
    };
  }

  function applySteering(heading, boost) {
    // The client treats xm/ym as offsets from the centre of the viewport:
    //   window.onmousemove -> xm = clientX - ww / 2
    //   slither.eang       -> atan2(ym, xm)
    var mag = 600;
    window.xm = Math.cos(heading) * mag;
    window.ym = Math.sin(heading) * mag;
    // Current client: boost lives on the snake object.
    // Older clients / other builds: window.wmd. Set both, harmlessly.
    try {
      if (window.slither) window.slither.wmd = !!boost;
    } catch (e) {}
    window.wmd = !!boost;
  }

  function releaseSteering() {
    var me = window.slither;
    var h = me ? num(me.ang, state.heading) : state.heading;
    // Keep the requested heading so releasing does not yank the snake
    // toward atan2(0, 0). The next real mouse move overrides this.
    window.xm = Math.cos(h) * 600;
    window.ym = Math.sin(h) * 600;
    try {
      if (me) me.wmd = false;
    } catch (e) {}
    window.wmd = false;
    // Clear the client's keyboard steering flags and pending key accumulators.
    try {
      window.kd_u = false;
      window.kd_l = false;
      window.kd_r = false;
      window.kd_l_frb = 0;
      window.kd_r_frb = 0;
    } catch (e) {}
  }

  function makeSnapshot(me, arena, threats, foods, heading, plan, selfBody) {
    var heads = [];
    for (var i = 0; i < threats.heads.length; i++) {
      var h = threats.heads[i];
      heads.push({
        x: h.x, y: h.y, ang: h.ang, speed: h.speed, boost: h.boost,
        sct: h.sct, sc: h.sc, r: h.r, d: h.d, id: h.id, hunt: !!h.hunt
      });
    }
    var bodyPoints = (threats.bodyPoints || []).slice(0, 460);
    return {
      me: { x: num(me.xx, 0), y: num(me.yy, 0), ang: num(me.ang, 0) },
      arena: arena,
      heading: heading,
      path: plan && plan.path ? plan.path.slice(0, 80) : [],
      threats: bodyPoints,
      heads: heads,
      selfBody: selfBody ? selfBody.slice(0, 120) : [],
      foods: foods.slice(0, TUNE.FOOD_RADAR_POINTS),
      target: plan && plan.target ? {
        id: plan.target.id, x: plan.target.x, y: plan.target.y,
        sct: plan.target.sct, d: plan.target.d, ang: plan.target.ang,
        maneuver: plan.target.maneuver
      } : null,
      corpse: state.corpse ? { x: state.corpse.x, y: state.corpse.y } : null,
      danger: state.danger,
      kills: state.kills,
      range: state.settings.radarRange
    };
  }

  function controlTick(me, now) {
    var arena = arenaInfo();
    var threats = collectThreats(me, now);
    var selfBody = collectSelfBody(me);
    var foods = collectFoods(me, Math.max(TUNE.FOOD_RANGE, state.settings.radarRange),
      TUNE.FOOD_RADAR_POINTS);
    var plan = choosePlan(me, threats, selfBody, foods, arena, now);
    if (!plan) return;

    state.heading = plan.heading;
    state.clearance = plan.minClear;
    state.threats = plan.threatCount;
    state.mode = plan.mode;
    state.boost = !!plan.boost;
    applySteering(plan.heading, state.boost);
    state.snapshot = makeSnapshot(me, arena, threats, foods, plan.heading, plan, selfBody);
    state.lastRadarAt = now;
  }

  function sampleSnapshot(me, now) {
    var arena = arenaInfo();
    var threats = collectThreats(me, now);
    threats.bodyPoints = buildBodyPoints(threats, null);
    var selfBody = collectSelfBody(me);
    var foods = collectFoods(me, Math.max(TUNE.FOOD_RANGE, state.settings.radarRange),
      TUNE.FOOD_RADAR_POINTS);
    if (state.corpse && now >= state.corpse.until) state.corpse = null;
    var danger = assessDanger(me, threats, arena);
    state.danger = danger.level;
    state.nearest = danger.nearest;
    state.snapshot = makeSnapshot(me, arena, threats, foods, num(me.ang, 0), null, selfBody);
    state.threats = threats.heads.length;
    state.clearance = null;
    state.lastRadarAt = now;
  }

  // ---- panel UI --------------------------------------------------------
  var host = null;
  var shadow = null;
  var els = {};
  var drag = null;

  function buildPanel() {
    host = document.createElement('div');
    host.id = 'slither-trainer-host';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      ':host{color-scheme:dark;}',
      '[hidden]{display:none !important;}',
      '*{box-sizing:border-box;}',
      '.panel{width:318px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;',
      'background:linear-gradient(180deg,rgba(17,26,36,.97),rgba(9,14,20,.97));',
      'border:1px solid #24384c;border-radius:12px;',
      'box-shadow:0 20px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.04);',
      'color:#dbe7f3;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'overflow:hidden;pointer-events:auto;user-select:none;}',
      '.hdr{display:flex;align-items:center;gap:8px;padding:10px 10px 9px;border-bottom:1px solid #1e2e3e;',
      'cursor:grab;touch-action:none;background:rgba(255,255,255,.015);}',
      '.hdr:active{cursor:grabbing;}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#64748b;box-shadow:0 0 0 3px rgba(100,116,139,.12);flex:none;}',
      '.dot[data-kind="active"]{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.16);}',
      '.dot[data-kind="armed"]{background:#fbbf24;box-shadow:0 0 0 3px rgba(251,191,36,.16);}',
      '.dot[data-kind="dead"]{background:#fb7185;box-shadow:0 0 0 3px rgba(251,113,133,.16);}',
      '.title{font-size:11px;letter-spacing:.14em;font-weight:700;color:#e6f1fb;white-space:nowrap;}',
      '.title b{color:#5eead4;}',
      '.ver{margin-left:auto;color:#53677c;font-size:10px;}',
      '.icon{width:20px;height:20px;border:1px solid #26384a;border-radius:5px;background:#101a24;',
      'color:#9fb3c8;cursor:pointer;font:12px/1 ui-monospace,monospace;padding:0;flex:none;}',
      '.icon:hover{color:#fff;border-color:#3a5570;}',
      '.body{padding:10px;overflow:auto;}',
      '.statusrow{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:9px;}',
      '.status{font-size:11px;color:#a9bdd1;min-width:0;}',
      '.status[data-kind="active"]{color:#a7f3d0;}',
      '.status[data-kind="armed"]{color:#fde68a;}',
      '.status[data-kind="dead"]{color:#fecdd3;}',
      '.pill{font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:999px;',
      'border:1px solid #2b4257;color:#8fa6bb;background:#0c151e;white-space:nowrap;}',
      '.pill[data-mode="escape"]{color:#fecdd3;border-color:#7f1d2d;background:#2a0d13;}',
      '.pill[data-mode="danger"]{color:#fed7aa;border-color:#7c4a1d;background:#2a1a0d;}',
      '.pill[data-mode="avoid"]{color:#fde68a;border-color:#66511d;background:#211c0d;}',
      '.pill[data-mode="farm"]{color:#bbf7d0;border-color:#1d5f3a;background:#0c2118;}',
      '.pill[data-mode="feast"]{color:#fde68a;border-color:#7c5a16;background:#251d08;}',
      '.pill[data-mode="hunt"]{color:#fecdd3;border-color:#7f1d2d;background:#2a0d13;}',
      '.pill[data-mode="coil"]{color:#fbcfe8;border-color:#7e2b5a;background:#280d1d;}',
      '.pill[data-mode="cut"]{color:#fed7aa;border-color:#9a3412;background:#2a130b;}',
      '.pill[data-mode="cruise"]{color:#bae6fd;border-color:#1d4f6b;background:#0c1c26;}',
      '.targetline{margin:-3px 0 8px;min-height:12px;color:#71889d;font-size:9px;letter-spacing:.02em;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.targetline[data-kind="hunt"]{color:#fda4af;}',
      '.targetline[data-kind="feast"]{color:#fde68a;}',
      '.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:9px;}',
      '.stat{background:#0b131c;border:1px solid #1c2c3b;border-radius:7px;padding:5px 6px;min-width:0;}',
      '.stat b{display:block;font-size:14px;color:#e8f3ff;font-weight:600;overflow:hidden;text-overflow:ellipsis;}',
      '.stat span{display:block;font-size:9px;color:#6f859b;letter-spacing:.06em;text-transform:uppercase;}',
      '.radarwrap{position:relative;width:190px;height:190px;margin:0 auto 9px;border:1px solid #1c2c3b;',
      'border-radius:8px;overflow:hidden;background:#081018;}',
      '.radar{display:block;width:190px;height:190px;}',
      '.radarlabel{position:absolute;right:6px;bottom:4px;font-size:8px;color:#4d657a;letter-spacing:.06em;}',
      '.actions{display:flex;gap:6px;margin-bottom:8px;}',
      'button{font:inherit;}',
      '.btn{flex:1;padding:7px 8px;border-radius:7px;border:1px solid #2a4055;background:#101b26;',
      'color:#c9dcee;cursor:pointer;}',
      '.btn:hover:not(:disabled){border-color:#3d5c78;color:#fff;}',
      '.btn:disabled{opacity:.45;cursor:default;}',
      '.btn.primary{border-color:#1c7f72;background:linear-gradient(180deg,#0f766e,#0b5f59);',
      'color:#eafffb;font-weight:700;}',
      '.btn.primary:hover:not(:disabled){border-color:#2dd4bf;}',
      '.btn.ghost{flex:0 0 92px;}',
      '.check{display:flex;align-items:center;gap:6px;color:#93a9be;font-size:11px;margin:5px 0;cursor:pointer;}',
      '.check input{accent-color:#14b8a6;}',
      '.slider{display:grid;grid-template-columns:52px 1fr 28px;align-items:center;gap:6px;',
      'color:#93a9be;font-size:10px;margin:6px 0;}',
      '.slider input{width:100%;accent-color:#14b8a6;}',
      '.slider output{text-align:right;color:#cfe2f2;}',
      '.hint{margin-top:8px;padding-top:7px;border-top:1px solid #1b2a38;color:#5e7388;font-size:9px;line-height:1.7;}',
      '.hint kbd{display:inline-block;padding:0 3px;border:1px solid #2b4055;border-radius:3px;',
      'background:#0b141d;color:#8fa6bb;font:9px ui-monospace,monospace;}',
      '.note{margin-top:5px;color:#4f657a;font-size:9px;}',
      '.tab{position:fixed;top:16px;right:16px;width:38px;height:38px;border-radius:50%;',
      'border:1px solid #2dd4bf;background:#0b1a1a;color:#5eead4;font:700 15px ui-monospace,monospace;',
      'cursor:pointer;pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,.5);}',
      '.tab:hover{background:#0f2a28;}',
      '</style>',
      '<div class="panel" id="panel">',
      '  <div class="hdr" id="hdr">',
      '    <span class="dot" id="dot" data-kind="idle"></span>',
      '    <span class="title">SLITHER <b>TRAINER</b></span>',
      '    <span class="ver">v' + VERSION + '</span>',
      '    <button type="button" class="icon" id="minBtn" title="Minimize">\u2013</button>',
      '    <button type="button" class="icon" id="hideBtn" title="Hide (Alt+B)">\u00d7</button>',
      '  </div>',
      '  <div class="body" id="body">',
      '    <div class="statusrow">',
      '      <span class="status" id="status" data-kind="idle">Waiting for a run</span>',
      '      <span class="pill" id="mode" data-mode="idle">idle</span>',
      '    </div>',
      '    <div class="stats">',
      '      <div class="stat"><b id="len">\u2013</b><span>length</span></div>',
      '      <div class="stat"><b id="score">\u2013</b><span>score</span></div>',
      '      <div class="stat"><b id="rank">\u2013</b><span>rank</span></div>',
      '      <div class="stat"><b id="near">\u2013</b><span>nearby</span></div>',
      '      <div class="stat"><b id="fps">\u2013</b><span>fps</span></div>',
      '      <div class="stat"><b id="clr">\u2013</b><span>clearance</span></div>',
      '    </div>',
      '    <div class="targetline" id="targetline">No hunt target</div>',
      '    <div class="radarwrap">',
      '      <canvas class="radar" id="radar" width="220" height="220"></canvas>',
      '      <span class="radarlabel" id="radarlabel">2,000 unit radar</span>',
      '    </div>',
      '    <div class="actions">',
      '      <button type="button" class="btn primary" id="takeBtn">Take over</button>',
      '      <button type="button" class="btn ghost" id="releaseBtn" disabled>Release</button>',
      '    </div>',
      '    <label class="check"><input type="checkbox" id="autoArm"> Re-arm after death</label>',
      '    <label class="check"><input type="checkbox" id="hunt"> Hunt smaller snakes</label>',
      '    <div class="slider"><span>Safety</span><input type="range" id="safety" min="4" max="40" step="1"><output id="safetyOut">18</output></div>',
      '    <div class="slider"><span>Food pull</span><input type="range" id="foodPull" min="0" max="2" step="0.1"><output id="foodPullOut">1.0</output></div>',
      '    <div class="slider"><span>Aggro</span><input type="range" id="aggression" min="0" max="2" step="0.1"><output id="aggressionOut">1.0</output></div>',
      '    <div class="slider"><span>Radar</span><input type="range" id="radarRange" min="800" max="2400" step="100"><output id="radarRangeOut">2000</output></div>',
      '    <label class="check"><input type="checkbox" id="boostEscape"> Allow gated boost</label>',
      '    <div class="hint"><kbd>Alt</kbd>+<kbd>B</kbd> panel &middot; <kbd>Alt</kbd>+<kbd>T</kbd> takeover<br><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> release</div>',
      '    <div class="note">Starts nothing. Takes over the snake you already spawned.</div>',
      '  </div>',
      '</div>',
      '<button type="button" class="tab" id="tab" hidden title="Show trainer (Alt+B)">T</button>'
    ].join('\n');

    document.documentElement.appendChild(host);

    els.panel = shadow.getElementById('panel');
    els.hdr = shadow.getElementById('hdr');
    els.dot = shadow.getElementById('dot');
    els.status = shadow.getElementById('status');
    els.mode = shadow.getElementById('mode');
    els.len = shadow.getElementById('len');
    els.score = shadow.getElementById('score');
    els.rank = shadow.getElementById('rank');
    els.near = shadow.getElementById('near');
    els.fps = shadow.getElementById('fps');
    els.clr = shadow.getElementById('clr');
    els.radar = shadow.getElementById('radar');
    els.radarlabel = shadow.getElementById('radarlabel');
    els.targetline = shadow.getElementById('targetline');
    els.body = shadow.getElementById('body');
    els.minBtn = shadow.getElementById('minBtn');
    els.hideBtn = shadow.getElementById('hideBtn');
    els.tab = shadow.getElementById('tab');
    els.takeBtn = shadow.getElementById('takeBtn');
    els.releaseBtn = shadow.getElementById('releaseBtn');
    els.autoArm = shadow.getElementById('autoArm');
    els.safety = shadow.getElementById('safety');
    els.safetyOut = shadow.getElementById('safetyOut');
    els.foodPull = shadow.getElementById('foodPull');
    els.foodPullOut = shadow.getElementById('foodPullOut');
    els.boostEscape = shadow.getElementById('boostEscape');
    els.hunt = shadow.getElementById('hunt');
    els.aggression = shadow.getElementById('aggression');
    els.aggressionOut = shadow.getElementById('aggressionOut');
    els.radarRange = shadow.getElementById('radarRange');
    els.radarRangeOut = shadow.getElementById('radarRangeOut');

    els.safety.value = state.settings.safety;
    els.safetyOut.textContent = state.settings.safety;
    els.foodPull.value = state.settings.foodPull;
    els.foodPullOut.textContent = Number(state.settings.foodPull).toFixed(1);
    els.hunt.checked = !!state.settings.hunt;
    els.aggression.value = state.settings.aggression;
    els.aggressionOut.textContent = Number(state.settings.aggression).toFixed(1);
    els.radarRange.value = state.settings.radarRange;
    els.radarRangeOut.textContent = Math.round(state.settings.radarRange);
    els.boostEscape.checked = !!state.settings.boostEscape;
    els.autoArm.checked = !!state.settings.autoArm;

    applySavedPosition();
  }

  function applySavedPosition() {
    var s = state.settings;
    if (s.x === null || s.y === null) return;
    var r = host.getBoundingClientRect();
    var x = clamp(s.x, 4, Math.max(4, window.innerWidth - r.width - 4));
    var y = clamp(s.y, 4, Math.max(4, window.innerHeight - r.height - 4));
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.right = 'auto';
  }

  function setMinimized(v) {
    state.minimized = !!v;
    if (!els.body) return;
    els.body.hidden = state.minimized;
    els.minBtn.textContent = state.minimized ? '+' : '\u2013';
    els.minBtn.title = state.minimized ? 'Expand' : 'Minimize';
  }

  function setHidden(v) {
    state.hidden = !!v;
    if (!els.panel) return;
    els.panel.hidden = state.hidden;
    els.tab.hidden = !state.hidden;
  }

  function onDragStart(e) {
    if (e.button !== undefined && e.button !== 0) return;
    var target = e.target;
    if (target && target.closest && target.closest('button')) return;
    var r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    host.style.left = r.left + 'px';
    host.style.top = r.top + 'px';
    host.style.right = 'auto';
    e.preventDefault();
    e.stopPropagation();
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onDragEnd, true);
    window.addEventListener('pointercancel', onDragEnd, true);
  }

  function onDragMove(e) {
    if (!drag) return;
    var r = host.getBoundingClientRect();
    var x = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - r.width - 4));
    var y = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - r.height - 4));
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    e.preventDefault();
    e.stopPropagation();
  }

  function onDragEnd(e) {
    if (!drag) return;
    drag = null;
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onDragEnd, true);
    window.removeEventListener('pointercancel', onDragEnd, true);
    state.settings.x = parseFloat(host.style.left);
    state.settings.y = parseFloat(host.style.top);
    if (!isFinite(state.settings.x)) state.settings.x = null;
    if (!isFinite(state.settings.y)) state.settings.y = null;
    saveSettings();
    e.preventDefault();
    e.stopPropagation();
  }

  function bindUi() {
    els.minBtn.addEventListener('click', function () { setMinimized(!state.minimized); });
    els.hideBtn.addEventListener('click', function () { setHidden(true); });
    els.tab.addEventListener('click', function () { setHidden(false); });
    els.takeBtn.addEventListener('click', function () {
      if (state.takeover || state.armed) return;
      if (liveSelf()) beginTakeover('panel');
      else armTakeover();
    });
    els.releaseBtn.addEventListener('click', function () {
      stopTakeover(false, 'panel release');
    });
    els.autoArm.addEventListener('change', function () {
      state.settings.autoArm = !!els.autoArm.checked;
      saveSettings();
    });
    els.hunt.addEventListener('change', function () {
      state.settings.hunt = !!els.hunt.checked;
      if (!state.settings.hunt) {
        state.huntTarget = null;
        state.huntTargetId = null;
      }
      saveSettings();
    });
    els.boostEscape.addEventListener('change', function () {
      state.settings.boostEscape = !!els.boostEscape.checked;
      saveSettings();
    });
    els.safety.addEventListener('input', function () {
      state.settings.safety = clamp(num(els.safety.value, 18), 4, 40);
      els.safetyOut.textContent = state.settings.safety;
    });
    els.safety.addEventListener('change', saveSettings);
    els.foodPull.addEventListener('input', function () {
      state.settings.foodPull = clamp(num(els.foodPull.value, 1), 0, 2);
      els.foodPullOut.textContent = Number(state.settings.foodPull).toFixed(1);
    });
    els.foodPull.addEventListener('change', saveSettings);
    els.aggression.addEventListener('input', function () {
      state.settings.aggression = clamp(num(els.aggression.value, 1), 0, 2);
      els.aggressionOut.textContent = Number(state.settings.aggression).toFixed(1);
    });
    els.aggression.addEventListener('change', saveSettings);
    els.radarRange.addEventListener('input', function () {
      state.settings.radarRange = clamp(num(els.radarRange.value, 2000), 800, TUNE.THREAT_RANGE);
      els.radarRangeOut.textContent = Math.round(state.settings.radarRange);
      drawRadar();
    });
    els.radarRange.addEventListener('change', saveSettings);
    els.hdr.addEventListener('pointerdown', onDragStart);

    window.addEventListener('resize', function () {
      if (!host.style.left) return;
      var r = host.getBoundingClientRect();
      host.style.left = clamp(parseFloat(host.style.left) || 4, 4, Math.max(4, window.innerWidth - r.width - 4)) + 'px';
      host.style.top = clamp(parseFloat(host.style.top) || 4, 4, Math.max(4, window.innerHeight - r.height - 4)) + 'px';
    });
  }

  function updateUi(now) {
    if (!els.status || now - state.lastUiAt < 100) return;
    state.lastUiAt = now;

    var me = liveSelf();
    var text = 'Waiting for a run \u2014 start it yourself';
    var kind = 'idle';

    if (state.takeover && me) {
      text = 'Takeover active \u00b7 run #' + me.id;
      kind = 'active';
    } else if (state.armed) {
      text = me ? 'Armed \u2014 starting takeover' : 'Armed \u2014 start a run yourself';
      kind = 'armed';
    } else if (me) {
      text = 'Run live \u00b7 trainer idle';
    } else if (state.sessionId !== null) {
      text = 'Run ended \u00b7 trainer idle';
      kind = 'dead';
    }

    els.status.textContent = text;
    els.status.dataset.kind = kind;
    els.dot.dataset.kind = kind;
    els.mode.textContent = me ? state.mode : 'idle';
    els.mode.dataset.mode = me ? state.mode : 'idle';

    els.len.textContent = me ? fmt(num(me.sct, 0)) : '\u2013';
    var score = me ? displayScore(me) : null;
    els.score.textContent = score === null ? '\u2013' : fmt(score);
    els.rank.textContent = me ? fmt(num(window.rank, 0)) : '\u2013';
    els.near.textContent = me ? fmt(state.threats) : '\u2013';
    els.fps.textContent = fmt(state.fps);
    els.clr.textContent = (me && state.clearance !== null && state.clearance < 900) ? fmt(state.clearance) : '\u2013';

    var tline = 'Kills ' + state.kills + ' \u00b7 no hunt target';
    var tkind = '';
    if (state.takeover && me && state.huntTarget) {
      tline = 'TARGET #' + state.huntTarget.id + ' \u00b7 len ' +
        fmt(state.huntTarget.sct) + ' \u00b7 ' + fmt(state.huntTarget.d) +
        'u \u00b7 kills ' + state.kills;
      tkind = 'hunt';
    } else if (state.takeover && me && state.corpse && now < state.corpse.until) {
      var cd = Math.sqrt(dist2(me.xx, me.yy, state.corpse.x, state.corpse.y));
      tline = 'Feast site \u00b7 ' + fmt(cd) + 'u \u00b7 kills ' + state.kills;
      tkind = 'feast';
    } else if (!state.takeover) {
      tline = 'Trainer idle \u00b7 takes over the run you start';
    }
    els.targetline.textContent = tline;
    els.targetline.dataset.kind = tkind;

    if (state.takeover) {
      els.takeBtn.disabled = true;
      els.takeBtn.textContent = 'Takeover active';
    } else if (state.armed) {
      els.takeBtn.disabled = true;
      els.takeBtn.textContent = 'Armed for next run';
    } else {
      els.takeBtn.disabled = false;
      els.takeBtn.textContent = me ? 'Take over now' : 'Arm for next run';
    }
    els.releaseBtn.disabled = !(state.takeover || state.armed);

    els.autoArm.checked = !!state.settings.autoArm;
    els.hunt.checked = !!state.settings.hunt;
    els.boostEscape.checked = !!state.settings.boostEscape;
    var active = shadow.activeElement;
    if (active !== els.safety) {
      els.safety.value = state.settings.safety;
      els.safetyOut.textContent = state.settings.safety;
    }
    if (active !== els.foodPull) {
      els.foodPull.value = state.settings.foodPull;
      els.foodPullOut.textContent = Number(state.settings.foodPull).toFixed(1);
    }
    if (active !== els.aggression) {
      els.aggression.value = state.settings.aggression;
      els.aggressionOut.textContent = Number(state.settings.aggression).toFixed(1);
    }
    if (active !== els.radarRange) {
      els.radarRange.value = state.settings.radarRange;
      els.radarRangeOut.textContent = Math.round(state.settings.radarRange);
    }

    drawRadar();
  }

  function drawRadar() {
    var canvas = els.radar;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var w = canvas.width;
    var h = canvas.height;
    var cx = w / 2;
    var cy = h / 2;
    var range = clamp(num(state.settings.radarRange, TUNE.RADAR_RANGE), 800, TUNE.THREAT_RANGE);
    var scale = (Math.min(w, h) / 2 - 10) / range;
    if (els.radarlabel) {
      var rangeText = String(Math.round(range)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      els.radarlabel.textContent = rangeText + ' unit radar';
    }

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#081018';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(94,234,212,.12)';
    ctx.lineWidth = 1;
    for (var i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (Math.min(w, h) / 2 - 10) * i / 3, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(94,234,212,.08)';
    ctx.beginPath();
    ctx.moveTo(cx, 8);
    ctx.lineTo(cx, h - 8);
    ctx.moveTo(8, cy);
    ctx.lineTo(w - 8, cy);
    ctx.stroke();

    var snap = state.snapshot;
    if (!snap) {
      ctx.fillStyle = '#3f566b';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no live run', cx, cy + 3);
      return;
    }

    // Arena boundary (usually far outside the radar; canvas clips it).
    var ax = cx + (snap.arena.cx - snap.me.x) * scale;
    var ay = cy + (snap.arena.cy - snap.me.y) * scale;
    ctx.strokeStyle = 'rgba(251,191,36,.35)';
    ctx.beginPath();
    ctx.arc(ax, ay, snap.arena.r * scale, 0, TAU);
    ctx.stroke();

    // Our own body, so a coil or a tight turn is visible.
    ctx.fillStyle = 'rgba(45,212,191,.45)';
    for (var sb = 0; sb < snap.selfBody.length; sb++) {
      var sbp = snap.selfBody[sb];
      var sbx = cx + (sbp.x - snap.me.x) * scale;
      var sby = cy + (sbp.y - snap.me.y) * scale;
      if (sbx < -4 || sby < -4 || sbx > w + 4 || sby > h + 4) continue;
      ctx.fillRect(sbx - 1, sby - 1, 2, 2);
    }

    // Food. Corpse pellets are amber and much easier to spot.
    for (var f = 0; f < snap.foods.length; f++) {
      var food = snap.foods[f];
      var fx = cx + (food.x - snap.me.x) * scale;
      var fy = cy + (food.y - snap.me.y) * scale;
      if (fx < -4 || fy < -4 || fx > w + 4 || fy > h + 4) continue;
      ctx.fillStyle = food.corpse ? 'rgba(251,191,36,.95)' : 'rgba(74,222,128,.72)';
      var fr = 1.1 + Math.min(2.8, food.sz * 0.16);
      ctx.beginPath();
      ctx.arc(fx, fy, fr, 0, TAU);
      ctx.fill();
    }

    // Enemy bodies. The target's body is highlighted so the player can see
    // which snake the trainer is trying to trap.
    for (var t = 0; t < snap.threats.length; t++) {
      var th = snap.threats[t];
      if (th.head) continue;
      var tx = cx + (th.x - snap.me.x) * scale;
      var ty = cy + (th.y - snap.me.y) * scale;
      if (tx < -10 || ty < -10 || tx > w + 10 || ty > h + 10) continue;
      ctx.fillStyle = th.hunt ? 'rgba(251,113,133,.72)' : 'rgba(251,146,60,.55)';
      ctx.fillRect(tx - 1, ty - 1, 2, 2);
    }

    // Planned rollout path.
    if (snap.path && snap.path.length >= 4) {
      ctx.strokeStyle = 'rgba(94,234,212,.7)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (var p = 0; p + 1 < snap.path.length; p += 2) {
        var px = cx + (snap.path[p] - snap.me.x) * scale;
        var py = cy + (snap.path[p + 1] - snap.me.y) * scale;
        if (p === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      var lastX = snap.path[snap.path.length - 2];
      var lastY = snap.path[snap.path.length - 1];
      ctx.fillStyle = 'rgba(94,234,212,.85)';
      ctx.beginPath();
      ctx.arc(cx + (lastX - snap.me.x) * scale, cy + (lastY - snap.me.y) * scale, 1.8, 0, TAU);
      ctx.fill();
    }

    // Heads and their predicted tracks.
    for (var hd = 0; hd < snap.heads.length; hd++) {
      var head = snap.heads[hd];
      var hx = cx + (head.x - snap.me.x) * scale;
      var hy = cy + (head.y - snap.me.y) * scale;
      if (hx < -20 || hy < -20 || hx > w + 20 || hy > h + 20) continue;
      var track = Math.min(320, 24 + head.speed * 0.55);
      ctx.strokeStyle = head.boost ? 'rgba(248,113,113,.58)' : 'rgba(251,113,133,.24)';
      ctx.lineWidth = head.boost ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + Math.cos(head.ang) * track * scale,
        hy + Math.sin(head.ang) * track * scale);
      ctx.stroke();
      ctx.fillStyle = head.hunt ? '#fda4af' : (head.boost ? '#f87171' : '#fb7185');
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4 + Math.min(2.4, head.sc * 0.7), 0, TAU);
      ctx.fill();
      if (head.boost) {
        ctx.strokeStyle = 'rgba(248,113,113,.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(hx, hy, 5.5 + Math.min(2.5, head.sc * 0.5), 0, TAU);
        ctx.stroke();
      }
    }

    // Hunt target: dashed lead line plus a crosshair.
    if (snap.target) {
      var tgx = cx + (snap.target.x - snap.me.x) * scale;
      var tgy = cy + (snap.target.y - snap.me.y) * scale;
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(253,164,175,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tgx, tgy);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = '#fda4af';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(tgx, tgy, 7, 0, TAU);
      ctx.moveTo(tgx - 10, tgy);
      ctx.lineTo(tgx - 4, tgy);
      ctx.moveTo(tgx + 4, tgy);
      ctx.lineTo(tgx + 10, tgy);
      ctx.moveTo(tgx, tgy - 10);
      ctx.lineTo(tgx, tgy - 4);
      ctx.moveTo(tgx, tgy + 4);
      ctx.lineTo(tgx, tgy + 10);
      ctx.stroke();
      if (snap.target.maneuver) {
        ctx.fillStyle = 'rgba(253,164,175,.85)';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(snap.target.maneuver, tgx + 10, tgy - 7);
      }
    }

    // Corpse / feast site.
    if (snap.corpse) {
      var cgx = cx + (snap.corpse.x - snap.me.x) * scale;
      var cgy = cy + (snap.corpse.y - snap.me.y) * scale;
      ctx.strokeStyle = 'rgba(251,191,36,.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cgx, cgy, 6, 0, TAU);
      ctx.moveTo(cgx - 8, cgy);
      ctx.lineTo(cgx + 8, cgy);
      ctx.moveTo(cgx, cgy - 8);
      ctx.lineTo(cgx, cgy + 8);
      ctx.stroke();
    }

    // Planned heading and self marker.
    var hx2 = Math.cos(snap.heading || 0);
    var hy2 = Math.sin(snap.heading || 0);
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + hx2 * 18, cy + hy2 * 18);
    ctx.stroke();

    ctx.fillStyle = '#eafffb';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#0f766e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, TAU);
    ctx.stroke();
  }

  // ---- input shield ----------------------------------------------------
  var GAME_HANDLER_KEYS = ['onmousemove', 'onmousedown', 'ontouchstart', 'ontouchmove', 'ontouchend'];
  var savedHandlers = null;
  var stubHandlers = null;
  var BLOCK_EVENTS = ['mousemove', 'mousedown', 'mouseup', 'pointermove', 'pointerdown',
    'pointerup', 'touchstart', 'touchmove', 'touchend', 'click', 'contextmenu', 'wheel'];
  var BLOCK_KEYS = {
    Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Enter: 1
  };

  function isPanelEvent(e) {
    if (!host) return false;
    var t = e.target;
    if (t && (t === host || (host.contains && host.contains(t)))) return true;
    if (typeof e.composedPath === 'function') {
      var path = e.composedPath();
      for (var i = 0; i < path.length; i++) {
        if (path[i] === host) return true;
      }
    }
    return false;
  }

  function silenceGameInput() {
    if (savedHandlers) return;
    savedHandlers = {};
    stubHandlers = {};
    for (var i = 0; i < GAME_HANDLER_KEYS.length; i++) {
      var key = GAME_HANDLER_KEYS[i];
      savedHandlers[key] = window[key];
      /* eslint-disable no-loop-func */
      var stub = function (e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      };
      /* eslint-enable no-loop-func */
      stubHandlers[key] = stub;
      try {
        window[key] = stub;
      } catch (e) {}
    }
  }

  function restoreGameInput() {
    if (!savedHandlers) return;
    for (var i = 0; i < GAME_HANDLER_KEYS.length; i++) {
      var key = GAME_HANDLER_KEYS[i];
      try {
        // Only restore if the page has not replaced our stub in the meantime.
        if (window[key] === stubHandlers[key]) window[key] = savedHandlers[key];
      } catch (e) {}
    }
    savedHandlers = null;
    stubHandlers = null;
  }

  function onShieldEvent(e) {
    // Idle input belongs to the player, except while the panel is being
    // dragged: moving the panel must not also steer the snake.
    if (!state.takeover && !drag) return;
    if (isPanelEvent(e)) return;
    // Dragging tracks the pointer outside the panel. Let only the pointer
    // events that drive the drag through; game mouse/touch input stays blocked.
    if (drag && (e.type === 'pointermove' || e.type === 'pointerup' || e.type === 'pointercancel')) return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onShieldKey(e) {
    if (!state.takeover) return;
    if (isPanelEvent(e)) return;
    if (BLOCK_KEYS[e.code] || BLOCK_KEYS[e.key]) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function installInputShield() {
    var opts = { capture: true, passive: false };
    for (var i = 0; i < BLOCK_EVENTS.length; i++) {
      window.addEventListener(BLOCK_EVENTS[i], onShieldEvent, opts);
    }
    window.addEventListener('keydown', onShieldKey, true);
    window.addEventListener('keyup', onShieldKey, true);
  }

  function installPanelShield() {
    var stop = function (e) { e.stopPropagation(); };
    var types = ['mousemove', 'pointermove', 'touchmove',
      'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'touchstart', 'touchend', 'click', 'contextmenu', 'wheel'];
    for (var i = 0; i < types.length; i++) {
      host.addEventListener(types[i], stop, { passive: false });
    }
  }

  function installHotkeys() {
    window.addEventListener('keydown', function (e) {
      if (!e.altKey || e.repeat) return;
      if (e.code === 'KeyB') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHidden(!state.hidden);
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleTakeover();
      } else if (e.code === 'KeyX' && e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stopTakeover(false, 'hotkey release');
      }
    }, true);
  }

  // ---- takeover --------------------------------------------------------
  function resetHuntState(full) {
    state.huntTargetId = null;
    state.huntTarget = null;
    state.huntUntil = 0;
    state.cutBoostCooldownUntil = 0;
    state.chaseUntil = 0;
    state.escapeHeading = null;
    state.escapeThreatId = null;
    state.escapeUntil = 0;
    if (full) {
      state.kills = 0;
      state.corpse = null;
      state.deadIds = {};
      state.danger = 0;
      state.nearest = null;
    }
  }

  function beginTakeover(source) {
    var me = liveSelf();
    if (!me) {
      armTakeover();
      return false;
    }
    if (state.takeover) return true;
    state.takeover = true;
    state.armed = true;
    state.sessionId = num(me.id, state.sessionId);
    state.heading = num(me.ang, 0);
    state.boost = false;
    state.boostUntil = 0;
    state.boostCooldownUntil = 0;
    resetHuntState(false);
    state.mode = 'cruise';
    state.clearance = null;
    silenceGameInput();
    applySteering(state.heading, false);
    sampleSnapshot(me, performance.now());
    state.lastUiAt = 0;
    updateUi(performance.now());
    console.info('[trainer] takeover active on run', me.id, source ? '(' + source + ')' : '');
    return true;
  }

  function armTakeover() {
    if (state.takeover) return;
    state.armed = true;
    state.mode = 'idle';
    state.boost = false;
    state.boostUntil = 0;
    state.boostCooldownUntil = 0;
    resetHuntState(false);
    releaseSteering();
    state.lastUiAt = 0;
    updateUi(performance.now());
    console.info('[trainer] armed; start or resume a run yourself');
  }

  function stopTakeover(keepArmed, reason) {
    var was = state.takeover;
    state.takeover = false;
    state.armed = !!keepArmed;
    state.boost = false;
    state.boostUntil = 0;
    state.boostCooldownUntil = 0;
    resetHuntState(false);
    state.mode = 'idle';
    state.clearance = null;
    // Only touch the game's steering if this call actually ends control.
    // Otherwise the emergency-release hotkey would yank an idle player's
    // snake toward its current heading.
    if (was) releaseSteering();
    restoreGameInput();
    state.lastUiAt = 0;
    updateUi(performance.now());
    if (was) console.info('[trainer] released:', reason || 'released');
  }

  function toggleTakeover() {
    if (state.takeover || state.armed) {
      stopTakeover(false, 'toggle');
    } else if (liveSelf()) {
      beginTakeover('toggle');
    } else {
      armTakeover();
    }
  }

  // ---- main loop -------------------------------------------------------
  function tick(now) {
    requestAnimationFrame(tick);

    state.frames++;
    if (now - state.fpsAt >= 500) {
      state.fps = Math.round((state.frames * 1000) / Math.max(1, now - state.fpsAt));
      state.frames = 0;
      state.fpsAt = now;
    }

    var me = liveSelf();
    if (me) {
      var id = num(me.id, 0);
      if (state.sessionId !== id) {
        state.sessionId = id;
        state.heading = num(me.ang, 0);
        state.boost = false;
        state.boostUntil = 0;
        state.boostCooldownUntil = 0;
        resetHuntState(true);
        state.mode = 'cruise';
        state.snapshot = null;
        if (state.armed && !state.takeover) beginTakeover('new run');
      }
      if (state.takeover) {
        controlTick(me, now);
      } else if (now - state.lastRadarAt >= 120) {
        sampleSnapshot(me, now);
      }
    } else {
      if (state.takeover) {
        // A death or disconnect ends control. It never clicks Play.
        stopTakeover(state.settings.autoArm, 'session ended');
      }
      if (state.sessionId !== null) {
        state.sessionId = null;
        state.snapshot = null;
        state.mode = 'idle';
        state.heading = 0;
        state.clearance = null;
        state.threats = 0;
        state.boost = false;
        state.boostUntil = 0;
        state.boostCooldownUntil = 0;
        resetHuntState(true);
      }
    }

    updateUi(now);
  }

  // ---- boot ------------------------------------------------------------
  function boot() {
    if (!document.documentElement) {
      setTimeout(boot, 50);
      return;
    }
    buildPanel();
    bindUi();
    installInputShield();
    installPanelShield();
    installHotkeys();
    requestAnimationFrame(tick);

    window.__slitherTrainer = {
      version: VERSION,
      state: state,
      settings: state.settings,
      tune: TUNE,
      show: function () { setHidden(false); },
      hide: function () { setHidden(true); },
      arm: armTakeover,
      start: function () { return beginTakeover('api'); },
      release: function () { stopTakeover(false, 'api release'); },
      toggle: toggleTakeover,
      planner: {
        choosePlan: choosePlan,
        evaluatePath: evaluatePath,
        collectThreats: collectThreats,
        collectSelfBody: collectSelfBody,
        collectFoods: collectFoods,
        assessDanger: assessDanger,
        selectHuntTarget: selectHuntTarget,
        detectCorpse: detectCorpse,
        arenaInfo: arenaInfo
      }
    };

    console.info('[trainer] panel ready v' + VERSION +
      ' \u2014 it starts nothing; it takes over the run you already started.');
  }

  boot();
})();
