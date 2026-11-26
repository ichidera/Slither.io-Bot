// ==UserScript==
// @name         Slither.io Trainer Panel
// @namespace    https://github.com/ichidera/Slither.io-Bot
// @version      0.1.0
// @description  Injects a control panel that takes over your current slither.io run. It never starts a new session.
// @author       ichidera
// @license      MIT
// @match        *://slither.io/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/gh/ichidera/Slither.io-Bot@main/panel/trainer/trainer.js
// @downloadURL  https://raw.githubusercontent.com/ichidera/Slither.io-Bot/main/panel/trainer/trainer.user.js
// @updateURL    https://raw.githubusercontent.com/ichidera/Slither.io-Bot/main/panel/trainer/trainer.user.js
// ==/UserScript==

/*
 * trainer.js is loaded by @require above. If you use a fork, a different
 * branch, or a local copy, update the @require URL to point at your copy.
 *
 * The fallback below only reports a load failure; it never creates a run
 * or touches the game.
 */
(function () {
  'use strict';

  setTimeout(function () {
    if (window.__slitherTrainer && window.__slitherTrainer.version) return;
    var box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'right:16px',
      'top:16px',
      'z-index:2147483647',
      'max-width:340px',
      'padding:10px 12px',
      'border-radius:8px',
      'background:#2a0d13',
      'color:#fecdd3',
      'border:1px solid #7f1d2d',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'box-shadow:0 12px 30px rgba(0,0,0,.5)'
    ].join(';');
    box.textContent = 'Slither Trainer: trainer.js did not load. Check the @require URL, or paste panel/trainer/trainer.js into the DevTools console.';
    document.documentElement.appendChild(box);
    setTimeout(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    }, 12000);
  }, 4000);
})();
