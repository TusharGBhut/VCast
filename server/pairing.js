'use strict';
const crypto = require('crypto');

const { EXPECT_TV_MS, CODE_DIGITS, MAX_TVS, FORGET_TV_AFTER_MS, DEFAULT_CODE_LIFE_SECONDS, DEFAULT_WRONG_CODES_PER_MINUTE } = require('./constants');

function shortId(id) {
  return String(id).slice(0, 6);
}

// Keeps the list of TVs. A TV page stores its own id, so after a network drop or a page reload
// it gets its old record back and stays paired.
class Pairing {
  constructor(options) {
    options = options || {};
    this.codeLifeMs = (options.codeLifeSeconds || DEFAULT_CODE_LIFE_SECONDS) * 1000;
    this.wrongCodesPerMinute = options.wrongCodesPerMinute || DEFAULT_WRONG_CODES_PER_MINUTE;
    this.now = options.now || Date.now;
    this.onTvForgotten = options.onTvForgotten || (() => {});
    this.tvs = new Map();
    this.wrongCodeTimes = [];
    this.expected = null;
  }

  // Called when the server has told a TV to open the page. The page link carries `key`; the TV
  // that connects with it is paired straight away to `session`, with no code to type.
  expectTv() {
    // Asking again while still waiting (an impatient second click) keeps the same key, so the
    // page the TV is already loading still pairs.
    if (this.expected && this.expected.endsAt > this.now()) {
      this.expected.endsAt = this.now() + EXPECT_TV_MS;
      return this.expected;
    }
    this.expected = {
      key: crypto.randomBytes(18).toString('base64url'),
      session: crypto.randomBytes(24).toString('base64url'),
      endsAt: this.now() + EXPECT_TV_MS
    };
    return this.expected;
  }

  isWaitingFor(session) {
    return !!session && !!this.expected && this.expected.session === session && this.expected.endsAt > this.now();
  }

  connectTv(id, socket, key) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || '')) id = crypto.randomBytes(12).toString('base64url');
    let tv = this.tvs.get(id);
    if (!tv) {
      if (this.tvs.size >= MAX_TVS && !this.forgetOneTv()) return null;
      tv = { id, socket: null, code: null, codeEndsAt: 0, session: null, cast: null, playback: null, lastSeen: 0 };
      this.tvs.set(id, tv);
    }
    if (tv.socket && tv.socket !== socket) tv.socket.close();
    tv.socket = socket;
    tv.lastSeen = this.now();
    if (key && this.expected && key === this.expected.key && this.expected.endsAt > this.now()) {
      tv.session = this.expected.session;
      tv.code = null;
      this.expected = null;
    }
    return tv;
  }

  disconnectTv(tv, socket) {
    if (tv.socket !== socket) return;
    tv.socket = null;
    tv.lastSeen = this.now();
  }

  forget(tv) {
    this.tvs.delete(tv.id);
    this.onTvForgotten(tv);
  }

  // Makes room for a new TV by dropping one that is offline, unpaired ones first.
  // A connected TV is never dropped. Returns false when there is no room.
  forgetOneTv() {
    const offline = [...this.tvs.values()].filter((tv) => !tv.socket);
    const pick = offline.find((tv) => !tv.session) || offline[0];
    if (pick) this.forget(pick);
    return !!pick;
  }

  // Gives the TV's code, making a new one when there is none or it ran out.
  // `isNew` tells the caller the TV screen needs updating.
  codeFor(tv) {
    if (tv.code && tv.codeEndsAt > this.now()) return { code: tv.code, isNew: false };
    let code;
    do {
      code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    } while ([...this.tvs.values()].some((other) => other.code === code));
    tv.code = code;
    tv.codeEndsAt = this.now() + this.codeLifeMs;
    return { code, isNew: true };
  }

  pairWithCode(code) {
    const now = this.now();
    this.wrongCodeTimes = this.wrongCodeTimes.filter((time) => now - time < 60000);
    if (this.wrongCodeTimes.length >= this.wrongCodesPerMinute) return { error: 'too_many_tries' };
    code = String(code || '').replace(/\D/g, '');
    for (const tv of this.tvs.values()) {
      if (!tv.session && tv.socket && tv.code === code && tv.codeEndsAt > now) {
        tv.code = null;
        tv.codeEndsAt = 0;
        tv.session = crypto.randomBytes(24).toString('base64url');
        return { tv, session: tv.session };
      }
    }
    this.wrongCodeTimes.push(now);
    return { error: 'bad_code' };
  }

  findBySession(session) {
    if (!session) return null;
    return [...this.tvs.values()].find((tv) => tv.session === session) || null;
  }

  unpair(tv) {
    tv.session = null;
    tv.cast = null;
    tv.playback = null;
  }

  // Removes TVs that have been offline for a long time and returns them.
  removeOldTvs() {
    const now = this.now();
    const removed = [...this.tvs.values()].filter((tv) => !tv.socket && now - tv.lastSeen > FORGET_TV_AFTER_MS);
    removed.forEach((tv) => this.forget(tv));
    return removed;
  }
}

module.exports = { Pairing, shortId };
