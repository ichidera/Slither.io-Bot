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

  var VERSION = '0.1.0';
  var STORAGE_KEY = 'slitherTrainer.settings.v1';
  var TAU = Math.PI * 2;

  // ---- planner tunables ------------------------------------------------
  var TUNE = {
    HORIZON: 1.4,          // rollout seconds
    STEPS: 15,             // rollout samples
    CONTROL_LAG: 0.24,     // server/control delay before a turn is assumed
    TURN_RATE: 4.125,      // rad/s, matches the client's base turn rate
    SPEED_MULT: 31.25,     // world units/s per sp unit
    SPEED_MIN: 120,
    BOOST_SPEED: 430,
    COARSE_N: 24,          // headings over the full circle
    FINE_N: 12,            // headings around the previous choice
    FINE_SPAN: 0.72,       // radians
    THREAT_RANGE: 1100,
    THREAT_POINTS: 80,     // local body points kept per enemy
    HEAD_MARGIN: 26,
    SELF_SKIP: 95,         // do not treat our own neck as an obstacle
    SELF_POINTS: 120,      // local self body points kept
    BODY_HALF: 14.5,       // rendered half-width at sc = 1
    WALL_MARGIN: 260,
    FOOD_RANGE: 520,
    FOOD_REACH: 240,
    FOOD_POINTS: 28,
    FOOD_WEIGHT: 16,
    DANGER_CLEAR: 14,
    BOOST_CLEAR: 9,
    BOOST_MS: 320,
    PREV_BONUS: 10,
    RADAR_RANGE: 1200
  };

  var DEFAULT_SETTINGS = {
    safety: 18,
    foodPull: 1,
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

  function collectThreats(me) {
    var points = [];
    var heads = [];
    var meId = String(me.id);
    var headRange2 = TUNE.THREAT_RANGE * TUNE.THREAT_RANGE;
    var includeRange2 = (TUNE.THREAT_RANGE * 2) * (TUNE.THREAT_RANGE * 2);
    var bodyRange2 = (TUNE.THREAT_RANGE * 1.1) * (TUNE.THREAT_RANGE * 1.1);
    var list = Array.isArray(window.slithers) ? window.slithers : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s === me || String(s.id) === meId) continue;
      if (s.dead || num(s.id, -1) <= 0) continue;
      var sx = num(s.xx, NaN);
      var sy = num(s.yy, NaN);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      var d2 = dist2(sx, sy, me.xx, me.yy);
      if (d2 > includeRange2) continue;
      var r = snakeRadius(s);
      var speed = Math.max(0, num(s.sp, 0)) * TUNE.SPEED_MULT;
      var headR = r + TUNE.HEAD_MARGIN + Math.min(18, speed * 0.05);
      if (d2 <= headRange2) {
        var head = { x: sx, y: sy, r: headR, head: true, id: s.id, d: Math.sqrt(d2), s: s };
        points.push(head);
        heads.push(head);
        var ang = num(s.ang, 0);
        points.push({
          x: sx + Math.cos(ang) * speed * 0.12,
          y: sy + Math.sin(ang) * speed * 0.12,
          r: headR,
          head: true,
          ghost: true
        });
      }
      // Keep dense, local body points. Sampling the whole body with a
      // large stride can leave holes that a rollout slips through.
      var pts = Array.isArray(s.pts) ? s.pts : [];
      var added = 0;
      for (var j = pts.length - 1; j >= 0 && added < TUNE.THREAT_POINTS; j--) {
        var p = pts[j];
        if (!p || p.dying) continue;
        var px = num(p.xx, NaN);
        var py = num(p.yy, NaN);
        if (!isFinite(px) || !isFinite(py)) continue;
        if (dist2(px, py, me.xx, me.yy) > bodyRange2) continue;
        points.push({ x: px, y: py, r: r + 3, head: false, id: s.id });
        added++;
      }
    }
    return { points: points, heads: heads };
  }

  function collectSelfBody(me) {
    var pts = Array.isArray(me.pts) ? me.pts : [];
    var r = snakeRadius(me);
    var out = [];
    if (!pts.length) return out;
    var skip2 = TUNE.SELF_SKIP * TUNE.SELF_SKIP;
    var range2 = 1000 * 1000;
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

  function collectFoods(me) {
    var list = Array.isArray(window.foods) ? window.foods : [];
    var range2 = TUNE.FOOD_RANGE * TUNE.FOOD_RANGE;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var fx = num(f.xx, NaN);
      var fy = num(f.yy, NaN);
      if (!isFinite(fx) || !isFinite(fy)) continue;
      var d2 = dist2(fx, fy, me.xx, me.yy);
      if (d2 > range2) continue;
      var sz = Math.max(1, num(f.sz, 1));
      out.push({ x: fx, y: fy, w: 0.5 + Math.min(2.5, sz / 4), d2: d2 });
    }
    out.sort(function (a, b) { return a.d2 - b.d2; });
    return out.slice(0, TUNE.FOOD_POINTS);
  }

  // ---- planner ---------------------------------------------------------
  function evaluatePath(me, target, obstacles, foods, arena, selfR, safety, speed) {
    var steps = TUNE.STEPS;
    var dt = TUNE.HORIZON / steps;
    var lagSteps = TUNE.CONTROL_LAG / dt;
    var turnRate = TUNE.TURN_RATE * clamp(num(me.scang, 1), 0.13, 1.2);
    var maxTurn = turnRate * dt;
    var startAng = num(me.ang, 0);
    var x = num(me.xx, 0);
    var y = num(me.yy, 0);
    var h = startAng;
    var minClear = 999;
    var minWall = 999;
    var score = 0;
    var path = [];
    for (var i = 1; i <= steps; i++) {
      if (i > lagSteps) {
        h += clamp(angleDiff(target, h), -maxTurn, maxTurn);
      }
      x += Math.cos(h) * speed * dt;
      y += Math.sin(h) * speed * dt;
      path.push(x, y);
      var early = 1 - ((i - 1) / steps) * 0.55;
      for (var j = 0; j < obstacles.length; j++) {
        var o = obstacles[j];
        var dx = x - o.x;
        var dy = y - o.y;
        var rr = o.r + selfR + safety;
        var clear = Math.sqrt(dx * dx + dy * dy) - rr;
        if (clear < minClear) minClear = clear;
        if (clear < 0) score += clear * 55 * early;
        else score += Math.min(clear, 140) * 2.2 * early;
      }
      var wd = Math.sqrt(dist2(x, y, arena.cx, arena.cy));
      var wall = arena.r - wd - TUNE.WALL_MARGIN - safety;
      if (wall < minWall) minWall = wall;
      if (wall < 0) score += wall * 30 * early;
      else score += Math.min(wall, 240) * 0.35 * early;
    }

    var foodScore = 0;
    if (foods.length && state.settings.foodPull > 0) {
      var stride = path.length > 16 ? 4 : 2;
      for (var p = 0; p < path.length; p += stride) {
        var px = path[p];
        var py = path[p + 1];
        var decay = 1.2 - 0.6 * (p / path.length);
        for (var f = 0; f < foods.length; f++) {
          var food = foods[f];
          var fd2 = dist2(px, py, food.x, food.y);
          if (fd2 < TUNE.FOOD_REACH * TUNE.FOOD_REACH) {
            var fd = Math.sqrt(fd2);
            foodScore += food.w * (1 - fd / TUNE.FOOD_REACH) * decay;
          }
        }
      }
      foodScore *= state.settings.foodPull;
      score += foodScore * TUNE.FOOD_WEIGHT;
    }

    // Prefer continuing in roughly the current direction. This is what
    // stops the planner from oscillating between two equally safe paths.
    score += Math.cos(angleDiff(target, startAng)) * 4;
    score += Math.cos(angleDiff(target, state.heading)) * TUNE.PREV_BONUS;

    return {
      score: score,
      minClear: minClear,
      minWall: minWall,
      foodScore: foodScore,
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
    var obstacles = threats.points.concat(selfBody);
    var selfR = snakeRadius(me);
    var safety = state.settings.safety;
    var baseSpeed = Math.max(TUNE.SPEED_MIN, num(me.sp, 5.5) * TUNE.SPEED_MULT);
    var speed = state.boost ? TUNE.BOOST_SPEED : baseSpeed;
    var base = num(me.ang, state.heading);
    var prev = isFinite(state.heading) ? state.heading : base;
    var candidates = [];
    var i;

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
      var res = evaluatePath(me, h, obstacles, foods, arena, selfR, safety, speed);
      if (!best || res.score > best.score) {
        best = {
          heading: h,
          score: res.score,
          minClear: res.minClear,
          minWall: res.minWall,
          foodScore: res.foodScore
        };
      }
    }
    if (!best) return null;

    var mode = 'cruise';
    if (best.minClear < 0) mode = 'escape';
    else if (best.minClear < TUNE.DANGER_CLEAR) mode = 'danger';
    else if (threats.heads.length > 0) mode = 'avoid';
    else if (best.foodScore > 0.5) mode = 'farm';

    var boost = now < state.boostUntil;
    if (!boost && now > state.boostCooldownUntil && state.settings.boostEscape &&
        num(me.sct, 0) >= 12 && best.minClear < TUNE.BOOST_CLEAR && best.minWall > 60) {
      var nearest = nearestHead(me, threats.heads);
      if (nearest && nearest.d < 340) {
        var away = Math.atan2(me.yy - nearest.y, me.xx - nearest.x);
        if (Math.abs(angleDiff(best.heading, away)) < 1) {
          state.boostUntil = now + TUNE.BOOST_MS;
          state.boostCooldownUntil = now + TUNE.BOOST_MS + 1200;
          boost = true;
        }
      }
    }
    if (boost && best.minWall < 40) {
      boost = false;
      state.boostUntil = 0;
    }

    return {
      heading: best.heading,
      minClear: best.minClear,
      minWall: best.minWall,
      foodScore: best.foodScore,
      mode: mode,
      boost: boost,
      threatCount: threats.heads.length
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

  function makeSnapshot(me, arena, threats, foods, heading) {
    return {
      me: { x: num(me.xx, 0), y: num(me.yy, 0), ang: num(me.ang, 0) },
      arena: arena,
      heading: heading,
      threats: threats.points.slice(0, 180),
      heads: threats.heads,
      foods: foods.slice(0, 40)
    };
  }

  function controlTick(me, now) {
    var arena = arenaInfo();
    var threats = collectThreats(me);
    var selfBody = collectSelfBody(me);
    var foods = collectFoods(me);
    var plan = choosePlan(me, threats, selfBody, foods, arena, now);
    if (!plan) return;

    state.heading = plan.heading;
    state.clearance = plan.minClear;
    state.threats = plan.threatCount;
    state.mode = plan.mode;
    state.boost = !!plan.boost;
    applySteering(plan.heading, state.boost);
    state.snapshot = makeSnapshot(me, arena, threats, foods, plan.heading);
    state.lastRadarAt = now;
  }

  function sampleSnapshot(me, now) {
    var arena = arenaInfo();
    var threats = collectThreats(me);
    var foods = collectFoods(me);
    state.snapshot = makeSnapshot(me, arena, threats, foods, num(me.ang, 0));
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
      '.pill[data-mode="cruise"]{color:#bae6fd;border-color:#1d4f6b;background:#0c1c26;}',
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
      '    <div class="radarwrap">',
      '      <canvas class="radar" id="radar" width="220" height="220"></canvas>',
      '      <span class="radarlabel">1,200 unit radar</span>',
      '    </div>',
      '    <div class="actions">',
      '      <button type="button" class="btn primary" id="takeBtn">Take over</button>',
      '      <button type="button" class="btn ghost" id="releaseBtn" disabled>Release</button>',
      '    </div>',
      '    <label class="check"><input type="checkbox" id="autoArm"> Re-arm after death</label>',
      '    <div class="slider"><span>Safety</span><input type="range" id="safety" min="4" max="40" step="1"><output id="safetyOut">18</output></div>',
      '    <div class="slider"><span>Food pull</span><input type="range" id="foodPull" min="0" max="2" step="0.1"><output id="foodPullOut">1.0</output></div>',
      '    <label class="check"><input type="checkbox" id="boostEscape"> Boost only to escape</label>',
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

    els.safety.value = state.settings.safety;
    els.safetyOut.textContent = state.settings.safety;
    els.foodPull.value = state.settings.foodPull;
    els.foodPullOut.textContent = Number(state.settings.foodPull).toFixed(1);
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
    var scale = (Math.min(w, h) / 2 - 10) / TUNE.RADAR_RANGE;

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

    // Food.
    ctx.fillStyle = 'rgba(74,222,128,.7)';
    for (var f = 0; f < snap.foods.length; f++) {
      var food = snap.foods[f];
      var fx = cx + (food.x - snap.me.x) * scale;
      var fy = cy + (food.y - snap.me.y) * scale;
      if (fx < 0 || fy < 0 || fx > w || fy > h) continue;
      ctx.fillRect(fx - 1.25, fy - 1.25, 2.5, 2.5);
    }

    // Threats: body points as small orange dots, heads as red dots.
    for (var t = 0; t < snap.threats.length; t++) {
      var th = snap.threats[t];
      var tx = cx + (th.x - snap.me.x) * scale;
      var ty = cy + (th.y - snap.me.y) * scale;
      if (tx < -10 || ty < -10 || tx > w + 10 || ty > h + 10) continue;
      if (th.head) {
        ctx.fillStyle = th.ghost ? 'rgba(251,113,133,.35)' : 'rgba(251,113,133,.95)';
        ctx.beginPath();
        ctx.arc(tx, ty, th.ghost ? 2 : 3.2, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(251,146,60,.65)';
        ctx.fillRect(tx - 1, ty - 1, 2, 2);
      }
    }

    // Planned heading.
    var hx = Math.cos(snap.heading || 0);
    var hy = Math.sin(snap.heading || 0);
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + hx * 18, cy + hy * 18);
    ctx.stroke();

    // Self.
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
        collectThreats: collectThreats,
        collectSelfBody: collectSelfBody,
        collectFoods: collectFoods,
        arenaInfo: arenaInfo
      }
    };

    console.info('[trainer] panel ready v' + VERSION +
      ' \u2014 it starts nothing; it takes over the run you already started.');
  }

  boot();
})();
