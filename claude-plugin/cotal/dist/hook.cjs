"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/types.js
var require_types = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.RepublishHeaders = exports2.DirectMsgHeaders = exports2.JsHeaders = exports2.AdvisoryKind = void 0;
    exports2.isOrderedPushConsumerOptions = isOrderedPushConsumerOptions;
    exports2.isPullConsumer = isPullConsumer;
    exports2.isPushConsumer = isPushConsumer;
    exports2.isBoundPushConsumerOptions = isBoundPushConsumerOptions;
    function isOrderedPushConsumerOptions(v) {
      if (v && typeof v === "object") {
        return "name_prefix" in v || "deliver_subject_prefix" in v || "filter_subjects" in v || "filter_subject" in v || "deliver_policy" in v || "opt_start_seq" in v || "opt_start_time" in v || "replay_policy" in v || "inactive_threshold" in v || "headers_only" in v || "deliver_prefix" in v;
      }
      return false;
    }
    function isPullConsumer(v) {
      return v.isPullConsumer();
    }
    function isPushConsumer(v) {
      return v.isPushConsumer();
    }
    function isBoundPushConsumerOptions(v) {
      if (v && typeof v === "object") {
        return "deliver_subject" in v || "deliver_group" in v || "idle_heartbeat" in v;
      }
      return false;
    }
    exports2.AdvisoryKind = {
      API: "api_audit",
      StreamAction: "stream_action",
      ConsumerAction: "consumer_action",
      SnapshotCreate: "snapshot_create",
      SnapshotComplete: "snapshot_complete",
      RestoreCreate: "restore_create",
      RestoreComplete: "restore_complete",
      MaxDeliver: "max_deliver",
      Terminated: "terminated",
      Ack: "consumer_ack",
      StreamLeaderElected: "stream_leader_elected",
      StreamQuorumLost: "stream_quorum_lost",
      ConsumerLeaderElected: "consumer_leader_elected",
      ConsumerQuorumLost: "consumer_quorum_lost"
    };
    exports2.JsHeaders = {
      /**
       * Set if message is from a stream source - format is `stream seq`
       */
      StreamSourceHdr: "Nats-Stream-Source",
      /**
       * Set for heartbeat messages
       */
      LastConsumerSeqHdr: "Nats-Last-Consumer",
      /**
       * Set for heartbeat messages
       */
      LastStreamSeqHdr: "Nats-Last-Stream",
      /**
       * Set for heartbeat messages if the consumer is stalled, reply subject
       * will unstall the client when the client responds
       */
      ConsumerStalledHdr: "Nats-Consumer-Stalled",
      /**
       * Set for headers_only consumers indicates the number of bytes in the payload
       */
      MessageSizeHdr: "Nats-Msg-Size",
      // rollup header
      RollupHdr: "Nats-Rollup",
      // value for rollup header when rolling up a subject
      RollupValueSubject: "sub",
      // value for rollup header when rolling up all subjects
      RollupValueAll: "all",
      /**
       * Set on protocol messages to indicate pull request message count that
       * was not honored.
       */
      PendingMessagesHdr: "Nats-Pending-Messages",
      /**
       * Set on protocol messages to indicate pull request byte count that
       * was not honored
       */
      PendingBytesHdr: "Nats-Pending-Bytes",
      /**
       * Asserts a minimum JetStream API level on a JS API request (ADR-44).
       */
      RequiredApiLevel: "Nats-Required-Api-Level"
    };
    exports2.DirectMsgHeaders = {
      Stream: "Nats-Stream",
      Sequence: "Nats-Sequence",
      TimeStamp: "Nats-Time-Stamp",
      Subject: "Nats-Subject",
      LastSequence: "Nats-Last-Sequence",
      NumPending: "Nats-Num-Pending"
    };
    exports2.RepublishHeaders = {
      /**
       * The source stream of the message
       */
      Stream: "Nats-Stream",
      /**
       * The original subject of the message
       */
      Subject: "Nats-Subject",
      /**
       * The sequence of the republished message
       */
      Sequence: "Nats-Sequence",
      /**
       * The stream sequence id of the last message ingested to the same original subject (or 0 if none or deleted)
       */
      LastSequence: "Nats-Last-Sequence",
      /**
       * The size in bytes of the message's body - Only if {@link Republish#headers_only} is set.
       */
      Size: "Nats-Msg-Size"
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/encoders.js
var require_encoders = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/encoders.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TD = exports2.TE = exports2.Empty = void 0;
    exports2.encode = encode;
    exports2.decode = decode2;
    exports2.Empty = new Uint8Array(0);
    exports2.TE = new TextEncoder();
    exports2.TD = new TextDecoder();
    function concat(...bufs) {
      let max = 0;
      for (let i = 0; i < bufs.length; i++) {
        max += bufs[i].length;
      }
      const out = new Uint8Array(max);
      let index = 0;
      for (let i = 0; i < bufs.length; i++) {
        out.set(bufs[i], index);
        index += bufs[i].length;
      }
      return out;
    }
    function encode(...a) {
      const bufs = [];
      for (let i = 0; i < a.length; i++) {
        bufs.push(exports2.TE.encode(a[i]));
      }
      if (bufs.length === 0) {
        return exports2.Empty;
      }
      if (bufs.length === 1) {
        return bufs[0];
      }
      return concat(...bufs);
    }
    function decode2(a) {
      if (!a || a.length === 0) {
        return "";
      }
      return exports2.TD.decode(a);
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/errors.js
var require_errors = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/errors.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.errors = exports2.PermissionViolationError = exports2.NoRespondersError = exports2.TimeoutError = exports2.RequestError = exports2.ProtocolError = exports2.ConnectionError = exports2.DrainingConnectionError = exports2.ClosedConnectionError = exports2.AuthorizationError = exports2.UserAuthenticationExpiredError = exports2.InvalidOperationError = exports2.InvalidArgumentError = exports2.InvalidSubjectError = void 0;
    var InvalidSubjectError = class extends Error {
      constructor(subject, options) {
        super(`illegal subject: '${subject}'`, options);
        this.name = "InvalidSubjectError";
      }
    };
    exports2.InvalidSubjectError = InvalidSubjectError;
    var InvalidArgumentError = class _InvalidArgumentError extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "InvalidArgumentError";
      }
      static format(property, message, options) {
        if (Array.isArray(message) && message.length > 1) {
          message = message[0];
        }
        if (Array.isArray(property)) {
          property = property.map((n) => `'${n}'`);
          property = property.join(",");
        } else {
          property = `'${property}'`;
        }
        return new _InvalidArgumentError(`${property} ${message}`, options);
      }
    };
    exports2.InvalidArgumentError = InvalidArgumentError;
    var InvalidOperationError = class extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "InvalidOperationError";
      }
    };
    exports2.InvalidOperationError = InvalidOperationError;
    var UserAuthenticationExpiredError2 = class _UserAuthenticationExpiredError extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "UserAuthenticationExpiredError";
      }
      static parse(s) {
        const ss = s.toLowerCase();
        if (ss.indexOf("user authentication expired") !== -1) {
          return new _UserAuthenticationExpiredError(s);
        }
        return null;
      }
    };
    exports2.UserAuthenticationExpiredError = UserAuthenticationExpiredError2;
    var AuthorizationError2 = class _AuthorizationError extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "AuthorizationError";
      }
      static parse(s) {
        const messages = [
          "authorization violation",
          "account authentication expired",
          "authentication timeout"
        ];
        const ss = s.toLowerCase();
        for (let i = 0; i < messages.length; i++) {
          if (ss.indexOf(messages[i]) !== -1) {
            return new _AuthorizationError(s);
          }
        }
        return null;
      }
    };
    exports2.AuthorizationError = AuthorizationError2;
    var ClosedConnectionError2 = class extends Error {
      constructor() {
        super("closed connection");
        this.name = "ClosedConnectionError";
      }
    };
    exports2.ClosedConnectionError = ClosedConnectionError2;
    var DrainingConnectionError = class extends Error {
      constructor() {
        super("connection draining");
        this.name = "DrainingConnectionError";
      }
    };
    exports2.DrainingConnectionError = DrainingConnectionError;
    var ConnectionError = class extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "ConnectionError";
      }
    };
    exports2.ConnectionError = ConnectionError;
    var ProtocolError = class extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "ProtocolError";
      }
    };
    exports2.ProtocolError = ProtocolError;
    var RequestError2 = class extends Error {
      constructor(message = "", options) {
        super(message, options);
        this.name = "RequestError";
      }
      isNoResponders() {
        return this.cause instanceof NoRespondersError2;
      }
    };
    exports2.RequestError = RequestError2;
    var TimeoutError2 = class extends Error {
      constructor(options) {
        super("timeout", options);
        this.name = "TimeoutError";
      }
    };
    exports2.TimeoutError = TimeoutError2;
    var NoRespondersError2 = class extends Error {
      subject;
      constructor(subject, options) {
        super(`no responders: '${subject}'`, options);
        this.subject = subject;
        this.name = "NoResponders";
      }
    };
    exports2.NoRespondersError = NoRespondersError2;
    var PermissionViolationError4 = class _PermissionViolationError extends Error {
      operation;
      subject;
      queue;
      constructor(message, operation, subject, queue, options) {
        super(message, options);
        this.name = "PermissionViolationError";
        this.operation = operation;
        this.subject = subject;
        this.queue = queue;
      }
      static parse(s) {
        const t = s ? s.toLowerCase() : "";
        if (t.indexOf("permissions violation") === -1) {
          return null;
        }
        let operation = "publish";
        let subject = "";
        let queue = void 0;
        const m = s.match(/(Publish|Subscription) to "(\S+)"/);
        if (m) {
          operation = m[1].toLowerCase();
          subject = m[2];
          if (operation === "subscription") {
            const qm = s.match(/using queue "(\S+)"/);
            if (qm) {
              queue = qm[1];
            }
          }
        }
        return new _PermissionViolationError(s, operation, subject, queue);
      }
    };
    exports2.PermissionViolationError = PermissionViolationError4;
    exports2.errors = {
      AuthorizationError: AuthorizationError2,
      ClosedConnectionError: ClosedConnectionError2,
      ConnectionError,
      DrainingConnectionError,
      InvalidArgumentError,
      InvalidOperationError,
      InvalidSubjectError,
      NoRespondersError: NoRespondersError2,
      PermissionViolationError: PermissionViolationError4,
      ProtocolError,
      RequestError: RequestError2,
      TimeoutError: TimeoutError2,
      UserAuthenticationExpiredError: UserAuthenticationExpiredError2
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/util.js
var require_util = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.SimpleMutex = exports2.Perf = void 0;
    exports2.extend = extend;
    exports2.render = render;
    exports2.timeout = timeout;
    exports2.delay = delay;
    exports2.deadline = deadline;
    exports2.deferred = deferred;
    exports2.debugDeferred = debugDeferred;
    exports2.shuffle = shuffle;
    exports2.collect = collect;
    exports2.jitter = jitter;
    exports2.backoff = backoff;
    exports2.nanos = nanos6;
    exports2.millis = millis;
    exports2.randomToken = randomToken;
    var encoders_1 = require_encoders();
    var errors_1 = require_errors();
    function extend(a, ...b) {
      for (let i = 0; i < b.length; i++) {
        const o = b[i];
        Object.keys(o).forEach(function(k) {
          a[k] = o[k];
        });
      }
      return a;
    }
    function render(frame) {
      const cr = "\u240D";
      const lf = "\u240A";
      return encoders_1.TD.decode(frame).replace(/\n/g, lf).replace(/\r/g, cr);
    }
    function timeout(ms, asyncTraces = true) {
      const err = asyncTraces ? new errors_1.TimeoutError() : null;
      let methods;
      let timer;
      const p = new Promise((_resolve, reject) => {
        const cancel = () => {
          if (timer) {
            clearTimeout(timer);
          }
        };
        methods = { cancel };
        timer = setTimeout(() => {
          if (err === null) {
            reject(new errors_1.TimeoutError());
          } else {
            reject(err);
          }
        }, ms);
      });
      return Object.assign(p, methods);
    }
    function delay(ms = 0) {
      let methods;
      const p = new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, ms);
        const cancel = () => {
          if (timer) {
            clearTimeout(timer);
            resolve();
          }
        };
        methods = { cancel };
      });
      return Object.assign(p, methods);
    }
    async function deadline(p, millis2 = 1e3) {
      const d = deferred();
      const timer = setTimeout(() => {
        d.reject(new errors_1.TimeoutError());
      }, millis2);
      try {
        return await Promise.race([p, d]);
      } finally {
        clearTimeout(timer);
      }
    }
    function deferred() {
      let methods = {};
      const p = new Promise((resolve, reject) => {
        methods = { resolve, reject };
      });
      return Object.assign(p, methods);
    }
    function debugDeferred() {
      let methods = {};
      const p = new Promise((resolve, reject) => {
        methods = {
          resolve: (v) => {
            console.trace("resolve", v);
            resolve(v);
          },
          reject: (err) => {
            console.trace("reject");
            reject(err);
          }
        };
      });
      return Object.assign(p, methods);
    }
    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    async function collect(iter) {
      const buf = [];
      for await (const v of iter) {
        buf.push(v);
      }
      return buf;
    }
    var Perf = class {
      timers;
      measures;
      constructor() {
        this.timers = /* @__PURE__ */ new Map();
        this.measures = /* @__PURE__ */ new Map();
      }
      mark(key) {
        this.timers.set(key, performance.now());
      }
      measure(key, startKey, endKey) {
        const s = this.timers.get(startKey);
        if (s === void 0) {
          throw new Error(`${startKey} is not defined`);
        }
        const e = this.timers.get(endKey);
        if (e === void 0) {
          throw new Error(`${endKey} is not defined`);
        }
        this.measures.set(key, e - s);
      }
      getEntries() {
        const values = [];
        this.measures.forEach((v, k) => {
          values.push({ name: k, duration: v });
        });
        return values;
      }
    };
    exports2.Perf = Perf;
    var SimpleMutex = class {
      max;
      current;
      waiting;
      /**
       * @param max number of concurrent operations
       */
      constructor(max = 1) {
        this.max = max;
        this.current = 0;
        this.waiting = [];
      }
      /**
       * Returns a promise that resolves when the mutex is acquired
       */
      lock() {
        this.current++;
        if (this.current <= this.max) {
          return Promise.resolve();
        }
        const d = deferred();
        this.waiting.push(d);
        return d;
      }
      /**
       * Release an acquired mutex - must be called
       */
      unlock() {
        this.current--;
        const d = this.waiting.pop();
        d?.resolve();
      }
    };
    exports2.SimpleMutex = SimpleMutex;
    function jitter(n) {
      if (n === 0) {
        return 0;
      }
      return Math.floor(n / 2 + Math.random() * n);
    }
    function backoff(policy = [0, 250, 250, 500, 500, 3e3, 5e3]) {
      if (!Array.isArray(policy)) {
        policy = [0, 250, 250, 500, 500, 3e3, 5e3];
      }
      const max = policy.length - 1;
      return {
        backoff(attempt) {
          return jitter(attempt > max ? policy[max] : policy[attempt]);
        }
      };
    }
    function nanos6(millis2) {
      return millis2 * 1e6;
    }
    function millis(ns) {
      return Math.floor(ns / 1e6);
    }
    var tokenDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var tokenDigitCodes = new Uint8Array(62);
    for (let i = 0; i < 62; i++)
      tokenDigitCodes[i] = tokenDigits.charCodeAt(i);
    var tokenSpace = 218340105584896;
    function randomToken() {
      let n = Math.floor(Math.random() * tokenSpace);
      let d = n % 62;
      const c0 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c1 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c2 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c3 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c4 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c5 = tokenDigitCodes[d];
      n = (n - d) / 62;
      d = n % 62;
      const c6 = tokenDigitCodes[d];
      n = (n - d) / 62;
      const c7 = tokenDigitCodes[n];
      return String.fromCharCode(c0, c1, c2, c3, c4, c5, c6, c7);
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nuid@3.0.0/node_modules/@nats-io/nuid/lib/nuid.js
var require_nuid = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nuid@3.0.0/node_modules/@nats-io/nuid/lib/nuid.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nuid = exports2.NuidImpl = void 0;
    var digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var base = 62;
    var preLen = 12;
    var seqLen = 10;
    var minInc = 33;
    var maxInc = 333;
    var totalLen = preLen + seqLen;
    var DIGIT_CODES = new Uint8Array(base);
    for (let i = 0; i < base; i++)
      DIGIT_CODES[i] = digits.charCodeAt(i);
    var TWO32 = 4294967296;
    var MAX_SEQ = BigInt(base) ** BigInt(seqLen);
    var MAX_HI = Number(MAX_SEQ / (1n << 32n));
    var MAX_LO = Number(MAX_SEQ % (1n << 32n));
    function _getRandomValues(a) {
      for (let i = 0; i < a.length; i++) {
        a[i] = Math.floor(Math.random() * 256);
      }
    }
    function fillRandom(a) {
      if (globalThis?.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(a);
      } else {
        _getRandomValues(a);
      }
    }
    var NuidImpl = class {
      buf;
      cbuf;
      seqHi;
      seqLo;
      inc;
      inited;
      constructor() {
        this.buf = new Uint8Array(totalLen);
        this.cbuf = new Uint8Array(preLen);
        this.inited = false;
      }
      /**
       * Initializes a nuid with a crypto random prefix,
       * and pseudo-random sequence and increment. This function
       * is only called if any api on a nuid is called.
       *
       * @ignore
       */
      init() {
        this.inited = true;
        this.setPre();
        this.initSeqAndInc();
        this.fillSeq();
      }
      /**
       * Initializes the pseudo random sequence number and the increment range.
       * @ignore
       */
      initSeqAndInc() {
        let tries = 0;
        do {
          this.seqHi = Math.floor(Math.random() * (MAX_HI + 1));
          this.seqLo = Math.floor(Math.random() * TWO32);
        } while (tries++ < 8 && this.seqHi === MAX_HI && this.seqLo >= MAX_LO);
        if (this.seqHi === MAX_HI && this.seqLo >= MAX_LO) {
          this.seqLo = 0;
        }
        this.inc = Math.random() * (maxInc - minInc) + minInc | 0;
      }
      /**
       * Sets the prefix from crypto random bytes. Converts them to base62.
       *
       * @ignore
       */
      setPre() {
        fillRandom(this.cbuf);
        for (let i = 0; i < preLen; i++) {
          this.buf[i] = DIGIT_CODES[this.cbuf[i] % base];
        }
      }
      /**
       * Fills the sequence portion of the buffer as base62 from
       * the split-int seq (seqHi, seqLo). Performs long division
       * by 62 over the 64-bit value using doubles only — no bigint.
       *
       * @ignore
       */
      fillSeq() {
        let hi = this.seqHi;
        let lo = this.seqLo;
        for (let i = totalLen - 1; i >= preLen; i--) {
          const hiQ = Math.floor(hi / base);
          const hiR = hi - hiQ * base;
          const combined = hiR * TWO32 + lo;
          const loQ = Math.floor(combined / base);
          const rem = combined - loQ * base;
          this.buf[i] = DIGIT_CODES[rem];
          hi = hiQ;
          lo = loQ;
        }
      }
      /**
       * Returns the next nuid.
       */
      next() {
        if (!this.inited) {
          this.init();
        }
        this.seqLo += this.inc;
        if (this.seqLo >= TWO32) {
          this.seqLo -= TWO32;
          this.seqHi += 1;
        }
        if (this.seqHi > MAX_HI || this.seqHi === MAX_HI && this.seqLo >= MAX_LO) {
          this.setPre();
          this.initSeqAndInc();
        }
        this.fillSeq();
        const b = this.buf;
        return String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15], b[16], b[17], b[18], b[19], b[20], b[21]);
      }
      /**
       * Resets the prefix and counter for the nuid. This is typically
       * called automatically from within next() if the current sequence
       * exceeds the resolution of the nuid.
       */
      reset() {
        this.init();
      }
    };
    exports2.NuidImpl = NuidImpl;
    exports2.nuid = new NuidImpl();
  }
});

// ../../node_modules/.pnpm/@nats-io+nuid@3.0.0/node_modules/@nats-io/nuid/lib/mod.js
var require_mod = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nuid@3.0.0/node_modules/@nats-io/nuid/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nuid = exports2.Nuid = void 0;
    var nuid_ts_1 = require_nuid();
    exports2.Nuid = nuid_ts_1.NuidImpl;
    exports2.nuid = nuid_ts_1.nuid;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nuid.js
var require_nuid2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nuid.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nuid = exports2.Nuid = void 0;
    var nuid_1 = require_mod();
    Object.defineProperty(exports2, "Nuid", { enumerable: true, get: function() {
      return nuid_1.Nuid;
    } });
    Object.defineProperty(exports2, "nuid", { enumerable: true, get: function() {
      return nuid_1.nuid;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/core.js
var require_core = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/core.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DEFAULT_HOST = exports2.DEFAULT_PORT = exports2.Match = void 0;
    exports2.syncIterator = syncIterator;
    exports2.createInbox = createInbox;
    var nuid_1 = require_nuid2();
    var errors_1 = require_errors();
    exports2.Match = {
      // Exact option is case-sensitive
      Exact: "exact",
      // Case-sensitive, but key is transformed to Canonical MIME representation
      CanonicalMIME: "canonical",
      // Case-insensitive matches
      IgnoreCase: "insensitive"
    };
    function syncIterator(src) {
      const iter = src[Symbol.asyncIterator]();
      return {
        async next() {
          const m = await iter.next();
          if (m.done) {
            return Promise.resolve(null);
          }
          return Promise.resolve(m.value);
        }
      };
    }
    function createInbox(prefix = "") {
      prefix = prefix || "_INBOX";
      if (typeof prefix !== "string") {
        throw new TypeError("prefix must be a string");
      }
      prefix.split(".").forEach((v) => {
        if (v === "*" || v === ">") {
          throw errors_1.InvalidArgumentError.format("prefix", `cannot have wildcards ('${prefix}')`);
        }
      });
      return `${prefix}.${nuid_1.nuid.next()}`;
    }
    exports2.DEFAULT_PORT = 4222;
    exports2.DEFAULT_HOST = "127.0.0.1";
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/databuffer.js
var require_databuffer = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/databuffer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DataBuffer = void 0;
    var encoders_1 = require_encoders();
    var DataBuffer = class {
      buffers;
      byteLength;
      constructor() {
        this.buffers = [];
        this.byteLength = 0;
      }
      static concat(...bufs) {
        let max = 0;
        for (let i = 0; i < bufs.length; i++) {
          max += bufs[i].length;
        }
        const out = new Uint8Array(max);
        let index = 0;
        for (let i = 0; i < bufs.length; i++) {
          out.set(bufs[i], index);
          index += bufs[i].length;
        }
        return out;
      }
      static fromAscii(m) {
        if (!m) {
          m = "";
        }
        return encoders_1.TE.encode(m);
      }
      static toAscii(a) {
        return encoders_1.TD.decode(a);
      }
      reset() {
        this.buffers.length = 0;
        this.byteLength = 0;
      }
      pack() {
        if (this.buffers.length > 1) {
          const v = new Uint8Array(this.byteLength);
          let index = 0;
          for (let i = 0; i < this.buffers.length; i++) {
            v.set(this.buffers[i], index);
            index += this.buffers[i].length;
          }
          this.buffers.length = 0;
          this.buffers.push(v);
        }
      }
      shift() {
        if (this.buffers.length) {
          const a = this.buffers.shift();
          if (a) {
            this.byteLength -= a.length;
            return a;
          }
        }
        return new Uint8Array(0);
      }
      drain(n) {
        if (this.buffers.length) {
          this.pack();
          const v = this.buffers.pop();
          if (v) {
            const max = this.byteLength;
            if (n === void 0 || n > max) {
              n = max;
            }
            const d = v.subarray(0, n);
            if (max > n) {
              this.buffers.push(v.subarray(n));
            }
            this.byteLength = max - n;
            return d;
          }
        }
        return new Uint8Array(0);
      }
      fill(a, ...bufs) {
        if (a) {
          this.buffers.push(a);
          this.byteLength += a.length;
        }
        for (let i = 0; i < bufs.length; i++) {
          if (bufs[i] && bufs[i].length) {
            this.buffers.push(bufs[i]);
            this.byteLength += bufs[i].length;
          }
        }
      }
      peek() {
        if (this.buffers.length) {
          this.pack();
          return this.buffers[0];
        }
        return new Uint8Array(0);
      }
      size() {
        return this.byteLength;
      }
      length() {
        return this.buffers.length;
      }
    };
    exports2.DataBuffer = DataBuffer;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/transport.js
var require_transport = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/transport.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LF = exports2.CR = exports2.CRLF = exports2.CR_LF_LEN = exports2.CR_LF = void 0;
    exports2.setTransportFactory = setTransportFactory;
    exports2.defaultPort = defaultPort;
    exports2.getUrlParseFn = getUrlParseFn;
    exports2.newTransport = newTransport;
    exports2.getResolveFn = getResolveFn;
    exports2.protoLen = protoLen;
    exports2.extractProtocolMessage = extractProtocolMessage;
    var encoders_1 = require_encoders();
    var core_1 = require_core();
    var databuffer_1 = require_databuffer();
    var transportConfig;
    function setTransportFactory(config) {
      transportConfig = config;
    }
    function defaultPort() {
      return transportConfig !== void 0 && transportConfig.defaultPort !== void 0 ? transportConfig.defaultPort : core_1.DEFAULT_PORT;
    }
    function getUrlParseFn() {
      return transportConfig !== void 0 && transportConfig.urlParseFn ? transportConfig.urlParseFn : void 0;
    }
    function newTransport() {
      if (!transportConfig || typeof transportConfig.factory !== "function") {
        throw new Error("transport fn is not set");
      }
      return transportConfig.factory();
    }
    function getResolveFn() {
      return transportConfig !== void 0 && transportConfig.dnsResolveFn ? transportConfig.dnsResolveFn : void 0;
    }
    exports2.CR_LF = "\r\n";
    exports2.CR_LF_LEN = exports2.CR_LF.length;
    exports2.CRLF = databuffer_1.DataBuffer.fromAscii(exports2.CR_LF);
    exports2.CR = new Uint8Array(exports2.CRLF)[0];
    exports2.LF = new Uint8Array(exports2.CRLF)[1];
    function protoLen(ba) {
      for (let i = 0; i < ba.length; i++) {
        const n = i + 1;
        if (ba.byteLength > n && ba[i] === exports2.CR && ba[n] === exports2.LF) {
          return n + 1;
        }
      }
      return 0;
    }
    function extractProtocolMessage(a) {
      const len = protoLen(a);
      if (len > 0) {
        const ba = new Uint8Array(a);
        const out = ba.slice(0, len);
        return encoders_1.TD.decode(out);
      }
      return "";
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/ipparser.js
var require_ipparser = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/ipparser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ipV4 = ipV4;
    exports2.isIP = isIP;
    exports2.parseIP = parseIP;
    var IPv4LEN = 4;
    var IPv6LEN = 16;
    var ASCII0 = 48;
    var ASCII9 = 57;
    var ASCIIA = 65;
    var ASCIIF = 70;
    var ASCIIa = 97;
    var ASCIIf = 102;
    var big = 16777215;
    function ipV4(a, b, c, d) {
      const ip = new Uint8Array(IPv6LEN);
      const prefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255];
      prefix.forEach((v, idx) => {
        ip[idx] = v;
      });
      ip[12] = a;
      ip[13] = b;
      ip[14] = c;
      ip[15] = d;
      return ip;
    }
    function isIP(h) {
      return parseIP(h) !== void 0;
    }
    function parseIP(h) {
      for (let i = 0; i < h.length; i++) {
        switch (h[i]) {
          case ".":
            return parseIPv4(h);
          case ":":
            return parseIPv6(h);
        }
      }
      return;
    }
    function parseIPv4(s) {
      const ip = new Uint8Array(IPv4LEN);
      for (let i = 0; i < IPv4LEN; i++) {
        if (s.length === 0) {
          return void 0;
        }
        if (i > 0) {
          if (s[0] !== ".") {
            return void 0;
          }
          s = s.substring(1);
        }
        const { n, c, ok } = dtoi(s);
        if (!ok || n > 255) {
          return void 0;
        }
        s = s.substring(c);
        ip[i] = n;
      }
      return ipV4(ip[0], ip[1], ip[2], ip[3]);
    }
    function parseIPv6(s) {
      const ip = new Uint8Array(IPv6LEN);
      let ellipsis = -1;
      if (s.length >= 2 && s[0] === ":" && s[1] === ":") {
        ellipsis = 0;
        s = s.substring(2);
        if (s.length === 0) {
          return ip;
        }
      }
      let i = 0;
      while (i < IPv6LEN) {
        const { n, c, ok } = xtoi(s);
        if (!ok || n > 65535) {
          return void 0;
        }
        if (c < s.length && s[c] === ".") {
          if (ellipsis < 0 && i != IPv6LEN - IPv4LEN) {
            return void 0;
          }
          if (i + IPv4LEN > IPv6LEN) {
            return void 0;
          }
          const ip4 = parseIPv4(s);
          if (ip4 === void 0) {
            return void 0;
          }
          ip[i] = ip4[12];
          ip[i + 1] = ip4[13];
          ip[i + 2] = ip4[14];
          ip[i + 3] = ip4[15];
          s = "";
          i += IPv4LEN;
          break;
        }
        ip[i] = n >> 8;
        ip[i + 1] = n;
        i += 2;
        s = s.substring(c);
        if (s.length === 0) {
          break;
        }
        if (s[0] !== ":" || s.length == 1) {
          return void 0;
        }
        s = s.substring(1);
        if (s[0] === ":") {
          if (ellipsis >= 0) {
            return void 0;
          }
          ellipsis = i;
          s = s.substring(1);
          if (s.length === 0) {
            break;
          }
        }
      }
      if (s.length !== 0) {
        return void 0;
      }
      if (i < IPv6LEN) {
        if (ellipsis < 0) {
          return void 0;
        }
        const n = IPv6LEN - i;
        for (let j = i - 1; j >= ellipsis; j--) {
          ip[j + n] = ip[j];
        }
        for (let j = ellipsis + n - 1; j >= ellipsis; j--) {
          ip[j] = 0;
        }
      } else if (ellipsis >= 0) {
        return void 0;
      }
      return ip;
    }
    function dtoi(s) {
      let i = 0;
      let n = 0;
      for (i = 0; i < s.length && ASCII0 <= s.charCodeAt(i) && s.charCodeAt(i) <= ASCII9; i++) {
        n = n * 10 + (s.charCodeAt(i) - ASCII0);
        if (n >= big) {
          return { n: big, c: i, ok: false };
        }
      }
      if (i === 0) {
        return { n: 0, c: 0, ok: false };
      }
      return { n, c: i, ok: true };
    }
    function xtoi(s) {
      let n = 0;
      let i = 0;
      for (i = 0; i < s.length; i++) {
        if (ASCII0 <= s.charCodeAt(i) && s.charCodeAt(i) <= ASCII9) {
          n *= 16;
          n += s.charCodeAt(i) - ASCII0;
        } else if (ASCIIa <= s.charCodeAt(i) && s.charCodeAt(i) <= ASCIIf) {
          n *= 16;
          n += s.charCodeAt(i) - ASCIIa + 10;
        } else if (ASCIIA <= s.charCodeAt(i) && s.charCodeAt(i) <= ASCIIF) {
          n *= 16;
          n += s.charCodeAt(i) - ASCIIA + 10;
        } else {
          break;
        }
        if (n >= big) {
          return { n: 0, c: i, ok: false };
        }
      }
      if (i === 0) {
        return { n: 0, c: i, ok: false };
      }
      return { n, c: i, ok: true };
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/servers.js
var require_servers = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/servers.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Servers = exports2.ServerImpl = void 0;
    exports2.isIPV4OrHostname = isIPV4OrHostname;
    exports2.hostPort = hostPort;
    var transport_1 = require_transport();
    var util_1 = require_util();
    var ipparser_1 = require_ipparser();
    var core_1 = require_core();
    var errors_1 = require_errors();
    function isIPV4OrHostname(hp) {
      if (hp.indexOf("[") !== -1 || hp.indexOf("::") !== -1) {
        return false;
      }
      if (hp.indexOf(".") !== -1) {
        return true;
      }
      if (hp.split(":").length <= 2) {
        return true;
      }
      return false;
    }
    function isIPV6(hp) {
      return !isIPV4OrHostname(hp);
    }
    function filterIpv6MappedToIpv4(hp) {
      const prefix = "::FFFF:";
      const idx = hp.toUpperCase().indexOf(prefix);
      if (idx !== -1 && hp.indexOf(".") !== -1) {
        let ip = hp.substring(idx + prefix.length);
        ip = ip.replace("[", "");
        return ip.replace("]", "");
      }
      return hp;
    }
    function hostPort(u) {
      u = u.trim();
      if (u.match(/^(.*:\/\/)(.*)/m)) {
        u = u.replace(/^(.*:\/\/)(.*)/gm, "$2");
      }
      u = filterIpv6MappedToIpv4(u);
      if (isIPV6(u) && u.indexOf("[") === -1) {
        u = `[${u}]`;
      }
      const op = isIPV6(u) ? u.match(/(]:)(\d+)/) : u.match(/(:)(\d+)/);
      const port = op && op.length === 3 && op[1] && op[2] ? parseInt(op[2]) : core_1.DEFAULT_PORT;
      const protocol = port === 80 ? "https" : "http";
      const url = new URL(`${protocol}://${u}`);
      url.port = `${port}`;
      let hostname = url.hostname;
      if (hostname.charAt(0) === "[") {
        hostname = hostname.substring(1, hostname.length - 1);
      }
      const listen = url.host;
      return { listen, hostname, port };
    }
    var ServerImpl = class _ServerImpl {
      src;
      listen;
      hostname;
      port;
      didConnect;
      reconnects;
      lastConnect;
      gossiped;
      tlsName;
      resolves;
      constructor(u, gossiped = false) {
        this.src = u;
        this.tlsName = "";
        const v = hostPort(u);
        this.listen = v.listen;
        this.hostname = v.hostname;
        this.port = v.port;
        this.didConnect = false;
        this.reconnects = 0;
        this.lastConnect = 0;
        this.gossiped = gossiped;
      }
      toString() {
        return this.listen;
      }
      async resolve(opts) {
        if (!opts.fn || opts.resolve === false) {
          return [this];
        }
        const buf = [];
        if ((0, ipparser_1.isIP)(this.hostname)) {
          return [this];
        } else {
          const ips = await opts.fn(this.hostname);
          if (opts.debug) {
            console.log(`resolve ${this.hostname} = ${ips.join(",")}`);
          }
          for (const ip of ips) {
            const proto = this.port === 80 ? "https" : "http";
            const url = new URL(`${proto}://${isIPV6(ip) ? "[" + ip + "]" : ip}`);
            url.port = `${this.port}`;
            const ss = new _ServerImpl(url.host, false);
            ss.tlsName = this.hostname;
            buf.push(ss);
          }
        }
        if (opts.randomize) {
          (0, util_1.shuffle)(buf);
        }
        this.resolves = buf;
        return buf;
      }
    };
    exports2.ServerImpl = ServerImpl;
    var Servers = class _Servers {
      firstSelect;
      servers;
      currentServer;
      tlsName;
      randomize;
      constructor(opts = {}) {
        this.firstSelect = true;
        this.servers = [];
        this.tlsName = "";
        this.randomize = opts.randomize || false;
      }
      /**
       * Replace the server pool with the provided list of `host:port` entries.
       *
       * Throws `InvalidArgumentError` if `listens` is empty or not an array.
       *
       * Note: reconnect attempts continue to follow the configured reconnect
       * policy, but if every entry in the new pool is unreachable the
       * connection may be left unable to recover.
       */
      setServers(listens) {
        if (!Array.isArray(listens) || listens.length === 0) {
          throw errors_1.InvalidArgumentError.format("servers", "cannot be empty");
        }
        const urlParseFn = (0, transport_1.getUrlParseFn)();
        const existing = /* @__PURE__ */ new Map();
        for (const s of this.servers)
          existing.set(s.listen, s);
        const merged = [];
        for (let hp of listens) {
          hp = urlParseFn ? urlParseFn(hp) : hp;
          const { listen } = hostPort(hp);
          const surviving = existing.get(listen);
          if (surviving) {
            surviving.gossiped = false;
            merged.push(surviving);
          } else {
            merged.push(new ServerImpl(hp));
          }
        }
        if (this.randomize)
          (0, util_1.shuffle)(merged);
        this.servers = merged;
        if (this.currentServer === void 0 || !merged.includes(this.currentServer)) {
          this.currentServer = merged[0];
          this.firstSelect = true;
        }
      }
      clear() {
        this.servers.length = 0;
      }
      updateTLSName() {
        const cs = this.getCurrentServer();
        if (!(0, ipparser_1.isIP)(cs.hostname)) {
          this.tlsName = cs.hostname;
          this.servers.forEach((s) => {
            if (s.gossiped) {
              s.tlsName = this.tlsName;
            }
          });
        }
      }
      getCurrentServer() {
        return this.currentServer;
      }
      addServer(u, implicit = false) {
        const urlParseFn = (0, transport_1.getUrlParseFn)();
        u = urlParseFn ? urlParseFn(u) : u;
        const s = new ServerImpl(u, implicit);
        if ((0, ipparser_1.isIP)(s.hostname)) {
          s.tlsName = this.tlsName;
        }
        this.servers.push(s);
      }
      selectServer() {
        if (this.firstSelect) {
          this.firstSelect = false;
          return this.currentServer;
        }
        const t = this.servers.shift();
        if (t) {
          this.servers.push(t);
          this.currentServer = t;
        }
        return t;
      }
      removeCurrentServer() {
        this.removeServer(this.currentServer);
      }
      removeServer(server) {
        if (server) {
          const index = this.servers.indexOf(server);
          this.servers.splice(index, 1);
        }
      }
      /**
       * Returns a frozen snapshot of the server pool in natural order.
       * Each entry is a defensive copy — callers cannot mutate pool state.
       */
      snapshot() {
        return _Servers.freezeAll(this.servers);
      }
      /**
       * Returns a frozen snapshot of the server pool with the current server
       * (= next dial candidate) at index 0. Used to present the handler with
       * the server the library would have selected.
       */
      snapshotForHandler() {
        const cur = this.currentServer;
        if (!cur)
          return this.snapshot();
        const idx = this.servers.indexOf(cur);
        if (idx <= 0)
          return this.snapshot();
        return _Servers.freezeAll([cur, ...this.servers.slice(0, idx), ...this.servers.slice(idx + 1)]);
      }
      static freezeAll(arr) {
        return arr.map((s) => Object.freeze({
          hostname: s.hostname,
          port: s.port,
          listen: s.listen,
          src: s.src,
          tlsName: s.tlsName,
          reconnects: s.reconnects,
          lastConnect: s.lastConnect,
          gossiped: s.gossiped,
          didConnect: s.didConnect
        }));
      }
      find(server) {
        return this.servers.find((s) => s.listen === server.listen);
      }
      setCurrent(server) {
        this.currentServer = server;
      }
      length() {
        return this.servers.length;
      }
      next() {
        return this.servers.length ? this.servers[0] : void 0;
      }
      getServers() {
        return this.servers;
      }
      update(info, encrypted) {
        const added = [];
        let deleted = [];
        const urlParseFn = (0, transport_1.getUrlParseFn)();
        const discovered = /* @__PURE__ */ new Map();
        if (info.connect_urls && info.connect_urls.length > 0) {
          info.connect_urls.forEach((hp) => {
            hp = urlParseFn ? urlParseFn(hp, encrypted) : hp;
            const s = new ServerImpl(hp, true);
            discovered.set(hp, s);
          });
        }
        const toDelete = [];
        this.servers.forEach((s, index) => {
          const u = s.listen;
          if (s.gossiped && this.currentServer.listen !== u && discovered.get(u) === void 0) {
            toDelete.push(index);
          }
          discovered.delete(u);
        });
        toDelete.reverse();
        toDelete.forEach((index) => {
          const removed = this.servers.splice(index, 1);
          deleted = deleted.concat(removed[0].listen);
        });
        discovered.forEach((v, k) => {
          this.servers.push(v);
          added.push(k);
        });
        if (this.randomize && added.length > 0) {
          const cur = this.currentServer;
          const others = this.servers.filter((s) => s !== cur);
          (0, util_1.shuffle)(others);
          this.servers = cur ? [cur, ...others] : others;
        }
        return { added, deleted };
      }
    };
    exports2.Servers = Servers;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/queued_iterator.js
var require_queued_iterator = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/queued_iterator.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.QueuedIteratorImpl = void 0;
    var util_1 = require_util();
    var errors_1 = require_errors();
    var QueuedIteratorImpl = class {
      inflight;
      processed;
      // this is updated by the protocol
      received;
      noIterator;
      iterClosed;
      done;
      signal;
      yields;
      filtered;
      pendingFiltered;
      ctx;
      _data;
      //data is for use by extenders in any way they like
      err;
      time;
      profile;
      yielding;
      didBreak;
      constructor() {
        this.inflight = 0;
        this.filtered = 0;
        this.pendingFiltered = 0;
        this.processed = 0;
        this.received = 0;
        this.noIterator = false;
        this.done = false;
        this.signal = (0, util_1.deferred)();
        this.yields = [];
        this.iterClosed = (0, util_1.deferred)();
        this.time = 0;
        this.yielding = false;
        this.didBreak = false;
        this.profile = false;
      }
      [Symbol.asyncIterator]() {
        return this.iterate();
      }
      push(v) {
        if (this.done) {
          return;
        }
        if (this.didBreak) {
          if (typeof v === "function") {
            const cb = v;
            try {
              cb();
            } catch (_) {
            }
          }
          return;
        }
        if (typeof v === "function") {
          this.pendingFiltered++;
        }
        this.yields.push(v);
        this.signal.resolve();
      }
      async *iterate() {
        if (this.noIterator) {
          throw new errors_1.InvalidOperationError("iterator cannot be used when a callback is registered");
        }
        if (this.yielding) {
          throw new errors_1.InvalidOperationError("iterator is already yielding");
        }
        this.yielding = true;
        try {
          while (true) {
            if (this.yields.length === 0) {
              await this.signal;
            }
            if (this.err) {
              throw this.err;
            }
            const yields = this.yields;
            this.inflight = yields.length;
            this.yields = [];
            for (let i = 0; i < yields.length; i++) {
              if (typeof yields[i] === "function") {
                this.pendingFiltered--;
                const fn = yields[i];
                try {
                  fn();
                } catch (err) {
                  throw err;
                }
                if (this.err) {
                  throw this.err;
                }
                continue;
              }
              this.processed++;
              this.inflight--;
              const start = this.profile ? Date.now() : 0;
              yield yields[i];
              this.time = this.profile ? Date.now() - start : 0;
            }
            if (this.done) {
              break;
            } else if (this.yields.length === 0) {
              yields.length = 0;
              this.yields = yields;
              this.signal = (0, util_1.deferred)();
            }
          }
        } finally {
          this.didBreak = true;
          this.stop();
        }
      }
      stop(err) {
        if (this.done) {
          return;
        }
        this.err = err;
        this.done = true;
        this.signal.resolve();
        this.iterClosed.resolve(err);
      }
      getProcessed() {
        return this.noIterator ? this.received : this.processed;
      }
      getPending() {
        return this.yields.length + this.inflight - this.pendingFiltered;
      }
      getReceived() {
        return this.received - this.filtered;
      }
    };
    exports2.QueuedIteratorImpl = QueuedIteratorImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/muxsubscription.js
var require_muxsubscription = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/muxsubscription.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MuxSubscription = void 0;
    var core_1 = require_core();
    var errors_1 = require_errors();
    var MuxSubscription = class {
      baseInbox;
      reqs;
      constructor() {
        this.reqs = /* @__PURE__ */ new Map();
      }
      size() {
        return this.reqs.size;
      }
      init(prefix) {
        this.baseInbox = `${(0, core_1.createInbox)(prefix)}.`;
        return this.baseInbox;
      }
      add(r) {
        if (!isNaN(r.received)) {
          r.received = 0;
        }
        this.reqs.set(r.token, r);
      }
      get(token2) {
        return this.reqs.get(token2);
      }
      cancel(r) {
        this.reqs.delete(r.token);
      }
      getToken(m) {
        const s = m.subject || "";
        if (s.indexOf(this.baseInbox) === 0) {
          return s.substring(this.baseInbox.length);
        }
        return null;
      }
      all() {
        return Array.from(this.reqs.values());
      }
      handleError(isMuxPermissionError, err) {
        if (isMuxPermissionError) {
          this.all().forEach((r) => {
            r.resolver(err, {});
          });
          return true;
        }
        if (err.operation === "publish") {
          const req = this.all().find((s) => {
            return s.requestSubject === err.subject;
          });
          if (req) {
            req.resolver(err, {});
            return true;
          }
        }
        return false;
      }
      dispatcher() {
        return (err, m) => {
          const token2 = this.getToken(m);
          if (token2) {
            const r = this.get(token2);
            if (r) {
              if (err === null) {
                err = m?.data?.length === 0 && m.headers?.code === 503 ? new errors_1.NoRespondersError(r.requestSubject) : null;
              }
              r.resolver(err, m);
            }
          }
        };
      }
      close() {
        const err = new errors_1.RequestError("connection closed");
        this.reqs.forEach((req) => {
          req.resolver(err, {});
        });
      }
    };
    exports2.MuxSubscription = MuxSubscription;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/heartbeats.js
var require_heartbeats = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/heartbeats.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Heartbeat = void 0;
    var util_1 = require_util();
    var Heartbeat = class {
      ph;
      interval;
      maxOut;
      timer;
      pendings;
      constructor(ph, interval, maxOut) {
        this.ph = ph;
        this.interval = interval;
        this.maxOut = maxOut;
        this.pendings = [];
      }
      // api to start the heartbeats, since this can be
      // spuriously called from dial, ensure we don't
      // leak timers
      start() {
        this.cancel();
        this._schedule();
      }
      // api for canceling the heartbeats, if stale is
      // true it will initiate a client disconnect
      cancel(stale) {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = void 0;
        }
        this._reset();
        if (stale) {
          this.ph.disconnect();
        }
      }
      _schedule() {
        this.timer = setTimeout(() => {
          this.ph.dispatchStatus({ type: "ping", pendingPings: this.pendings.length + 1 });
          if (this.pendings.length === this.maxOut) {
            this.cancel(true);
            return;
          }
          const ping = (0, util_1.deferred)();
          this.ph.flush(ping).then(() => {
            this._reset();
          }).catch(() => {
            this.cancel();
          });
          this.pendings.push(ping);
          this._schedule();
        }, this.interval);
      }
      _reset() {
        this.pendings = this.pendings.filter((p) => {
          const d = p;
          d.resolve();
          return false;
        });
      }
    };
    exports2.Heartbeat = Heartbeat;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/denobuffer.js
var require_denobuffer = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/denobuffer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DenoBuffer = exports2.MAX_SIZE = exports2.AssertionError = void 0;
    exports2.assert = assert;
    exports2.concat = concat;
    exports2.append = append;
    exports2.readAll = readAll;
    exports2.writeAll = writeAll;
    var encoders_1 = require_encoders();
    var AssertionError = class extends Error {
      constructor(msg) {
        super(msg);
        this.name = "AssertionError";
      }
    };
    exports2.AssertionError = AssertionError;
    function assert(cond, msg = "Assertion failed.") {
      if (!cond) {
        throw new AssertionError(msg);
      }
    }
    var MIN_READ = 32 * 1024;
    exports2.MAX_SIZE = 2 ** 32 - 2;
    function copy(src, dst, off = 0) {
      const r = dst.byteLength - off;
      if (src.byteLength > r) {
        src = src.subarray(0, r);
      }
      dst.set(src, off);
      return src.byteLength;
    }
    function concat(origin, b) {
      if (origin === void 0 && b === void 0) {
        return new Uint8Array(0);
      }
      if (origin === void 0) {
        return b;
      }
      if (b === void 0) {
        return origin;
      }
      const output = new Uint8Array(origin.length + b.length);
      output.set(origin, 0);
      output.set(b, origin.length);
      return output;
    }
    function append(origin, b) {
      return concat(origin, Uint8Array.of(b));
    }
    var DenoBuffer = class {
      _buf;
      // contents are the bytes _buf[off : len(_buf)]
      _off;
      // read at _buf[off], write at _buf[_buf.byteLength]
      constructor(ab) {
        this._off = 0;
        if (ab == null) {
          this._buf = new Uint8Array(0);
          return;
        }
        this._buf = new Uint8Array(ab);
      }
      bytes(options = { copy: true }) {
        if (options.copy === false)
          return this._buf.subarray(this._off);
        return this._buf.slice(this._off);
      }
      empty() {
        return this._buf.byteLength <= this._off;
      }
      get length() {
        return this._buf.byteLength - this._off;
      }
      get capacity() {
        return this._buf.buffer.byteLength;
      }
      truncate(n) {
        if (n === 0) {
          this.reset();
          return;
        }
        if (n < 0 || n > this.length) {
          throw Error("bytes.Buffer: truncation out of range");
        }
        this._reslice(this._off + n);
      }
      reset() {
        this._reslice(0);
        this._off = 0;
      }
      _tryGrowByReslice(n) {
        const l = this._buf.byteLength;
        if (n <= this.capacity - l) {
          this._reslice(l + n);
          return l;
        }
        return -1;
      }
      _reslice(len) {
        assert(len <= this._buf.buffer.byteLength);
        this._buf = new Uint8Array(this._buf.buffer, 0, len);
      }
      readByte() {
        const a = new Uint8Array(1);
        if (this.read(a)) {
          return a[0];
        }
        return null;
      }
      read(p) {
        if (this.empty()) {
          this.reset();
          if (p.byteLength === 0) {
            return 0;
          }
          return null;
        }
        const nread = copy(this._buf.subarray(this._off), p);
        this._off += nread;
        return nread;
      }
      writeByte(n) {
        return this.write(Uint8Array.of(n));
      }
      writeString(s) {
        return this.write(encoders_1.TE.encode(s));
      }
      write(p) {
        const m = this._grow(p.byteLength);
        return copy(p, this._buf, m);
      }
      _grow(n) {
        const m = this.length;
        if (m === 0 && this._off !== 0) {
          this.reset();
        }
        const i = this._tryGrowByReslice(n);
        if (i >= 0) {
          return i;
        }
        const c = this.capacity;
        if (n <= Math.floor(c / 2) - m) {
          copy(this._buf.subarray(this._off), this._buf);
        } else if (c + n > exports2.MAX_SIZE) {
          throw new Error("The buffer cannot be grown beyond the maximum size.");
        } else {
          const buf = new Uint8Array(Math.min(2 * c + n, exports2.MAX_SIZE));
          copy(this._buf.subarray(this._off), buf);
          this._buf = buf;
        }
        this._off = 0;
        this._reslice(Math.min(m + n, exports2.MAX_SIZE));
        return m;
      }
      grow(n) {
        if (n < 0) {
          throw Error("Buffer._grow: negative count");
        }
        const m = this._grow(n);
        this._reslice(m);
      }
      readFrom(r) {
        let n = 0;
        const tmp = new Uint8Array(MIN_READ);
        while (true) {
          const shouldGrow = this.capacity - this.length < MIN_READ;
          const buf = shouldGrow ? tmp : new Uint8Array(this._buf.buffer, this.length);
          const nread = r.read(buf);
          if (nread === null) {
            return n;
          }
          if (shouldGrow)
            this.write(buf.subarray(0, nread));
          else
            this._reslice(this.length + nread);
          n += nread;
        }
      }
    };
    exports2.DenoBuffer = DenoBuffer;
    function readAll(r) {
      const buf = new DenoBuffer();
      buf.readFrom(r);
      return buf.bytes();
    }
    function writeAll(w, arr) {
      let nwritten = 0;
      while (nwritten < arr.length) {
        nwritten += w.write(arr.subarray(nwritten));
      }
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/parser.js
var require_parser = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.cc = exports2.State = exports2.Parser = exports2.Kind = void 0;
    exports2.describe = describe;
    var denobuffer_1 = require_denobuffer();
    var encoders_1 = require_encoders();
    exports2.Kind = {
      OK: 0,
      ERR: 1,
      MSG: 2,
      INFO: 3,
      PING: 4,
      PONG: 5
    };
    function describe(e) {
      let ks;
      let data = "";
      switch (e.kind) {
        case exports2.Kind.MSG:
          ks = "MSG";
          break;
        case exports2.Kind.OK:
          ks = "OK";
          break;
        case exports2.Kind.ERR:
          ks = "ERR";
          data = encoders_1.TD.decode(e.data);
          break;
        case exports2.Kind.PING:
          ks = "PING";
          break;
        case exports2.Kind.PONG:
          ks = "PONG";
          break;
        case exports2.Kind.INFO:
          ks = "INFO";
          data = encoders_1.TD.decode(e.data);
      }
      return `${ks}: ${data}`;
    }
    function newMsgArg() {
      const ma = {};
      ma.sid = -1;
      ma.hdr = -1;
      ma.size = -1;
      return ma;
    }
    var ASCII_0 = 48;
    var ASCII_9 = 57;
    var MAX_64MB = 64 * 1024 * 1024;
    var Parser = class {
      dispatcher;
      state;
      as;
      drop;
      hdr;
      ma;
      argBuf;
      msgBuf;
      constructor(dispatcher) {
        this.dispatcher = dispatcher;
        this.state = exports2.State.OP_START;
        this.as = 0;
        this.drop = 0;
        this.hdr = 0;
      }
      parse(buf) {
        let i;
        for (i = 0; i < buf.length; i++) {
          const b = buf[i];
          switch (this.state) {
            case exports2.State.OP_START:
              switch (b) {
                case exports2.cc.M:
                case exports2.cc.m:
                  this.state = exports2.State.OP_M;
                  this.hdr = -1;
                  this.ma = newMsgArg();
                  break;
                case exports2.cc.H:
                case exports2.cc.h:
                  this.state = exports2.State.OP_H;
                  this.hdr = 0;
                  this.ma = newMsgArg();
                  break;
                case exports2.cc.P:
                case exports2.cc.p:
                  this.state = exports2.State.OP_P;
                  break;
                case exports2.cc.PLUS:
                  this.state = exports2.State.OP_PLUS;
                  break;
                case exports2.cc.MINUS:
                  this.state = exports2.State.OP_MINUS;
                  break;
                case exports2.cc.I:
                case exports2.cc.i:
                  this.state = exports2.State.OP_I;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_H:
              switch (b) {
                case exports2.cc.M:
                case exports2.cc.m:
                  this.state = exports2.State.OP_M;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_M:
              switch (b) {
                case exports2.cc.S:
                case exports2.cc.s:
                  this.state = exports2.State.OP_MS;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MS:
              switch (b) {
                case exports2.cc.G:
                case exports2.cc.g:
                  this.state = exports2.State.OP_MSG;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MSG:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  this.state = exports2.State.OP_MSG_SPC;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MSG_SPC:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  continue;
                default:
                  this.state = exports2.State.MSG_ARG;
                  this.as = i;
              }
              break;
            case exports2.State.MSG_ARG:
              switch (b) {
                case exports2.cc.CR:
                  this.drop = 1;
                  break;
                case exports2.cc.NL: {
                  const arg = this.argBuf ? this.argBuf.bytes() : buf.subarray(this.as, i - this.drop);
                  this.processMsgArgs(arg);
                  this.drop = 0;
                  this.as = i + 1;
                  this.state = exports2.State.MSG_PAYLOAD;
                  i = this.as + this.ma.size - 1;
                  break;
                }
                default:
                  if (this.argBuf) {
                    this.argBuf.writeByte(b);
                  }
              }
              break;
            case exports2.State.MSG_PAYLOAD:
              if (this.msgBuf) {
                if (this.msgBuf.length >= this.ma.size) {
                  const data = this.msgBuf.bytes({ copy: false });
                  this.dispatcher.push({ kind: exports2.Kind.MSG, msg: this.ma, data });
                  this.argBuf = void 0;
                  this.msgBuf = void 0;
                  this.state = exports2.State.MSG_END;
                } else {
                  let toCopy = this.ma.size - this.msgBuf.length;
                  const avail = buf.length - i;
                  if (avail < toCopy) {
                    toCopy = avail;
                  }
                  if (toCopy > 0) {
                    this.msgBuf.write(buf.subarray(i, i + toCopy));
                    i = i + toCopy - 1;
                  } else {
                    this.msgBuf.writeByte(b);
                  }
                }
              } else if (i - this.as >= this.ma.size) {
                this.dispatcher.push({ kind: exports2.Kind.MSG, msg: this.ma, data: buf.subarray(this.as, i) });
                this.argBuf = void 0;
                this.msgBuf = void 0;
                this.state = exports2.State.MSG_END;
              }
              break;
            case exports2.State.MSG_END:
              switch (b) {
                case exports2.cc.NL:
                  this.drop = 0;
                  this.as = i + 1;
                  this.state = exports2.State.OP_START;
                  break;
                default:
                  continue;
              }
              break;
            case exports2.State.OP_PLUS:
              switch (b) {
                case exports2.cc.O:
                case exports2.cc.o:
                  this.state = exports2.State.OP_PLUS_O;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PLUS_O:
              switch (b) {
                case exports2.cc.K:
                case exports2.cc.k:
                  this.state = exports2.State.OP_PLUS_OK;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PLUS_OK:
              switch (b) {
                case exports2.cc.NL:
                  this.dispatcher.push({ kind: exports2.Kind.OK });
                  this.drop = 0;
                  this.state = exports2.State.OP_START;
                  break;
              }
              break;
            case exports2.State.OP_MINUS:
              switch (b) {
                case exports2.cc.E:
                case exports2.cc.e:
                  this.state = exports2.State.OP_MINUS_E;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MINUS_E:
              switch (b) {
                case exports2.cc.R:
                case exports2.cc.r:
                  this.state = exports2.State.OP_MINUS_ER;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MINUS_ER:
              switch (b) {
                case exports2.cc.R:
                case exports2.cc.r:
                  this.state = exports2.State.OP_MINUS_ERR;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MINUS_ERR:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  this.state = exports2.State.OP_MINUS_ERR_SPC;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_MINUS_ERR_SPC:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  continue;
                default:
                  this.state = exports2.State.MINUS_ERR_ARG;
                  this.as = i;
              }
              break;
            case exports2.State.MINUS_ERR_ARG:
              switch (b) {
                case exports2.cc.CR:
                  this.drop = 1;
                  break;
                case exports2.cc.NL: {
                  let arg;
                  if (this.argBuf) {
                    arg = this.argBuf.bytes();
                    this.argBuf = void 0;
                  } else {
                    arg = buf.subarray(this.as, i - this.drop);
                  }
                  this.dispatcher.push({ kind: exports2.Kind.ERR, data: arg });
                  this.drop = 0;
                  this.as = i + 1;
                  this.state = exports2.State.OP_START;
                  break;
                }
                default:
                  if (this.argBuf) {
                    this.argBuf.write(Uint8Array.of(b));
                  }
              }
              break;
            case exports2.State.OP_P:
              switch (b) {
                case exports2.cc.I:
                case exports2.cc.i:
                  this.state = exports2.State.OP_PI;
                  break;
                case exports2.cc.O:
                case exports2.cc.o:
                  this.state = exports2.State.OP_PO;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PO:
              switch (b) {
                case exports2.cc.N:
                case exports2.cc.n:
                  this.state = exports2.State.OP_PON;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PON:
              switch (b) {
                case exports2.cc.G:
                case exports2.cc.g:
                  this.state = exports2.State.OP_PONG;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PONG:
              switch (b) {
                case exports2.cc.NL:
                  this.dispatcher.push({ kind: exports2.Kind.PONG });
                  this.drop = 0;
                  this.state = exports2.State.OP_START;
                  break;
              }
              break;
            case exports2.State.OP_PI:
              switch (b) {
                case exports2.cc.N:
                case exports2.cc.n:
                  this.state = exports2.State.OP_PIN;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PIN:
              switch (b) {
                case exports2.cc.G:
                case exports2.cc.g:
                  this.state = exports2.State.OP_PING;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_PING:
              switch (b) {
                case exports2.cc.NL:
                  this.dispatcher.push({ kind: exports2.Kind.PING });
                  this.drop = 0;
                  this.state = exports2.State.OP_START;
                  break;
              }
              break;
            case exports2.State.OP_I:
              switch (b) {
                case exports2.cc.N:
                case exports2.cc.n:
                  this.state = exports2.State.OP_IN;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_IN:
              switch (b) {
                case exports2.cc.F:
                case exports2.cc.f:
                  this.state = exports2.State.OP_INF;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_INF:
              switch (b) {
                case exports2.cc.O:
                case exports2.cc.o:
                  this.state = exports2.State.OP_INFO;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_INFO:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  this.state = exports2.State.OP_INFO_SPC;
                  break;
                default:
                  throw this.fail(buf.subarray(i));
              }
              break;
            case exports2.State.OP_INFO_SPC:
              switch (b) {
                case exports2.cc.SPACE:
                case exports2.cc.TAB:
                  continue;
                default:
                  this.state = exports2.State.INFO_ARG;
                  this.as = i;
              }
              break;
            case exports2.State.INFO_ARG:
              switch (b) {
                case exports2.cc.CR:
                  this.drop = 1;
                  break;
                case exports2.cc.NL: {
                  let arg;
                  if (this.argBuf) {
                    arg = this.argBuf.bytes();
                    this.argBuf = void 0;
                  } else {
                    arg = buf.subarray(this.as, i - this.drop);
                  }
                  this.dispatcher.push({ kind: exports2.Kind.INFO, data: arg });
                  this.drop = 0;
                  this.as = i + 1;
                  this.state = exports2.State.OP_START;
                  break;
                }
                default:
                  if (this.argBuf) {
                    this.argBuf.writeByte(b);
                  }
              }
              break;
            default:
              throw this.fail(buf.subarray(i));
          }
        }
        if ((this.state === exports2.State.MSG_ARG || this.state === exports2.State.MINUS_ERR_ARG || this.state === exports2.State.INFO_ARG) && !this.argBuf) {
          this.argBuf = new denobuffer_1.DenoBuffer(buf.subarray(this.as, i - this.drop));
        }
        if (this.state === exports2.State.MSG_PAYLOAD && !this.msgBuf) {
          if (!this.argBuf) {
            this.cloneMsgArg();
          }
          this.msgBuf = new denobuffer_1.DenoBuffer(buf.subarray(this.as));
        }
      }
      cloneMsgArg() {
        const s = this.ma.subject.length;
        const r = this.ma.reply ? this.ma.reply.length : 0;
        const buf = new Uint8Array(s + r);
        buf.set(this.ma.subject);
        if (this.ma.reply) {
          buf.set(this.ma.reply, s);
        }
        this.argBuf = new denobuffer_1.DenoBuffer(buf);
        this.ma.subject = buf.subarray(0, s);
        if (this.ma.reply) {
          this.ma.reply = buf.subarray(s);
        }
      }
      processMsgArgs(arg) {
        if (this.hdr >= 0) {
          return this.processHeaderMsgArgs(arg);
        }
        const args = [];
        let start = -1;
        for (let i = 0; i < arg.length; i++) {
          const b = arg[i];
          switch (b) {
            case exports2.cc.SPACE:
            case exports2.cc.TAB:
            case exports2.cc.CR:
            case exports2.cc.NL:
              if (start >= 0) {
                args.push(arg.subarray(start, i));
                start = -1;
              }
              break;
            default:
              if (start < 0) {
                start = i;
              }
          }
        }
        if (start >= 0) {
          args.push(arg.subarray(start));
        }
        switch (args.length) {
          case 3:
            this.ma.subject = args[0];
            this.ma.sid = this.protoParseInt(args[1]);
            this.ma.reply = void 0;
            this.ma.size = this.protoParseInt(args[2], MAX_64MB);
            break;
          case 4:
            this.ma.subject = args[0];
            this.ma.sid = this.protoParseInt(args[1]);
            this.ma.reply = args[2];
            this.ma.size = this.protoParseInt(args[3], MAX_64MB);
            break;
          default:
            throw this.fail(arg, "processMsgArgs Parse Error");
        }
        if (this.ma.sid < 0) {
          throw this.fail(arg, "processMsgArgs Bad or Missing Sid Error");
        }
        if (this.ma.size < 0) {
          throw this.fail(arg, "processMsgArgs Bad or Missing Size Error");
        }
      }
      fail(data, label = "") {
        if (!label) {
          label = `parse error [${this.state}]`;
        } else {
          label = `${label} [${this.state}]`;
        }
        return new Error(`${label}: ${encoders_1.TD.decode(data)}`);
      }
      processHeaderMsgArgs(arg) {
        const args = [];
        let start = -1;
        for (let i = 0; i < arg.length; i++) {
          const b = arg[i];
          switch (b) {
            case exports2.cc.SPACE:
            case exports2.cc.TAB:
            case exports2.cc.CR:
            case exports2.cc.NL:
              if (start >= 0) {
                args.push(arg.subarray(start, i));
                start = -1;
              }
              break;
            default:
              if (start < 0) {
                start = i;
              }
          }
        }
        if (start >= 0) {
          args.push(arg.subarray(start));
        }
        switch (args.length) {
          case 4:
            this.ma.subject = args[0];
            this.ma.sid = this.protoParseInt(args[1]);
            this.ma.reply = void 0;
            this.ma.hdr = this.protoParseInt(args[2], MAX_64MB);
            this.ma.size = this.protoParseInt(args[3], MAX_64MB);
            break;
          case 5:
            this.ma.subject = args[0];
            this.ma.sid = this.protoParseInt(args[1]);
            this.ma.reply = args[2];
            this.ma.hdr = this.protoParseInt(args[3], MAX_64MB);
            this.ma.size = this.protoParseInt(args[4], MAX_64MB);
            break;
          default:
            throw this.fail(arg, "processHeaderMsgArgs Parse Error");
        }
        if (this.ma.sid < 0) {
          throw this.fail(arg, "processHeaderMsgArgs Bad or Missing Sid Error");
        }
        if (this.ma.hdr < 0 || this.ma.hdr > this.ma.size) {
          throw this.fail(arg, "processHeaderMsgArgs Bad or Missing Header Size Error");
        }
        if (this.ma.size < 0) {
          throw this.fail(arg, "processHeaderMsgArgs Bad or Missing Size Error");
        }
      }
      protoParseInt(a, max) {
        if (a.length === 0 || a.length > 15) {
          return -1;
        }
        let n = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] < ASCII_0 || a[i] > ASCII_9) {
            return -1;
          }
          n = n * 10 + (a[i] - ASCII_0);
        }
        return max !== void 0 && n > max ? -1 : n;
      }
    };
    exports2.Parser = Parser;
    exports2.State = {
      OP_START: 0,
      OP_PLUS: 1,
      OP_PLUS_O: 2,
      OP_PLUS_OK: 3,
      OP_MINUS: 4,
      OP_MINUS_E: 5,
      OP_MINUS_ER: 6,
      OP_MINUS_ERR: 7,
      OP_MINUS_ERR_SPC: 8,
      MINUS_ERR_ARG: 9,
      OP_M: 10,
      OP_MS: 11,
      OP_MSG: 12,
      OP_MSG_SPC: 13,
      MSG_ARG: 14,
      MSG_PAYLOAD: 15,
      MSG_END: 16,
      OP_H: 17,
      OP_P: 18,
      OP_PI: 19,
      OP_PIN: 20,
      OP_PING: 21,
      OP_PO: 22,
      OP_PON: 23,
      OP_PONG: 24,
      OP_I: 25,
      OP_IN: 26,
      OP_INF: 27,
      OP_INFO: 28,
      OP_INFO_SPC: 29,
      INFO_ARG: 30
    };
    exports2.cc = {
      CR: "\r".charCodeAt(0),
      E: "E".charCodeAt(0),
      e: "e".charCodeAt(0),
      F: "F".charCodeAt(0),
      f: "f".charCodeAt(0),
      G: "G".charCodeAt(0),
      g: "g".charCodeAt(0),
      H: "H".charCodeAt(0),
      h: "h".charCodeAt(0),
      I: "I".charCodeAt(0),
      i: "i".charCodeAt(0),
      K: "K".charCodeAt(0),
      k: "k".charCodeAt(0),
      M: "M".charCodeAt(0),
      m: "m".charCodeAt(0),
      MINUS: "-".charCodeAt(0),
      N: "N".charCodeAt(0),
      n: "n".charCodeAt(0),
      NL: "\n".charCodeAt(0),
      O: "O".charCodeAt(0),
      o: "o".charCodeAt(0),
      P: "P".charCodeAt(0),
      p: "p".charCodeAt(0),
      PLUS: "+".charCodeAt(0),
      R: "R".charCodeAt(0),
      r: "r".charCodeAt(0),
      S: "S".charCodeAt(0),
      s: "s".charCodeAt(0),
      SPACE: " ".charCodeAt(0),
      TAB: "	".charCodeAt(0)
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/headers.js
var require_headers = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/headers.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MsgHdrsImpl = void 0;
    exports2.canonicalMIMEHeaderKey = canonicalMIMEHeaderKey;
    exports2.headers = headers3;
    var encoders_1 = require_encoders();
    var core_1 = require_core();
    var errors_1 = require_errors();
    function canonicalMIMEHeaderKey(k) {
      const a = 97;
      const A = 65;
      const Z = 90;
      const z = 122;
      const dash = 45;
      const colon = 58;
      const start = 33;
      const end = 126;
      const toLower = a - A;
      let upper = true;
      const buf = new Array(k.length);
      for (let i = 0; i < k.length; i++) {
        let c = k.charCodeAt(i);
        if (c === colon || c < start || c > end) {
          throw errors_1.InvalidArgumentError.format("header", `'${k[i]}' is not a valid character in a header name`);
        }
        if (upper && a <= c && c <= z) {
          c -= toLower;
        } else if (!upper && A <= c && c <= Z) {
          c += toLower;
        }
        buf[i] = c;
        upper = c == dash;
      }
      return String.fromCharCode(...buf);
    }
    function headers3(code = 0, description = "") {
      if (code === 0 && description !== "") {
        throw errors_1.InvalidArgumentError.format("code", "is required");
      } else if (code > 0 && description === "") {
        throw errors_1.InvalidArgumentError.format("description", "is required");
      }
      return new MsgHdrsImpl(code, description);
    }
    var HEADER = "NATS/1.0";
    var MsgHdrsImpl = class _MsgHdrsImpl {
      _code;
      headers;
      _description;
      constructor(code = 0, description = "") {
        this._code = code;
        this._description = description;
        this.headers = /* @__PURE__ */ new Map();
      }
      [Symbol.iterator]() {
        return this.headers.entries();
      }
      size() {
        return this.headers.size;
      }
      equals(mh) {
        if (mh && this.headers.size === mh.headers.size && this._code === mh._code) {
          for (const [k, v] of this.headers) {
            const a = mh.values(k);
            if (v.length !== a.length) {
              return false;
            }
            const vv = [...v].sort();
            const aa = [...a].sort();
            for (let i = 0; i < vv.length; i++) {
              if (vv[i] !== aa[i]) {
                return false;
              }
            }
          }
          return true;
        }
        return false;
      }
      static decode(a) {
        const mh = new _MsgHdrsImpl();
        const s = encoders_1.TD.decode(a);
        const lines = s.split("\r\n");
        const h = lines[0];
        if (h !== HEADER) {
          let str = h.replace(HEADER, "").trim();
          if (str.length > 0) {
            mh._code = parseInt(str, 10);
            if (isNaN(mh._code)) {
              mh._code = 0;
            }
            const scode = mh._code.toString();
            str = str.replace(scode, "");
            mh._description = str.trim();
          }
        }
        if (lines.length >= 1) {
          lines.slice(1).map((s2) => {
            if (s2) {
              const idx = s2.indexOf(":");
              if (idx > -1) {
                const k = s2.slice(0, idx);
                const v = s2.slice(idx + 1).trim();
                mh.append(k, v);
              }
            }
          });
        }
        return mh;
      }
      toString() {
        if (this.headers.size === 0 && this._code === 0) {
          return "";
        }
        let s = HEADER;
        if (this._code > 0 && this._description !== "") {
          s += ` ${this._code} ${this._description}`;
        }
        for (const [k, v] of this.headers) {
          for (let i = 0; i < v.length; i++) {
            s = `${s}\r
${k}: ${v[i]}`;
          }
        }
        return `${s}\r
\r
`;
      }
      encode() {
        return encoders_1.TE.encode(this.toString());
      }
      static validHeaderValue(k) {
        const inv = /[\r\n]/;
        if (inv.test(k)) {
          throw errors_1.InvalidArgumentError.format("header", "values cannot contain \\r or \\n");
        }
        return k.trim();
      }
      keys() {
        const keys = [];
        for (const sk of this.headers.keys()) {
          keys.push(sk);
        }
        return keys;
      }
      findKeys(k, match = core_1.Match.Exact) {
        const keys = this.keys();
        switch (match) {
          case core_1.Match.Exact:
            return keys.filter((v) => {
              return v === k;
            });
          case core_1.Match.CanonicalMIME:
            k = canonicalMIMEHeaderKey(k);
            return keys.filter((v) => {
              return v === k;
            });
          default: {
            const lci = k.toLowerCase();
            return keys.filter((v) => {
              return lci === v.toLowerCase();
            });
          }
        }
      }
      get(k, match = core_1.Match.Exact) {
        const keys = this.findKeys(k, match);
        if (keys.length) {
          const v = this.headers.get(keys[0]);
          if (v) {
            return Array.isArray(v) ? v[0] : v;
          }
        }
        return "";
      }
      last(k, match = core_1.Match.Exact) {
        const keys = this.findKeys(k, match);
        if (keys.length) {
          const v = this.headers.get(keys[0]);
          if (v) {
            return Array.isArray(v) ? v[v.length - 1] : v;
          }
        }
        return "";
      }
      has(k, match = core_1.Match.Exact) {
        return this.findKeys(k, match).length > 0;
      }
      set(k, v, match = core_1.Match.Exact) {
        this.delete(k, match);
        this.append(k, v, match);
      }
      append(k, v, match = core_1.Match.Exact) {
        const ck = canonicalMIMEHeaderKey(k);
        if (match === core_1.Match.CanonicalMIME) {
          k = ck;
        }
        const keys = this.findKeys(k, match);
        k = keys.length > 0 ? keys[0] : k;
        const value = _MsgHdrsImpl.validHeaderValue(v);
        let a = this.headers.get(k);
        if (!a) {
          a = [];
          this.headers.set(k, a);
        }
        a.push(value);
      }
      values(k, match = core_1.Match.Exact) {
        const buf = [];
        const keys = this.findKeys(k, match);
        keys.forEach((v) => {
          const values = this.headers.get(v);
          if (values) {
            buf.push(...values);
          }
        });
        return buf;
      }
      delete(k, match = core_1.Match.Exact) {
        const keys = this.findKeys(k, match);
        keys.forEach((v) => {
          this.headers.delete(v);
        });
      }
      get hasError() {
        return this._code >= 300;
      }
      get status() {
        return `${this._code} ${this._description}`.trim();
      }
      toRecord() {
        const data = {};
        this.keys().forEach((v) => {
          data[v] = this.values(v);
        });
        return data;
      }
      get code() {
        return this._code;
      }
      get description() {
        return this._description;
      }
      static fromRecord(r) {
        const h = new _MsgHdrsImpl();
        for (const k in r) {
          const v = r[k];
          h.headers.set(k, Array.isArray(v) ? v : [`${v}`]);
        }
        return h;
      }
    };
    exports2.MsgHdrsImpl = MsgHdrsImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/msg.js
var require_msg = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/msg.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MsgImpl = void 0;
    var headers_1 = require_headers();
    var encoders_1 = require_encoders();
    var MsgImpl = class {
      _headers;
      _msg;
      _rdata;
      _reply;
      _subject;
      publisher;
      constructor(msg, data, publisher) {
        this._msg = msg;
        this._rdata = data;
        this.publisher = publisher;
      }
      get subject() {
        if (this._subject) {
          return this._subject;
        }
        this._subject = encoders_1.TD.decode(this._msg.subject);
        return this._subject;
      }
      get reply() {
        if (this._reply) {
          return this._reply;
        }
        this._reply = encoders_1.TD.decode(this._msg.reply);
        return this._reply;
      }
      get sid() {
        return this._msg.sid;
      }
      get headers() {
        if (this._msg.hdr > -1 && !this._headers) {
          const buf = this._rdata.subarray(0, this._msg.hdr);
          this._headers = headers_1.MsgHdrsImpl.decode(buf);
        }
        return this._headers;
      }
      get data() {
        if (!this._rdata) {
          return new Uint8Array(0);
        }
        return this._msg.hdr > -1 ? this._rdata.subarray(this._msg.hdr) : this._rdata;
      }
      // eslint-ignore-next-line @typescript-eslint/no-explicit-any
      respond(data = encoders_1.Empty, opts) {
        if (this.reply) {
          this.publisher.publish(this.reply, data, opts);
          return true;
        }
        return false;
      }
      size() {
        const subj = this._msg.subject.length;
        const reply = this._msg.reply?.length || 0;
        const payloadAndHeaders = this._msg.size === -1 ? 0 : this._msg.size;
        return subj + reply + payloadAndHeaders;
      }
      json(reviver) {
        return JSON.parse(this.string(), reviver);
      }
      string() {
        return encoders_1.TD.decode(this.data);
      }
      requestInfo() {
        const v = this.headers?.get("Nats-Request-Info");
        if (v) {
          return JSON.parse(v, function(key, value) {
            if ((key === "start" || key === "stop") && value !== "") {
              return new Date(Date.parse(value));
            }
            return value;
          });
        }
        return null;
      }
    };
    exports2.MsgImpl = MsgImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/semver.js
var require_semver = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/semver.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Features = exports2.Feature = void 0;
    exports2.parseSemVer = parseSemVer;
    exports2.compare = compare;
    function parseSemVer(s = "") {
      const m = s.match(/(\d+).(\d+).(\d+)/);
      if (m) {
        return {
          major: parseInt(m[1]),
          minor: parseInt(m[2]),
          micro: parseInt(m[3])
        };
      }
      throw new Error(`'${s}' is not a semver value`);
    }
    function compare(a, b) {
      if (a.major < b.major)
        return -1;
      if (a.major > b.major)
        return 1;
      if (a.minor < b.minor)
        return -1;
      if (a.minor > b.minor)
        return 1;
      if (a.micro < b.micro)
        return -1;
      if (a.micro > b.micro)
        return 1;
      return 0;
    }
    exports2.Feature = {
      JS_KV: "js_kv",
      JS_OBJECTSTORE: "js_objectstore",
      JS_PULL_MAX_BYTES: "js_pull_max_bytes",
      JS_NEW_CONSUMER_CREATE_API: "js_new_consumer_create",
      JS_ALLOW_DIRECT: "js_allow_direct",
      JS_MULTIPLE_CONSUMER_FILTER: "js_multiple_consumer_filter",
      JS_SIMPLIFICATION: "js_simplification",
      JS_STREAM_CONSUMER_METADATA: "js_stream_consumer_metadata",
      JS_CONSUMER_FILTER_SUBJECTS: "js_consumer_filter_subjects",
      JS_STREAM_FIRST_SEQ: "js_stream_first_seq",
      JS_STREAM_SUBJECT_TRANSFORM: "js_stream_subject_transform",
      JS_STREAM_SOURCE_SUBJECT_TRANSFORM: "js_stream_source_subject_transform",
      JS_STREAM_COMPRESSION: "js_stream_compression",
      JS_DEFAULT_CONSUMER_LIMITS: "js_default_consumer_limits",
      JS_BATCH_DIRECT_GET: "js_batch_direct_get",
      JS_PRIORITY_GROUPS: "js_priority_groups",
      JS_CONSUMER_RESET: "js_consumer_reset"
    };
    var Features = class {
      server;
      features;
      disabled;
      constructor(v) {
        this.features = /* @__PURE__ */ new Map();
        this.disabled = [];
        this.update(v);
      }
      /**
       * Removes all disabled entries
       */
      resetDisabled() {
        this.disabled.length = 0;
        this.update(this.server);
      }
      /**
       * Disables a particular feature.
       * @param f
       */
      disable(f) {
        this.disabled.push(f);
        this.update(this.server);
      }
      isDisabled(f) {
        return this.disabled.indexOf(f) !== -1;
      }
      update(v) {
        if (typeof v === "string") {
          v = parseSemVer(v);
        }
        this.server = v;
        this.set(exports2.Feature.JS_KV, "2.6.2");
        this.set(exports2.Feature.JS_OBJECTSTORE, "2.6.3");
        this.set(exports2.Feature.JS_PULL_MAX_BYTES, "2.8.3");
        this.set(exports2.Feature.JS_NEW_CONSUMER_CREATE_API, "2.9.0");
        this.set(exports2.Feature.JS_ALLOW_DIRECT, "2.9.0");
        this.set(exports2.Feature.JS_MULTIPLE_CONSUMER_FILTER, "2.10.0");
        this.set(exports2.Feature.JS_SIMPLIFICATION, "2.9.4");
        this.set(exports2.Feature.JS_STREAM_CONSUMER_METADATA, "2.10.0");
        this.set(exports2.Feature.JS_CONSUMER_FILTER_SUBJECTS, "2.10.0");
        this.set(exports2.Feature.JS_STREAM_FIRST_SEQ, "2.10.0");
        this.set(exports2.Feature.JS_STREAM_SUBJECT_TRANSFORM, "2.10.0");
        this.set(exports2.Feature.JS_STREAM_SOURCE_SUBJECT_TRANSFORM, "2.10.0");
        this.set(exports2.Feature.JS_STREAM_COMPRESSION, "2.10.0");
        this.set(exports2.Feature.JS_DEFAULT_CONSUMER_LIMITS, "2.10.0");
        this.set(exports2.Feature.JS_BATCH_DIRECT_GET, "2.11.0");
        this.set(exports2.Feature.JS_PRIORITY_GROUPS, "2.11.0");
        this.set(exports2.Feature.JS_CONSUMER_RESET, "2.14.0");
        this.disabled.forEach((f) => {
          this.features.delete(f);
        });
      }
      /**
       * Register a feature that requires a particular server version.
       * @param f
       * @param requires
       */
      set(f, requires) {
        this.features.set(f, {
          min: requires,
          ok: compare(this.server, parseSemVer(requires)) >= 0
        });
      }
      /**
       * Returns whether the feature is available and the min server
       * version that supports it.
       * @param f
       */
      get(f) {
        return this.features.get(f) || { min: "unknown", ok: false };
      }
      /**
       * Returns true if the feature is supported
       * @param f
       */
      supports(f) {
        return this.get(f)?.ok || false;
      }
      /**
       * Returns true if the server is at least the specified version
       * @param v
       */
      require(v) {
        if (typeof v === "string") {
          v = parseSemVer(v);
        }
        return compare(this.server, v) >= 0;
      }
    };
    exports2.Features = Features;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/crc16.js
var require_crc16 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/crc16.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.crc16 = void 0;
    var crc16tab2 = new Uint16Array([
      0,
      4129,
      8258,
      12387,
      16516,
      20645,
      24774,
      28903,
      33032,
      37161,
      41290,
      45419,
      49548,
      53677,
      57806,
      61935,
      4657,
      528,
      12915,
      8786,
      21173,
      17044,
      29431,
      25302,
      37689,
      33560,
      45947,
      41818,
      54205,
      50076,
      62463,
      58334,
      9314,
      13379,
      1056,
      5121,
      25830,
      29895,
      17572,
      21637,
      42346,
      46411,
      34088,
      38153,
      58862,
      62927,
      50604,
      54669,
      13907,
      9842,
      5649,
      1584,
      30423,
      26358,
      22165,
      18100,
      46939,
      42874,
      38681,
      34616,
      63455,
      59390,
      55197,
      51132,
      18628,
      22757,
      26758,
      30887,
      2112,
      6241,
      10242,
      14371,
      51660,
      55789,
      59790,
      63919,
      35144,
      39273,
      43274,
      47403,
      23285,
      19156,
      31415,
      27286,
      6769,
      2640,
      14899,
      10770,
      56317,
      52188,
      64447,
      60318,
      39801,
      35672,
      47931,
      43802,
      27814,
      31879,
      19684,
      23749,
      11298,
      15363,
      3168,
      7233,
      60846,
      64911,
      52716,
      56781,
      44330,
      48395,
      36200,
      40265,
      32407,
      28342,
      24277,
      20212,
      15891,
      11826,
      7761,
      3696,
      65439,
      61374,
      57309,
      53244,
      48923,
      44858,
      40793,
      36728,
      37256,
      33193,
      45514,
      41451,
      53516,
      49453,
      61774,
      57711,
      4224,
      161,
      12482,
      8419,
      20484,
      16421,
      28742,
      24679,
      33721,
      37784,
      41979,
      46042,
      49981,
      54044,
      58239,
      62302,
      689,
      4752,
      8947,
      13010,
      16949,
      21012,
      25207,
      29270,
      46570,
      42443,
      38312,
      34185,
      62830,
      58703,
      54572,
      50445,
      13538,
      9411,
      5280,
      1153,
      29798,
      25671,
      21540,
      17413,
      42971,
      47098,
      34713,
      38840,
      59231,
      63358,
      50973,
      55100,
      9939,
      14066,
      1681,
      5808,
      26199,
      30326,
      17941,
      22068,
      55628,
      51565,
      63758,
      59695,
      39368,
      35305,
      47498,
      43435,
      22596,
      18533,
      30726,
      26663,
      6336,
      2273,
      14466,
      10403,
      52093,
      56156,
      60223,
      64286,
      35833,
      39896,
      43963,
      48026,
      19061,
      23124,
      27191,
      31254,
      2801,
      6864,
      10931,
      14994,
      64814,
      60687,
      56684,
      52557,
      48554,
      44427,
      40424,
      36297,
      31782,
      27655,
      23652,
      19525,
      15522,
      11395,
      7392,
      3265,
      61215,
      65342,
      53085,
      57212,
      44955,
      49082,
      36825,
      40952,
      28183,
      32310,
      20053,
      24180,
      11923,
      16050,
      3793,
      7920
    ]);
    var crc16 = class _crc16 {
      // crc16 returns the crc for the data provided.
      static checksum(data) {
        let crc = 0;
        for (let i = 0; i < data.byteLength; i++) {
          const b = data[i];
          crc = crc << 8 & 65535 ^ crc16tab2[(crc >> 8 ^ b) & 255];
        }
        return crc;
      }
      // validate will check the calculated crc16 checksum for data against the expected.
      static validate(data, expected) {
        const ba = _crc16.checksum(data);
        return ba == expected;
      }
    };
    exports2.crc16 = crc16;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/base32.js
var require_base32 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/base32.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.base32 = void 0;
    var b32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var base32 = class {
      static encode(src) {
        let bits = 0;
        let value = 0;
        const a = new Uint8Array(src);
        const buf = new Uint8Array(src.byteLength * 2);
        let j = 0;
        for (let i = 0; i < a.byteLength; i++) {
          value = value << 8 | a[i];
          bits += 8;
          while (bits >= 5) {
            const index = value >>> bits - 5 & 31;
            buf[j++] = b32Alphabet.charAt(index).charCodeAt(0);
            bits -= 5;
          }
        }
        if (bits > 0) {
          const index = value << 5 - bits & 31;
          buf[j++] = b32Alphabet.charAt(index).charCodeAt(0);
        }
        return buf.slice(0, j);
      }
      static decode(src) {
        let bits = 0;
        let byte = 0;
        let j = 0;
        const a = new Uint8Array(src);
        const out = new Uint8Array(a.byteLength * 5 / 8 | 0);
        for (let i = 0; i < a.byteLength; i++) {
          const v = String.fromCharCode(a[i]);
          const vv = b32Alphabet.indexOf(v);
          if (vv === -1) {
            throw new Error("Illegal Base32 character: " + a[i]);
          }
          byte = byte << 5 | vv;
          bits += 5;
          if (bits >= 8) {
            out[j++] = byte >>> bits - 8 & 255;
            bits -= 8;
          }
        }
        return out.slice(0, j);
      }
    };
    exports2.base32 = base32;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/codec.js
var require_codec = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/codec.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Codec = void 0;
    var crc16_1 = require_crc16();
    var nkeys_1 = require_nkeys();
    var base32_1 = require_base32();
    var Codec = class _Codec {
      static encode(prefix, src) {
        if (!src || !(src instanceof Uint8Array)) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.SerializationError);
        }
        if (!nkeys_1.Prefixes.isValidPrefix(prefix)) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPrefixByte);
        }
        return _Codec._encode(false, prefix, src);
      }
      static encodeSeed(role, src) {
        if (!src) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ApiError);
        }
        if (!nkeys_1.Prefixes.isValidPublicPrefix(role)) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPrefixByte);
        }
        if (src.byteLength !== 32) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidSeedLen);
        }
        return _Codec._encode(true, role, src);
      }
      static decode(expected, src) {
        if (!nkeys_1.Prefixes.isValidPrefix(expected)) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPrefixByte);
        }
        const raw = _Codec._decode(src);
        if (raw[0] !== expected) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPrefixByte);
        }
        return raw.slice(1);
      }
      static decodeSeed(src) {
        const raw = _Codec._decode(src);
        const prefix = _Codec._decodePrefix(raw);
        if (prefix[0] != nkeys_1.Prefix.Seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidSeed);
        }
        if (!nkeys_1.Prefixes.isValidPublicPrefix(prefix[1])) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPrefixByte);
        }
        return { buf: raw.slice(2), prefix: prefix[1] };
      }
      // unsafe encode no prefix/role validation
      static _encode(seed, role, payload) {
        const payloadOffset = seed ? 2 : 1;
        const payloadLen = payload.byteLength;
        const checkLen = 2;
        const cap = payloadOffset + payloadLen + checkLen;
        const checkOffset = payloadOffset + payloadLen;
        const raw = new Uint8Array(cap);
        if (seed) {
          const encodedPrefix = _Codec._encodePrefix(nkeys_1.Prefix.Seed, role);
          raw.set(encodedPrefix);
        } else {
          raw[0] = role;
        }
        raw.set(payload, payloadOffset);
        const checksum = crc16_1.crc16.checksum(raw.slice(0, checkOffset));
        const dv = new DataView(raw.buffer);
        dv.setUint16(checkOffset, checksum, true);
        return base32_1.base32.encode(raw);
      }
      // unsafe decode - no prefix/role validation
      static _decode(src) {
        if (src.byteLength < 4) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidEncoding);
        }
        let raw;
        try {
          raw = base32_1.base32.decode(src);
        } catch (ex) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidEncoding, { cause: ex });
        }
        const checkOffset = raw.byteLength - 2;
        const dv = new DataView(raw.buffer);
        const checksum = dv.getUint16(checkOffset, true);
        const payload = raw.slice(0, checkOffset);
        if (!crc16_1.crc16.validate(payload, checksum)) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidChecksum);
        }
        return payload;
      }
      static _encodePrefix(kind, role) {
        const b1 = kind | role >> 5;
        const b2 = (role & 31) << 3;
        return new Uint8Array([b1, b2]);
      }
      static _decodePrefix(raw) {
        const b1 = raw[0] & 248;
        const b2 = (raw[0] & 7) << 5 | (raw[1] & 248) >> 3;
        return new Uint8Array([b1, b2]);
      }
    };
    exports2.Codec = Codec;
  }
});

// ../../node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js
var require_nacl_fast = __commonJS({
  "../../node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js"(exports2, module2) {
    (function(nacl2) {
      "use strict";
      var gf = function(init) {
        var i, r = new Float64Array(16);
        if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
        return r;
      };
      var randombytes = function() {
        throw new Error("no PRNG");
      };
      var _0 = new Uint8Array(16);
      var _9 = new Uint8Array(32);
      _9[0] = 9;
      var gf0 = gf(), gf1 = gf([1]), _121665 = gf([56129, 1]), D = gf([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), D2 = gf([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), X = gf([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), Y = gf([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), I = gf([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
      function ts64(x, i, h, l) {
        x[i] = h >> 24 & 255;
        x[i + 1] = h >> 16 & 255;
        x[i + 2] = h >> 8 & 255;
        x[i + 3] = h & 255;
        x[i + 4] = l >> 24 & 255;
        x[i + 5] = l >> 16 & 255;
        x[i + 6] = l >> 8 & 255;
        x[i + 7] = l & 255;
      }
      function vn(x, xi, y, yi, n) {
        var i, d = 0;
        for (i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
        return (1 & d - 1 >>> 8) - 1;
      }
      function crypto_verify_16(x, xi, y, yi) {
        return vn(x, xi, y, yi, 16);
      }
      function crypto_verify_32(x, xi, y, yi) {
        return vn(x, xi, y, yi, 32);
      }
      function core_salsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        x0 = x0 + j0 | 0;
        x1 = x1 + j1 | 0;
        x2 = x2 + j2 | 0;
        x3 = x3 + j3 | 0;
        x4 = x4 + j4 | 0;
        x5 = x5 + j5 | 0;
        x6 = x6 + j6 | 0;
        x7 = x7 + j7 | 0;
        x8 = x8 + j8 | 0;
        x9 = x9 + j9 | 0;
        x10 = x10 + j10 | 0;
        x11 = x11 + j11 | 0;
        x12 = x12 + j12 | 0;
        x13 = x13 + j13 | 0;
        x14 = x14 + j14 | 0;
        x15 = x15 + j15 | 0;
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x1 >>> 0 & 255;
        o[5] = x1 >>> 8 & 255;
        o[6] = x1 >>> 16 & 255;
        o[7] = x1 >>> 24 & 255;
        o[8] = x2 >>> 0 & 255;
        o[9] = x2 >>> 8 & 255;
        o[10] = x2 >>> 16 & 255;
        o[11] = x2 >>> 24 & 255;
        o[12] = x3 >>> 0 & 255;
        o[13] = x3 >>> 8 & 255;
        o[14] = x3 >>> 16 & 255;
        o[15] = x3 >>> 24 & 255;
        o[16] = x4 >>> 0 & 255;
        o[17] = x4 >>> 8 & 255;
        o[18] = x4 >>> 16 & 255;
        o[19] = x4 >>> 24 & 255;
        o[20] = x5 >>> 0 & 255;
        o[21] = x5 >>> 8 & 255;
        o[22] = x5 >>> 16 & 255;
        o[23] = x5 >>> 24 & 255;
        o[24] = x6 >>> 0 & 255;
        o[25] = x6 >>> 8 & 255;
        o[26] = x6 >>> 16 & 255;
        o[27] = x6 >>> 24 & 255;
        o[28] = x7 >>> 0 & 255;
        o[29] = x7 >>> 8 & 255;
        o[30] = x7 >>> 16 & 255;
        o[31] = x7 >>> 24 & 255;
        o[32] = x8 >>> 0 & 255;
        o[33] = x8 >>> 8 & 255;
        o[34] = x8 >>> 16 & 255;
        o[35] = x8 >>> 24 & 255;
        o[36] = x9 >>> 0 & 255;
        o[37] = x9 >>> 8 & 255;
        o[38] = x9 >>> 16 & 255;
        o[39] = x9 >>> 24 & 255;
        o[40] = x10 >>> 0 & 255;
        o[41] = x10 >>> 8 & 255;
        o[42] = x10 >>> 16 & 255;
        o[43] = x10 >>> 24 & 255;
        o[44] = x11 >>> 0 & 255;
        o[45] = x11 >>> 8 & 255;
        o[46] = x11 >>> 16 & 255;
        o[47] = x11 >>> 24 & 255;
        o[48] = x12 >>> 0 & 255;
        o[49] = x12 >>> 8 & 255;
        o[50] = x12 >>> 16 & 255;
        o[51] = x12 >>> 24 & 255;
        o[52] = x13 >>> 0 & 255;
        o[53] = x13 >>> 8 & 255;
        o[54] = x13 >>> 16 & 255;
        o[55] = x13 >>> 24 & 255;
        o[56] = x14 >>> 0 & 255;
        o[57] = x14 >>> 8 & 255;
        o[58] = x14 >>> 16 & 255;
        o[59] = x14 >>> 24 & 255;
        o[60] = x15 >>> 0 & 255;
        o[61] = x15 >>> 8 & 255;
        o[62] = x15 >>> 16 & 255;
        o[63] = x15 >>> 24 & 255;
      }
      function core_hsalsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x5 >>> 0 & 255;
        o[5] = x5 >>> 8 & 255;
        o[6] = x5 >>> 16 & 255;
        o[7] = x5 >>> 24 & 255;
        o[8] = x10 >>> 0 & 255;
        o[9] = x10 >>> 8 & 255;
        o[10] = x10 >>> 16 & 255;
        o[11] = x10 >>> 24 & 255;
        o[12] = x15 >>> 0 & 255;
        o[13] = x15 >>> 8 & 255;
        o[14] = x15 >>> 16 & 255;
        o[15] = x15 >>> 24 & 255;
        o[16] = x6 >>> 0 & 255;
        o[17] = x6 >>> 8 & 255;
        o[18] = x6 >>> 16 & 255;
        o[19] = x6 >>> 24 & 255;
        o[20] = x7 >>> 0 & 255;
        o[21] = x7 >>> 8 & 255;
        o[22] = x7 >>> 16 & 255;
        o[23] = x7 >>> 24 & 255;
        o[24] = x8 >>> 0 & 255;
        o[25] = x8 >>> 8 & 255;
        o[26] = x8 >>> 16 & 255;
        o[27] = x8 >>> 24 & 255;
        o[28] = x9 >>> 0 & 255;
        o[29] = x9 >>> 8 & 255;
        o[30] = x9 >>> 16 & 255;
        o[31] = x9 >>> 24 & 255;
      }
      function crypto_core_salsa20(out, inp, k, c) {
        core_salsa20(out, inp, k, c);
      }
      function crypto_core_hsalsa20(out, inp, k, c) {
        core_hsalsa20(out, inp, k, c);
      }
      var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
      function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
        var z = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z[i] = 0;
        for (i = 0; i < 8; i++) z[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = m[mpos + i] ^ x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z[i] & 255) | 0;
            z[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
          mpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = m[mpos + i] ^ x[i];
        }
        return 0;
      }
      function crypto_stream_salsa20(c, cpos, b, n, k) {
        var z = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z[i] = 0;
        for (i = 0; i < 8; i++) z[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z[i] & 255) | 0;
            z[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = x[i];
        }
        return 0;
      }
      function crypto_stream(c, cpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20(c, cpos, d, sn, s);
      }
      function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, sn, s);
      }
      var poly1305 = function(key) {
        this.buffer = new Uint8Array(16);
        this.r = new Uint16Array(10);
        this.h = new Uint16Array(10);
        this.pad = new Uint16Array(8);
        this.leftover = 0;
        this.fin = 0;
        var t0, t1, t2, t3, t4, t5, t6, t7;
        t0 = key[0] & 255 | (key[1] & 255) << 8;
        this.r[0] = t0 & 8191;
        t1 = key[2] & 255 | (key[3] & 255) << 8;
        this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
        t2 = key[4] & 255 | (key[5] & 255) << 8;
        this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
        t3 = key[6] & 255 | (key[7] & 255) << 8;
        this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
        t4 = key[8] & 255 | (key[9] & 255) << 8;
        this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
        this.r[5] = t4 >>> 1 & 8190;
        t5 = key[10] & 255 | (key[11] & 255) << 8;
        this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
        t6 = key[12] & 255 | (key[13] & 255) << 8;
        this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
        t7 = key[14] & 255 | (key[15] & 255) << 8;
        this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
        this.r[9] = t7 >>> 5 & 127;
        this.pad[0] = key[16] & 255 | (key[17] & 255) << 8;
        this.pad[1] = key[18] & 255 | (key[19] & 255) << 8;
        this.pad[2] = key[20] & 255 | (key[21] & 255) << 8;
        this.pad[3] = key[22] & 255 | (key[23] & 255) << 8;
        this.pad[4] = key[24] & 255 | (key[25] & 255) << 8;
        this.pad[5] = key[26] & 255 | (key[27] & 255) << 8;
        this.pad[6] = key[28] & 255 | (key[29] & 255) << 8;
        this.pad[7] = key[30] & 255 | (key[31] & 255) << 8;
      };
      poly1305.prototype.blocks = function(m, mpos, bytes) {
        var hibit = this.fin ? 0 : 1 << 11;
        var t0, t1, t2, t3, t4, t5, t6, t7, c;
        var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;
        var h0 = this.h[0], h1 = this.h[1], h2 = this.h[2], h3 = this.h[3], h4 = this.h[4], h5 = this.h[5], h6 = this.h[6], h7 = this.h[7], h8 = this.h[8], h9 = this.h[9];
        var r0 = this.r[0], r1 = this.r[1], r2 = this.r[2], r3 = this.r[3], r4 = this.r[4], r5 = this.r[5], r6 = this.r[6], r7 = this.r[7], r8 = this.r[8], r9 = this.r[9];
        while (bytes >= 16) {
          t0 = m[mpos + 0] & 255 | (m[mpos + 1] & 255) << 8;
          h0 += t0 & 8191;
          t1 = m[mpos + 2] & 255 | (m[mpos + 3] & 255) << 8;
          h1 += (t0 >>> 13 | t1 << 3) & 8191;
          t2 = m[mpos + 4] & 255 | (m[mpos + 5] & 255) << 8;
          h2 += (t1 >>> 10 | t2 << 6) & 8191;
          t3 = m[mpos + 6] & 255 | (m[mpos + 7] & 255) << 8;
          h3 += (t2 >>> 7 | t3 << 9) & 8191;
          t4 = m[mpos + 8] & 255 | (m[mpos + 9] & 255) << 8;
          h4 += (t3 >>> 4 | t4 << 12) & 8191;
          h5 += t4 >>> 1 & 8191;
          t5 = m[mpos + 10] & 255 | (m[mpos + 11] & 255) << 8;
          h6 += (t4 >>> 14 | t5 << 2) & 8191;
          t6 = m[mpos + 12] & 255 | (m[mpos + 13] & 255) << 8;
          h7 += (t5 >>> 11 | t6 << 5) & 8191;
          t7 = m[mpos + 14] & 255 | (m[mpos + 15] & 255) << 8;
          h8 += (t6 >>> 8 | t7 << 8) & 8191;
          h9 += t7 >>> 5 | hibit;
          c = 0;
          d0 = c;
          d0 += h0 * r0;
          d0 += h1 * (5 * r9);
          d0 += h2 * (5 * r8);
          d0 += h3 * (5 * r7);
          d0 += h4 * (5 * r6);
          c = d0 >>> 13;
          d0 &= 8191;
          d0 += h5 * (5 * r5);
          d0 += h6 * (5 * r4);
          d0 += h7 * (5 * r3);
          d0 += h8 * (5 * r2);
          d0 += h9 * (5 * r1);
          c += d0 >>> 13;
          d0 &= 8191;
          d1 = c;
          d1 += h0 * r1;
          d1 += h1 * r0;
          d1 += h2 * (5 * r9);
          d1 += h3 * (5 * r8);
          d1 += h4 * (5 * r7);
          c = d1 >>> 13;
          d1 &= 8191;
          d1 += h5 * (5 * r6);
          d1 += h6 * (5 * r5);
          d1 += h7 * (5 * r4);
          d1 += h8 * (5 * r3);
          d1 += h9 * (5 * r2);
          c += d1 >>> 13;
          d1 &= 8191;
          d2 = c;
          d2 += h0 * r2;
          d2 += h1 * r1;
          d2 += h2 * r0;
          d2 += h3 * (5 * r9);
          d2 += h4 * (5 * r8);
          c = d2 >>> 13;
          d2 &= 8191;
          d2 += h5 * (5 * r7);
          d2 += h6 * (5 * r6);
          d2 += h7 * (5 * r5);
          d2 += h8 * (5 * r4);
          d2 += h9 * (5 * r3);
          c += d2 >>> 13;
          d2 &= 8191;
          d3 = c;
          d3 += h0 * r3;
          d3 += h1 * r2;
          d3 += h2 * r1;
          d3 += h3 * r0;
          d3 += h4 * (5 * r9);
          c = d3 >>> 13;
          d3 &= 8191;
          d3 += h5 * (5 * r8);
          d3 += h6 * (5 * r7);
          d3 += h7 * (5 * r6);
          d3 += h8 * (5 * r5);
          d3 += h9 * (5 * r4);
          c += d3 >>> 13;
          d3 &= 8191;
          d4 = c;
          d4 += h0 * r4;
          d4 += h1 * r3;
          d4 += h2 * r2;
          d4 += h3 * r1;
          d4 += h4 * r0;
          c = d4 >>> 13;
          d4 &= 8191;
          d4 += h5 * (5 * r9);
          d4 += h6 * (5 * r8);
          d4 += h7 * (5 * r7);
          d4 += h8 * (5 * r6);
          d4 += h9 * (5 * r5);
          c += d4 >>> 13;
          d4 &= 8191;
          d5 = c;
          d5 += h0 * r5;
          d5 += h1 * r4;
          d5 += h2 * r3;
          d5 += h3 * r2;
          d5 += h4 * r1;
          c = d5 >>> 13;
          d5 &= 8191;
          d5 += h5 * r0;
          d5 += h6 * (5 * r9);
          d5 += h7 * (5 * r8);
          d5 += h8 * (5 * r7);
          d5 += h9 * (5 * r6);
          c += d5 >>> 13;
          d5 &= 8191;
          d6 = c;
          d6 += h0 * r6;
          d6 += h1 * r5;
          d6 += h2 * r4;
          d6 += h3 * r3;
          d6 += h4 * r2;
          c = d6 >>> 13;
          d6 &= 8191;
          d6 += h5 * r1;
          d6 += h6 * r0;
          d6 += h7 * (5 * r9);
          d6 += h8 * (5 * r8);
          d6 += h9 * (5 * r7);
          c += d6 >>> 13;
          d6 &= 8191;
          d7 = c;
          d7 += h0 * r7;
          d7 += h1 * r6;
          d7 += h2 * r5;
          d7 += h3 * r4;
          d7 += h4 * r3;
          c = d7 >>> 13;
          d7 &= 8191;
          d7 += h5 * r2;
          d7 += h6 * r1;
          d7 += h7 * r0;
          d7 += h8 * (5 * r9);
          d7 += h9 * (5 * r8);
          c += d7 >>> 13;
          d7 &= 8191;
          d8 = c;
          d8 += h0 * r8;
          d8 += h1 * r7;
          d8 += h2 * r6;
          d8 += h3 * r5;
          d8 += h4 * r4;
          c = d8 >>> 13;
          d8 &= 8191;
          d8 += h5 * r3;
          d8 += h6 * r2;
          d8 += h7 * r1;
          d8 += h8 * r0;
          d8 += h9 * (5 * r9);
          c += d8 >>> 13;
          d8 &= 8191;
          d9 = c;
          d9 += h0 * r9;
          d9 += h1 * r8;
          d9 += h2 * r7;
          d9 += h3 * r6;
          d9 += h4 * r5;
          c = d9 >>> 13;
          d9 &= 8191;
          d9 += h5 * r4;
          d9 += h6 * r3;
          d9 += h7 * r2;
          d9 += h8 * r1;
          d9 += h9 * r0;
          c += d9 >>> 13;
          d9 &= 8191;
          c = (c << 2) + c | 0;
          c = c + d0 | 0;
          d0 = c & 8191;
          c = c >>> 13;
          d1 += c;
          h0 = d0;
          h1 = d1;
          h2 = d2;
          h3 = d3;
          h4 = d4;
          h5 = d5;
          h6 = d6;
          h7 = d7;
          h8 = d8;
          h9 = d9;
          mpos += 16;
          bytes -= 16;
        }
        this.h[0] = h0;
        this.h[1] = h1;
        this.h[2] = h2;
        this.h[3] = h3;
        this.h[4] = h4;
        this.h[5] = h5;
        this.h[6] = h6;
        this.h[7] = h7;
        this.h[8] = h8;
        this.h[9] = h9;
      };
      poly1305.prototype.finish = function(mac, macpos) {
        var g = new Uint16Array(10);
        var c, mask, f, i;
        if (this.leftover) {
          i = this.leftover;
          this.buffer[i++] = 1;
          for (; i < 16; i++) this.buffer[i] = 0;
          this.fin = 1;
          this.blocks(this.buffer, 0, 16);
        }
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        for (i = 2; i < 10; i++) {
          this.h[i] += c;
          c = this.h[i] >>> 13;
          this.h[i] &= 8191;
        }
        this.h[0] += c * 5;
        c = this.h[0] >>> 13;
        this.h[0] &= 8191;
        this.h[1] += c;
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        this.h[2] += c;
        g[0] = this.h[0] + 5;
        c = g[0] >>> 13;
        g[0] &= 8191;
        for (i = 1; i < 10; i++) {
          g[i] = this.h[i] + c;
          c = g[i] >>> 13;
          g[i] &= 8191;
        }
        g[9] -= 1 << 13;
        mask = (c ^ 1) - 1;
        for (i = 0; i < 10; i++) g[i] &= mask;
        mask = ~mask;
        for (i = 0; i < 10; i++) this.h[i] = this.h[i] & mask | g[i];
        this.h[0] = (this.h[0] | this.h[1] << 13) & 65535;
        this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535;
        this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535;
        this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535;
        this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535;
        this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535;
        this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535;
        this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535;
        f = this.h[0] + this.pad[0];
        this.h[0] = f & 65535;
        for (i = 1; i < 8; i++) {
          f = (this.h[i] + this.pad[i] | 0) + (f >>> 16) | 0;
          this.h[i] = f & 65535;
        }
        mac[macpos + 0] = this.h[0] >>> 0 & 255;
        mac[macpos + 1] = this.h[0] >>> 8 & 255;
        mac[macpos + 2] = this.h[1] >>> 0 & 255;
        mac[macpos + 3] = this.h[1] >>> 8 & 255;
        mac[macpos + 4] = this.h[2] >>> 0 & 255;
        mac[macpos + 5] = this.h[2] >>> 8 & 255;
        mac[macpos + 6] = this.h[3] >>> 0 & 255;
        mac[macpos + 7] = this.h[3] >>> 8 & 255;
        mac[macpos + 8] = this.h[4] >>> 0 & 255;
        mac[macpos + 9] = this.h[4] >>> 8 & 255;
        mac[macpos + 10] = this.h[5] >>> 0 & 255;
        mac[macpos + 11] = this.h[5] >>> 8 & 255;
        mac[macpos + 12] = this.h[6] >>> 0 & 255;
        mac[macpos + 13] = this.h[6] >>> 8 & 255;
        mac[macpos + 14] = this.h[7] >>> 0 & 255;
        mac[macpos + 15] = this.h[7] >>> 8 & 255;
      };
      poly1305.prototype.update = function(m, mpos, bytes) {
        var i, want;
        if (this.leftover) {
          want = 16 - this.leftover;
          if (want > bytes)
            want = bytes;
          for (i = 0; i < want; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          bytes -= want;
          mpos += want;
          this.leftover += want;
          if (this.leftover < 16)
            return;
          this.blocks(this.buffer, 0, 16);
          this.leftover = 0;
        }
        if (bytes >= 16) {
          want = bytes - bytes % 16;
          this.blocks(m, mpos, want);
          mpos += want;
          bytes -= want;
        }
        if (bytes) {
          for (i = 0; i < bytes; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          this.leftover += bytes;
        }
      };
      function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
        var s = new poly1305(k);
        s.update(m, mpos, n);
        s.finish(out, outpos);
        return 0;
      }
      function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
        var x = new Uint8Array(16);
        crypto_onetimeauth(x, 0, m, mpos, n, k);
        return crypto_verify_16(h, hpos, x, 0);
      }
      function crypto_secretbox(c, m, d, n, k) {
        var i;
        if (d < 32) return -1;
        crypto_stream_xor(c, 0, m, 0, d, n, k);
        crypto_onetimeauth(c, 16, c, 32, d - 32, c);
        for (i = 0; i < 16; i++) c[i] = 0;
        return 0;
      }
      function crypto_secretbox_open(m, c, d, n, k) {
        var i;
        var x = new Uint8Array(32);
        if (d < 32) return -1;
        crypto_stream(x, 0, 32, n, k);
        if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0) return -1;
        crypto_stream_xor(m, 0, c, 0, d, n, k);
        for (i = 0; i < 32; i++) m[i] = 0;
        return 0;
      }
      function set25519(r, a) {
        var i;
        for (i = 0; i < 16; i++) r[i] = a[i] | 0;
      }
      function car25519(o) {
        var i, v, c = 1;
        for (i = 0; i < 16; i++) {
          v = o[i] + c + 65535;
          c = Math.floor(v / 65536);
          o[i] = v - c * 65536;
        }
        o[0] += c - 1 + 37 * (c - 1);
      }
      function sel25519(p, q, b) {
        var t, c = ~(b - 1);
        for (var i = 0; i < 16; i++) {
          t = c & (p[i] ^ q[i]);
          p[i] ^= t;
          q[i] ^= t;
        }
      }
      function pack25519(o, n) {
        var i, j, b;
        var m = gf(), t = gf();
        for (i = 0; i < 16; i++) t[i] = n[i];
        car25519(t);
        car25519(t);
        car25519(t);
        for (j = 0; j < 2; j++) {
          m[0] = t[0] - 65517;
          for (i = 1; i < 15; i++) {
            m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
            m[i - 1] &= 65535;
          }
          m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
          b = m[15] >> 16 & 1;
          m[14] &= 65535;
          sel25519(t, m, 1 - b);
        }
        for (i = 0; i < 16; i++) {
          o[2 * i] = t[i] & 255;
          o[2 * i + 1] = t[i] >> 8;
        }
      }
      function neq25519(a, b) {
        var c = new Uint8Array(32), d = new Uint8Array(32);
        pack25519(c, a);
        pack25519(d, b);
        return crypto_verify_32(c, 0, d, 0);
      }
      function par25519(a) {
        var d = new Uint8Array(32);
        pack25519(d, a);
        return d[0] & 1;
      }
      function unpack25519(o, n) {
        var i;
        for (i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
        o[15] &= 32767;
      }
      function A(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
      }
      function Z(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
      }
      function M(o, a, b) {
        var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
        v = a[0];
        t0 += v * b0;
        t1 += v * b1;
        t2 += v * b2;
        t3 += v * b3;
        t4 += v * b4;
        t5 += v * b5;
        t6 += v * b6;
        t7 += v * b7;
        t8 += v * b8;
        t9 += v * b9;
        t10 += v * b10;
        t11 += v * b11;
        t12 += v * b12;
        t13 += v * b13;
        t14 += v * b14;
        t15 += v * b15;
        v = a[1];
        t1 += v * b0;
        t2 += v * b1;
        t3 += v * b2;
        t4 += v * b3;
        t5 += v * b4;
        t6 += v * b5;
        t7 += v * b6;
        t8 += v * b7;
        t9 += v * b8;
        t10 += v * b9;
        t11 += v * b10;
        t12 += v * b11;
        t13 += v * b12;
        t14 += v * b13;
        t15 += v * b14;
        t16 += v * b15;
        v = a[2];
        t2 += v * b0;
        t3 += v * b1;
        t4 += v * b2;
        t5 += v * b3;
        t6 += v * b4;
        t7 += v * b5;
        t8 += v * b6;
        t9 += v * b7;
        t10 += v * b8;
        t11 += v * b9;
        t12 += v * b10;
        t13 += v * b11;
        t14 += v * b12;
        t15 += v * b13;
        t16 += v * b14;
        t17 += v * b15;
        v = a[3];
        t3 += v * b0;
        t4 += v * b1;
        t5 += v * b2;
        t6 += v * b3;
        t7 += v * b4;
        t8 += v * b5;
        t9 += v * b6;
        t10 += v * b7;
        t11 += v * b8;
        t12 += v * b9;
        t13 += v * b10;
        t14 += v * b11;
        t15 += v * b12;
        t16 += v * b13;
        t17 += v * b14;
        t18 += v * b15;
        v = a[4];
        t4 += v * b0;
        t5 += v * b1;
        t6 += v * b2;
        t7 += v * b3;
        t8 += v * b4;
        t9 += v * b5;
        t10 += v * b6;
        t11 += v * b7;
        t12 += v * b8;
        t13 += v * b9;
        t14 += v * b10;
        t15 += v * b11;
        t16 += v * b12;
        t17 += v * b13;
        t18 += v * b14;
        t19 += v * b15;
        v = a[5];
        t5 += v * b0;
        t6 += v * b1;
        t7 += v * b2;
        t8 += v * b3;
        t9 += v * b4;
        t10 += v * b5;
        t11 += v * b6;
        t12 += v * b7;
        t13 += v * b8;
        t14 += v * b9;
        t15 += v * b10;
        t16 += v * b11;
        t17 += v * b12;
        t18 += v * b13;
        t19 += v * b14;
        t20 += v * b15;
        v = a[6];
        t6 += v * b0;
        t7 += v * b1;
        t8 += v * b2;
        t9 += v * b3;
        t10 += v * b4;
        t11 += v * b5;
        t12 += v * b6;
        t13 += v * b7;
        t14 += v * b8;
        t15 += v * b9;
        t16 += v * b10;
        t17 += v * b11;
        t18 += v * b12;
        t19 += v * b13;
        t20 += v * b14;
        t21 += v * b15;
        v = a[7];
        t7 += v * b0;
        t8 += v * b1;
        t9 += v * b2;
        t10 += v * b3;
        t11 += v * b4;
        t12 += v * b5;
        t13 += v * b6;
        t14 += v * b7;
        t15 += v * b8;
        t16 += v * b9;
        t17 += v * b10;
        t18 += v * b11;
        t19 += v * b12;
        t20 += v * b13;
        t21 += v * b14;
        t22 += v * b15;
        v = a[8];
        t8 += v * b0;
        t9 += v * b1;
        t10 += v * b2;
        t11 += v * b3;
        t12 += v * b4;
        t13 += v * b5;
        t14 += v * b6;
        t15 += v * b7;
        t16 += v * b8;
        t17 += v * b9;
        t18 += v * b10;
        t19 += v * b11;
        t20 += v * b12;
        t21 += v * b13;
        t22 += v * b14;
        t23 += v * b15;
        v = a[9];
        t9 += v * b0;
        t10 += v * b1;
        t11 += v * b2;
        t12 += v * b3;
        t13 += v * b4;
        t14 += v * b5;
        t15 += v * b6;
        t16 += v * b7;
        t17 += v * b8;
        t18 += v * b9;
        t19 += v * b10;
        t20 += v * b11;
        t21 += v * b12;
        t22 += v * b13;
        t23 += v * b14;
        t24 += v * b15;
        v = a[10];
        t10 += v * b0;
        t11 += v * b1;
        t12 += v * b2;
        t13 += v * b3;
        t14 += v * b4;
        t15 += v * b5;
        t16 += v * b6;
        t17 += v * b7;
        t18 += v * b8;
        t19 += v * b9;
        t20 += v * b10;
        t21 += v * b11;
        t22 += v * b12;
        t23 += v * b13;
        t24 += v * b14;
        t25 += v * b15;
        v = a[11];
        t11 += v * b0;
        t12 += v * b1;
        t13 += v * b2;
        t14 += v * b3;
        t15 += v * b4;
        t16 += v * b5;
        t17 += v * b6;
        t18 += v * b7;
        t19 += v * b8;
        t20 += v * b9;
        t21 += v * b10;
        t22 += v * b11;
        t23 += v * b12;
        t24 += v * b13;
        t25 += v * b14;
        t26 += v * b15;
        v = a[12];
        t12 += v * b0;
        t13 += v * b1;
        t14 += v * b2;
        t15 += v * b3;
        t16 += v * b4;
        t17 += v * b5;
        t18 += v * b6;
        t19 += v * b7;
        t20 += v * b8;
        t21 += v * b9;
        t22 += v * b10;
        t23 += v * b11;
        t24 += v * b12;
        t25 += v * b13;
        t26 += v * b14;
        t27 += v * b15;
        v = a[13];
        t13 += v * b0;
        t14 += v * b1;
        t15 += v * b2;
        t16 += v * b3;
        t17 += v * b4;
        t18 += v * b5;
        t19 += v * b6;
        t20 += v * b7;
        t21 += v * b8;
        t22 += v * b9;
        t23 += v * b10;
        t24 += v * b11;
        t25 += v * b12;
        t26 += v * b13;
        t27 += v * b14;
        t28 += v * b15;
        v = a[14];
        t14 += v * b0;
        t15 += v * b1;
        t16 += v * b2;
        t17 += v * b3;
        t18 += v * b4;
        t19 += v * b5;
        t20 += v * b6;
        t21 += v * b7;
        t22 += v * b8;
        t23 += v * b9;
        t24 += v * b10;
        t25 += v * b11;
        t26 += v * b12;
        t27 += v * b13;
        t28 += v * b14;
        t29 += v * b15;
        v = a[15];
        t15 += v * b0;
        t16 += v * b1;
        t17 += v * b2;
        t18 += v * b3;
        t19 += v * b4;
        t20 += v * b5;
        t21 += v * b6;
        t22 += v * b7;
        t23 += v * b8;
        t24 += v * b9;
        t25 += v * b10;
        t26 += v * b11;
        t27 += v * b12;
        t28 += v * b13;
        t29 += v * b14;
        t30 += v * b15;
        t0 += 38 * t16;
        t1 += 38 * t17;
        t2 += 38 * t18;
        t3 += 38 * t19;
        t4 += 38 * t20;
        t5 += 38 * t21;
        t6 += 38 * t22;
        t7 += 38 * t23;
        t8 += 38 * t24;
        t9 += 38 * t25;
        t10 += 38 * t26;
        t11 += 38 * t27;
        t12 += 38 * t28;
        t13 += 38 * t29;
        t14 += 38 * t30;
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        o[0] = t0;
        o[1] = t1;
        o[2] = t2;
        o[3] = t3;
        o[4] = t4;
        o[5] = t5;
        o[6] = t6;
        o[7] = t7;
        o[8] = t8;
        o[9] = t9;
        o[10] = t10;
        o[11] = t11;
        o[12] = t12;
        o[13] = t13;
        o[14] = t14;
        o[15] = t15;
      }
      function S(o, a) {
        M(o, a, a);
      }
      function inv25519(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 253; a >= 0; a--) {
          S(c, c);
          if (a !== 2 && a !== 4) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function pow2523(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 250; a >= 0; a--) {
          S(c, c);
          if (a !== 1) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function crypto_scalarmult(q, n, p) {
        var z = new Uint8Array(32);
        var x = new Float64Array(80), r, i;
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
        for (i = 0; i < 31; i++) z[i] = n[i];
        z[31] = n[31] & 127 | 64;
        z[0] &= 248;
        unpack25519(x, p);
        for (i = 0; i < 16; i++) {
          b[i] = x[i];
          d[i] = a[i] = c[i] = 0;
        }
        a[0] = d[0] = 1;
        for (i = 254; i >= 0; --i) {
          r = z[i >>> 3] >>> (i & 7) & 1;
          sel25519(a, b, r);
          sel25519(c, d, r);
          A(e, a, c);
          Z(a, a, c);
          A(c, b, d);
          Z(b, b, d);
          S(d, e);
          S(f, a);
          M(a, c, a);
          M(c, b, e);
          A(e, a, c);
          Z(a, a, c);
          S(b, a);
          Z(c, d, f);
          M(a, c, _121665);
          A(a, a, d);
          M(c, c, a);
          M(a, d, f);
          M(d, b, x);
          S(b, e);
          sel25519(a, b, r);
          sel25519(c, d, r);
        }
        for (i = 0; i < 16; i++) {
          x[i + 16] = a[i];
          x[i + 32] = c[i];
          x[i + 48] = b[i];
          x[i + 64] = d[i];
        }
        var x32 = x.subarray(32);
        var x16 = x.subarray(16);
        inv25519(x32, x32);
        M(x16, x16, x32);
        pack25519(q, x16);
        return 0;
      }
      function crypto_scalarmult_base(q, n) {
        return crypto_scalarmult(q, n, _9);
      }
      function crypto_box_keypair(y, x) {
        randombytes(x, 32);
        return crypto_scalarmult_base(y, x);
      }
      function crypto_box_beforenm(k, y, x) {
        var s = new Uint8Array(32);
        crypto_scalarmult(s, x, y);
        return crypto_core_hsalsa20(k, _0, s, sigma);
      }
      var crypto_box_afternm = crypto_secretbox;
      var crypto_box_open_afternm = crypto_secretbox_open;
      function crypto_box(c, m, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_afternm(c, m, d, n, k);
      }
      function crypto_box_open(m, c, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_open_afternm(m, c, d, n, k);
      }
      var K = [
        1116352408,
        3609767458,
        1899447441,
        602891725,
        3049323471,
        3964484399,
        3921009573,
        2173295548,
        961987163,
        4081628472,
        1508970993,
        3053834265,
        2453635748,
        2937671579,
        2870763221,
        3664609560,
        3624381080,
        2734883394,
        310598401,
        1164996542,
        607225278,
        1323610764,
        1426881987,
        3590304994,
        1925078388,
        4068182383,
        2162078206,
        991336113,
        2614888103,
        633803317,
        3248222580,
        3479774868,
        3835390401,
        2666613458,
        4022224774,
        944711139,
        264347078,
        2341262773,
        604807628,
        2007800933,
        770255983,
        1495990901,
        1249150122,
        1856431235,
        1555081692,
        3175218132,
        1996064986,
        2198950837,
        2554220882,
        3999719339,
        2821834349,
        766784016,
        2952996808,
        2566594879,
        3210313671,
        3203337956,
        3336571891,
        1034457026,
        3584528711,
        2466948901,
        113926993,
        3758326383,
        338241895,
        168717936,
        666307205,
        1188179964,
        773529912,
        1546045734,
        1294757372,
        1522805485,
        1396182291,
        2643833823,
        1695183700,
        2343527390,
        1986661051,
        1014477480,
        2177026350,
        1206759142,
        2456956037,
        344077627,
        2730485921,
        1290863460,
        2820302411,
        3158454273,
        3259730800,
        3505952657,
        3345764771,
        106217008,
        3516065817,
        3606008344,
        3600352804,
        1432725776,
        4094571909,
        1467031594,
        275423344,
        851169720,
        430227734,
        3100823752,
        506948616,
        1363258195,
        659060556,
        3750685593,
        883997877,
        3785050280,
        958139571,
        3318307427,
        1322822218,
        3812723403,
        1537002063,
        2003034995,
        1747873779,
        3602036899,
        1955562222,
        1575990012,
        2024104815,
        1125592928,
        2227730452,
        2716904306,
        2361852424,
        442776044,
        2428436474,
        593698344,
        2756734187,
        3733110249,
        3204031479,
        2999351573,
        3329325298,
        3815920427,
        3391569614,
        3928383900,
        3515267271,
        566280711,
        3940187606,
        3454069534,
        4118630271,
        4000239992,
        116418474,
        1914138554,
        174292421,
        2731055270,
        289380356,
        3203993006,
        460393269,
        320620315,
        685471733,
        587496836,
        852142971,
        1086792851,
        1017036298,
        365543100,
        1126000580,
        2618297676,
        1288033470,
        3409855158,
        1501505948,
        4234509866,
        1607167915,
        987167468,
        1816402316,
        1246189591
      ];
      function crypto_hashblocks_hl(hh, hl, m, n) {
        var wh = new Int32Array(16), wl = new Int32Array(16), bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7, bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7, th, tl, i, j, h, l, a, b, c, d;
        var ah0 = hh[0], ah1 = hh[1], ah2 = hh[2], ah3 = hh[3], ah4 = hh[4], ah5 = hh[5], ah6 = hh[6], ah7 = hh[7], al0 = hl[0], al1 = hl[1], al2 = hl[2], al3 = hl[3], al4 = hl[4], al5 = hl[5], al6 = hl[6], al7 = hl[7];
        var pos = 0;
        while (n >= 128) {
          for (i = 0; i < 16; i++) {
            j = 8 * i + pos;
            wh[i] = m[j + 0] << 24 | m[j + 1] << 16 | m[j + 2] << 8 | m[j + 3];
            wl[i] = m[j + 4] << 24 | m[j + 5] << 16 | m[j + 6] << 8 | m[j + 7];
          }
          for (i = 0; i < 80; i++) {
            bh0 = ah0;
            bh1 = ah1;
            bh2 = ah2;
            bh3 = ah3;
            bh4 = ah4;
            bh5 = ah5;
            bh6 = ah6;
            bh7 = ah7;
            bl0 = al0;
            bl1 = al1;
            bl2 = al2;
            bl3 = al3;
            bl4 = al4;
            bl5 = al5;
            bl6 = al6;
            bl7 = al7;
            h = ah7;
            l = al7;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah4 >>> 14 | al4 << 32 - 14) ^ (ah4 >>> 18 | al4 << 32 - 18) ^ (al4 >>> 41 - 32 | ah4 << 32 - (41 - 32));
            l = (al4 >>> 14 | ah4 << 32 - 14) ^ (al4 >>> 18 | ah4 << 32 - 18) ^ (ah4 >>> 41 - 32 | al4 << 32 - (41 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah4 & ah5 ^ ~ah4 & ah6;
            l = al4 & al5 ^ ~al4 & al6;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = K[i * 2];
            l = K[i * 2 + 1];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = wh[i % 16];
            l = wl[i % 16];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            th = c & 65535 | d << 16;
            tl = a & 65535 | b << 16;
            h = th;
            l = tl;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah0 >>> 28 | al0 << 32 - 28) ^ (al0 >>> 34 - 32 | ah0 << 32 - (34 - 32)) ^ (al0 >>> 39 - 32 | ah0 << 32 - (39 - 32));
            l = (al0 >>> 28 | ah0 << 32 - 28) ^ (ah0 >>> 34 - 32 | al0 << 32 - (34 - 32)) ^ (ah0 >>> 39 - 32 | al0 << 32 - (39 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah0 & ah1 ^ ah0 & ah2 ^ ah1 & ah2;
            l = al0 & al1 ^ al0 & al2 ^ al1 & al2;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh7 = c & 65535 | d << 16;
            bl7 = a & 65535 | b << 16;
            h = bh3;
            l = bl3;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = th;
            l = tl;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh3 = c & 65535 | d << 16;
            bl3 = a & 65535 | b << 16;
            ah1 = bh0;
            ah2 = bh1;
            ah3 = bh2;
            ah4 = bh3;
            ah5 = bh4;
            ah6 = bh5;
            ah7 = bh6;
            ah0 = bh7;
            al1 = bl0;
            al2 = bl1;
            al3 = bl2;
            al4 = bl3;
            al5 = bl4;
            al6 = bl5;
            al7 = bl6;
            al0 = bl7;
            if (i % 16 === 15) {
              for (j = 0; j < 16; j++) {
                h = wh[j];
                l = wl[j];
                a = l & 65535;
                b = l >>> 16;
                c = h & 65535;
                d = h >>> 16;
                h = wh[(j + 9) % 16];
                l = wl[(j + 9) % 16];
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 1) % 16];
                tl = wl[(j + 1) % 16];
                h = (th >>> 1 | tl << 32 - 1) ^ (th >>> 8 | tl << 32 - 8) ^ th >>> 7;
                l = (tl >>> 1 | th << 32 - 1) ^ (tl >>> 8 | th << 32 - 8) ^ (tl >>> 7 | th << 32 - 7);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 14) % 16];
                tl = wl[(j + 14) % 16];
                h = (th >>> 19 | tl << 32 - 19) ^ (tl >>> 61 - 32 | th << 32 - (61 - 32)) ^ th >>> 6;
                l = (tl >>> 19 | th << 32 - 19) ^ (th >>> 61 - 32 | tl << 32 - (61 - 32)) ^ (tl >>> 6 | th << 32 - 6);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                b += a >>> 16;
                c += b >>> 16;
                d += c >>> 16;
                wh[j] = c & 65535 | d << 16;
                wl[j] = a & 65535 | b << 16;
              }
            }
          }
          h = ah0;
          l = al0;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[0];
          l = hl[0];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[0] = ah0 = c & 65535 | d << 16;
          hl[0] = al0 = a & 65535 | b << 16;
          h = ah1;
          l = al1;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[1];
          l = hl[1];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[1] = ah1 = c & 65535 | d << 16;
          hl[1] = al1 = a & 65535 | b << 16;
          h = ah2;
          l = al2;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[2];
          l = hl[2];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[2] = ah2 = c & 65535 | d << 16;
          hl[2] = al2 = a & 65535 | b << 16;
          h = ah3;
          l = al3;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[3];
          l = hl[3];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[3] = ah3 = c & 65535 | d << 16;
          hl[3] = al3 = a & 65535 | b << 16;
          h = ah4;
          l = al4;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[4];
          l = hl[4];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[4] = ah4 = c & 65535 | d << 16;
          hl[4] = al4 = a & 65535 | b << 16;
          h = ah5;
          l = al5;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[5];
          l = hl[5];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[5] = ah5 = c & 65535 | d << 16;
          hl[5] = al5 = a & 65535 | b << 16;
          h = ah6;
          l = al6;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[6];
          l = hl[6];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[6] = ah6 = c & 65535 | d << 16;
          hl[6] = al6 = a & 65535 | b << 16;
          h = ah7;
          l = al7;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[7];
          l = hl[7];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[7] = ah7 = c & 65535 | d << 16;
          hl[7] = al7 = a & 65535 | b << 16;
          pos += 128;
          n -= 128;
        }
        return n;
      }
      function crypto_hash(out, m, n) {
        var hh = new Int32Array(8), hl = new Int32Array(8), x = new Uint8Array(256), i, b = n;
        hh[0] = 1779033703;
        hh[1] = 3144134277;
        hh[2] = 1013904242;
        hh[3] = 2773480762;
        hh[4] = 1359893119;
        hh[5] = 2600822924;
        hh[6] = 528734635;
        hh[7] = 1541459225;
        hl[0] = 4089235720;
        hl[1] = 2227873595;
        hl[2] = 4271175723;
        hl[3] = 1595750129;
        hl[4] = 2917565137;
        hl[5] = 725511199;
        hl[6] = 4215389547;
        hl[7] = 327033209;
        crypto_hashblocks_hl(hh, hl, m, n);
        n %= 128;
        for (i = 0; i < n; i++) x[i] = m[b - n + i];
        x[n] = 128;
        n = 256 - 128 * (n < 112 ? 1 : 0);
        x[n - 9] = 0;
        ts64(x, n - 8, b / 536870912 | 0, b << 3);
        crypto_hashblocks_hl(hh, hl, x, n);
        for (i = 0; i < 8; i++) ts64(out, 8 * i, hh[i], hl[i]);
        return 0;
      }
      function add(p, q) {
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
        Z(a, p[1], p[0]);
        Z(t, q[1], q[0]);
        M(a, a, t);
        A(b, p[0], p[1]);
        A(t, q[0], q[1]);
        M(b, b, t);
        M(c, p[3], q[3]);
        M(c, c, D2);
        M(d, p[2], q[2]);
        A(d, d, d);
        Z(e, b, a);
        Z(f, d, c);
        A(g, d, c);
        A(h, b, a);
        M(p[0], e, f);
        M(p[1], h, g);
        M(p[2], g, f);
        M(p[3], e, h);
      }
      function cswap(p, q, b) {
        var i;
        for (i = 0; i < 4; i++) {
          sel25519(p[i], q[i], b);
        }
      }
      function pack(r, p) {
        var tx = gf(), ty = gf(), zi = gf();
        inv25519(zi, p[2]);
        M(tx, p[0], zi);
        M(ty, p[1], zi);
        pack25519(r, ty);
        r[31] ^= par25519(tx) << 7;
      }
      function scalarmult(p, q, s) {
        var b, i;
        set25519(p[0], gf0);
        set25519(p[1], gf1);
        set25519(p[2], gf1);
        set25519(p[3], gf0);
        for (i = 255; i >= 0; --i) {
          b = s[i / 8 | 0] >> (i & 7) & 1;
          cswap(p, q, b);
          add(q, p);
          add(p, p);
          cswap(p, q, b);
        }
      }
      function scalarbase(p, s) {
        var q = [gf(), gf(), gf(), gf()];
        set25519(q[0], X);
        set25519(q[1], Y);
        set25519(q[2], gf1);
        M(q[3], X, Y);
        scalarmult(p, q, s);
      }
      function crypto_sign_keypair(pk, sk, seeded) {
        var d = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()];
        var i;
        if (!seeded) randombytes(sk, 32);
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        scalarbase(p, d);
        pack(pk, p);
        for (i = 0; i < 32; i++) sk[i + 32] = pk[i];
        return 0;
      }
      var L = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
      function modL(r, x) {
        var carry, i, j, k;
        for (i = 63; i >= 32; --i) {
          carry = 0;
          for (j = i - 32, k = i - 12; j < k; ++j) {
            x[j] += carry - 16 * x[i] * L[j - (i - 32)];
            carry = Math.floor((x[j] + 128) / 256);
            x[j] -= carry * 256;
          }
          x[j] += carry;
          x[i] = 0;
        }
        carry = 0;
        for (j = 0; j < 32; j++) {
          x[j] += carry - (x[31] >> 4) * L[j];
          carry = x[j] >> 8;
          x[j] &= 255;
        }
        for (j = 0; j < 32; j++) x[j] -= carry * L[j];
        for (i = 0; i < 32; i++) {
          x[i + 1] += x[i] >> 8;
          r[i] = x[i] & 255;
        }
      }
      function reduce(r) {
        var x = new Float64Array(64), i;
        for (i = 0; i < 64; i++) x[i] = r[i];
        for (i = 0; i < 64; i++) r[i] = 0;
        modL(r, x);
      }
      function crypto_sign(sm, m, n, sk) {
        var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
        var i, j, x = new Float64Array(64);
        var p = [gf(), gf(), gf(), gf()];
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        var smlen = n + 64;
        for (i = 0; i < n; i++) sm[64 + i] = m[i];
        for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];
        crypto_hash(r, sm.subarray(32), n + 32);
        reduce(r);
        scalarbase(p, r);
        pack(sm, p);
        for (i = 32; i < 64; i++) sm[i] = sk[i];
        crypto_hash(h, sm, n + 64);
        reduce(h);
        for (i = 0; i < 64; i++) x[i] = 0;
        for (i = 0; i < 32; i++) x[i] = r[i];
        for (i = 0; i < 32; i++) {
          for (j = 0; j < 32; j++) {
            x[i + j] += h[i] * d[j];
          }
        }
        modL(sm.subarray(32), x);
        return smlen;
      }
      function unpackneg(r, p) {
        var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
        set25519(r[2], gf1);
        unpack25519(r[1], p);
        S(num, r[1]);
        M(den, num, D);
        Z(num, num, r[2]);
        A(den, r[2], den);
        S(den2, den);
        S(den4, den2);
        M(den6, den4, den2);
        M(t, den6, num);
        M(t, t, den);
        pow2523(t, t);
        M(t, t, num);
        M(t, t, den);
        M(t, t, den);
        M(r[0], t, den);
        S(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) M(r[0], r[0], I);
        S(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) return -1;
        if (par25519(r[0]) === p[31] >> 7) Z(r[0], gf0, r[0]);
        M(r[3], r[0], r[1]);
        return 0;
      }
      function crypto_sign_open(m, sm, n, pk) {
        var i;
        var t = new Uint8Array(32), h = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
        if (n < 64) return -1;
        if (unpackneg(q, pk)) return -1;
        for (i = 0; i < n; i++) m[i] = sm[i];
        for (i = 0; i < 32; i++) m[i + 32] = pk[i];
        crypto_hash(h, m, n);
        reduce(h);
        scalarmult(p, q, h);
        scalarbase(q, sm.subarray(32));
        add(p, q);
        pack(t, p);
        n -= 64;
        if (crypto_verify_32(sm, 0, t, 0)) {
          for (i = 0; i < n; i++) m[i] = 0;
          return -1;
        }
        for (i = 0; i < n; i++) m[i] = sm[i + 64];
        return n;
      }
      var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
      nacl2.lowlevel = {
        crypto_core_hsalsa20,
        crypto_stream_xor,
        crypto_stream,
        crypto_stream_salsa20_xor,
        crypto_stream_salsa20,
        crypto_onetimeauth,
        crypto_onetimeauth_verify,
        crypto_verify_16,
        crypto_verify_32,
        crypto_secretbox,
        crypto_secretbox_open,
        crypto_scalarmult,
        crypto_scalarmult_base,
        crypto_box_beforenm,
        crypto_box_afternm,
        crypto_box,
        crypto_box_open,
        crypto_box_keypair,
        crypto_hash,
        crypto_sign,
        crypto_sign_keypair,
        crypto_sign_open,
        crypto_secretbox_KEYBYTES,
        crypto_secretbox_NONCEBYTES,
        crypto_secretbox_ZEROBYTES,
        crypto_secretbox_BOXZEROBYTES,
        crypto_scalarmult_BYTES,
        crypto_scalarmult_SCALARBYTES,
        crypto_box_PUBLICKEYBYTES,
        crypto_box_SECRETKEYBYTES,
        crypto_box_BEFORENMBYTES,
        crypto_box_NONCEBYTES,
        crypto_box_ZEROBYTES,
        crypto_box_BOXZEROBYTES,
        crypto_sign_BYTES,
        crypto_sign_PUBLICKEYBYTES,
        crypto_sign_SECRETKEYBYTES,
        crypto_sign_SEEDBYTES,
        crypto_hash_BYTES,
        gf,
        D,
        L,
        pack25519,
        unpack25519,
        M,
        A,
        S,
        Z,
        pow2523,
        add,
        set25519,
        modL,
        scalarmult,
        scalarbase
      };
      function checkLengths(k, n) {
        if (k.length !== crypto_secretbox_KEYBYTES) throw new Error("bad key size");
        if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error("bad nonce size");
      }
      function checkBoxLengths(pk, sk) {
        if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error("bad public key size");
        if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
      }
      function checkArrayTypes() {
        for (var i = 0; i < arguments.length; i++) {
          if (!(arguments[i] instanceof Uint8Array))
            throw new TypeError("unexpected type, use Uint8Array");
        }
      }
      function cleanup(arr) {
        for (var i = 0; i < arr.length; i++) arr[i] = 0;
      }
      nacl2.randomBytes = function(n) {
        var b = new Uint8Array(n);
        randombytes(b, n);
        return b;
      };
      nacl2.secretbox = function(msg, nonce, key) {
        checkArrayTypes(msg, nonce, key);
        checkLengths(key, nonce);
        var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
        var c = new Uint8Array(m.length);
        for (var i = 0; i < msg.length; i++) m[i + crypto_secretbox_ZEROBYTES] = msg[i];
        crypto_secretbox(c, m, m.length, nonce, key);
        return c.subarray(crypto_secretbox_BOXZEROBYTES);
      };
      nacl2.secretbox.open = function(box, nonce, key) {
        checkArrayTypes(box, nonce, key);
        checkLengths(key, nonce);
        var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
        var m = new Uint8Array(c.length);
        for (var i = 0; i < box.length; i++) c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
        if (c.length < 32) return null;
        if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0) return null;
        return m.subarray(crypto_secretbox_ZEROBYTES);
      };
      nacl2.secretbox.keyLength = crypto_secretbox_KEYBYTES;
      nacl2.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
      nacl2.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
      nacl2.scalarMult = function(n, p) {
        checkArrayTypes(n, p);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        if (p.length !== crypto_scalarmult_BYTES) throw new Error("bad p size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult(q, n, p);
        return q;
      };
      nacl2.scalarMult.base = function(n) {
        checkArrayTypes(n);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult_base(q, n);
        return q;
      };
      nacl2.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
      nacl2.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
      nacl2.box = function(msg, nonce, publicKey, secretKey) {
        var k = nacl2.box.before(publicKey, secretKey);
        return nacl2.secretbox(msg, nonce, k);
      };
      nacl2.box.before = function(publicKey, secretKey) {
        checkArrayTypes(publicKey, secretKey);
        checkBoxLengths(publicKey, secretKey);
        var k = new Uint8Array(crypto_box_BEFORENMBYTES);
        crypto_box_beforenm(k, publicKey, secretKey);
        return k;
      };
      nacl2.box.after = nacl2.secretbox;
      nacl2.box.open = function(msg, nonce, publicKey, secretKey) {
        var k = nacl2.box.before(publicKey, secretKey);
        return nacl2.secretbox.open(msg, nonce, k);
      };
      nacl2.box.open.after = nacl2.secretbox.open;
      nacl2.box.keyPair = function() {
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
        crypto_box_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.box.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_box_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        crypto_scalarmult_base(pk, secretKey);
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl2.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
      nacl2.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
      nacl2.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
      nacl2.box.nonceLength = crypto_box_NONCEBYTES;
      nacl2.box.overheadLength = nacl2.secretbox.overheadLength;
      nacl2.sign = function(msg, secretKey) {
        checkArrayTypes(msg, secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
        crypto_sign(signedMsg, msg, msg.length, secretKey);
        return signedMsg;
      };
      nacl2.sign.open = function(signedMsg, publicKey) {
        checkArrayTypes(signedMsg, publicKey);
        if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var tmp = new Uint8Array(signedMsg.length);
        var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey);
        if (mlen < 0) return null;
        var m = new Uint8Array(mlen);
        for (var i = 0; i < m.length; i++) m[i] = tmp[i];
        return m;
      };
      nacl2.sign.detached = function(msg, secretKey) {
        var signedMsg = nacl2.sign(msg, secretKey);
        var sig = new Uint8Array(crypto_sign_BYTES);
        for (var i = 0; i < sig.length; i++) sig[i] = signedMsg[i];
        return sig;
      };
      nacl2.sign.detached.verify = function(msg, sig, publicKey) {
        checkArrayTypes(msg, sig, publicKey);
        if (sig.length !== crypto_sign_BYTES)
          throw new Error("bad signature size");
        if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
        var m = new Uint8Array(crypto_sign_BYTES + msg.length);
        var i;
        for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
        for (i = 0; i < msg.length; i++) sm[i + crypto_sign_BYTES] = msg[i];
        return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
      };
      nacl2.sign.keyPair = function() {
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        crypto_sign_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.sign.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32 + i];
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl2.sign.keyPair.fromSeed = function(seed) {
        checkArrayTypes(seed);
        if (seed.length !== crypto_sign_SEEDBYTES)
          throw new Error("bad seed size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        for (var i = 0; i < 32; i++) sk[i] = seed[i];
        crypto_sign_keypair(pk, sk, true);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
      nacl2.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
      nacl2.sign.seedLength = crypto_sign_SEEDBYTES;
      nacl2.sign.signatureLength = crypto_sign_BYTES;
      nacl2.hash = function(msg) {
        checkArrayTypes(msg);
        var h = new Uint8Array(crypto_hash_BYTES);
        crypto_hash(h, msg, msg.length);
        return h;
      };
      nacl2.hash.hashLength = crypto_hash_BYTES;
      nacl2.verify = function(x, y) {
        checkArrayTypes(x, y);
        if (x.length === 0 || y.length === 0) return false;
        if (x.length !== y.length) return false;
        return vn(x, 0, y, 0, x.length) === 0 ? true : false;
      };
      nacl2.setPRNG = function(fn) {
        randombytes = fn;
      };
      (function() {
        var crypto2 = typeof self !== "undefined" ? self.crypto || self.msCrypto : null;
        if (crypto2 && crypto2.getRandomValues) {
          var QUOTA = 65536;
          nacl2.setPRNG(function(x, n) {
            var i, v = new Uint8Array(n);
            for (i = 0; i < n; i += QUOTA) {
              crypto2.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
            }
            for (i = 0; i < n; i++) x[i] = v[i];
            cleanup(v);
          });
        } else if (typeof require !== "undefined") {
          crypto2 = require("crypto");
          if (crypto2 && crypto2.randomBytes) {
            nacl2.setPRNG(function(x, n) {
              var i, v = crypto2.randomBytes(n);
              for (i = 0; i < n; i++) x[i] = v[i];
              cleanup(v);
            });
          }
        }
      })();
    })(typeof module2 !== "undefined" && module2.exports ? module2.exports : self.nacl = self.nacl || {});
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/nacl.js
var require_nacl = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/nacl.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var tweetnacl_1 = __importDefault(require_nacl_fast());
    exports2.default = tweetnacl_1.default;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/kp.js
var require_kp = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/kp.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.KP = void 0;
    var codec_1 = require_codec();
    var nkeys_1 = require_nkeys();
    var nacl_1 = __importDefault(require_nacl());
    var KP = class {
      seed;
      constructor(seed) {
        this.seed = seed;
      }
      getRawSeed() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const sd = codec_1.Codec.decodeSeed(this.seed);
        return sd.buf;
      }
      getSeed() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        return this.seed;
      }
      getPublicKey() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const sd = codec_1.Codec.decodeSeed(this.seed);
        const kp = nacl_1.default.sign.keyPair.fromSeed(this.getRawSeed());
        const buf = codec_1.Codec.encode(sd.prefix, kp.publicKey);
        return new TextDecoder().decode(buf);
      }
      getPrivateKey() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const kp = nacl_1.default.sign.keyPair.fromSeed(this.getRawSeed());
        return codec_1.Codec.encode(nkeys_1.Prefix.Private, kp.secretKey);
      }
      sign(input) {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const kp = nacl_1.default.sign.keyPair.fromSeed(this.getRawSeed());
        return nacl_1.default.sign.detached(input, kp.secretKey);
      }
      verify(input, sig) {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const kp = nacl_1.default.sign.keyPair.fromSeed(this.getRawSeed());
        return nacl_1.default.sign.detached.verify(input, sig, kp.publicKey);
      }
      clear() {
        if (!this.seed) {
          return;
        }
        this.seed.fill(0);
        this.seed = void 0;
      }
      seal(_, _recipient, _nonce) {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidNKeyOperation);
      }
      open(_, _sender) {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidNKeyOperation);
      }
    };
    exports2.KP = KP;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/public.js
var require_public = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/public.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PublicKey = void 0;
    var codec_1 = require_codec();
    var nkeys_1 = require_nkeys();
    var nacl_1 = __importDefault(require_nacl());
    var PublicKey = class {
      publicKey;
      constructor(publicKey) {
        this.publicKey = publicKey;
      }
      getPublicKey() {
        if (!this.publicKey) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        return new TextDecoder().decode(this.publicKey);
      }
      getPrivateKey() {
        if (!this.publicKey) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.PublicKeyOnly);
      }
      getSeed() {
        if (!this.publicKey) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.PublicKeyOnly);
      }
      sign(_) {
        if (!this.publicKey) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.CannotSign);
      }
      verify(input, sig) {
        if (!this.publicKey) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const buf = codec_1.Codec._decode(this.publicKey);
        return nacl_1.default.sign.detached.verify(input, sig, buf.slice(1));
      }
      clear() {
        if (!this.publicKey) {
          return;
        }
        this.publicKey.fill(0);
        this.publicKey = void 0;
      }
      seal(_, _recipient, _nonce) {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidNKeyOperation);
      }
      open(_, _sender) {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidNKeyOperation);
      }
    };
    exports2.PublicKey = PublicKey;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/curve.js
var require_curve = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/curve.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CurveKP = exports2.curveNonceLen = exports2.curveKeyLen = void 0;
    var nkeys_1 = require_nkeys();
    var nacl_1 = __importDefault(require_nacl());
    var codec_1 = require_codec();
    var nkeys_2 = require_nkeys();
    var base32_1 = require_base32();
    var crc16_1 = require_crc16();
    exports2.curveKeyLen = 32;
    var curveDecodeLen = 35;
    exports2.curveNonceLen = 24;
    var XKeyVersionV1 = [120, 107, 118, 49];
    var CurveKP = class {
      seed;
      constructor(seed) {
        this.seed = seed;
      }
      clear() {
        if (!this.seed) {
          return;
        }
        this.seed.fill(0);
        this.seed = void 0;
      }
      getPrivateKey() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        return codec_1.Codec.encode(nkeys_2.Prefix.Private, this.seed);
      }
      getPublicKey() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        const pub = nacl_1.default.scalarMult.base(this.seed);
        const buf = codec_1.Codec.encode(nkeys_2.Prefix.Curve, pub);
        return new TextDecoder().decode(buf);
      }
      getSeed() {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        return codec_1.Codec.encodeSeed(nkeys_2.Prefix.Curve, this.seed);
      }
      sign() {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidCurveOperation);
      }
      verify() {
        throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidCurveOperation);
      }
      decodePubCurveKey(src) {
        try {
          const raw = base32_1.base32.decode(new TextEncoder().encode(src));
          if (raw.byteLength !== curveDecodeLen) {
            throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidCurveKey);
          }
          if (raw[0] !== nkeys_2.Prefix.Curve) {
            throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidPublicKey);
          }
          const checkOffset = raw.byteLength - 2;
          const dv = new DataView(raw.buffer);
          const checksum = dv.getUint16(checkOffset, true);
          const payload = raw.slice(0, checkOffset);
          if (!crc16_1.crc16.validate(payload, checksum)) {
            throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidChecksum);
          }
          return payload.slice(1);
        } catch (ex) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidRecipient, { cause: ex });
        }
      }
      seal(message, recipient, nonce) {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        if (!nonce) {
          nonce = nacl_1.default.randomBytes(exports2.curveNonceLen);
        }
        const pub = this.decodePubCurveKey(recipient);
        const out = new Uint8Array(XKeyVersionV1.length + exports2.curveNonceLen);
        out.set(XKeyVersionV1, 0);
        out.set(nonce, XKeyVersionV1.length);
        const encrypted = nacl_1.default.box(message, nonce, pub, this.seed);
        const fullMessage = new Uint8Array(out.length + encrypted.length);
        fullMessage.set(out);
        fullMessage.set(encrypted, out.length);
        return fullMessage;
      }
      open(message, sender) {
        if (!this.seed) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.ClearedPair);
        }
        if (message.length <= exports2.curveNonceLen + XKeyVersionV1.length) {
          throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidEncrypted);
        }
        for (let i = 0; i < XKeyVersionV1.length; i++) {
          if (message[i] !== XKeyVersionV1[i]) {
            throw new nkeys_1.NKeysError(nkeys_1.NKeysErrorCode.InvalidEncrypted);
          }
        }
        const pub = this.decodePubCurveKey(sender);
        message = message.slice(XKeyVersionV1.length);
        const nonce = message.slice(0, exports2.curveNonceLen);
        message = message.slice(exports2.curveNonceLen);
        return nacl_1.default.box.open(message, nonce, pub, this.seed);
      }
    };
    exports2.CurveKP = CurveKP;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/nkeys.js
var require_nkeys = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/nkeys.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NKeysError = exports2.NKeysErrorCode = exports2.Prefixes = exports2.Prefix = void 0;
    exports2.createPair = createPair;
    exports2.createOperator = createOperator2;
    exports2.createAccount = createAccount2;
    exports2.createUser = createUser2;
    exports2.createCluster = createCluster;
    exports2.createServer = createServer;
    exports2.createCurve = createCurve;
    exports2.fromPublic = fromPublic4;
    exports2.fromCurveSeed = fromCurveSeed;
    exports2.fromSeed = fromSeed4;
    var kp_1 = require_kp();
    var public_1 = require_public();
    var codec_1 = require_codec();
    var curve_1 = require_curve();
    var nacl_1 = __importDefault(require_nacl());
    function createPair(prefix) {
      const len = prefix === Prefix2.Curve ? curve_1.curveKeyLen : 32;
      const rawSeed = nacl_1.default.randomBytes(len);
      const str = codec_1.Codec.encodeSeed(prefix, new Uint8Array(rawSeed));
      return prefix === Prefix2.Curve ? new curve_1.CurveKP(new Uint8Array(rawSeed)) : new kp_1.KP(str);
    }
    function createOperator2() {
      return createPair(Prefix2.Operator);
    }
    function createAccount2() {
      return createPair(Prefix2.Account);
    }
    function createUser2() {
      return createPair(Prefix2.User);
    }
    function createCluster() {
      return createPair(Prefix2.Cluster);
    }
    function createServer() {
      return createPair(Prefix2.Server);
    }
    function createCurve() {
      return createPair(Prefix2.Curve);
    }
    function fromPublic4(src) {
      const ba = new TextEncoder().encode(src);
      const raw = codec_1.Codec._decode(ba);
      const prefix = Prefixes.parsePrefix(raw[0]);
      if (Prefixes.isValidPublicPrefix(prefix)) {
        return new public_1.PublicKey(ba);
      }
      throw new NKeysError(NKeysErrorCode2.InvalidPublicKey);
    }
    function fromCurveSeed(src) {
      const sd = codec_1.Codec.decodeSeed(src);
      if (sd.prefix !== Prefix2.Curve) {
        throw new NKeysError(NKeysErrorCode2.InvalidCurveSeed);
      }
      if (sd.buf.byteLength !== curve_1.curveKeyLen) {
        throw new NKeysError(NKeysErrorCode2.InvalidSeedLen);
      }
      return new curve_1.CurveKP(sd.buf);
    }
    function fromSeed4(src) {
      const sd = codec_1.Codec.decodeSeed(src);
      if (sd.prefix === Prefix2.Curve) {
        return fromCurveSeed(src);
      }
      return new kp_1.KP(src);
    }
    var Prefix2;
    (function(Prefix3) {
      Prefix3[Prefix3["Unknown"] = -1] = "Unknown";
      Prefix3[Prefix3["Seed"] = 144] = "Seed";
      Prefix3[Prefix3["Private"] = 120] = "Private";
      Prefix3[Prefix3["Operator"] = 112] = "Operator";
      Prefix3[Prefix3["Server"] = 104] = "Server";
      Prefix3[Prefix3["Cluster"] = 16] = "Cluster";
      Prefix3[Prefix3["Account"] = 0] = "Account";
      Prefix3[Prefix3["User"] = 160] = "User";
      Prefix3[Prefix3["Curve"] = 184] = "Curve";
    })(Prefix2 || (exports2.Prefix = Prefix2 = {}));
    var Prefixes = class {
      static isValidPublicPrefix(prefix) {
        return prefix == Prefix2.Server || prefix == Prefix2.Operator || prefix == Prefix2.Cluster || prefix == Prefix2.Account || prefix == Prefix2.User || prefix == Prefix2.Curve;
      }
      static startsWithValidPrefix(s) {
        const c = s[0];
        return c == "S" || c == "P" || c == "O" || c == "N" || c == "C" || c == "A" || c == "U" || c == "X";
      }
      static isValidPrefix(prefix) {
        const v = this.parsePrefix(prefix);
        return v !== Prefix2.Unknown;
      }
      static parsePrefix(v) {
        switch (v) {
          case Prefix2.Seed:
            return Prefix2.Seed;
          case Prefix2.Private:
            return Prefix2.Private;
          case Prefix2.Operator:
            return Prefix2.Operator;
          case Prefix2.Server:
            return Prefix2.Server;
          case Prefix2.Cluster:
            return Prefix2.Cluster;
          case Prefix2.Account:
            return Prefix2.Account;
          case Prefix2.User:
            return Prefix2.User;
          case Prefix2.Curve:
            return Prefix2.Curve;
          default:
            return Prefix2.Unknown;
        }
      }
    };
    exports2.Prefixes = Prefixes;
    var NKeysErrorCode2;
    (function(NKeysErrorCode3) {
      NKeysErrorCode3["InvalidPrefixByte"] = "nkeys: invalid prefix byte";
      NKeysErrorCode3["InvalidKey"] = "nkeys: invalid key";
      NKeysErrorCode3["InvalidPublicKey"] = "nkeys: invalid public key";
      NKeysErrorCode3["InvalidSeedLen"] = "nkeys: invalid seed length";
      NKeysErrorCode3["InvalidSeed"] = "nkeys: invalid seed";
      NKeysErrorCode3["InvalidCurveSeed"] = "nkeys: invalid curve seed";
      NKeysErrorCode3["InvalidCurveKey"] = "nkeys: not a valid curve key";
      NKeysErrorCode3["InvalidCurveOperation"] = "nkeys: curve key is not valid for sign/verify";
      NKeysErrorCode3["InvalidNKeyOperation"] = "keys: only curve key can seal/open";
      NKeysErrorCode3["InvalidEncoding"] = "nkeys: invalid encoded key";
      NKeysErrorCode3["InvalidRecipient"] = "nkeys: not a valid recipient public curve key";
      NKeysErrorCode3["InvalidEncrypted"] = "nkeys: encrypted input is not valid";
      NKeysErrorCode3["CannotSign"] = "nkeys: cannot sign, no private key available";
      NKeysErrorCode3["PublicKeyOnly"] = "nkeys: no seed or private key available";
      NKeysErrorCode3["InvalidChecksum"] = "nkeys: invalid checksum";
      NKeysErrorCode3["SerializationError"] = "nkeys: serialization error";
      NKeysErrorCode3["ApiError"] = "nkeys: api error";
      NKeysErrorCode3["ClearedPair"] = "nkeys: pair is cleared";
    })(NKeysErrorCode2 || (exports2.NKeysErrorCode = NKeysErrorCode2 = {}));
    var NKeysError = class extends Error {
      code;
      constructor(code, options) {
        super(code, options);
        this.code = code;
      }
    };
    exports2.NKeysError = NKeysError;
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/util.js
var require_util2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.encode = encode;
    exports2.decode = decode2;
    exports2.dump = dump;
    function encode(bytes) {
      return btoa(String.fromCharCode(...bytes));
    }
    function decode2(b64str) {
      const bin = atob(b64str);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }
    function dump(buf, msg) {
      if (msg) {
        console.log(msg);
      }
      const a = [];
      for (let i = 0; i < buf.byteLength; i++) {
        if (i % 8 === 0) {
          a.push("\n");
        }
        let v = buf[i].toString(16);
        if (v.length === 1) {
          v = "0" + v;
        }
        a.push(v);
      }
      console.log(a.join("  "));
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/version.js
var require_version = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/version.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = void 0;
    exports2.version = "2.0.3";
  }
});

// ../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/mod.js
var require_mod2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = exports2.encode = exports2.decode = exports2.Prefixes = exports2.Prefix = exports2.NKeysErrorCode = exports2.NKeysError = exports2.fromSeed = exports2.fromPublic = exports2.fromCurveSeed = exports2.createUser = exports2.createServer = exports2.createPair = exports2.createOperator = exports2.createCurve = exports2.createCluster = exports2.createAccount = void 0;
    var nkeys_1 = require_nkeys();
    Object.defineProperty(exports2, "createAccount", { enumerable: true, get: function() {
      return nkeys_1.createAccount;
    } });
    Object.defineProperty(exports2, "createCluster", { enumerable: true, get: function() {
      return nkeys_1.createCluster;
    } });
    Object.defineProperty(exports2, "createCurve", { enumerable: true, get: function() {
      return nkeys_1.createCurve;
    } });
    Object.defineProperty(exports2, "createOperator", { enumerable: true, get: function() {
      return nkeys_1.createOperator;
    } });
    Object.defineProperty(exports2, "createPair", { enumerable: true, get: function() {
      return nkeys_1.createPair;
    } });
    Object.defineProperty(exports2, "createServer", { enumerable: true, get: function() {
      return nkeys_1.createServer;
    } });
    Object.defineProperty(exports2, "createUser", { enumerable: true, get: function() {
      return nkeys_1.createUser;
    } });
    Object.defineProperty(exports2, "fromCurveSeed", { enumerable: true, get: function() {
      return nkeys_1.fromCurveSeed;
    } });
    Object.defineProperty(exports2, "fromPublic", { enumerable: true, get: function() {
      return nkeys_1.fromPublic;
    } });
    Object.defineProperty(exports2, "fromSeed", { enumerable: true, get: function() {
      return nkeys_1.fromSeed;
    } });
    Object.defineProperty(exports2, "NKeysError", { enumerable: true, get: function() {
      return nkeys_1.NKeysError;
    } });
    Object.defineProperty(exports2, "NKeysErrorCode", { enumerable: true, get: function() {
      return nkeys_1.NKeysErrorCode;
    } });
    Object.defineProperty(exports2, "Prefix", { enumerable: true, get: function() {
      return nkeys_1.Prefix;
    } });
    Object.defineProperty(exports2, "Prefixes", { enumerable: true, get: function() {
      return nkeys_1.Prefixes;
    } });
    var util_1 = require_util2();
    Object.defineProperty(exports2, "decode", { enumerable: true, get: function() {
      return util_1.decode;
    } });
    Object.defineProperty(exports2, "encode", { enumerable: true, get: function() {
      return util_1.encode;
    } });
    var version_1 = require_version();
    Object.defineProperty(exports2, "version", { enumerable: true, get: function() {
      return version_1.version;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nkeys.js
var require_nkeys2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nkeys.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ (function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    })();
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nkeys = void 0;
    exports2.nkeys = __importStar(require_mod2());
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/authenticator.js
var require_authenticator = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/authenticator.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.multiAuthenticator = multiAuthenticator;
    exports2.noAuthFn = noAuthFn;
    exports2.usernamePasswordAuthenticator = usernamePasswordAuthenticator;
    exports2.tokenAuthenticator = tokenAuthenticator3;
    exports2.nkeyAuthenticator = nkeyAuthenticator;
    exports2.jwtAuthenticator = jwtAuthenticator;
    exports2.credsAuthenticator = credsAuthenticator7;
    var nkeys_1 = require_nkeys2();
    var encoders_1 = require_encoders();
    function multiAuthenticator(authenticators) {
      return (nonce) => {
        let auth = {};
        authenticators.forEach((a) => {
          const args = a(nonce) || {};
          auth = Object.assign(auth, args);
        });
        return auth;
      };
    }
    function noAuthFn() {
      return () => {
        return;
      };
    }
    function usernamePasswordAuthenticator(user, pass) {
      return () => {
        const u = typeof user === "function" ? user() : user;
        const p = typeof pass === "function" ? pass() : pass;
        return { user: u, pass: p };
      };
    }
    function tokenAuthenticator3(token2) {
      return () => {
        const auth_token = typeof token2 === "function" ? token2() : token2;
        return { auth_token };
      };
    }
    function nkeyAuthenticator(seed) {
      return (nonce) => {
        const s = typeof seed === "function" ? seed() : seed;
        const kp = s ? nkeys_1.nkeys.fromSeed(s) : void 0;
        const nkey = kp ? kp.getPublicKey() : "";
        const challenge = encoders_1.TE.encode(nonce || "");
        const sigBytes = kp !== void 0 && nonce ? kp.sign(challenge) : void 0;
        const sig = sigBytes ? nkeys_1.nkeys.encode(sigBytes) : "";
        return { nkey, sig };
      };
    }
    function jwtAuthenticator(ajwt, seed) {
      return (nonce) => {
        const jwt = typeof ajwt === "function" ? ajwt() : ajwt;
        const fn = nkeyAuthenticator(seed);
        const { nkey, sig } = fn(nonce);
        return { jwt, nkey, sig };
      };
    }
    function credsAuthenticator7(creds) {
      const fn = typeof creds !== "function" ? () => creds : creds;
      const parse = () => {
        const CREDS = /\s*(?:(?:[-]{3,}[^\n]*[-]{3,}\n)(.+)(?:\n\s*[-]{3,}[^\n]*[-]{3,}\n))/ig;
        const s = encoders_1.TD.decode(fn());
        let m = CREDS.exec(s);
        if (!m) {
          throw new Error("unable to parse credentials");
        }
        const jwt = m[1].trim();
        m = CREDS.exec(s);
        if (!m) {
          throw new Error("unable to parse credentials");
        }
        const seed = encoders_1.TE.encode(m[1].trim());
        return { jwt, seed };
      };
      const jwtFn = () => {
        const { jwt } = parse();
        return jwt;
      };
      const nkeyFn = () => {
        const { seed } = parse();
        return seed;
      };
      return jwtAuthenticator(jwtFn, nkeyFn);
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/options.js
var require_options = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/options.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DEFAULT_RECONNECT_TIME_WAIT = exports2.DEFAULT_MAX_PING_OUT = exports2.DEFAULT_PING_INTERVAL = exports2.DEFAULT_JITTER_TLS = exports2.DEFAULT_JITTER = exports2.DEFAULT_MAX_RECONNECT_ATTEMPTS = void 0;
    exports2.defaultOptions = defaultOptions;
    exports2.hasWsProtocol = hasWsProtocol;
    exports2.buildAuthenticator = buildAuthenticator;
    exports2.parseOptions = parseOptions;
    exports2.checkOptions = checkOptions;
    exports2.checkUnsupportedOption = checkUnsupportedOption;
    var util_1 = require_util();
    var transport_1 = require_transport();
    var core_1 = require_core();
    var authenticator_1 = require_authenticator();
    var errors_1 = require_errors();
    exports2.DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
    exports2.DEFAULT_JITTER = 100;
    exports2.DEFAULT_JITTER_TLS = 1e3;
    exports2.DEFAULT_PING_INTERVAL = 2 * 60 * 1e3;
    exports2.DEFAULT_MAX_PING_OUT = 2;
    exports2.DEFAULT_RECONNECT_TIME_WAIT = 2 * 1e3;
    function defaultOptions() {
      return {
        maxPingOut: exports2.DEFAULT_MAX_PING_OUT,
        maxReconnectAttempts: exports2.DEFAULT_MAX_RECONNECT_ATTEMPTS,
        noRandomize: false,
        pedantic: false,
        pingInterval: exports2.DEFAULT_PING_INTERVAL,
        reconnect: true,
        reconnectJitter: exports2.DEFAULT_JITTER,
        reconnectJitterTLS: exports2.DEFAULT_JITTER_TLS,
        reconnectTimeWait: exports2.DEFAULT_RECONNECT_TIME_WAIT,
        tls: void 0,
        verbose: false,
        waitOnFirstConnect: false,
        ignoreAuthErrorAbort: false
      };
    }
    function hasWsProtocol(opts) {
      if (opts) {
        let { servers } = opts;
        if (typeof servers === "string") {
          servers = [servers];
        }
        if (servers) {
          for (let i = 0; i < servers.length; i++) {
            const s = servers[i].toLowerCase();
            if (s.startsWith("ws://") || s.startsWith("wss://")) {
              return true;
            }
          }
        }
      }
      return false;
    }
    function buildAuthenticator(opts) {
      const buf = [];
      if (typeof opts.authenticator === "function") {
        buf.push(opts.authenticator);
      }
      if (Array.isArray(opts.authenticator)) {
        buf.push(...opts.authenticator);
      }
      if (opts.token) {
        buf.push((0, authenticator_1.tokenAuthenticator)(opts.token));
      }
      if (opts.user) {
        buf.push((0, authenticator_1.usernamePasswordAuthenticator)(opts.user, opts.pass));
      }
      return buf.length === 0 ? (0, authenticator_1.noAuthFn)() : (0, authenticator_1.multiAuthenticator)(buf);
    }
    function parseOptions(opts) {
      const dhp = `${core_1.DEFAULT_HOST}:${(0, transport_1.defaultPort)()}`;
      opts = opts || { servers: [dhp] };
      opts.servers = opts.servers || [];
      if (typeof opts.servers === "string") {
        opts.servers = [opts.servers];
      }
      if (opts.servers.length > 0 && opts.port) {
        throw errors_1.InvalidArgumentError.format(["servers", "port"], "are mutually exclusive");
      }
      if (opts.servers.length === 0 && opts.port) {
        opts.servers = [`${core_1.DEFAULT_HOST}:${opts.port}`];
      }
      if (opts.servers && opts.servers.length === 0) {
        opts.servers = [dhp];
      }
      const options = (0, util_1.extend)(defaultOptions(), opts);
      options.authenticator = buildAuthenticator(options);
      ["reconnectDelayHandler", "authenticator"].forEach((n) => {
        if (options[n] && typeof options[n] !== "function") {
          throw TypeError(`'${n}' must be a function`);
        }
      });
      if (!options.reconnectDelayHandler) {
        options.reconnectDelayHandler = () => {
          let extra = options.tls ? options.reconnectJitterTLS : options.reconnectJitter;
          if (extra) {
            extra++;
            extra = Math.floor(Math.random() * extra);
          }
          return options.reconnectTimeWait + extra;
        };
      }
      if (options.inboxPrefix) {
        (0, core_1.createInbox)(options.inboxPrefix);
      }
      if (options.resolve === void 0) {
        options.resolve = typeof (0, transport_1.getResolveFn)() === "function";
      }
      if (options.resolve) {
        if (typeof (0, transport_1.getResolveFn)() !== "function") {
          throw errors_1.InvalidArgumentError.format("resolve", "is not supported in the current runtime");
        }
      }
      return options;
    }
    function checkOptions(info, options) {
      const { proto, tls_required: tlsRequired, tls_available: tlsAvailable } = info;
      if ((proto === void 0 || proto < 1) && options.noEcho) {
        throw new errors_1.errors.ConnectionError(`server does not support 'noEcho'`);
      }
      const tls = tlsRequired || tlsAvailable || false;
      if (options.tls && !tls) {
        throw new errors_1.errors.ConnectionError(`server does not support 'tls'`);
      }
    }
    function checkUnsupportedOption(prop, v) {
      if (v) {
        throw errors_1.InvalidArgumentError.format(prop, "is not supported");
      }
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/protocol.js
var require_protocol = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/protocol.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ProtocolHandler = exports2.Subscriptions = exports2.SubscriptionImpl = exports2.Connect = exports2.INFO = void 0;
    var encoders_1 = require_encoders();
    var transport_1 = require_transport();
    var util_1 = require_util();
    var databuffer_1 = require_databuffer();
    var servers_1 = require_servers();
    var queued_iterator_1 = require_queued_iterator();
    var muxsubscription_1 = require_muxsubscription();
    var heartbeats_1 = require_heartbeats();
    var parser_1 = require_parser();
    var msg_1 = require_msg();
    var semver_1 = require_semver();
    var options_1 = require_options();
    var errors_1 = require_errors();
    var FLUSH_THRESHOLD = 1024 * 32;
    exports2.INFO = /^INFO\s+([^\r\n]+)\r\n/i;
    var PONG_CMD = (0, encoders_1.encode)("PONG\r\n");
    var PING_CMD = (0, encoders_1.encode)("PING\r\n");
    var ERR_RECONNECT_HANDLER_FAILED = "client option reconnectToServer handler failed";
    var ERR_RECONNECT_HANDLER_NOT_IN_POOL = "returned server is not in the pool";
    function isDelayedServer(x) {
      return x !== null && typeof x === "object" && "server" in x && "delay" in x;
    }
    var Connect = class {
      echo;
      no_responders;
      protocol;
      verbose;
      pedantic;
      jwt;
      nkey;
      sig;
      user;
      pass;
      auth_token;
      tls_required;
      name;
      lang;
      version;
      headers;
      constructor(transport, opts, nonce) {
        this.protocol = 1;
        this.version = transport.version;
        this.lang = transport.lang;
        this.echo = opts.noEcho ? false : void 0;
        this.verbose = opts.verbose;
        this.pedantic = opts.pedantic;
        this.tls_required = opts.tls ? true : void 0;
        this.name = opts.name;
        const creds = (opts && typeof opts.authenticator === "function" ? opts.authenticator(nonce) : {}) || {};
        (0, util_1.extend)(this, creds);
      }
    };
    exports2.Connect = Connect;
    var SlowNotifier = class {
      slow;
      cb;
      notified;
      constructor(slow, cb) {
        this.slow = slow;
        this.cb = cb;
        this.notified = false;
      }
      maybeNotify(pending) {
        if (pending <= this.slow) {
          this.notified = false;
        } else {
          if (!this.notified) {
            this.cb(pending);
            this.notified = true;
          }
        }
      }
    };
    var SubscriptionImpl = class extends queued_iterator_1.QueuedIteratorImpl {
      sid;
      queue;
      draining;
      max;
      subject;
      drained;
      protocol;
      timer;
      info;
      cleanupFn;
      closed;
      requestSubject;
      slow;
      constructor(protocol, subject, opts = {}) {
        super();
        (0, util_1.extend)(this, opts);
        this.protocol = protocol;
        this.subject = subject;
        this.draining = false;
        this.noIterator = typeof opts.callback === "function";
        this.closed = (0, util_1.deferred)();
        const asyncTraces = !(protocol.options?.noAsyncTraces || false);
        if (opts.timeout) {
          this.timer = (0, util_1.timeout)(opts.timeout, asyncTraces);
          this.timer.then(() => {
            this.timer = void 0;
          }).catch((err) => {
            this.stop(err);
            if (this.noIterator) {
              this.callback(err, {});
            }
          });
        }
        if (!this.noIterator) {
          this.iterClosed.then((err) => {
            this.closed.resolve(err);
            this.unsubscribe();
          });
        }
      }
      setSlowNotificationFn(slow, fn) {
        this.slow = void 0;
        if (fn) {
          if (this.noIterator) {
            throw new Error("callbacks don't support slow notifications");
          }
          this.slow = new SlowNotifier(slow, fn);
        }
      }
      callback(err, msg) {
        this.cancelTimeout();
        err ? this.stop(err) : this.push(msg);
        if (!err && this.slow) {
          this.slow.maybeNotify(this.getPending());
        }
      }
      close(err) {
        if (!this.isClosed()) {
          this.cancelTimeout();
          const fn = () => {
            this.stop();
            if (this.cleanupFn) {
              try {
                this.cleanupFn(this, this.info);
              } catch (_err) {
              }
            }
            this.closed.resolve(err);
          };
          if (this.noIterator) {
            fn();
          } else {
            this.push(fn);
          }
        }
      }
      unsubscribe(max) {
        this.protocol.unsubscribe(this, max);
      }
      cancelTimeout() {
        if (this.timer) {
          this.timer.cancel();
          this.timer = void 0;
        }
      }
      drain() {
        if (this.protocol.isClosed()) {
          return Promise.reject(new errors_1.errors.ClosedConnectionError());
        }
        if (this.isClosed()) {
          return Promise.reject(new errors_1.errors.InvalidOperationError("subscription is already closed"));
        }
        if (!this.drained) {
          this.draining = true;
          this.protocol.unsub(this);
          this.drained = this.protocol.flush((0, util_1.deferred)()).then(() => {
            this.protocol.subscriptions.cancel(this);
          }).catch(() => {
            this.protocol.subscriptions.cancel(this);
          });
        }
        return this.drained;
      }
      async [Symbol.asyncDispose]() {
        if (this.protocol.isClosed() || this.isClosed()) {
          return;
        }
        if (this.drained) {
          await this.drained;
          return;
        }
        await this.drain();
      }
      isDraining() {
        return this.draining;
      }
      isClosed() {
        return this.done;
      }
      getSubject() {
        return this.subject;
      }
      getMax() {
        return this.max;
      }
      getID() {
        return this.sid;
      }
    };
    exports2.SubscriptionImpl = SubscriptionImpl;
    var Subscriptions = class {
      mux;
      subs;
      sidCounter;
      constructor() {
        this.sidCounter = 0;
        this.mux = null;
        this.subs = /* @__PURE__ */ new Map();
      }
      size() {
        return this.subs.size;
      }
      add(s) {
        this.sidCounter++;
        s.sid = this.sidCounter;
        this.subs.set(s.sid, s);
        return s;
      }
      setMux(s) {
        this.mux = s;
        return s;
      }
      getMux() {
        return this.mux;
      }
      get(sid) {
        return this.subs.get(sid);
      }
      resub(s) {
        this.sidCounter++;
        this.subs.delete(s.sid);
        s.sid = this.sidCounter;
        this.subs.set(s.sid, s);
        return s;
      }
      all() {
        return Array.from(this.subs.values());
      }
      cancel(s) {
        if (s) {
          s.close();
          this.subs.delete(s.sid);
        }
      }
      handleError(err) {
        const subs = this.all();
        let sub;
        if (err.operation === "subscription") {
          sub = subs.find((s) => {
            return s.subject === err.subject && s.queue === err.queue;
          });
        } else if (err.operation === "publish") {
          sub = subs.find((s) => {
            return s.requestSubject === err.subject;
          });
        }
        if (sub) {
          sub.callback(err, {});
          sub.close(err);
          this.subs.delete(sub.sid);
          return sub !== this.mux;
        }
        return false;
      }
      close() {
        this.subs.forEach((sub) => {
          sub.close();
        });
      }
    };
    exports2.Subscriptions = Subscriptions;
    var ProtocolHandler = class _ProtocolHandler {
      connected;
      connectedOnce;
      infoReceived;
      info;
      muxSubscriptions;
      options;
      outbound;
      pongs;
      subscriptions;
      transport;
      noMorePublishing;
      connectError;
      publisher;
      _closed;
      closed;
      listeners;
      heartbeats;
      parser;
      outMsgs;
      inMsgs;
      outBytes;
      inBytes;
      pendingLimit;
      lastError;
      abortReconnect;
      whyClosed;
      servers;
      server;
      features;
      connectPromise;
      dialDelay;
      raceTimer;
      constructor(options, publisher) {
        this._closed = false;
        this.connected = false;
        this.connectedOnce = false;
        this.infoReceived = false;
        this.noMorePublishing = false;
        this.abortReconnect = false;
        this.listeners = [];
        this.pendingLimit = FLUSH_THRESHOLD;
        this.outMsgs = 0;
        this.inMsgs = 0;
        this.outBytes = 0;
        this.inBytes = 0;
        this.options = options;
        this.publisher = publisher;
        this.subscriptions = new Subscriptions();
        this.muxSubscriptions = new muxsubscription_1.MuxSubscription();
        this.outbound = new databuffer_1.DataBuffer();
        this.pongs = [];
        this.whyClosed = "";
        this.pendingLimit = options.pendingLimit || this.pendingLimit;
        this.features = new semver_1.Features({ major: 0, minor: 0, micro: 0 });
        this.connectPromise = null;
        this.dialDelay = null;
        const servers = typeof options.servers === "string" ? [options.servers] : options.servers;
        this.servers = new servers_1.Servers({
          randomize: !options.noRandomize
        });
        this.servers.setServers(servers);
        this.closed = (0, util_1.deferred)();
        this.parser = new parser_1.Parser(this);
        this.heartbeats = new heartbeats_1.Heartbeat(this, this.options.pingInterval || options_1.DEFAULT_PING_INTERVAL, this.options.maxPingOut || options_1.DEFAULT_MAX_PING_OUT);
      }
      resetOutbound() {
        this.outbound.reset();
        const pongs = this.pongs;
        this.pongs = [];
        const err = new errors_1.errors.RequestError("connection disconnected");
        err.stack = "";
        pongs.forEach((p) => {
          p.reject(err);
        });
        this.parser = new parser_1.Parser(this);
        this.infoReceived = false;
      }
      dispatchStatus(status) {
        this.listeners.forEach((q) => {
          q.push(status);
        });
      }
      prepare() {
        if (this.transport) {
          this.transport.discard();
        }
        this.info = void 0;
        this.resetOutbound();
        const pong = (0, util_1.deferred)();
        pong.catch(() => {
        });
        this.pongs.unshift(pong);
        this.connectError = (err) => {
          pong.reject(err);
        };
        this.transport = (0, transport_1.newTransport)();
        this.transport.closed().then(async (_err) => {
          this.connected = false;
          if (!this.isClosed()) {
            await this.disconnected(this.transport.closeError || this.lastError);
            return;
          }
        });
        return pong;
      }
      disconnect() {
        this.dispatchStatus({ type: "staleConnection" });
        this.transport.disconnect();
      }
      reconnect() {
        if (this.connected) {
          this.dispatchStatus({
            type: "forceReconnect"
          });
          this.transport.disconnect();
        }
        return Promise.resolve();
      }
      async disconnected(err) {
        this.dispatchStatus({
          type: "disconnect",
          server: this.servers.getCurrentServer().toString()
        });
        if (this.options.reconnect) {
          await this.dialLoop().then(() => {
            this.dispatchStatus({
              type: "reconnect",
              server: this.servers.getCurrentServer().toString()
            });
            if (this.lastError instanceof errors_1.errors.UserAuthenticationExpiredError) {
              this.lastError = void 0;
            }
          }).catch((err2) => {
            this.close(err2).catch();
          });
        } else {
          await this.close(err).catch();
        }
      }
      async dial(srv) {
        const pong = this.prepare();
        try {
          this.raceTimer = (0, util_1.timeout)(this.options.timeout || 2e4);
          const cp = this.transport.connect(srv, this.options);
          await Promise.race([cp, this.raceTimer]);
          (async () => {
            try {
              for await (const b of this.transport) {
                this.parser.parse(b);
              }
            } catch (err) {
              console.log("reader closed", err);
            }
          })().then();
        } catch (err) {
          pong.reject(err);
        }
        try {
          await Promise.race([this.raceTimer, pong]);
          this.raceTimer?.cancel();
          this.connected = true;
          this.connectError = void 0;
          this.sendSubscriptions();
          this.connectedOnce = true;
          this.server.didConnect = true;
          this.server.reconnects = 0;
          this.flushPending();
          this.heartbeats.start();
        } catch (err) {
          this.raceTimer?.cancel();
          await this.transport.close(err);
          throw err;
        }
      }
      async _doDial(srv) {
        const { resolve } = this.options;
        const alts = await srv.resolve({
          fn: (0, transport_1.getResolveFn)(),
          debug: this.options.debug,
          randomize: !this.options.noRandomize,
          resolve
        });
        let lastErr = null;
        for (const a of alts) {
          try {
            lastErr = null;
            this.dispatchStatus({ type: "reconnecting" });
            await this.dial(a);
            return;
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      }
      dialLoop() {
        if (this.connectPromise === null) {
          this.connectPromise = this.dodialLoop();
          this.connectPromise.then(() => {
          }).catch(() => {
          }).finally(() => {
            this.connectPromise = null;
          });
        }
        return this.connectPromise;
      }
      async dodialLoop() {
        let lastError;
        while (true) {
          if (this._closed) {
            this.servers.clear();
          }
          const wait = this.options.reconnectDelayHandler ? this.options.reconnectDelayHandler() : options_1.DEFAULT_RECONNECT_TIME_WAIT;
          let maxWait = wait;
          const srv = this.selectServer();
          if (!srv || this.abortReconnect) {
            if (lastError) {
              throw lastError;
            } else if (this.lastError) {
              throw this.lastError;
            } else {
              throw new errors_1.errors.ConnectionError("connection refused");
            }
          }
          const now = Date.now();
          if (srv.lastConnect === 0 || srv.lastConnect + wait <= now) {
            let target = srv;
            let extraDelay = 0;
            if (this.options.reconnectToServer) {
              try {
                const snap = this.servers.snapshotForHandler();
                const r = this.options.reconnectToServer(snap, this.info ?? null);
                let picked;
                if (isDelayedServer(r)) {
                  picked = r.server;
                  extraDelay = Number.isFinite(r.delay) && r.delay > 0 ? Math.floor(r.delay) : 0;
                } else {
                  picked = r;
                }
                if (picked !== null) {
                  const found = this.servers.find(picked);
                  if (!found) {
                    throw new Error(ERR_RECONNECT_HANDLER_NOT_IN_POOL);
                  }
                  if (found !== srv) {
                    target = found;
                    this.servers.setCurrent(target);
                    this.server = target;
                  }
                }
              } catch (cause) {
                const c = cause instanceof Error ? cause : new Error(String(cause));
                throw new errors_1.errors.ConnectionError(`${ERR_RECONNECT_HANDLER_FAILED}: ${c.message}`, { cause: c });
              }
            }
            if (extraDelay > 0) {
              this.dialDelay = (0, util_1.delay)(extraDelay);
              await this.dialDelay;
            }
            target.lastConnect = Date.now();
            try {
              await this._doDial(target);
              break;
            } catch (err) {
              lastError = err;
              if (!this.connectedOnce) {
                if (this.options.waitOnFirstConnect) {
                  continue;
                }
                this.servers.removeCurrentServer();
              }
              target.reconnects++;
              const mra = this.options.maxReconnectAttempts || 0;
              if (mra !== -1 && target.reconnects >= mra) {
                this.servers.removeCurrentServer();
              }
            }
          } else {
            maxWait = Math.min(maxWait, srv.lastConnect + wait - now);
            this.dialDelay = (0, util_1.delay)(maxWait);
            await this.dialDelay;
          }
        }
      }
      static async connect(options, publisher) {
        const h = new _ProtocolHandler(options, publisher);
        await h.dialLoop();
        return h;
      }
      static toError(s) {
        let err = errors_1.errors.PermissionViolationError.parse(s);
        if (err) {
          return err;
        }
        err = errors_1.errors.UserAuthenticationExpiredError.parse(s);
        if (err) {
          return err;
        }
        err = errors_1.errors.AuthorizationError.parse(s);
        if (err) {
          return err;
        }
        return new errors_1.errors.ProtocolError(s);
      }
      processMsg(msg, data) {
        this.inMsgs++;
        this.inBytes += data.length;
        if (!this.subscriptions.sidCounter) {
          return;
        }
        const sub = this.subscriptions.get(msg.sid);
        if (!sub) {
          return;
        }
        sub.received += 1;
        if (sub.callback) {
          sub.callback(null, new msg_1.MsgImpl(msg, data, this));
        }
        if (sub.max !== void 0 && sub.received >= sub.max) {
          sub.unsubscribe();
        }
      }
      processError(m) {
        let s = (0, encoders_1.decode)(m);
        if (s.startsWith("'") && s.endsWith("'")) {
          s = s.slice(1, s.length - 1);
        }
        const err = _ProtocolHandler.toError(s);
        switch (err.constructor) {
          case errors_1.errors.PermissionViolationError: {
            const pe = err;
            const mux = this.subscriptions.getMux();
            const isMuxPermission = mux ? pe.subject === mux.subject : false;
            this.subscriptions.handleError(pe);
            this.muxSubscriptions.handleError(isMuxPermission, pe);
            if (isMuxPermission) {
              this.subscriptions.setMux(null);
            }
          }
        }
        this.dispatchStatus({ type: "error", error: err });
        this.handleError(err);
      }
      handleError(err) {
        if (err instanceof errors_1.errors.UserAuthenticationExpiredError || err instanceof errors_1.errors.AuthorizationError) {
          this.handleAuthError(err);
        }
        if (!(err instanceof errors_1.errors.PermissionViolationError)) {
          this.lastError = err;
        }
      }
      handleAuthError(err) {
        if ((this.lastError instanceof errors_1.errors.UserAuthenticationExpiredError || this.lastError instanceof errors_1.errors.AuthorizationError) && this.options.ignoreAuthErrorAbort === false) {
          this.abortReconnect = true;
        }
        if (this.connectError) {
          this.connectError(err);
        } else {
          this.disconnect();
        }
      }
      processPing() {
        this.transport.send(PONG_CMD);
      }
      processPong() {
        const cb = this.pongs.shift();
        if (cb) {
          cb.resolve();
        }
      }
      processInfo(m) {
        const info = JSON.parse((0, encoders_1.decode)(m));
        this.info = info;
        const updates = this.options && this.options.ignoreClusterUpdates ? void 0 : this.servers.update(info, this.transport.isEncrypted());
        if (!this.infoReceived) {
          this.features.update((0, semver_1.parseSemVer)(info.version));
          this.infoReceived = true;
          if (this.transport.isEncrypted()) {
            this.servers.updateTLSName();
          }
          const { version, lang } = this.transport;
          try {
            const c = new Connect({ version, lang }, this.options, info.nonce);
            if (info.headers) {
              c.headers = true;
              c.no_responders = true;
            }
            const cs = JSON.stringify(c);
            this.transport.send((0, encoders_1.encode)(`CONNECT ${cs}${transport_1.CR_LF}`));
            this.transport.send(PING_CMD);
          } catch (err) {
            this.close(err).catch();
          }
        }
        if (updates) {
          const { added, deleted } = updates;
          this.dispatchStatus({ type: "update", added, deleted });
        }
        const ldm = info.ldm !== void 0 ? info.ldm : false;
        if (ldm) {
          this.dispatchStatus({
            type: "ldm",
            server: this.servers.getCurrentServer().toString()
          });
        }
      }
      push(e) {
        switch (e.kind) {
          case parser_1.Kind.MSG: {
            const { msg, data } = e;
            this.processMsg(msg, data);
            break;
          }
          case parser_1.Kind.OK:
            break;
          case parser_1.Kind.ERR:
            this.processError(e.data);
            break;
          case parser_1.Kind.PING:
            this.processPing();
            break;
          case parser_1.Kind.PONG:
            this.processPong();
            break;
          case parser_1.Kind.INFO:
            this.processInfo(e.data);
            break;
        }
      }
      sendCommand(cmd, ...payloads) {
        const len = this.outbound.length();
        let buf;
        if (typeof cmd === "string") {
          buf = (0, encoders_1.encode)(cmd);
        } else {
          buf = cmd;
        }
        this.outbound.fill(buf, ...payloads);
        if (len === 0) {
          queueMicrotask(() => {
            this.flushPending();
          });
        } else if (this.outbound.size() >= this.pendingLimit) {
          this.flushPending();
        }
      }
      publish(subject, payload = encoders_1.Empty, options) {
        let data;
        if (payload instanceof Uint8Array) {
          data = payload;
        } else if (typeof payload === "string") {
          data = encoders_1.TE.encode(payload);
        } else {
          throw new TypeError("payload types can be strings or Uint8Array");
        }
        let len = data.length;
        options = options || {};
        options.reply = options.reply || "";
        let headers3 = encoders_1.Empty;
        let hlen = 0;
        if (options.headers) {
          if (this.info && !this.info.headers) {
            errors_1.InvalidArgumentError.format("headers", "are not available on this server");
          }
          const hdrs = options.headers;
          headers3 = hdrs.encode();
          hlen = headers3.length;
          len = data.length + hlen;
        }
        if (this.info && len > this.info.max_payload) {
          throw errors_1.InvalidArgumentError.format("payload", "max_payload size exceeded");
        }
        this.outBytes += len;
        this.outMsgs++;
        let proto;
        if (options.headers) {
          if (options.reply) {
            proto = `HPUB ${subject} ${options.reply} ${hlen} ${len}\r
`;
          } else {
            proto = `HPUB ${subject} ${hlen} ${len}\r
`;
          }
          this.sendCommand(proto, headers3, data, transport_1.CRLF);
        } else {
          if (options.reply) {
            proto = `PUB ${subject} ${options.reply} ${len}\r
`;
          } else {
            proto = `PUB ${subject} ${len}\r
`;
          }
          this.sendCommand(proto, data, transport_1.CRLF);
        }
      }
      request(r) {
        this.initMux();
        this.muxSubscriptions.add(r);
        return r;
      }
      subscribe(s) {
        this.subscriptions.add(s);
        this._subunsub(s);
        return s;
      }
      _sub(s) {
        if (s.queue) {
          this.sendCommand(`SUB ${s.subject} ${s.queue} ${s.sid}\r
`);
        } else {
          this.sendCommand(`SUB ${s.subject} ${s.sid}\r
`);
        }
      }
      _subunsub(s) {
        this._sub(s);
        if (s.max) {
          this.unsubscribe(s, s.max);
        }
        return s;
      }
      unsubscribe(s, max) {
        this.unsub(s, max);
        if (s.max === void 0 || s.received >= s.max) {
          this.subscriptions.cancel(s);
        }
      }
      unsub(s, max) {
        if (!s || this.isClosed()) {
          return;
        }
        if (max) {
          this.sendCommand(`UNSUB ${s.sid} ${max}\r
`);
        } else {
          this.sendCommand(`UNSUB ${s.sid}\r
`);
        }
        s.max = max;
      }
      resub(s, subject) {
        if (!s || this.isClosed()) {
          return;
        }
        this.unsub(s);
        s.subject = subject;
        this.subscriptions.resub(s);
        this._sub(s);
      }
      flush(p) {
        if (!p) {
          p = (0, util_1.deferred)();
        }
        this.pongs.push(p);
        this.outbound.fill(PING_CMD);
        this.flushPending();
        return p;
      }
      sendSubscriptions() {
        const cmds = [];
        this.subscriptions.all().forEach((s) => {
          const sub = s;
          if (sub.queue) {
            cmds.push(`SUB ${sub.subject} ${sub.queue} ${sub.sid}${transport_1.CR_LF}`);
          } else {
            cmds.push(`SUB ${sub.subject} ${sub.sid}${transport_1.CR_LF}`);
          }
        });
        if (cmds.length) {
          this.transport.send((0, encoders_1.encode)(cmds.join("")));
        }
      }
      async close(err) {
        if (this._closed) {
          return;
        }
        this.whyClosed = new Error("close trace").stack || "";
        this.heartbeats.cancel();
        if (this.connectError) {
          this.connectError(err);
          this.connectError = void 0;
        }
        this.muxSubscriptions.close();
        this.subscriptions.close();
        const proms = [];
        for (let i = 0; i < this.listeners.length; i++) {
          const qi = this.listeners[i];
          if (qi) {
            qi.push({ type: "close" });
            qi.stop();
            proms.push(qi.iterClosed);
          }
        }
        if (proms.length) {
          await Promise.all(proms);
        }
        this._closed = true;
        await this.transport.close(err);
        this.raceTimer?.cancel();
        this.dialDelay?.cancel();
        this.closed.resolve(err);
      }
      isClosed() {
        return this._closed;
      }
      async drain() {
        const subs = this.subscriptions.all();
        const promises = [];
        subs.forEach((sub) => {
          promises.push(sub.drain());
        });
        try {
          await Promise.allSettled(promises);
        } catch {
        } finally {
          this.noMorePublishing = true;
          await this.flush();
        }
        return this.close();
      }
      flushPending() {
        if (!this.infoReceived || !this.connected) {
          return;
        }
        if (this.outbound.size()) {
          const d = this.outbound.drain();
          this.transport.send(d);
        }
      }
      initMux() {
        const mux = this.subscriptions.getMux();
        if (!mux) {
          const inbox = this.muxSubscriptions.init(this.options.inboxPrefix);
          const sub = new SubscriptionImpl(this, `${inbox}*`);
          sub.callback = this.muxSubscriptions.dispatcher();
          this.subscriptions.setMux(sub);
          this.subscribe(sub);
        }
      }
      selectServer() {
        const server = this.servers.selectServer();
        if (server === void 0) {
          return void 0;
        }
        this.server = server;
        return this.server;
      }
      getServer() {
        return this.server;
      }
    };
    exports2.ProtocolHandler = ProtocolHandler;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/request.js
var require_request = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/request.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.RequestOne = exports2.RequestMany = exports2.BaseRequest = void 0;
    var util_1 = require_util();
    var errors_1 = require_errors();
    var BaseRequest = class {
      token;
      received;
      ctx;
      requestSubject;
      mux;
      constructor(mux, requestSubject, asyncTraces = true) {
        this.mux = mux;
        this.requestSubject = requestSubject;
        this.received = 0;
        this.token = (0, util_1.randomToken)();
        if (asyncTraces) {
          this.ctx = new errors_1.RequestError();
        }
      }
    };
    exports2.BaseRequest = BaseRequest;
    var RequestMany = class extends BaseRequest {
      callback;
      done;
      timer;
      max;
      opts;
      constructor(mux, requestSubject, opts = { maxWait: 1e3 }) {
        super(mux, requestSubject);
        this.opts = opts;
        if (typeof this.opts.callback !== "function") {
          throw new TypeError("callback must be a function");
        }
        this.callback = this.opts.callback;
        this.max = typeof opts.maxMessages === "number" && opts.maxMessages > 0 ? opts.maxMessages : -1;
        this.done = (0, util_1.deferred)();
        this.done.then(() => {
          this.callback(null, null);
        });
        this.timer = setTimeout(() => {
          this.cancel();
        }, opts.maxWait);
      }
      cancel(err) {
        if (err) {
          this.callback(err, null);
        }
        clearTimeout(this.timer);
        this.mux.cancel(this);
        this.done.resolve();
      }
      resolver(err, msg) {
        if (err) {
          if (this.ctx) {
            err.stack += `

${this.ctx.stack}`;
          }
          this.cancel(err);
        } else {
          this.callback(null, msg);
          if (this.opts.strategy === "count") {
            this.max--;
            if (this.max === 0) {
              this.cancel();
            }
          }
          if (this.opts.strategy === "stall") {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
              this.cancel();
            }, this.opts.stall || 300);
          }
          if (this.opts.strategy === "sentinel") {
            if (msg && msg.data.length === 0) {
              this.cancel();
            }
          }
        }
      }
    };
    exports2.RequestMany = RequestMany;
    var RequestOne = class extends BaseRequest {
      deferred;
      timer;
      constructor(mux, requestSubject, opts = { timeout: 1e3 }, asyncTraces = true) {
        super(mux, requestSubject, asyncTraces);
        this.deferred = (0, util_1.deferred)();
        this.timer = (0, util_1.timeout)(opts.timeout, asyncTraces);
      }
      resolver(err, msg) {
        if (this.timer) {
          this.timer.cancel();
        }
        if (err) {
          if (!(err instanceof errors_1.TimeoutError)) {
            if (this.ctx) {
              this.ctx.message = err.message;
              this.ctx.cause = err;
              err = this.ctx;
            } else {
              err = new errors_1.errors.RequestError(err.message, { cause: err });
            }
          }
          this.deferred.reject(err);
        } else {
          this.deferred.resolve(msg);
        }
        this.cancel();
      }
      cancel(err) {
        if (this.timer) {
          this.timer.cancel();
        }
        this.mux.cancel(this);
        this.deferred.reject(err ? err : new errors_1.RequestError("cancelled"));
      }
    };
    exports2.RequestOne = RequestOne;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nats.js
var require_nats = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/nats.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NatsConnectionImpl = void 0;
    var util_1 = require_util();
    var protocol_1 = require_protocol();
    var encoders_1 = require_encoders();
    var headers_1 = require_headers();
    var semver_1 = require_semver();
    var options_1 = require_options();
    var queued_iterator_1 = require_queued_iterator();
    var request_1 = require_request();
    var core_1 = require_core();
    var errors_1 = require_errors();
    var whitespaceRegex = /[ \n\r\t]/;
    var NatsConnectionImpl = class _NatsConnectionImpl {
      options;
      protocol;
      draining;
      closeListeners;
      constructor(opts) {
        this.draining = false;
        this.options = (0, options_1.parseOptions)(opts);
      }
      static connect(opts = {}) {
        return new Promise((resolve, reject) => {
          const nc = new _NatsConnectionImpl(opts);
          protocol_1.ProtocolHandler.connect(nc.options, nc).then((ph) => {
            nc.protocol = ph;
            resolve(nc);
          }).catch((err) => {
            reject(err);
          });
        });
      }
      closed() {
        return this.protocol.closed;
      }
      async close() {
        await this.protocol.close();
      }
      _check(subject, sub, pub) {
        if (this.isClosed()) {
          throw new errors_1.errors.ClosedConnectionError();
        }
        if (sub && this.isDraining()) {
          throw new errors_1.errors.DrainingConnectionError();
        }
        if (pub && this.protocol.noMorePublishing) {
          throw new errors_1.errors.DrainingConnectionError();
        }
        subject = subject || "";
        if (subject.length === 0 || whitespaceRegex.test(subject)) {
          throw new errors_1.errors.InvalidSubjectError(subject);
        }
      }
      publish(subject, data, options) {
        this._check(subject, false, true);
        if (options?.reply) {
          this._check(options.reply, false, true);
        }
        if (typeof options?.traceOnly === "boolean") {
          const hdrs = options.headers || (0, headers_1.headers)();
          hdrs.set("Nats-Trace-Only", "true");
          options.headers = hdrs;
        }
        if (typeof options?.traceDestination === "string") {
          const hdrs = options.headers || (0, headers_1.headers)();
          hdrs.set("Nats-Trace-Dest", options.traceDestination);
          options.headers = hdrs;
        }
        this.protocol.publish(subject, data, options);
      }
      publishMessage(msg) {
        return this.publish(msg.subject, msg.data, {
          reply: msg.reply,
          headers: msg.headers
        });
      }
      respondMessage(msg) {
        if (msg.reply) {
          this.publish(msg.reply, msg.data, {
            reply: msg.reply,
            headers: msg.headers
          });
          return true;
        }
        return false;
      }
      subscribe(subject, opts = {}) {
        this._check(subject, true, false);
        const sub = new protocol_1.SubscriptionImpl(this.protocol, subject, opts);
        if (typeof opts.callback !== "function" && typeof opts.slow === "number") {
          sub.setSlowNotificationFn(opts.slow, (pending) => {
            this.protocol.dispatchStatus({
              type: "slowConsumer",
              sub,
              pending
            });
          });
        }
        this.protocol.subscribe(sub);
        return sub;
      }
      _resub(s, subject, max) {
        this._check(subject, true, false);
        const si = s;
        si.max = max;
        if (max) {
          si.max = max + si.received;
        }
        this.protocol.resub(si, subject);
      }
      // possibilities are:
      // stop on error or any non-100 status
      // AND:
      // - wait for timer
      // - wait for n messages or timer
      // - wait for unknown messages, done when empty or reset timer expires (with possible alt wait)
      // - wait for unknown messages, done when an empty payload is received or timer expires (with possible alt wait)
      requestMany(subject, data = encoders_1.Empty, opts = { maxWait: 1e3, maxMessages: -1 }) {
        const asyncTraces = !(this.protocol.options.noAsyncTraces || false);
        try {
          this._check(subject, true, true);
        } catch (err) {
          return Promise.reject(err);
        }
        opts.strategy = opts.strategy || "timer";
        opts.maxWait = opts.maxWait || 1e3;
        if (opts.maxWait < 1) {
          return Promise.reject(errors_1.InvalidArgumentError.format("timeout", "must be greater than 0"));
        }
        const qi = new queued_iterator_1.QueuedIteratorImpl();
        function stop(err) {
          qi.push(() => {
            qi.stop(err);
          });
        }
        function callback(err, msg) {
          if (err || msg === null) {
            stop(err === null ? void 0 : err);
          } else {
            qi.push(msg);
          }
        }
        if (opts.noMux) {
          const stack = asyncTraces ? new Error().stack : null;
          let max = typeof opts.maxMessages === "number" && opts.maxMessages > 0 ? opts.maxMessages : -1;
          const sub = this.subscribe((0, core_1.createInbox)(this.options.inboxPrefix), {
            callback: (err, msg) => {
              if (msg?.data?.length === 0 && msg?.headers?.status === "503") {
                err = new errors_1.errors.NoRespondersError(subject);
              }
              if (err) {
                if (stack) {
                  err.stack += `

${stack}`;
                }
                cancel(err);
                return;
              }
              callback(null, msg);
              if (opts.strategy === "count") {
                max--;
                if (max === 0) {
                  cancel();
                }
              }
              if (opts.strategy === "stall") {
                clearTimers();
                timer = setTimeout(() => {
                  cancel();
                }, 300);
              }
              if (opts.strategy === "sentinel") {
                if (msg && msg.data.length === 0) {
                  cancel();
                }
              }
            }
          });
          sub.requestSubject = subject;
          sub.closed.then(() => {
            stop();
          }).catch((err) => {
            qi.stop(err);
          });
          const cancel = (err) => {
            if (err) {
              qi.push(() => {
                throw err;
              });
            }
            clearTimers();
            sub.drain().then(() => {
              stop();
            }).catch((_err) => {
              stop();
            });
          };
          qi.iterClosed.then(() => {
            clearTimers();
            sub?.unsubscribe();
          }).catch((_err) => {
            clearTimers();
            sub?.unsubscribe();
          });
          const { headers: headers3, traceDestination, traceOnly } = opts;
          try {
            this.publish(subject, data, {
              reply: sub.getSubject(),
              headers: headers3,
              traceDestination,
              traceOnly
            });
          } catch (err) {
            cancel(err);
          }
          let timer = setTimeout(() => {
            cancel();
          }, opts.maxWait);
          const clearTimers = () => {
            if (timer) {
              clearTimeout(timer);
            }
          };
        } else {
          const rmo = opts;
          rmo.callback = callback;
          qi.iterClosed.then(() => {
            r.cancel();
          }).catch((err) => {
            r.cancel(err);
          });
          const r = new request_1.RequestMany(this.protocol.muxSubscriptions, subject, rmo);
          this.protocol.request(r);
          const { headers: headers3, traceDestination, traceOnly } = opts;
          try {
            this.publish(subject, data, {
              reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
              headers: headers3,
              traceDestination,
              traceOnly
            });
          } catch (err) {
            r.cancel(err);
          }
        }
        return Promise.resolve(qi);
      }
      request(subject, data, opts = { timeout: 1e3, noMux: false }) {
        try {
          this._check(subject, true, true);
        } catch (err) {
          return Promise.reject(err);
        }
        const asyncTraces = !(this.protocol.options.noAsyncTraces || false);
        opts.timeout = opts.timeout || 1e3;
        if (opts.timeout < 1) {
          return Promise.reject(errors_1.InvalidArgumentError.format("timeout", `must be greater than 0`));
        }
        if (!opts.noMux && opts.reply) {
          return Promise.reject(errors_1.InvalidArgumentError.format(["reply", "noMux"], "are mutually exclusive"));
        }
        if (opts.noMux) {
          const inbox = opts.reply ? opts.reply : (0, core_1.createInbox)(this.options.inboxPrefix);
          const d = (0, util_1.deferred)();
          const errCtx = asyncTraces ? new errors_1.errors.RequestError("") : null;
          const sub = this.subscribe(inbox, {
            max: 1,
            timeout: opts.timeout,
            callback: (err, msg) => {
              if (msg && msg.data?.length === 0 && msg.headers?.code === 503) {
                err = new errors_1.errors.NoRespondersError(subject);
              }
              if (err) {
                if (!(err instanceof errors_1.TimeoutError)) {
                  if (errCtx) {
                    errCtx.message = err.message;
                    errCtx.cause = err;
                    err = errCtx;
                  } else {
                    err = new errors_1.errors.RequestError(err.message, { cause: err });
                  }
                }
                d.reject(err);
                sub.unsubscribe();
              } else {
                d.resolve(msg);
              }
            }
          });
          sub.requestSubject = subject;
          this.protocol.publish(subject, data, {
            reply: inbox,
            headers: opts.headers
          });
          return d;
        } else {
          const r = new request_1.RequestOne(this.protocol.muxSubscriptions, subject, opts, asyncTraces);
          this.protocol.request(r);
          const { headers: headers3, traceDestination, traceOnly } = opts;
          try {
            this.publish(subject, data, {
              reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
              headers: headers3,
              traceDestination,
              traceOnly
            });
          } catch (err) {
            r.cancel(err);
          }
          const p = Promise.race([r.timer, r.deferred]);
          p.catch(() => {
            r.cancel();
          });
          return p;
        }
      }
      /** *
       * Flushes to the server. Promise resolves when round-trip completes.
       * @returns {Promise<void>}
       */
      flush() {
        if (this.isClosed()) {
          return Promise.reject(new errors_1.errors.ClosedConnectionError());
        }
        return this.protocol.flush();
      }
      drain() {
        if (this.isClosed()) {
          return Promise.reject(new errors_1.errors.ClosedConnectionError());
        }
        if (this.isDraining()) {
          return Promise.reject(new errors_1.errors.DrainingConnectionError());
        }
        this.draining = true;
        return this.protocol.drain();
      }
      async [Symbol.asyncDispose]() {
        if (this.isClosed()) {
          return;
        }
        if (this.isDraining()) {
          await this.closed();
          return;
        }
        await this.drain();
      }
      isClosed() {
        return this.protocol.isClosed();
      }
      isDraining() {
        return this.draining;
      }
      getServer() {
        const srv = this.protocol.getServer();
        return srv ? srv.listen : "";
      }
      setServers(servers) {
        this.protocol.servers.setServers(servers);
      }
      getServers() {
        return this.protocol.servers.snapshot();
      }
      status() {
        const iter = new queued_iterator_1.QueuedIteratorImpl();
        iter.iterClosed.then(() => {
          const idx = this.protocol.listeners.indexOf(iter);
          if (idx > -1) {
            this.protocol.listeners.splice(idx, 1);
          }
        });
        this.protocol.listeners.push(iter);
        return iter;
      }
      get info() {
        return this.protocol.isClosed() ? void 0 : this.protocol.info;
      }
      async context() {
        const r = await this.request(`$SYS.REQ.USER.INFO`);
        return r.json((key, value) => {
          if (key === "time") {
            return new Date(Date.parse(value));
          }
          return value;
        });
      }
      stats() {
        return {
          inBytes: this.protocol.inBytes,
          outBytes: this.protocol.outBytes,
          inMsgs: this.protocol.inMsgs,
          outMsgs: this.protocol.outMsgs
        };
      }
      getServerVersion() {
        const info = this.info;
        return info ? (0, semver_1.parseSemVer)(info.version) : void 0;
      }
      async rtt() {
        if (this.isClosed()) {
          throw new errors_1.errors.ClosedConnectionError();
        }
        if (!this.protocol.connected) {
          throw new errors_1.errors.RequestError("connection disconnected");
        }
        const start = Date.now();
        await this.flush();
        return Date.now() - start;
      }
      get features() {
        return this.protocol.features;
      }
      reconnect() {
        if (this.isClosed()) {
          return Promise.reject(new errors_1.errors.ClosedConnectionError());
        }
        if (this.isDraining()) {
          return Promise.reject(new errors_1.errors.DrainingConnectionError());
        }
        return this.protocol.reconnect();
      }
      // internal
      addCloseListener(listener) {
        if (this.closeListeners === void 0) {
          this.closeListeners = new CloseListeners(this.closed());
        }
        this.closeListeners.add(listener);
      }
      // internal
      removeCloseListener(listener) {
        if (this.closeListeners) {
          this.closeListeners.remove(listener);
        }
      }
    };
    exports2.NatsConnectionImpl = NatsConnectionImpl;
    var CloseListeners = class {
      listeners;
      constructor(closed) {
        this.listeners = [];
        closed.then((err) => {
          this.notify(err);
        });
      }
      add(listener) {
        this.listeners.push(listener);
      }
      remove(listener) {
        this.listeners = this.listeners.filter((l) => l !== listener);
      }
      notify(err) {
        this.listeners.forEach((l) => {
          if (typeof l.connectionClosedCallback === "function") {
            try {
              l.connectionClosedCallback(err);
            } catch (_) {
            }
          }
        });
        this.listeners = [];
      }
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/types.js
var require_types2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Empty = void 0;
    var encoders_1 = require_encoders();
    Object.defineProperty(exports2, "Empty", { enumerable: true, get: function() {
      return encoders_1.Empty;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/bench.js
var require_bench = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/bench.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Bench = exports2.Metric = void 0;
    exports2.throughput = throughput;
    exports2.msgThroughput = msgThroughput;
    exports2.humanizeBytes = humanizeBytes;
    var types_1 = require_types2();
    var nuid_1 = require_nuid2();
    var util_1 = require_util();
    var Metric = class {
      name;
      duration;
      date;
      payload;
      msgs;
      lang;
      version;
      bytes;
      asyncRequests;
      min;
      max;
      constructor(name, duration) {
        this.name = name;
        this.duration = duration;
        this.date = Date.now();
        this.payload = 0;
        this.msgs = 0;
        this.bytes = 0;
      }
      toString() {
        const sec = this.duration / 1e3;
        const mps = Math.round(this.msgs / sec);
        const label = this.asyncRequests ? "asyncRequests" : "";
        let minmax = "";
        if (this.max) {
          minmax = `${this.min}/${this.max}`;
        }
        return `${this.name}${label ? " [asyncRequests]" : ""} ${humanizeNumber(mps)} msgs/sec - [${sec.toFixed(2)} secs] ~ ${throughput(this.bytes, sec)} ${minmax}`;
      }
      toCsv() {
        return `"${this.name}",${new Date(this.date).toISOString()},${this.lang},${this.version},${this.msgs},${this.payload},${this.bytes},${this.duration},${this.asyncRequests ? this.asyncRequests : false}
`;
      }
      static header() {
        return `Test,Date,Lang,Version,Count,MsgPayload,Bytes,Millis,Async
`;
      }
    };
    exports2.Metric = Metric;
    var Bench = class {
      nc;
      callbacks;
      msgs;
      size;
      subject;
      asyncRequests;
      pub;
      sub;
      req;
      rep;
      perf;
      payload;
      constructor(nc, opts = {
        msgs: 1e5,
        size: 128,
        subject: "",
        asyncRequests: false,
        pub: false,
        sub: false,
        req: false,
        rep: false
      }) {
        this.nc = nc;
        this.callbacks = opts.callbacks || false;
        this.msgs = opts.msgs || 0;
        this.size = opts.size || 0;
        this.subject = opts.subject || nuid_1.nuid.next();
        this.asyncRequests = opts.asyncRequests || false;
        this.pub = opts.pub || false;
        this.sub = opts.sub || false;
        this.req = opts.req || false;
        this.rep = opts.rep || false;
        this.perf = new util_1.Perf();
        this.payload = this.size ? new Uint8Array(this.size) : types_1.Empty;
        if (!this.pub && !this.sub && !this.req && !this.rep) {
          throw new Error("no options selected");
        }
      }
      async run() {
        this.nc.closed().then((err) => {
          if (err) {
            throw err;
          }
        });
        if (this.callbacks) {
          await this.runCallbacks();
        } else {
          await this.runAsync();
        }
        return this.processMetrics();
      }
      processMetrics() {
        const nc = this.nc;
        const { lang, version } = nc.protocol.transport;
        if (this.pub && this.sub) {
          this.perf.measure("pubsub", "pubStart", "subStop");
        }
        if (this.req && this.rep) {
          this.perf.measure("reqrep", "reqStart", "reqStop");
        }
        const measures = this.perf.getEntries();
        const pubsub = measures.find((m) => m.name === "pubsub");
        const reqrep = measures.find((m) => m.name === "reqrep");
        const req = measures.find((m) => m.name === "req");
        const rep = measures.find((m) => m.name === "rep");
        const pub = measures.find((m) => m.name === "pub");
        const sub = measures.find((m) => m.name === "sub");
        const stats = this.nc.stats();
        const metrics = [];
        if (pubsub) {
          const { name, duration } = pubsub;
          const m = new Metric(name, duration);
          m.msgs = this.msgs * 2;
          m.bytes = stats.inBytes + stats.outBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        if (reqrep) {
          const { name, duration } = reqrep;
          const m = new Metric(name, duration);
          m.msgs = this.msgs * 2;
          m.bytes = stats.inBytes + stats.outBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        if (pub) {
          const { name, duration } = pub;
          const m = new Metric(name, duration);
          m.msgs = this.msgs;
          m.bytes = stats.outBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        if (sub) {
          const { name, duration } = sub;
          const m = new Metric(name, duration);
          m.msgs = this.msgs;
          m.bytes = stats.inBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        if (rep) {
          const { name, duration } = rep;
          const m = new Metric(name, duration);
          m.msgs = this.msgs;
          m.bytes = stats.inBytes + stats.outBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        if (req) {
          const { name, duration } = req;
          const m = new Metric(name, duration);
          m.msgs = this.msgs;
          m.bytes = stats.inBytes + stats.outBytes;
          m.lang = lang;
          m.version = version;
          m.payload = this.payload.length;
          metrics.push(m);
        }
        return metrics;
      }
      async runCallbacks() {
        const jobs = [];
        if (this.sub) {
          const d = (0, util_1.deferred)();
          jobs.push(d);
          let i = 0;
          this.nc.subscribe(this.subject, {
            max: this.msgs,
            callback: () => {
              i++;
              if (i === 1) {
                this.perf.mark("subStart");
              }
              if (i === this.msgs) {
                this.perf.mark("subStop");
                this.perf.measure("sub", "subStart", "subStop");
                d.resolve();
              }
            }
          });
        }
        if (this.rep) {
          const d = (0, util_1.deferred)();
          jobs.push(d);
          let i = 0;
          this.nc.subscribe(this.subject, {
            max: this.msgs,
            callback: (_, m) => {
              m.respond(this.payload);
              i++;
              if (i === 1) {
                this.perf.mark("repStart");
              }
              if (i === this.msgs) {
                this.perf.mark("repStop");
                this.perf.measure("rep", "repStart", "repStop");
                d.resolve();
              }
            }
          });
        }
        if (this.pub) {
          const job = (async () => {
            this.perf.mark("pubStart");
            for (let i = 0; i < this.msgs; i++) {
              this.nc.publish(this.subject, this.payload);
            }
            await this.nc.flush();
            this.perf.mark("pubStop");
            this.perf.measure("pub", "pubStart", "pubStop");
          })();
          jobs.push(job);
        }
        if (this.req) {
          const job = (async () => {
            if (this.asyncRequests) {
              this.perf.mark("reqStart");
              const a = [];
              for (let i = 0; i < this.msgs; i++) {
                a.push(this.nc.request(this.subject, this.payload, { timeout: 2e4 }));
              }
              await Promise.all(a);
              this.perf.mark("reqStop");
              this.perf.measure("req", "reqStart", "reqStop");
            } else {
              this.perf.mark("reqStart");
              for (let i = 0; i < this.msgs; i++) {
                await this.nc.request(this.subject);
              }
              this.perf.mark("reqStop");
              this.perf.measure("req", "reqStart", "reqStop");
            }
          })();
          jobs.push(job);
        }
        await Promise.all(jobs);
      }
      async runAsync() {
        const jobs = [];
        if (this.rep) {
          let first = false;
          const sub = this.nc.subscribe(this.subject, { max: this.msgs });
          const job = (async () => {
            for await (const m of sub) {
              if (!first) {
                this.perf.mark("repStart");
                first = true;
              }
              m.respond(this.payload);
            }
            await this.nc.flush();
            this.perf.mark("repStop");
            this.perf.measure("rep", "repStart", "repStop");
          })();
          jobs.push(job);
        }
        if (this.sub) {
          let first = false;
          const sub = this.nc.subscribe(this.subject, { max: this.msgs });
          const job = (async () => {
            for await (const _m of sub) {
              if (!first) {
                this.perf.mark("subStart");
                first = true;
              }
            }
            this.perf.mark("subStop");
            this.perf.measure("sub", "subStart", "subStop");
          })();
          jobs.push(job);
        }
        if (this.pub) {
          const job = (async () => {
            this.perf.mark("pubStart");
            for (let i = 0; i < this.msgs; i++) {
              this.nc.publish(this.subject, this.payload);
            }
            await this.nc.flush();
            this.perf.mark("pubStop");
            this.perf.measure("pub", "pubStart", "pubStop");
          })();
          jobs.push(job);
        }
        if (this.req) {
          const job = (async () => {
            if (this.asyncRequests) {
              this.perf.mark("reqStart");
              const a = [];
              for (let i = 0; i < this.msgs; i++) {
                a.push(this.nc.request(this.subject, this.payload, { timeout: 2e4 }));
              }
              await Promise.all(a);
              this.perf.mark("reqStop");
              this.perf.measure("req", "reqStart", "reqStop");
            } else {
              this.perf.mark("reqStart");
              for (let i = 0; i < this.msgs; i++) {
                await this.nc.request(this.subject);
              }
              this.perf.mark("reqStop");
              this.perf.measure("req", "reqStart", "reqStop");
            }
          })();
          jobs.push(job);
        }
        await Promise.all(jobs);
      }
    };
    exports2.Bench = Bench;
    function throughput(bytes, seconds) {
      return `${humanizeBytes(bytes / seconds)}/sec`;
    }
    function msgThroughput(msgs, seconds) {
      return `${Math.floor(msgs / seconds)} msgs/sec`;
    }
    function humanizeBytes(bytes, si = false) {
      const base = si ? 1e3 : 1024;
      const pre = si ? ["k", "M", "G", "T", "P", "E"] : ["K", "M", "G", "T", "P", "E"];
      const post = si ? "iB" : "B";
      if (bytes < base) {
        return `${bytes.toFixed(2)} ${post}`;
      }
      const exp = parseInt(Math.log(bytes) / Math.log(base) + "");
      const index = parseInt(exp - 1 + "");
      return `${(bytes / Math.pow(base, exp)).toFixed(2)} ${pre[index]}${post}`;
    }
    function humanizeNumber(n) {
      return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/idleheartbeat_monitor.js
var require_idleheartbeat_monitor = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/idleheartbeat_monitor.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.IdleHeartbeatMonitor = void 0;
    var IdleHeartbeatMonitor = class {
      interval;
      maxOut;
      cancelAfter;
      timer;
      autoCancelTimer;
      last;
      missed;
      count;
      callback;
      /**
       * Constructor
       * @param interval in millis to check
       * @param cb a callback to report when heartbeats are missed
       * @param opts monitor options @see IdleHeartbeatOptions
       */
      constructor(interval, cb, opts = { maxOut: 2 }) {
        this.interval = interval;
        this.maxOut = opts?.maxOut || 2;
        this.cancelAfter = opts?.cancelAfter || 0;
        this.last = Date.now();
        this.missed = 0;
        this.count = 0;
        this.callback = cb;
        this._schedule();
      }
      /**
       * cancel monitoring
       */
      cancel() {
        if (this.autoCancelTimer) {
          clearTimeout(this.autoCancelTimer);
        }
        if (this.timer) {
          clearInterval(this.timer);
        }
        this.timer = 0;
        this.autoCancelTimer = 0;
        this.missed = 0;
      }
      /**
       * work signals that there was work performed
       */
      work() {
        this.last = Date.now();
        this.missed = 0;
      }
      /**
       * internal api to change the interval, cancelAfter and maxOut
       * @param interval
       * @param cancelAfter
       * @param maxOut
       */
      _change(interval, cancelAfter = 0, maxOut = 2) {
        this.interval = interval;
        this.maxOut = maxOut;
        this.cancelAfter = cancelAfter;
        this.restart();
      }
      /**
       * cancels and restarts the monitoring
       */
      restart() {
        this.cancel();
        this._schedule();
      }
      /**
       * internal api called to start monitoring
       */
      _schedule() {
        if (this.cancelAfter > 0) {
          this.autoCancelTimer = setTimeout(() => {
            this.cancel();
          }, this.cancelAfter);
        }
        this.timer = setInterval(() => {
          this.count++;
          if (Date.now() - this.last > this.interval) {
            this.missed++;
          }
          if (this.missed >= this.maxOut) {
            try {
              if (this.callback(this.missed) === true) {
                this.cancel();
              }
            } catch (err) {
              console.log(err);
            }
          }
        }, this.interval);
      }
    };
    exports2.IdleHeartbeatMonitor = IdleHeartbeatMonitor;
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/version.js
var require_version2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/version.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = void 0;
    exports2.version = "3.4.0";
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/ws_transport.js
var require_ws_transport = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/ws_transport.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WsTransport = void 0;
    exports2.wsUrlParseFn = wsUrlParseFn;
    exports2.wsconnect = wsconnect2;
    var util_1 = require_util();
    var transport_1 = require_transport();
    var options_1 = require_options();
    var databuffer_1 = require_databuffer();
    var protocol_1 = require_protocol();
    var nats_1 = require_nats();
    var version_1 = require_version2();
    var errors_1 = require_errors();
    var VERSION = version_1.version;
    var LANG = "nats.ws";
    var WsTransport = class {
      version;
      lang;
      closeError;
      connected;
      done;
      // @ts-ignore: expecting global WebSocket
      socket;
      options;
      socketClosed;
      encrypted;
      peeked;
      yields;
      signal;
      closedNotification;
      constructor() {
        this.version = VERSION;
        this.lang = LANG;
        this.connected = false;
        this.done = false;
        this.socketClosed = false;
        this.encrypted = false;
        this.peeked = false;
        this.yields = [];
        this.signal = (0, util_1.deferred)();
        this.closedNotification = (0, util_1.deferred)();
      }
      async connect(server, options) {
        const connected = false;
        const ok = (0, util_1.deferred)();
        this.options = options;
        const u = server.src;
        if (options.wsFactory) {
          const { socket, encrypted } = await options.wsFactory(server.src, options);
          this.socket = socket;
          this.encrypted = encrypted;
        } else {
          this.encrypted = u.indexOf("wss://") === 0;
          this.socket = new WebSocket(u);
        }
        this.socket.binaryType = "arraybuffer";
        this.socket.onopen = () => {
          if (this.done) {
            this._closed(new Error("aborted"));
          }
        };
        this.socket.onmessage = (me) => {
          if (this.done) {
            return;
          }
          this.yields.push(new Uint8Array(me.data));
          if (this.peeked) {
            this.signal.resolve();
            return;
          }
          const t = databuffer_1.DataBuffer.concat(...this.yields);
          const pm = (0, transport_1.extractProtocolMessage)(t);
          if (pm !== "") {
            const m = protocol_1.INFO.exec(pm);
            if (!m) {
              if (options.debug) {
                console.error("!!!", (0, util_1.render)(t));
              }
              ok.reject(new Error("unexpected response from server"));
              return;
            }
            try {
              const info = JSON.parse(m[1]);
              (0, options_1.checkOptions)(info, this.options);
              this.peeked = true;
              this.connected = true;
              this.signal.resolve();
              ok.resolve();
            } catch (err) {
              ok.reject(err);
              return;
            }
          }
        };
        this.socket.onclose = (evt) => {
          let reason;
          if (!evt.wasClean && evt.reason !== "") {
            reason = new Error(evt.reason);
          }
          this._closed(reason);
          this._cleanup();
        };
        this.socket.onerror = (e) => {
          if (this.done) {
            return;
          }
          const evt = e;
          const err = new errors_1.errors.ConnectionError(evt.message);
          if (!connected) {
            ok.reject(err);
          } else {
            this._closed(err);
          }
          this._cleanup();
        };
        return ok;
      }
      _cleanup() {
        if (this.socketClosed === false) {
          this.socketClosed = true;
          this.socket.onopen = null;
          this.socket.onmessage = null;
          this.socket.onerror = null;
          this.socket.onclose = null;
          this.closedNotification.resolve(this.closeError);
        }
      }
      disconnect() {
        this._closed(void 0, true);
      }
      async _closed(err, _internal = true) {
        if (this.done) {
          try {
            this.socket.close();
          } catch (_) {
          }
          return;
        }
        this.closeError = err;
        if (!err) {
          while (!this.socketClosed && this.socket.bufferedAmount > 0) {
            await (0, util_1.delay)(100);
          }
        }
        this.done = true;
        try {
          this.socket.close();
        } catch (_) {
        }
        return this.closedNotification;
      }
      get isClosed() {
        return this.done;
      }
      [Symbol.asyncIterator]() {
        return this.iterate();
      }
      async *iterate() {
        while (true) {
          if (this.done) {
            return;
          }
          if (this.yields.length === 0) {
            await this.signal;
          }
          const yields = this.yields;
          this.yields = [];
          for (let i = 0; i < yields.length; i++) {
            if (this.options.debug) {
              console.info(`> ${(0, util_1.render)(yields[i])}`);
            }
            yield yields[i];
          }
          if (this.done) {
            break;
          } else if (this.yields.length === 0) {
            yields.length = 0;
            this.yields = yields;
            this.signal = (0, util_1.deferred)();
          }
        }
      }
      isEncrypted() {
        return this.connected && this.encrypted;
      }
      send(frame) {
        if (this.done) {
          return;
        }
        try {
          this.socket.send(frame.buffer);
          if (this.options.debug) {
            console.info(`< ${(0, util_1.render)(frame)}`);
          }
          return;
        } catch (err) {
          if (this.options.debug) {
            console.error(`!!! ${(0, util_1.render)(frame)}: ${err}`);
          }
        }
      }
      close(err) {
        return this._closed(err, false);
      }
      closed() {
        return this.closedNotification;
      }
      // this is to allow a force discard on a connection
      // if the connection fails during the handshake protocol.
      // Firefox for example, will keep connections going,
      // so eventually if it succeeds, the client will have
      // an additional transport running. With this
      discard() {
        this.socket?.close();
      }
    };
    exports2.WsTransport = WsTransport;
    function wsUrlParseFn(u, encrypted) {
      const ut = /^(.*:\/\/)(.*)/;
      if (!ut.test(u)) {
        if (typeof encrypted === "boolean") {
          u = `${encrypted === true ? "https" : "http"}://${u}`;
        } else {
          u = `https://${u}`;
        }
      }
      let url = new URL(u);
      const srcProto = url.protocol.toLowerCase();
      if (srcProto === "ws:") {
        encrypted = false;
      }
      if (srcProto === "wss:") {
        encrypted = true;
      }
      if (srcProto !== "https:" && srcProto !== "http") {
        u = u.replace(/^(.*:\/\/)(.*)/gm, "$2");
        url = new URL(`http://${u}`);
      }
      let protocol;
      let port;
      const host = url.hostname;
      const path = url.pathname;
      const search = url.search || "";
      switch (srcProto) {
        case "http:":
        case "ws:":
        case "nats:":
          port = url.port || "80";
          protocol = "ws:";
          break;
        case "https:":
        case "wss:":
        case "tls:":
          port = url.port || "443";
          protocol = "wss:";
          break;
        default:
          port = url.port || encrypted === true ? "443" : "80";
          protocol = encrypted === true ? "wss:" : "ws:";
          break;
      }
      return `${protocol}//${host}:${port}${path}${search}`;
    }
    function wsconnect2(opts = {}) {
      (0, transport_1.setTransportFactory)({
        defaultPort: 443,
        urlParseFn: wsUrlParseFn,
        factory: () => {
          if (opts.tls) {
            throw errors_1.InvalidArgumentError.format("tls", "is not configurable on w3c websocket connections");
          }
          return new WsTransport();
        }
      });
      return nats_1.NatsConnectionImpl.connect(opts);
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/internal_mod.js
var require_internal_mod = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/internal_mod.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Metric = exports2.Bench = exports2.writeAll = exports2.readAll = exports2.MAX_SIZE = exports2.DenoBuffer = exports2.State = exports2.Parser = exports2.Kind = exports2.describe = exports2.QueuedIteratorImpl = exports2.usernamePasswordAuthenticator = exports2.tokenAuthenticator = exports2.nkeyAuthenticator = exports2.jwtAuthenticator = exports2.credsAuthenticator = exports2.RequestOne = exports2.parseOptions = exports2.hasWsProtocol = exports2.defaultOptions = exports2.DEFAULT_MAX_RECONNECT_ATTEMPTS = exports2.checkUnsupportedOption = exports2.checkOptions = exports2.buildAuthenticator = exports2.DataBuffer = exports2.MuxSubscription = exports2.Heartbeat = exports2.MsgHdrsImpl = exports2.headers = exports2.canonicalMIMEHeaderKey = exports2.timeout = exports2.SimpleMutex = exports2.render = exports2.nanos = exports2.millis = exports2.extend = exports2.delay = exports2.deferred = exports2.deadline = exports2.collect = exports2.backoff = exports2.ProtocolHandler = exports2.INFO = exports2.Connect = exports2.setTransportFactory = exports2.getResolveFn = exports2.MsgImpl = exports2.nuid = exports2.Nuid = exports2.NatsConnectionImpl = void 0;
    exports2.UserAuthenticationExpiredError = exports2.TimeoutError = exports2.RequestError = exports2.ProtocolError = exports2.PermissionViolationError = exports2.NoRespondersError = exports2.InvalidSubjectError = exports2.InvalidOperationError = exports2.InvalidArgumentError = exports2.errors = exports2.DrainingConnectionError = exports2.ConnectionError = exports2.ClosedConnectionError = exports2.AuthorizationError = exports2.wsUrlParseFn = exports2.wsconnect = exports2.Servers = exports2.isIPV4OrHostname = exports2.IdleHeartbeatMonitor = exports2.Subscriptions = exports2.SubscriptionImpl = exports2.syncIterator = exports2.Match = exports2.createInbox = exports2.protoLen = exports2.extractProtocolMessage = exports2.Empty = exports2.parseSemVer = exports2.Features = exports2.Feature = exports2.compare = exports2.parseIP = exports2.isIP = exports2.ipV4 = exports2.TE = exports2.TD = void 0;
    var nats_1 = require_nats();
    Object.defineProperty(exports2, "NatsConnectionImpl", { enumerable: true, get: function() {
      return nats_1.NatsConnectionImpl;
    } });
    var nuid_1 = require_nuid2();
    Object.defineProperty(exports2, "Nuid", { enumerable: true, get: function() {
      return nuid_1.Nuid;
    } });
    Object.defineProperty(exports2, "nuid", { enumerable: true, get: function() {
      return nuid_1.nuid;
    } });
    var msg_1 = require_msg();
    Object.defineProperty(exports2, "MsgImpl", { enumerable: true, get: function() {
      return msg_1.MsgImpl;
    } });
    var transport_1 = require_transport();
    Object.defineProperty(exports2, "getResolveFn", { enumerable: true, get: function() {
      return transport_1.getResolveFn;
    } });
    Object.defineProperty(exports2, "setTransportFactory", { enumerable: true, get: function() {
      return transport_1.setTransportFactory;
    } });
    var protocol_1 = require_protocol();
    Object.defineProperty(exports2, "Connect", { enumerable: true, get: function() {
      return protocol_1.Connect;
    } });
    Object.defineProperty(exports2, "INFO", { enumerable: true, get: function() {
      return protocol_1.INFO;
    } });
    Object.defineProperty(exports2, "ProtocolHandler", { enumerable: true, get: function() {
      return protocol_1.ProtocolHandler;
    } });
    var util_1 = require_util();
    Object.defineProperty(exports2, "backoff", { enumerable: true, get: function() {
      return util_1.backoff;
    } });
    Object.defineProperty(exports2, "collect", { enumerable: true, get: function() {
      return util_1.collect;
    } });
    Object.defineProperty(exports2, "deadline", { enumerable: true, get: function() {
      return util_1.deadline;
    } });
    Object.defineProperty(exports2, "deferred", { enumerable: true, get: function() {
      return util_1.deferred;
    } });
    Object.defineProperty(exports2, "delay", { enumerable: true, get: function() {
      return util_1.delay;
    } });
    Object.defineProperty(exports2, "extend", { enumerable: true, get: function() {
      return util_1.extend;
    } });
    Object.defineProperty(exports2, "millis", { enumerable: true, get: function() {
      return util_1.millis;
    } });
    Object.defineProperty(exports2, "nanos", { enumerable: true, get: function() {
      return util_1.nanos;
    } });
    Object.defineProperty(exports2, "render", { enumerable: true, get: function() {
      return util_1.render;
    } });
    Object.defineProperty(exports2, "SimpleMutex", { enumerable: true, get: function() {
      return util_1.SimpleMutex;
    } });
    Object.defineProperty(exports2, "timeout", { enumerable: true, get: function() {
      return util_1.timeout;
    } });
    var headers_1 = require_headers();
    Object.defineProperty(exports2, "canonicalMIMEHeaderKey", { enumerable: true, get: function() {
      return headers_1.canonicalMIMEHeaderKey;
    } });
    Object.defineProperty(exports2, "headers", { enumerable: true, get: function() {
      return headers_1.headers;
    } });
    Object.defineProperty(exports2, "MsgHdrsImpl", { enumerable: true, get: function() {
      return headers_1.MsgHdrsImpl;
    } });
    var heartbeats_1 = require_heartbeats();
    Object.defineProperty(exports2, "Heartbeat", { enumerable: true, get: function() {
      return heartbeats_1.Heartbeat;
    } });
    var muxsubscription_1 = require_muxsubscription();
    Object.defineProperty(exports2, "MuxSubscription", { enumerable: true, get: function() {
      return muxsubscription_1.MuxSubscription;
    } });
    var databuffer_1 = require_databuffer();
    Object.defineProperty(exports2, "DataBuffer", { enumerable: true, get: function() {
      return databuffer_1.DataBuffer;
    } });
    var options_1 = require_options();
    Object.defineProperty(exports2, "buildAuthenticator", { enumerable: true, get: function() {
      return options_1.buildAuthenticator;
    } });
    Object.defineProperty(exports2, "checkOptions", { enumerable: true, get: function() {
      return options_1.checkOptions;
    } });
    Object.defineProperty(exports2, "checkUnsupportedOption", { enumerable: true, get: function() {
      return options_1.checkUnsupportedOption;
    } });
    Object.defineProperty(exports2, "DEFAULT_MAX_RECONNECT_ATTEMPTS", { enumerable: true, get: function() {
      return options_1.DEFAULT_MAX_RECONNECT_ATTEMPTS;
    } });
    Object.defineProperty(exports2, "defaultOptions", { enumerable: true, get: function() {
      return options_1.defaultOptions;
    } });
    Object.defineProperty(exports2, "hasWsProtocol", { enumerable: true, get: function() {
      return options_1.hasWsProtocol;
    } });
    Object.defineProperty(exports2, "parseOptions", { enumerable: true, get: function() {
      return options_1.parseOptions;
    } });
    var request_1 = require_request();
    Object.defineProperty(exports2, "RequestOne", { enumerable: true, get: function() {
      return request_1.RequestOne;
    } });
    var authenticator_1 = require_authenticator();
    Object.defineProperty(exports2, "credsAuthenticator", { enumerable: true, get: function() {
      return authenticator_1.credsAuthenticator;
    } });
    Object.defineProperty(exports2, "jwtAuthenticator", { enumerable: true, get: function() {
      return authenticator_1.jwtAuthenticator;
    } });
    Object.defineProperty(exports2, "nkeyAuthenticator", { enumerable: true, get: function() {
      return authenticator_1.nkeyAuthenticator;
    } });
    Object.defineProperty(exports2, "tokenAuthenticator", { enumerable: true, get: function() {
      return authenticator_1.tokenAuthenticator;
    } });
    Object.defineProperty(exports2, "usernamePasswordAuthenticator", { enumerable: true, get: function() {
      return authenticator_1.usernamePasswordAuthenticator;
    } });
    __exportStar(require_nkeys2(), exports2);
    var queued_iterator_1 = require_queued_iterator();
    Object.defineProperty(exports2, "QueuedIteratorImpl", { enumerable: true, get: function() {
      return queued_iterator_1.QueuedIteratorImpl;
    } });
    var parser_1 = require_parser();
    Object.defineProperty(exports2, "describe", { enumerable: true, get: function() {
      return parser_1.describe;
    } });
    Object.defineProperty(exports2, "Kind", { enumerable: true, get: function() {
      return parser_1.Kind;
    } });
    Object.defineProperty(exports2, "Parser", { enumerable: true, get: function() {
      return parser_1.Parser;
    } });
    Object.defineProperty(exports2, "State", { enumerable: true, get: function() {
      return parser_1.State;
    } });
    var denobuffer_1 = require_denobuffer();
    Object.defineProperty(exports2, "DenoBuffer", { enumerable: true, get: function() {
      return denobuffer_1.DenoBuffer;
    } });
    Object.defineProperty(exports2, "MAX_SIZE", { enumerable: true, get: function() {
      return denobuffer_1.MAX_SIZE;
    } });
    Object.defineProperty(exports2, "readAll", { enumerable: true, get: function() {
      return denobuffer_1.readAll;
    } });
    Object.defineProperty(exports2, "writeAll", { enumerable: true, get: function() {
      return denobuffer_1.writeAll;
    } });
    var bench_1 = require_bench();
    Object.defineProperty(exports2, "Bench", { enumerable: true, get: function() {
      return bench_1.Bench;
    } });
    Object.defineProperty(exports2, "Metric", { enumerable: true, get: function() {
      return bench_1.Metric;
    } });
    var encoders_1 = require_encoders();
    Object.defineProperty(exports2, "TD", { enumerable: true, get: function() {
      return encoders_1.TD;
    } });
    Object.defineProperty(exports2, "TE", { enumerable: true, get: function() {
      return encoders_1.TE;
    } });
    var ipparser_1 = require_ipparser();
    Object.defineProperty(exports2, "ipV4", { enumerable: true, get: function() {
      return ipparser_1.ipV4;
    } });
    Object.defineProperty(exports2, "isIP", { enumerable: true, get: function() {
      return ipparser_1.isIP;
    } });
    Object.defineProperty(exports2, "parseIP", { enumerable: true, get: function() {
      return ipparser_1.parseIP;
    } });
    var semver_1 = require_semver();
    Object.defineProperty(exports2, "compare", { enumerable: true, get: function() {
      return semver_1.compare;
    } });
    Object.defineProperty(exports2, "Feature", { enumerable: true, get: function() {
      return semver_1.Feature;
    } });
    Object.defineProperty(exports2, "Features", { enumerable: true, get: function() {
      return semver_1.Features;
    } });
    Object.defineProperty(exports2, "parseSemVer", { enumerable: true, get: function() {
      return semver_1.parseSemVer;
    } });
    var types_1 = require_types2();
    Object.defineProperty(exports2, "Empty", { enumerable: true, get: function() {
      return types_1.Empty;
    } });
    var transport_2 = require_transport();
    Object.defineProperty(exports2, "extractProtocolMessage", { enumerable: true, get: function() {
      return transport_2.extractProtocolMessage;
    } });
    Object.defineProperty(exports2, "protoLen", { enumerable: true, get: function() {
      return transport_2.protoLen;
    } });
    var core_1 = require_core();
    Object.defineProperty(exports2, "createInbox", { enumerable: true, get: function() {
      return core_1.createInbox;
    } });
    Object.defineProperty(exports2, "Match", { enumerable: true, get: function() {
      return core_1.Match;
    } });
    Object.defineProperty(exports2, "syncIterator", { enumerable: true, get: function() {
      return core_1.syncIterator;
    } });
    var protocol_2 = require_protocol();
    Object.defineProperty(exports2, "SubscriptionImpl", { enumerable: true, get: function() {
      return protocol_2.SubscriptionImpl;
    } });
    Object.defineProperty(exports2, "Subscriptions", { enumerable: true, get: function() {
      return protocol_2.Subscriptions;
    } });
    var idleheartbeat_monitor_1 = require_idleheartbeat_monitor();
    Object.defineProperty(exports2, "IdleHeartbeatMonitor", { enumerable: true, get: function() {
      return idleheartbeat_monitor_1.IdleHeartbeatMonitor;
    } });
    var servers_1 = require_servers();
    Object.defineProperty(exports2, "isIPV4OrHostname", { enumerable: true, get: function() {
      return servers_1.isIPV4OrHostname;
    } });
    Object.defineProperty(exports2, "Servers", { enumerable: true, get: function() {
      return servers_1.Servers;
    } });
    var ws_transport_1 = require_ws_transport();
    Object.defineProperty(exports2, "wsconnect", { enumerable: true, get: function() {
      return ws_transport_1.wsconnect;
    } });
    Object.defineProperty(exports2, "wsUrlParseFn", { enumerable: true, get: function() {
      return ws_transport_1.wsUrlParseFn;
    } });
    var errors_1 = require_errors();
    Object.defineProperty(exports2, "AuthorizationError", { enumerable: true, get: function() {
      return errors_1.AuthorizationError;
    } });
    Object.defineProperty(exports2, "ClosedConnectionError", { enumerable: true, get: function() {
      return errors_1.ClosedConnectionError;
    } });
    Object.defineProperty(exports2, "ConnectionError", { enumerable: true, get: function() {
      return errors_1.ConnectionError;
    } });
    Object.defineProperty(exports2, "DrainingConnectionError", { enumerable: true, get: function() {
      return errors_1.DrainingConnectionError;
    } });
    Object.defineProperty(exports2, "errors", { enumerable: true, get: function() {
      return errors_1.errors;
    } });
    Object.defineProperty(exports2, "InvalidArgumentError", { enumerable: true, get: function() {
      return errors_1.InvalidArgumentError;
    } });
    Object.defineProperty(exports2, "InvalidOperationError", { enumerable: true, get: function() {
      return errors_1.InvalidOperationError;
    } });
    Object.defineProperty(exports2, "InvalidSubjectError", { enumerable: true, get: function() {
      return errors_1.InvalidSubjectError;
    } });
    Object.defineProperty(exports2, "NoRespondersError", { enumerable: true, get: function() {
      return errors_1.NoRespondersError;
    } });
    Object.defineProperty(exports2, "PermissionViolationError", { enumerable: true, get: function() {
      return errors_1.PermissionViolationError;
    } });
    Object.defineProperty(exports2, "ProtocolError", { enumerable: true, get: function() {
      return errors_1.ProtocolError;
    } });
    Object.defineProperty(exports2, "RequestError", { enumerable: true, get: function() {
      return errors_1.RequestError;
    } });
    Object.defineProperty(exports2, "TimeoutError", { enumerable: true, get: function() {
      return errors_1.TimeoutError;
    } });
    Object.defineProperty(exports2, "UserAuthenticationExpiredError", { enumerable: true, get: function() {
      return errors_1.UserAuthenticationExpiredError;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jserrors.js
var require_jserrors = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jserrors.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.jserrors = exports2.StreamNotFoundError = exports2.ConsumerNotFoundError = exports2.JetStreamApiError = exports2.InvalidNameError = exports2.JetStreamApiCodes = exports2.JetStreamStatus = exports2.JetStreamStatusError = exports2.JetStreamError = exports2.JetStreamNotEnabled = void 0;
    exports2.isMessageNotFound = isMessageNotFound;
    var types_1 = require_types();
    var JetStreamNotEnabled = class extends Error {
      constructor(message, opts) {
        super(message, opts);
        this.name = "JetStreamNotEnabled";
      }
    };
    exports2.JetStreamNotEnabled = JetStreamNotEnabled;
    var JetStreamError = class extends Error {
      constructor(message, opts) {
        super(message, opts);
        this.name = "JetStreamError";
      }
    };
    exports2.JetStreamError = JetStreamError;
    var JetStreamStatusError = class extends JetStreamError {
      code;
      constructor(message, code, opts) {
        super(message, opts);
        this.code = code;
        this.name = "JetStreamStatusError";
      }
    };
    exports2.JetStreamStatusError = JetStreamStatusError;
    var JetStreamStatus = class _JetStreamStatus {
      msg;
      _description;
      constructor(msg) {
        this.msg = msg;
        this._description = "";
      }
      static maybeParseStatus(msg) {
        const status = new _JetStreamStatus(msg);
        return status.code === 0 ? null : status;
      }
      toError() {
        return new JetStreamStatusError(this.description, this.code);
      }
      debug() {
        console.log({
          subject: this.msg.subject,
          reply: this.msg.reply,
          description: this.description,
          status: this.code,
          headers: this.msg.headers
        });
      }
      get code() {
        return this.msg.headers?.code || 0;
      }
      get description() {
        if (this._description === "") {
          this._description = this.msg.headers?.description?.toLowerCase() || "";
          if (this._description === "") {
            this._description = this.code === 503 ? "no responders" : "unknown";
          }
        }
        return this._description;
      }
      isIdleHeartbeat() {
        return this.code === 100 && this.description === "idle heartbeat";
      }
      isFlowControlRequest() {
        return this.code === 100 && this.description === "flowcontrol request";
      }
      parseHeartbeat() {
        if (this.isIdleHeartbeat()) {
          return {
            type: "heartbeat",
            lastConsumerSequence: parseInt(this.msg.headers?.get("Nats-Last-Consumer") || "0"),
            lastStreamSequence: parseInt(this.msg.headers?.get("Nats-Last-Stream") || "0")
          };
        }
        return null;
      }
      isRequestTimeout() {
        return this.code === 408 && this.description === "request timeout";
      }
      parseDiscard() {
        const discard = {
          msgsLeft: 0,
          bytesLeft: 0
        };
        const msgsLeft = this.msg.headers?.get(types_1.JsHeaders.PendingMessagesHdr);
        if (msgsLeft) {
          discard.msgsLeft = parseInt(msgsLeft);
        }
        const bytesLeft = this.msg.headers?.get(types_1.JsHeaders.PendingBytesHdr);
        if (bytesLeft) {
          discard.bytesLeft = parseInt(bytesLeft);
        }
        return discard;
      }
      isBadRequest() {
        return this.code === 400;
      }
      isConsumerDeleted() {
        return this.code === 409 && this.description === "consumer deleted";
      }
      isStreamDeleted() {
        return this.code === 409 && this.description === "stream deleted";
      }
      isIdleHeartbeatMissed() {
        return this.code === 409 && this.description === "idle heartbeats missed";
      }
      isMaxWaitingExceeded() {
        return this.code === 409 && this.description === "exceeded maxwaiting";
      }
      isConsumerIsPushBased() {
        return this.code === 409 && this.description === "consumer is push based";
      }
      isExceededMaxWaiting() {
        return this.code === 409 && this.description.includes("exceeded maxwaiting");
      }
      isExceededMaxRequestBatch() {
        return this.code === 409 && this.description.includes("exceeded maxrequestbatch");
      }
      isExceededMaxExpires() {
        return this.code === 409 && this.description.includes("exceeded maxrequestexpires");
      }
      isExceededLimit() {
        return this.isExceededMaxExpires() || this.isExceededMaxWaiting() || this.isExceededMaxRequestBatch() || this.isMessageSizeExceedsMaxBytes();
      }
      isMessageNotFound() {
        return this.code === 404 && this.description === "message not found";
      }
      isNoResults() {
        return this.code === 404 && this.description === "no results";
      }
      isMessageSizeExceedsMaxBytes() {
        return this.code === 409 && this.description === "message size exceeds maxbytes";
      }
      isEndOfBatch() {
        return this.code === 204 && this.description === "eob";
      }
    };
    exports2.JetStreamStatus = JetStreamStatus;
    exports2.JetStreamApiCodes = {
      ConsumerNotFound: 10014,
      StreamNotFound: 10059,
      JetStreamNotEnabledForAccount: 10039,
      StreamWrongLastSequence: 10071,
      StreamWrongLastSequenceUnknown: 10164,
      NoMessageFound: 10037
    };
    function isMessageNotFound(err) {
      return err instanceof JetStreamApiError4 && err.code === exports2.JetStreamApiCodes.NoMessageFound;
    }
    var InvalidNameError = class extends Error {
      constructor(message = "", opts) {
        super(message, opts);
        this.name = "InvalidNameError";
      }
    };
    exports2.InvalidNameError = InvalidNameError;
    var JetStreamApiError4 = class extends Error {
      #apiError;
      constructor(jsErr, opts) {
        super(jsErr.description, opts);
        this.#apiError = jsErr;
        this.name = "JetStreamApiError";
      }
      get code() {
        return this.#apiError.err_code;
      }
      get status() {
        return this.#apiError.code;
      }
      apiError() {
        return Object.assign({}, this.#apiError);
      }
    };
    exports2.JetStreamApiError = JetStreamApiError4;
    var ConsumerNotFoundError = class extends JetStreamApiError4 {
      constructor(jsErr, opts) {
        super(jsErr, opts);
        this.name = "ConsumerNotFoundError";
      }
    };
    exports2.ConsumerNotFoundError = ConsumerNotFoundError;
    var StreamNotFoundError = class _StreamNotFoundError extends JetStreamApiError4 {
      constructor(jsErr, opts) {
        super(jsErr, opts);
        this.name = "StreamNotFoundError";
      }
      static fromMessage(message) {
        return new _StreamNotFoundError({
          err_code: exports2.JetStreamApiCodes.StreamNotFound,
          description: message,
          code: 404
        });
      }
    };
    exports2.StreamNotFoundError = StreamNotFoundError;
    exports2.jserrors = {
      InvalidNameError,
      ConsumerNotFoundError,
      StreamNotFoundError,
      JetStreamError,
      JetStreamApiError: JetStreamApiError4,
      JetStreamNotEnabled
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsbaseclient_api.js
var require_jsbaseclient_api = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsbaseclient_api.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BaseApiClientImpl = void 0;
    exports2.parseJsResponse = parseJsResponse;
    exports2.defaultJsOptions = defaultJsOptions;
    var internal_1 = require_internal_mod();
    var types_1 = require_types();
    var jserrors_1 = require_jserrors();
    var defaultPrefix = "$JS.API";
    var defaultTimeout = 5e3;
    function parseJsResponse(m) {
      const v = JSON.parse(new TextDecoder().decode(m.data));
      const r = v;
      if (r.error) {
        switch (r.error.err_code) {
          case jserrors_1.JetStreamApiCodes.ConsumerNotFound:
            throw new jserrors_1.ConsumerNotFoundError(r.error);
          case jserrors_1.JetStreamApiCodes.StreamNotFound:
            throw new jserrors_1.StreamNotFoundError(r.error);
          case jserrors_1.JetStreamApiCodes.JetStreamNotEnabledForAccount: {
            const jserr = new jserrors_1.JetStreamApiError(r.error);
            throw new jserrors_1.JetStreamNotEnabled(jserr.message, { cause: jserr });
          }
          default:
            throw new jserrors_1.JetStreamApiError(r.error);
        }
      }
      return v;
    }
    function defaultJsOptions(opts) {
      opts = opts || {};
      if (opts.domain) {
        opts.apiPrefix = `$JS.${opts.domain}.API`;
        delete opts.domain;
      }
      return (0, internal_1.extend)({ apiPrefix: defaultPrefix, timeout: defaultTimeout }, opts);
    }
    var BaseApiClientImpl = class {
      nc;
      opts;
      prefix;
      timeout;
      constructor(nc, opts) {
        this.nc = nc;
        opts = opts || {};
        opts.watcherPrefix = opts.watcherPrefix || this.nc.options.inboxPrefix;
        this.opts = defaultJsOptions(opts);
        this._parseOpts();
        this.prefix = this.opts.apiPrefix;
        this.timeout = this.opts.timeout;
      }
      getOptions() {
        return Object.assign({}, this.opts);
      }
      sendRequiredApiLevel() {
        return this.opts.sendRequiredApiLevel === true;
      }
      _parseOpts() {
        let prefix = this.opts.apiPrefix;
        if (!prefix || prefix.length === 0) {
          throw internal_1.errors.InvalidArgumentError.format("prefix", "cannot be empty");
        }
        const c = prefix[prefix.length - 1];
        if (c === ".") {
          prefix = prefix.substr(0, prefix.length - 1);
        }
        this.opts.apiPrefix = prefix;
        (0, internal_1.createInbox)(this.opts.watcherPrefix);
      }
      async _request(subj, data = null, opts) {
        const { retries: r, minApiVersion, ...rest } = opts ?? {};
        const reqOpts = { ...rest, timeout: this.timeout };
        let a = internal_1.Empty;
        if (data) {
          a = new TextEncoder().encode(JSON.stringify(data));
        }
        if (typeof minApiVersion === "number") {
          const h = reqOpts.headers ?? (0, internal_1.headers)();
          h.set(types_1.JsHeaders.RequiredApiLevel, minApiVersion.toString());
          reqOpts.headers = h;
        }
        let retries = r || 1;
        retries = retries === -1 ? Number.MAX_SAFE_INTEGER : retries;
        const bo = (0, internal_1.backoff)();
        for (let i = 0; i < retries; i++) {
          try {
            const m = await this.nc.request(subj, a, reqOpts);
            return this.parseJsResponse(m);
          } catch (err) {
            const re = err instanceof internal_1.RequestError ? err : null;
            if ((err instanceof internal_1.errors.TimeoutError || re?.isNoResponders()) && i + 1 < retries) {
              await (0, internal_1.delay)(bo.backoff(i));
            } else {
              throw re?.isNoResponders() ? new jserrors_1.JetStreamNotEnabled("jetstream is not enabled", {
                cause: err
              }) : err;
            }
          }
        }
      }
      async findStream(subject) {
        const q = { subject };
        const r = await this._request(`${this.prefix}.STREAM.NAMES`, q);
        const names = r;
        if (!names.streams || names.streams.length !== 1) {
          throw jserrors_1.StreamNotFoundError.fromMessage("no stream matches subject");
        }
        return names.streams[0];
      }
      getConnection() {
        return this.nc;
      }
      parseJsResponse(m) {
        return parseJsResponse(m);
      }
    };
    exports2.BaseApiClientImpl = BaseApiClientImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jslister.js
var require_jslister = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jslister.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ListerImpl = void 0;
    var internal_1 = require_internal_mod();
    var ListerImpl = class {
      err;
      offset;
      pageInfo;
      subject;
      jsm;
      filter;
      payload;
      constructor(subject, filter, jsm, payload) {
        if (!subject) {
          throw internal_1.errors.InvalidArgumentError.format("subject", "is required");
        }
        this.subject = subject;
        this.jsm = jsm;
        this.offset = 0;
        this.pageInfo = {};
        this.filter = filter;
        this.payload = payload || {};
      }
      async next() {
        if (this.err) {
          return [];
        }
        if (this.pageInfo && this.offset >= this.pageInfo.total) {
          return [];
        }
        const offset = { offset: this.offset };
        if (this.payload) {
          Object.assign(offset, this.payload);
        }
        try {
          const r = await this.jsm._request(this.subject, offset, { timeout: this.jsm.timeout });
          this.pageInfo = r;
          const count = this.countResponse(r);
          if (count === 0) {
            return [];
          }
          this.offset += count;
          return this.filter(r);
        } catch (err) {
          this.err = err;
          throw err;
        }
      }
      countResponse(r) {
        switch (r?.type) {
          case "io.nats.jetstream.api.v1.stream_names_response":
          case "io.nats.jetstream.api.v1.stream_list_response":
            return r.streams?.length || 0;
          case "io.nats.jetstream.api.v1.consumer_list_response":
            return r.consumers?.length || 0;
          default:
            console.error(`jslister.ts: unknown API response for paged output: ${r?.type}`);
            return r.streams?.length || 0;
        }
      }
      async *[Symbol.asyncIterator]() {
        let page = await this.next();
        while (page.length > 0) {
          for (const item of page) {
            yield item;
          }
          page = await this.next();
        }
      }
    };
    exports2.ListerImpl = ListerImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsutil.js
var require_jsutil = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsutil.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateDurableName = validateDurableName;
    exports2.validateStreamName = validateStreamName;
    exports2.minValidation = minValidation;
    exports2.validateName = validateName;
    exports2.validName = validName;
    var jserrors_1 = require_jserrors();
    function validateDurableName(name) {
      return minValidation("durable", name);
    }
    function validateStreamName(name) {
      return minValidation("stream", name);
    }
    function minValidation(context, name = "") {
      if (name === "") {
        throw Error(`${context} name required`);
      }
      const bad = [".", "*", ">", "/", "\\", " ", "	", "\n", "\r"];
      bad.forEach((v) => {
        if (name.indexOf(v) !== -1) {
          switch (v) {
            case "\n":
              v = "\\n";
              break;
            case "\r":
              v = "\\r";
              break;
            case "	":
              v = "\\t";
              break;
            default:
          }
          throw new jserrors_1.InvalidNameError(`${context} name ('${name}') cannot contain '${v}'`);
        }
      });
      return "";
    }
    function validateName(context, name = "") {
      if (name === "") {
        throw Error(`${context} name required`);
      }
      const m = validName(name);
      if (m.length) {
        throw new Error(`invalid ${context} name - ${context} name ${m}`);
      }
    }
    function validName(name = "") {
      if (name === "") {
        throw Error(`name required`);
      }
      const RE = /^[-\w]+$/g;
      const m = name.match(RE);
      if (m === null) {
        for (const c of name.split("")) {
          const mm = c.match(RE);
          if (mm === null) {
            return `cannot contain '${c}'`;
          }
        }
      }
      return "";
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/mod.js
var require_mod3 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+nats-core@3.4.0/node_modules/@nats-io/nats-core/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.wsconnect = exports2.usernamePasswordAuthenticator = exports2.UserAuthenticationExpiredError = exports2.tokenAuthenticator = exports2.TimeoutError = exports2.syncIterator = exports2.RequestError = exports2.ProtocolError = exports2.PermissionViolationError = exports2.nuid = exports2.Nuid = exports2.NoRespondersError = exports2.nkeys = exports2.nkeyAuthenticator = exports2.nanos = exports2.MsgHdrsImpl = exports2.millis = exports2.Metric = exports2.Match = exports2.jwtAuthenticator = exports2.InvalidSubjectError = exports2.InvalidOperationError = exports2.InvalidArgumentError = exports2.headers = exports2.hasWsProtocol = exports2.errors = exports2.Empty = exports2.DrainingConnectionError = exports2.delay = exports2.deferred = exports2.deadline = exports2.credsAuthenticator = exports2.createInbox = exports2.ConnectionError = exports2.ClosedConnectionError = exports2.canonicalMIMEHeaderKey = exports2.buildAuthenticator = exports2.Bench = exports2.backoff = exports2.AuthorizationError = void 0;
    var internal_mod_1 = require_internal_mod();
    Object.defineProperty(exports2, "AuthorizationError", { enumerable: true, get: function() {
      return internal_mod_1.AuthorizationError;
    } });
    Object.defineProperty(exports2, "backoff", { enumerable: true, get: function() {
      return internal_mod_1.backoff;
    } });
    Object.defineProperty(exports2, "Bench", { enumerable: true, get: function() {
      return internal_mod_1.Bench;
    } });
    Object.defineProperty(exports2, "buildAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.buildAuthenticator;
    } });
    Object.defineProperty(exports2, "canonicalMIMEHeaderKey", { enumerable: true, get: function() {
      return internal_mod_1.canonicalMIMEHeaderKey;
    } });
    Object.defineProperty(exports2, "ClosedConnectionError", { enumerable: true, get: function() {
      return internal_mod_1.ClosedConnectionError;
    } });
    Object.defineProperty(exports2, "ConnectionError", { enumerable: true, get: function() {
      return internal_mod_1.ConnectionError;
    } });
    Object.defineProperty(exports2, "createInbox", { enumerable: true, get: function() {
      return internal_mod_1.createInbox;
    } });
    Object.defineProperty(exports2, "credsAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.credsAuthenticator;
    } });
    Object.defineProperty(exports2, "deadline", { enumerable: true, get: function() {
      return internal_mod_1.deadline;
    } });
    Object.defineProperty(exports2, "deferred", { enumerable: true, get: function() {
      return internal_mod_1.deferred;
    } });
    Object.defineProperty(exports2, "delay", { enumerable: true, get: function() {
      return internal_mod_1.delay;
    } });
    Object.defineProperty(exports2, "DrainingConnectionError", { enumerable: true, get: function() {
      return internal_mod_1.DrainingConnectionError;
    } });
    Object.defineProperty(exports2, "Empty", { enumerable: true, get: function() {
      return internal_mod_1.Empty;
    } });
    Object.defineProperty(exports2, "errors", { enumerable: true, get: function() {
      return internal_mod_1.errors;
    } });
    Object.defineProperty(exports2, "hasWsProtocol", { enumerable: true, get: function() {
      return internal_mod_1.hasWsProtocol;
    } });
    Object.defineProperty(exports2, "headers", { enumerable: true, get: function() {
      return internal_mod_1.headers;
    } });
    Object.defineProperty(exports2, "InvalidArgumentError", { enumerable: true, get: function() {
      return internal_mod_1.InvalidArgumentError;
    } });
    Object.defineProperty(exports2, "InvalidOperationError", { enumerable: true, get: function() {
      return internal_mod_1.InvalidOperationError;
    } });
    Object.defineProperty(exports2, "InvalidSubjectError", { enumerable: true, get: function() {
      return internal_mod_1.InvalidSubjectError;
    } });
    Object.defineProperty(exports2, "jwtAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.jwtAuthenticator;
    } });
    Object.defineProperty(exports2, "Match", { enumerable: true, get: function() {
      return internal_mod_1.Match;
    } });
    Object.defineProperty(exports2, "Metric", { enumerable: true, get: function() {
      return internal_mod_1.Metric;
    } });
    Object.defineProperty(exports2, "millis", { enumerable: true, get: function() {
      return internal_mod_1.millis;
    } });
    Object.defineProperty(exports2, "MsgHdrsImpl", { enumerable: true, get: function() {
      return internal_mod_1.MsgHdrsImpl;
    } });
    Object.defineProperty(exports2, "nanos", { enumerable: true, get: function() {
      return internal_mod_1.nanos;
    } });
    Object.defineProperty(exports2, "nkeyAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.nkeyAuthenticator;
    } });
    Object.defineProperty(exports2, "nkeys", { enumerable: true, get: function() {
      return internal_mod_1.nkeys;
    } });
    Object.defineProperty(exports2, "NoRespondersError", { enumerable: true, get: function() {
      return internal_mod_1.NoRespondersError;
    } });
    Object.defineProperty(exports2, "Nuid", { enumerable: true, get: function() {
      return internal_mod_1.Nuid;
    } });
    Object.defineProperty(exports2, "nuid", { enumerable: true, get: function() {
      return internal_mod_1.nuid;
    } });
    Object.defineProperty(exports2, "PermissionViolationError", { enumerable: true, get: function() {
      return internal_mod_1.PermissionViolationError;
    } });
    Object.defineProperty(exports2, "ProtocolError", { enumerable: true, get: function() {
      return internal_mod_1.ProtocolError;
    } });
    Object.defineProperty(exports2, "RequestError", { enumerable: true, get: function() {
      return internal_mod_1.RequestError;
    } });
    Object.defineProperty(exports2, "syncIterator", { enumerable: true, get: function() {
      return internal_mod_1.syncIterator;
    } });
    Object.defineProperty(exports2, "TimeoutError", { enumerable: true, get: function() {
      return internal_mod_1.TimeoutError;
    } });
    Object.defineProperty(exports2, "tokenAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.tokenAuthenticator;
    } });
    Object.defineProperty(exports2, "UserAuthenticationExpiredError", { enumerable: true, get: function() {
      return internal_mod_1.UserAuthenticationExpiredError;
    } });
    Object.defineProperty(exports2, "usernamePasswordAuthenticator", { enumerable: true, get: function() {
      return internal_mod_1.usernamePasswordAuthenticator;
    } });
    Object.defineProperty(exports2, "wsconnect", { enumerable: true, get: function() {
      return internal_mod_1.wsconnect;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsapi_types.js
var require_jsapi_types = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsapi_types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PubHeaders = exports2.PriorityPolicy = exports2.ConsumerApiAction = exports2.PersistMode = exports2.StoreCompression = exports2.ReplayPolicy = exports2.AckPolicy = exports2.DeliverPolicy = exports2.StorageType = exports2.DiscardPolicy = exports2.RetentionPolicy = void 0;
    exports2.defaultConsumer = defaultConsumer;
    var nats_core_1 = require_mod3();
    exports2.RetentionPolicy = {
      /**
       * Retain messages until the limits are reached, then trigger the discard policy.
       */
      Limits: "limits",
      /**
       * Retain messages while there is consumer interest on the particular subject.
       */
      Interest: "interest",
      /**
       * Retain messages until acknowledged
       */
      Workqueue: "workqueue"
    };
    exports2.DiscardPolicy = {
      /**
       * Discard old messages to make room for the new ones
       */
      Old: "old",
      /**
       * Discard the new messages
       */
      New: "new"
    };
    exports2.StorageType = {
      /**
       * Store persistently on files
       */
      File: "file",
      /**
       * Store in server memory - doesn't survive server restarts
       */
      Memory: "memory"
    };
    exports2.DeliverPolicy = {
      /**
       * Deliver all messages
       */
      All: "all",
      /**
       * Deliver starting with the last message
       */
      Last: "last",
      /**
       * Deliver starting with new messages
       */
      New: "new",
      /**
       * Deliver starting with the specified sequence
       */
      StartSequence: "by_start_sequence",
      /**
       * Deliver starting with the specified time
       */
      StartTime: "by_start_time",
      /**
       * Deliver starting with the last messages for every subject
       */
      LastPerSubject: "last_per_subject"
    };
    exports2.AckPolicy = {
      /**
       * Messages don't need to be Ack'ed.
       */
      None: "none",
      /**
       * Ack, acknowledges all messages with a lower sequence
       */
      All: "all",
      /**
       * All sequences must be explicitly acknowledged
       */
      Explicit: "explicit",
      /**
       * Functions like AckAll, but acks based on flow control responses. Used
       * for durable mirror/source consumers (ADR-60). Available on server 2.14+.
       */
      FlowControl: "flow_control",
      /**
       * @ignore
       */
      NotSet: ""
    };
    exports2.ReplayPolicy = {
      /**
       * Replays messages as fast as possible
       */
      Instant: "instant",
      /**
       * Replays messages following the original delay between messages
       */
      Original: "original"
    };
    exports2.StoreCompression = {
      /**
       * No compression
       */
      None: "none",
      /**
       * S2 compression
       */
      S2: "s2"
    };
    exports2.PersistMode = {
      /**
       * All writes are committed and stream data is synced to disk before the publish
       * acknowledgement is sent.
       * This is the default mode, and provides the strongest data durability guarantee.
       */
      Default: "default",
      /**
       * Writes to the stream are committed, but writes to the disk are asynchronously synced.
       * The publish acknowledgement is sent before the sync to the disk is complete.
       * This could result in data-loss if the server crashes before the sync is completed, however
       * with an R3+ stream, the replication provides in-flight redundancy to reduce the likelihood of
       * this occurring with distinct fault domains.
       * This can significantly increase the publish throughput.
       */
      Async: "async"
    };
    exports2.ConsumerApiAction = {
      CreateOrUpdate: "",
      Update: "update",
      Create: "create"
    };
    exports2.PriorityPolicy = {
      None: "none",
      Overflow: "overflow",
      PinnedClient: "pinned_client",
      Prioritized: "prioritized"
    };
    function defaultConsumer(name, opts = {}) {
      return Object.assign({
        name,
        deliver_policy: exports2.DeliverPolicy.All,
        ack_policy: exports2.AckPolicy.Explicit,
        ack_wait: (0, nats_core_1.nanos)(30 * 1e3),
        replay_policy: exports2.ReplayPolicy.Instant
      }, opts);
    }
    exports2.PubHeaders = {
      MsgIdHdr: "Nats-Msg-Id",
      ExpectedStreamHdr: "Nats-Expected-Stream",
      ExpectedLastSeqHdr: "Nats-Expected-Last-Sequence",
      ExpectedLastMsgIdHdr: "Nats-Expected-Last-Msg-Id",
      ExpectedLastSubjectSequenceHdr: "Nats-Expected-Last-Subject-Sequence",
      ExpectedLastSubjectSequenceSubjectHdr: "Nats-Expected-Last-Subject-Sequence-Subject",
      /**
       * Sets the TTL for a message (Nanos value). Only have effect on streams that
       * enable `StreamConfig.allow_msg_ttl`.
       */
      MessageTTL: "Nats-TTL",
      Schedule: "Nats-Schedule",
      ScheduleTarget: "Nats-Schedule-Target",
      ScheduleSource: "Nats-Schedule-Source",
      ScheduleTTL: "Nats-Schedule-TTL",
      ScheduleTimeZone: "Nats-Schedule-Time-Zone",
      ScheduleRollup: "Nats-Schedule-Rollup",
      /**
       * Set on messages produced by the scheduler. Holds the subject of the
       * schedule that produced the message. Also used by clients to atomically
       * cancel a schedule (set together with `ScheduleNext: "purge"`).
       */
      Scheduler: "Nats-Scheduler",
      /**
       * Set on messages produced by the scheduler. Holds the timestamp of the
       * next invocation for cron schedules, or `purge` for delayed messages.
       * Also used by clients with value `purge` to atomically cancel a schedule.
       */
      ScheduleNext: "Nats-Schedule-Next"
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmconsumer_api.js
var require_jsmconsumer_api = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmconsumer_api.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ConsumerAPIImpl = void 0;
    var jsbaseclient_api_1 = require_jsbaseclient_api();
    var jslister_1 = require_jslister();
    var jsutil_1 = require_jsutil();
    var internal_1 = require_internal_mod();
    var jsapi_types_1 = require_jsapi_types();
    var ConsumerAPIImpl = class extends jsbaseclient_api_1.BaseApiClientImpl {
      constructor(nc, opts) {
        super(nc, opts);
      }
      async addUpdate(stream, cfg, opts, delta) {
        (0, jsutil_1.validateStreamName)(stream);
        opts = opts || {};
        if (cfg.deliver_group && cfg.flow_control) {
          throw internal_1.InvalidArgumentError.format(["flow_control", "deliver_group"], "are mutually exclusive");
        }
        if (cfg.deliver_group && cfg.idle_heartbeat) {
          throw internal_1.InvalidArgumentError.format(["idle_heartbeat", "deliver_group"], "are mutually exclusive");
        }
        if (isPriorityGroup(cfg)) {
          const { min: min2, ok } = this.nc.features.get(internal_1.Feature.JS_PRIORITY_GROUPS);
          if (!ok) {
            throw new Error(`priority_groups require server ${min2}`);
          }
          if (cfg.deliver_subject) {
            throw internal_1.InvalidArgumentError.format("deliver_subject", "cannot be set when using priority groups");
          }
          validatePriorityGroups(cfg);
        }
        const cr = {};
        cr.config = cfg;
        cr.stream_name = stream;
        cr.action = opts.action || jsapi_types_1.ConsumerApiAction.Create;
        cr.pedantic = opts.pedantic || false;
        if (cr.config.durable_name) {
          (0, jsutil_1.validateDurableName)(cr.config.durable_name);
        }
        const nci = this.nc;
        let { min, ok: newAPI } = nci.features.get(internal_1.Feature.JS_NEW_CONSUMER_CREATE_API);
        const name = cfg.name === "" ? void 0 : cfg.name;
        if (name && !newAPI) {
          throw internal_1.InvalidArgumentError.format("name", `requires server ${min}`);
        }
        if (name) {
          try {
            (0, jsutil_1.minValidation)("name", name);
          } catch (err) {
            const m = err.message;
            const idx = m.indexOf("cannot contain");
            if (idx !== -1) {
              throw new Error(`consumer 'name' ${m.substring(idx)}`);
            }
            throw err;
          }
        }
        let subj;
        let consumerName = "";
        if (Array.isArray(cfg.filter_subjects)) {
          const { min: min2, ok } = nci.features.get(internal_1.Feature.JS_MULTIPLE_CONSUMER_FILTER);
          if (!ok) {
            throw internal_1.InvalidArgumentError.format("filter_subjects", `requires server ${min2}`);
          }
          newAPI = false;
        }
        if (cfg.metadata) {
          const { min: min2, ok } = nci.features.get(internal_1.Feature.JS_STREAM_CONSUMER_METADATA);
          if (!ok) {
            throw internal_1.InvalidArgumentError.format("metadata", `requires server ${min2}`);
          }
        }
        if (newAPI) {
          consumerName = cfg.name ?? cfg.durable_name ?? "";
        }
        if (consumerName !== "") {
          let fs = cfg.filter_subject ?? void 0;
          if (fs === ">") {
            fs = void 0;
          }
          subj = fs !== void 0 ? `${this.prefix}.CONSUMER.CREATE.${stream}.${consumerName}.${fs}` : `${this.prefix}.CONSUMER.CREATE.${stream}.${consumerName}`;
        } else {
          subj = cfg.durable_name ? `${this.prefix}.CONSUMER.DURABLE.CREATE.${stream}.${cfg.durable_name}` : `${this.prefix}.CONSUMER.CREATE.${stream}`;
        }
        const assertCfg = delta ?? cr.config;
        const r = await this._request(subj, cr, { ...opts, ...this.requiredApiOpts(assertCfg) });
        return r;
      }
      // mirrors server/jetstream_versioning.go:setStaticConsumerMetadata
      minConsumerApi(c) {
        if (c.ack_policy === jsapi_types_1.AckPolicy.FlowControl)
          return 4;
        if (typeof c.pause_until === "string" && c.pause_until !== "")
          return 1;
        if (c.priority_policy !== void 0 && c.priority_policy !== jsapi_types_1.PriorityPolicy.None)
          return 1;
        if (typeof c.priority_timeout === "number" && c.priority_timeout > 0) {
          return 1;
        }
        if (Array.isArray(c.priority_groups) && c.priority_groups.length > 0) {
          return 1;
        }
        return 0;
      }
      requiredApiOpts(c) {
        if (!this.sendRequiredApiLevel())
          return {};
        const minApiVersion = this.minConsumerApi(c);
        return minApiVersion > 0 ? { minApiVersion } : {};
      }
      add(stream, cfg, opts) {
        opts = opts || {};
        let action = jsapi_types_1.ConsumerApiAction.Create;
        if (typeof opts === "string") {
          action = opts;
          opts = {};
        }
        const cco = Object.assign({}, { action }, opts);
        return this.addUpdate(stream, cfg, cco);
      }
      async update(stream, durable, cfg) {
        const ci = await this.info(stream, durable);
        const changable = cfg;
        return this.addUpdate(stream, Object.assign(ci.config, changable), { action: jsapi_types_1.ConsumerApiAction.Update }, changable);
      }
      async info(stream, name) {
        (0, jsutil_1.validateStreamName)(stream);
        (0, jsutil_1.validateDurableName)(name);
        const r = await this._request(`${this.prefix}.CONSUMER.INFO.${stream}.${name}`);
        return r;
      }
      async delete(stream, name) {
        (0, jsutil_1.validateStreamName)(stream);
        (0, jsutil_1.validateDurableName)(name);
        const r = await this._request(`${this.prefix}.CONSUMER.DELETE.${stream}.${name}`);
        const cr = r;
        return cr.success;
      }
      list(stream) {
        (0, jsutil_1.validateStreamName)(stream);
        const filter = (v) => {
          const clr = v;
          return clr.consumers;
        };
        const subj = `${this.prefix}.CONSUMER.LIST.${stream}`;
        return new jslister_1.ListerImpl(subj, filter, this);
      }
      // Fixme: the API returns the number of nanoseconds, but really should return
      //  millis,
      pause(stream, name, until) {
        const subj = `${this.prefix}.CONSUMER.PAUSE.${stream}.${name}`;
        const opts = {
          pause_until: until.toISOString()
        };
        return this._request(subj, opts);
      }
      // Fixme: the API returns the number of nanoseconds, but really should return
      //  millis,
      resume(stream, name) {
        return this.pause(stream, name, /* @__PURE__ */ new Date(0));
      }
      unpin(stream, name, group) {
        const subj = `${this.prefix}.CONSUMER.UNPIN.${stream}.${name}`;
        return this._request(subj, { group });
      }
      async reset(stream, name, seq) {
        (0, jsutil_1.validateStreamName)(stream);
        (0, jsutil_1.validateDurableName)(name);
        const nci = this.nc;
        const { min, ok } = nci.features.get(internal_1.Feature.JS_CONSUMER_RESET);
        if (!ok) {
          throw new Error(`consumer reset requires server ${min}`);
        }
        if (typeof seq === "number" && (!Number.isInteger(seq) || seq < 0)) {
          throw internal_1.InvalidArgumentError.format("seq", "must be a non-negative integer");
        }
        const subj = `${this.prefix}.CONSUMER.RESET.${stream}.${name}`;
        const body = typeof seq === "number" ? { seq } : void 0;
        const r = await this._request(subj, body);
        return r;
      }
    };
    exports2.ConsumerAPIImpl = ConsumerAPIImpl;
    function isPriorityGroup(config) {
      const pg = config;
      return pg && pg.priority_groups !== void 0 || pg.priority_policy !== void 0;
    }
    function validatePriorityGroups(pg) {
      if (isPriorityGroup(pg)) {
        if (!Array.isArray(pg.priority_groups)) {
          throw internal_1.InvalidArgumentError.format(["priority_groups"], "must be an array");
        }
        if (pg.priority_groups.length === 0) {
          throw internal_1.InvalidArgumentError.format(["priority_groups"], "must have at least one group");
        }
        pg.priority_groups.forEach((g) => {
          (0, jsutil_1.minValidation)("priority_group", g);
          if (g.length > 16) {
            throw internal_1.errors.InvalidArgumentError.format("group", "must be 16 characters or less");
          }
        });
        if (pg.priority_policy !== jsapi_types_1.PriorityPolicy.None && pg.priority_policy !== jsapi_types_1.PriorityPolicy.Overflow && pg.priority_policy !== jsapi_types_1.PriorityPolicy.PinnedClient && pg.priority_policy !== jsapi_types_1.PriorityPolicy.Prioritized) {
          throw internal_1.InvalidArgumentError.format(["priority_policy"], "must be 'none', 'prioritized', 'overflow', or 'pinned_client'");
        }
      }
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmsg.js
var require_jsmsg = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmsg.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.JsMsgImpl = exports2.ACK = void 0;
    exports2.toJsMsg = toJsMsg;
    exports2.parseInfo = parseInfo;
    var internal_1 = require_internal_mod();
    exports2.ACK = Uint8Array.of(43, 65, 67, 75);
    var NAK = Uint8Array.of(45, 78, 65, 75);
    var WPI = Uint8Array.of(43, 87, 80, 73);
    var NXT = Uint8Array.of(43, 78, 88, 84);
    var TERM = Uint8Array.of(43, 84, 69, 82, 77);
    var SPACE = Uint8Array.of(32);
    function toJsMsg(m, ackTimeout = 5e3) {
      return new JsMsgImpl(m, ackTimeout);
    }
    function parseInfo(s) {
      const tokens = s.split(".");
      if (tokens.length === 9) {
        tokens.splice(2, 0, "_", "");
      }
      if (tokens.length < 11 || tokens[0] !== "$JS" || tokens[1] !== "ACK") {
        throw new Error(`unable to parse delivery info - not a jetstream message`);
      }
      const di = {};
      di.domain = tokens[2] === "_" ? "" : tokens[2];
      di.account_hash = tokens[3];
      di.stream = tokens[4];
      di.consumer = tokens[5];
      di.deliveryCount = parseInt(tokens[6], 10);
      di.redelivered = di.deliveryCount > 1;
      di.streamSequence = parseInt(tokens[7], 10);
      di.deliverySequence = parseInt(tokens[8], 10);
      di.timestampNanos = parseInt(tokens[9], 10);
      di.pending = parseInt(tokens[10], 10);
      return di;
    }
    function parseTimestampNanos(s) {
      const tokens = s.split(".");
      if (tokens.length === 9) {
        tokens.splice(2, 0, "_", "");
      }
      if (tokens.length < 11 || tokens[0] !== "$JS" || tokens[1] !== "ACK") {
        throw new Error(`unable to parse delivery info - not a jetstream message`);
      }
      return BigInt(tokens[9]);
    }
    var JsMsgImpl = class {
      msg;
      di;
      didAck;
      timeout;
      constructor(msg, timeout) {
        this.msg = msg;
        this.didAck = false;
        this.timeout = timeout;
      }
      get subject() {
        return this.msg.subject;
      }
      get sid() {
        return this.msg.sid;
      }
      get data() {
        return this.msg.data;
      }
      get headers() {
        return this.msg.headers;
      }
      get info() {
        if (!this.di) {
          this.di = parseInfo(this.reply);
        }
        return this.di;
      }
      get redelivered() {
        return this.info.deliveryCount > 1;
      }
      get reply() {
        return this.msg.reply || "";
      }
      get seq() {
        return this.info.streamSequence;
      }
      get time() {
        const ms = (0, internal_1.millis)(this.info.timestampNanos);
        return new Date(ms);
      }
      get timestamp() {
        return this.time.toISOString();
      }
      get timestampNanos() {
        return parseTimestampNanos(this.reply);
      }
      doAck(payload) {
        if (!this.didAck) {
          this.didAck = !this.isWIP(payload);
          this.msg.respond(payload);
        }
      }
      isWIP(p) {
        return p.length === 4 && p[0] === WPI[0] && p[1] === WPI[1] && p[2] === WPI[2] && p[3] === WPI[3];
      }
      // this has to dig into the internals as the message has access
      // to the protocol but not the high-level client.
      async ackAck(opts) {
        const d = (0, internal_1.deferred)();
        if (!this.didAck) {
          this.didAck = true;
          if (this.msg.reply) {
            opts = opts || {};
            opts.timeout = opts.timeout || this.timeout;
            const mi = this.msg;
            const proto = mi.publisher;
            const trace = !(proto.options?.noAsyncTraces || false);
            const r = new internal_1.RequestOne(proto.muxSubscriptions, this.msg.reply, {
              timeout: opts.timeout
            }, trace);
            proto.request(r);
            try {
              proto.publish(this.msg.reply, exports2.ACK, {
                reply: `${proto.muxSubscriptions.baseInbox}${r.token}`
              });
            } catch (err) {
              r.cancel(err);
            }
            try {
              await Promise.race([r.timer, r.deferred]);
              d.resolve(true);
            } catch (err) {
              r.cancel(err);
              d.reject(err);
            }
          } else {
            d.resolve(false);
          }
        } else {
          d.resolve(false);
        }
        return d;
      }
      ack() {
        this.doAck(exports2.ACK);
      }
      nak(millis) {
        let payload = NAK;
        if (millis) {
          payload = new TextEncoder().encode(`-NAK ${JSON.stringify({ delay: (0, internal_1.nanos)(millis) })}`);
        }
        this.doAck(payload);
      }
      working() {
        this.doAck(WPI);
      }
      next(subj, opts = { batch: 1 }) {
        const args = {};
        args.batch = opts.batch || 1;
        args.no_wait = opts.no_wait || false;
        if (opts.expires && opts.expires > 0) {
          args.expires = (0, internal_1.nanos)(opts.expires);
        }
        const data = new TextEncoder().encode(JSON.stringify(args));
        const payload = internal_1.DataBuffer.concat(NXT, SPACE, data);
        const reqOpts = subj ? { reply: subj } : void 0;
        this.msg.respond(payload, reqOpts);
      }
      term(reason = "") {
        let term = TERM;
        if (reason?.length > 0) {
          term = new TextEncoder().encode(`+TERM ${reason}`);
        }
        this.doAck(term);
      }
      json() {
        return this.msg.json();
      }
      string() {
        return this.msg.string();
      }
    };
    exports2.JsMsgImpl = JsMsgImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/consumer.js
var require_consumer = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/consumer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PullConsumerImpl = exports2.PullConsumerMessagesImpl = exports2.PullConsumerType = void 0;
    exports2.isOverflowOptions = isOverflowOptions;
    exports2.isPrioritizedOptions = isPrioritizedOptions;
    exports2.validateOverflowPullOptions = validateOverflowPullOptions;
    exports2.validatePrioritizedPullOptions = validatePrioritizedPullOptions;
    var internal_1 = require_internal_mod();
    var jsmsg_1 = require_jsmsg();
    var jsapi_types_1 = require_jsapi_types();
    var jserrors_1 = require_jserrors();
    var jsutil_1 = require_jsutil();
    exports2.PullConsumerType = {
      Unset: "",
      Consume: "consume",
      Fetch: "fetch"
    };
    function isOverflowOptions(opts) {
      const oo = opts;
      return oo && typeof oo.group === "string" || typeof oo.min_pending === "number" || typeof oo.min_ack_pending === "number";
    }
    function isPrioritizedOptions(opts) {
      const oo = opts;
      return oo && typeof oo.group === "string" && typeof oo.priority === "number";
    }
    var PullConsumerMessagesImpl = class extends internal_1.QueuedIteratorImpl {
      consumer;
      opts;
      sub;
      monitor;
      pending;
      isConsume;
      callback;
      listeners;
      statusIterator;
      abortOnMissingResource;
      bind;
      inboxPrefix;
      inbox;
      cancelables;
      inReset;
      closeListener;
      isPinned;
      isPriority;
      natsPinId;
      // callback: ConsumerCallbackFn;
      constructor(c, opts, refilling = false) {
        super();
        this.consumer = c;
        this.isConsume = refilling;
        this.cancelables = [];
        this.inboxPrefix = (0, internal_1.createInbox)(this.consumer.api.nc.options.inboxPrefix);
        this.inbox = `${this.inboxPrefix}.${this.consumer.serial}`;
        this.inReset = false;
        this.isPinned = false;
        this.isPriority = false;
        this.natsPinId = "";
        if (this.consumer.ordered) {
          if (isOverflowOptions(opts)) {
            throw internal_1.errors.InvalidArgumentError.format([
              "group",
              "min_pending",
              "min_ack_pending"
            ], "cannot be specified for ordered consumers");
          }
          if (this.consumer.orderedConsumerState === void 0) {
            const ocs = {};
            const iopts = c.opts;
            ocs.namePrefix = iopts.name_prefix ?? `oc_${internal_1.nuid.next()}`;
            ocs.opts = iopts;
            ocs.cursor = { stream_seq: 1, deliver_seq: 0 };
            const startSeq = c._info.config.opt_start_seq || 0;
            ocs.cursor.stream_seq = startSeq > 0 ? startSeq - 1 : 0;
            ocs.createFails = 0;
            this.consumer.orderedConsumerState = ocs;
          }
        }
        const copts = opts;
        this.opts = this.parseOptions(opts, this.isConsume);
        this.callback = copts.callback || null;
        this.noIterator = typeof this.callback === "function";
        this.monitor = null;
        this.pending = { msgs: 0, bytes: 0, requests: 0 };
        this.listeners = [];
        this.abortOnMissingResource = copts.abort_on_missing_resource === true;
        this.bind = copts.bind === true;
        if (copts.group) {
          const { min_pending, min_ack_pending } = copts;
          this.isPinned = min_pending === void 0 && min_ack_pending === void 0;
          const { priority } = copts;
          this.isPriority = typeof priority === "number";
        }
        this.closeListener = {
          // we don't propagate the error here
          connectionClosedCallback: () => {
            this._push(() => {
              this.stop();
            });
          }
        };
        this.consumer.api.nc.addCloseListener(this.closeListener);
        this.start();
      }
      start() {
        const { max_messages, max_bytes, idle_heartbeat, threshold_bytes, threshold_messages } = this.opts;
        this.sub = this.consumer.api.nc.subscribe(this.inbox, {
          callback: (err, msg) => {
            if (err) {
              this.stop(err);
              return;
            }
            this.monitor?.work();
            const isProtocol = this.consumer.ordered ? msg.subject.indexOf(this?.inboxPrefix) === 0 : msg.subject === this.inbox;
            if (isProtocol) {
              if (msg.subject !== this.sub.getSubject()) {
                return;
              }
              const status = new jserrors_1.JetStreamStatus(msg);
              const hb = status.parseHeartbeat();
              if (hb) {
                this.notify(hb);
                return;
              }
              const code = status.code;
              const description = status.description;
              const { msgsLeft, bytesLeft } = status.parseDiscard();
              if (msgsLeft && msgsLeft > 0 || bytesLeft && bytesLeft > 0) {
                this.pending.msgs -= msgsLeft;
                this.pending.bytes -= bytesLeft;
                this.pending.requests--;
                this.notify({
                  type: "discard",
                  messagesLeft: msgsLeft,
                  bytesLeft
                });
              }
              switch (code) {
                case 400:
                  this.stop(status.toError());
                  return;
                case 409: {
                  const err2 = this.handle409(status);
                  if (err2) {
                    this.stop(err2);
                    return;
                  }
                  if (status.isMessageSizeExceedsMaxBytes() && this.yields.length > 0) {
                    break;
                  }
                  return;
                }
                case 423:
                  this.natsPinId = "";
                  this.notify({ type: "consumer_unpinned" });
                  break;
                case 503:
                  this.notify({ type: "no_responders", code });
                  if (this.consumer.ordered) {
                    const ocs = this.consumer.orderedConsumerState;
                    ocs.needsReset = true;
                  }
                  if (!this.isConsume) {
                    this.stop(status.toError());
                    return;
                  }
                  break;
                default:
                  this.notify({ type: "debug", code, description });
              }
            } else {
              const m = (0, jsmsg_1.toJsMsg)(msg, this.consumer.api.timeout);
              if (this.isPinned) {
                const pinID = m?.headers?.get("Nats-Pin-Id");
                if (pinID && this.natsPinId === "") {
                  this.natsPinId = pinID;
                  this.notify({ type: "consumer_pinned", id: pinID });
                }
              }
              if (this.consumer.ordered) {
                const cursor = this.consumer.orderedConsumerState.cursor;
                const dseq = m.info.deliverySequence;
                const sseq = m.info.streamSequence;
                const expected_dseq = cursor.deliver_seq + 1;
                if (dseq !== expected_dseq) {
                  this.reset();
                  return;
                }
                cursor.deliver_seq = dseq;
                cursor.stream_seq = sseq;
              }
              this._push(m);
              this.received++;
              if (this.pending.msgs) {
                this.pending.msgs--;
              }
              if (this.pending.bytes) {
                this.pending.bytes -= msg.size();
              }
            }
            if (this.pending.msgs === 0 && this.pending.bytes === 0) {
              this.pending.requests = 0;
            }
            if (this.isConsume) {
              if (max_messages && this.pending.msgs <= threshold_messages || max_bytes && this.pending.bytes <= threshold_bytes) {
                const batch = this.pullOptions();
                this.pull(batch);
              }
            } else if (this.pending.requests === 0) {
              this._push(() => {
                this.stop();
              });
            }
          }
        });
        if (idle_heartbeat) {
          this.monitor = new internal_1.IdleHeartbeatMonitor(idle_heartbeat, (count) => {
            this.notify({ type: "heartbeats_missed", count });
            if (!this.isConsume && !this.consumer.ordered) {
              this.stop(new jserrors_1.JetStreamError("heartbeats missed"));
              return true;
            }
            this.resetPending().then(() => {
            }).catch(() => {
            });
            return false;
          }, { maxOut: 2 });
        }
        (async () => {
          const status = this.consumer.api.nc.status();
          this.statusIterator = status;
          for await (const s of status) {
            switch (s.type) {
              case "disconnect":
                this.monitor?.cancel();
                break;
              case "reconnect":
                this.resetPending().then((ok) => {
                  if (ok) {
                    this.monitor?.restart();
                  }
                }).catch(() => {
                });
                break;
              default:
            }
          }
        })();
        this.sub.closed.then(() => {
          if (this.sub.isDraining()) {
            this._push(() => {
              this.stop();
            });
          }
        });
        this.pull(this.pullOptions());
      }
      /**
       * Handle the notification of 409 error and whether
       * it should reject the operation by returning an Error or null
       * @param status
       */
      handle409(status) {
        const { code, description } = status;
        if (status.isConsumerDeleted()) {
          this.notify({ type: "consumer_deleted", code, description });
        } else if (status.isExceededLimit()) {
          this.notify({ type: "exceeded_limits", code, description });
        }
        if (!this.isConsume) {
          return status.toError();
        }
        if (status.isConsumerDeleted() && this.abortOnMissingResource) {
          return status.toError();
        }
        return null;
      }
      reset() {
        this.monitor?.cancel();
        const ocs = this.consumer.orderedConsumerState;
        const { name } = this.consumer._info?.config;
        if (name) {
          this.notify({ type: "reset", name });
          this.consumer.api.delete(this.consumer.stream, name).catch(() => {
          });
        }
        const config = this.consumer.getConsumerOpts();
        this.inbox = `${this.inboxPrefix}.${this.consumer.serial}`;
        ocs.cursor.deliver_seq = 0;
        this.consumer.name = config.name;
        this.consumer.api.nc._resub(this.sub, this.inbox);
        this.consumer.api.add(this.consumer.stream, config).then((ci) => {
          ocs.createFails = 0;
          this.consumer._info = ci;
          this.notify({ type: "ordered_consumer_recreated", name: ci.name });
          this.monitor?.restart();
          this.pull(this.pullOptions());
        }).catch((err) => {
          ocs.createFails++;
          if (err.message === "stream not found") {
            this.notify({
              type: "stream_not_found",
              consumerCreateFails: ocs.createFails,
              name: this.consumer.stream
            });
            if (this.abortOnMissingResource) {
              this.stop(err);
              return;
            }
          }
          if (ocs.createFails >= 30 && this.received === 0) {
            this.stop(err);
          }
          const bo = (0, internal_1.backoff)();
          const c = (0, internal_1.delay)(bo.backoff(ocs.createFails));
          c.then(() => {
            const idx = this.cancelables.indexOf(c);
            if (idx !== -1) {
              this.cancelables = this.cancelables.splice(idx, idx);
            }
            if (!this.done) {
              this.reset();
            }
          }).catch((_) => {
          });
          this.cancelables.push(c);
        });
      }
      _push(r) {
        if (!this.callback) {
          super.push(r);
        } else {
          const fn = typeof r === "function" ? r : null;
          try {
            if (!fn) {
              const m = r;
              this.callback(m);
            } else {
              fn();
            }
          } catch (err) {
            this.stop(err);
          }
        }
      }
      notify(n) {
        if (this.listeners.length > 0) {
          (() => {
            this.listeners.forEach((l) => {
              const qi = l;
              if (!qi.done) {
                qi.push(n);
              }
            });
          })();
        }
      }
      async resetPending() {
        if (this.inReset) {
          return Promise.resolve(true);
        }
        this.inReset = true;
        const v = this.bind ? this.resetPendingNoInfo() : this.resetPendingWithInfo();
        const tf = await v;
        this.inReset = false;
        return tf;
      }
      resetPendingNoInfo() {
        this.pending.msgs = 0;
        this.pending.bytes = 0;
        this.pending.requests = 0;
        this.pull(this.pullOptions());
        return Promise.resolve(true);
      }
      async resetPendingWithInfo() {
        let notFound = 0;
        let streamNotFound = 0;
        const bo = (0, internal_1.backoff)([this.opts.expires || 3e4]);
        let attempt = 0;
        while (true) {
          if (this.done) {
            return false;
          }
          if (this.consumer.api.nc.isClosed()) {
            return false;
          }
          try {
            await this.consumer.info();
            notFound = 0;
            this.pending.msgs = 0;
            this.pending.bytes = 0;
            this.pending.requests = 0;
            this.pull(this.pullOptions());
            return true;
          } catch (err) {
            if (err instanceof internal_1.errors.ClosedConnectionError) {
              this.stop(err);
              return false;
            }
            if (err.message === "stream not found") {
              streamNotFound++;
              this.notify({ type: "stream_not_found", name: this.consumer.stream });
              if (!this.isConsume || this.abortOnMissingResource) {
                this.stop(err);
                return false;
              }
            } else if (err.message === "consumer not found") {
              notFound++;
              this.notify({
                type: "consumer_not_found",
                name: this.consumer.name,
                stream: this.consumer.stream,
                count: notFound
              });
              if (!this.isConsume || this.abortOnMissingResource) {
                if (this.consumer.ordered) {
                  const ocs = this.consumer.orderedConsumerState;
                  ocs.needsReset = true;
                }
                this.stop(err);
                return false;
              }
              if (this.consumer.ordered) {
                this.reset();
                return false;
              }
            } else {
              notFound = 0;
              streamNotFound = 0;
            }
            const to = bo.backoff(attempt);
            const de = (0, internal_1.delay)(to);
            await Promise.race([de, this.consumer.api.nc.closed()]);
            de.cancel();
            attempt++;
          }
        }
      }
      pull(opts) {
        this.pending.bytes += opts.max_bytes ?? 0;
        this.pending.msgs += opts.batch ?? 0;
        this.pending.requests++;
        const nc = this.consumer.api.nc;
        const subj = `${this.consumer.api.prefix}.CONSUMER.MSG.NEXT.${this.consumer.stream}.${this.consumer._info.name}`;
        this._push(() => {
          nc.publish(subj, JSON.stringify(opts), { reply: this.inbox });
          this.notify({ type: "next", options: opts });
        });
      }
      pullOptions() {
        const batch = this.opts.max_messages - this.pending.msgs;
        const max_bytes = this.opts.max_bytes - this.pending.bytes;
        const idle_heartbeat = (0, internal_1.nanos)(this.opts.idle_heartbeat);
        const expires = (0, internal_1.nanos)(this.opts.expires);
        const opts = { batch, max_bytes, idle_heartbeat, expires };
        if (this.isPinned && this.natsPinId !== "") {
          opts.id = this.natsPinId;
        }
        if (isOverflowOptions(this.opts)) {
          opts.group = this.opts.group;
          if (this.opts.min_pending) {
            opts.min_pending = this.opts.min_pending;
          }
          if (this.opts.min_ack_pending) {
            opts.min_ack_pending = this.opts.min_ack_pending;
          }
        }
        if (isPrioritizedOptions(this.opts)) {
          opts.group = this.opts.group;
          opts.priority = this.opts.priority;
        }
        return opts;
      }
      close() {
        this.stop();
        return this.iterClosed;
      }
      closed() {
        return this.iterClosed;
      }
      clearTimers() {
        this.monitor?.cancel();
        this.monitor = null;
      }
      stop(err) {
        if (this.done) {
          return;
        }
        this.consumer.api.nc.removeCloseListener(this.closeListener);
        this.sub?.unsubscribe();
        this.clearTimers();
        this.statusIterator?.stop();
        this._push(() => {
          super.stop(err);
          this.listeners.forEach((iter) => {
            iter.stop();
          });
        });
      }
      parseOptions(opts, refilling = false) {
        const args = opts || {};
        args.max_messages = args.max_messages || 0;
        args.max_bytes = args.max_bytes || 0;
        if (args.max_messages !== 0 && args.max_bytes !== 0) {
          throw internal_1.errors.InvalidArgumentError.format(["max_messages", "max_bytes"], "are mutually exclusive");
        }
        if (args.max_messages === 0) {
          args.max_messages = 100;
        }
        args.expires = args.expires || 3e4;
        if (args.expires < 1e3) {
          throw internal_1.errors.InvalidArgumentError.format("expires", "must be at least 1000ms");
        }
        args.idle_heartbeat = args.idle_heartbeat || args.expires / 2;
        args.idle_heartbeat = args.idle_heartbeat > 3e4 ? 3e4 : args.idle_heartbeat;
        if (args.idle_heartbeat < 500) {
          args.idle_heartbeat = 500;
        }
        if (refilling) {
          const minMsgs = Math.round(args.max_messages * 0.75) || 1;
          args.threshold_messages = args.threshold_messages || minMsgs;
          const minBytes = Math.round(args.max_bytes * 0.75) || 1;
          args.threshold_bytes = args.threshold_bytes || minBytes;
        }
        if (isOverflowOptions(opts)) {
          const { min, ok } = this.consumer.api.nc.features.get(internal_1.Feature.JS_PRIORITY_GROUPS);
          if (!ok) {
            throw new Error(`priority_groups require server ${min}`);
          }
          validateOverflowPullOptions(opts);
          if (opts.group) {
            args.group = opts.group;
          }
          if (opts.min_ack_pending) {
            args.min_ack_pending = opts.min_ack_pending;
          }
          if (opts.min_pending) {
            args.min_pending = opts.min_pending;
          }
        } else if (isPrioritizedOptions(opts)) {
          validatePrioritizedPullOptions(opts);
          if (opts.group) {
            args.group = opts.group;
          }
          if (typeof opts.priority === "number") {
            args.priority = opts.priority;
          }
        }
        return args;
      }
      status() {
        const iter = new internal_1.QueuedIteratorImpl();
        this.listeners.push(iter);
        return iter;
      }
    };
    exports2.PullConsumerMessagesImpl = PullConsumerMessagesImpl;
    var PullConsumerImpl = class {
      api;
      _info;
      stream;
      name;
      opts;
      type;
      messages;
      ordered;
      serial;
      orderedConsumerState;
      constructor(api, info, opts = null) {
        this.api = api;
        this._info = info;
        this.name = info.name;
        this.stream = info.stream_name;
        this.ordered = opts !== null;
        this.opts = opts || {};
        this.serial = 1;
        this.type = exports2.PullConsumerType.Unset;
      }
      debug() {
        console.log({
          serial: this.serial,
          cursor: this.orderedConsumerState?.cursor
        });
      }
      isPullConsumer() {
        return true;
      }
      isPushConsumer() {
        return false;
      }
      consume(opts = {
        max_messages: 100,
        expires: 3e4
      }) {
        opts = { ...opts };
        if (this.ordered) {
          if (opts.bind) {
            return Promise.reject(internal_1.errors.InvalidArgumentError.format("bind", "is not supported"));
          }
          if (this.type === exports2.PullConsumerType.Fetch) {
            return Promise.reject(new internal_1.errors.InvalidOperationError("ordered consumer initialized as fetch"));
          }
          if (this.type === exports2.PullConsumerType.Consume) {
            return Promise.reject(new internal_1.errors.InvalidOperationError("ordered consumer doesn't support concurrent consume"));
          }
          this.type = exports2.PullConsumerType.Consume;
        }
        return Promise.resolve(new PullConsumerMessagesImpl(this, opts, true));
      }
      async fetch(opts = {
        max_messages: 100,
        expires: 3e4
      }) {
        opts = { ...opts };
        if (this.ordered) {
          if (opts.group) {
            return Promise.reject(internal_1.errors.InvalidArgumentError.format("group", "ordered consumers don't support priority groups"));
          }
          if (opts.bind) {
            return Promise.reject(internal_1.errors.InvalidArgumentError.format("bind", "is not supported"));
          }
          if (this.type === exports2.PullConsumerType.Consume) {
            return Promise.reject(new internal_1.errors.InvalidOperationError("ordered consumer already initialized as consume"));
          }
          if (this.messages?.done === false) {
            return Promise.reject(new internal_1.errors.InvalidOperationError("ordered consumer doesn't support concurrent fetch"));
          }
          if (this.ordered) {
            if (this.orderedConsumerState?.cursor?.deliver_seq) {
              this._info.config.opt_start_seq = this.orderedConsumerState?.cursor.stream_seq + 1;
            }
            if (this.orderedConsumerState?.needsReset === true) {
              await this._reset();
            }
          }
          this.type = exports2.PullConsumerType.Fetch;
        }
        const m = new PullConsumerMessagesImpl(this, opts);
        if (this.ordered) {
          this.messages = m;
        }
        return Promise.resolve(m);
      }
      async next(opts = { expires: 3e4 }) {
        opts = { ...opts };
        const fopts = opts;
        fopts.max_messages = 1;
        const iter = await this.fetch(fopts);
        try {
          for await (const m of iter) {
            return m;
          }
        } catch (err) {
          return Promise.reject(err);
        }
        return null;
      }
      delete() {
        const { stream_name, name } = this._info;
        return this.api.delete(stream_name, name);
      }
      getConsumerOpts() {
        const ocs = this.orderedConsumerState;
        this.serial++;
        this.name = `${ocs.namePrefix}_${this.serial}`;
        const conf = Object.assign({}, this._info.config, {
          name: this.name,
          deliver_policy: jsapi_types_1.DeliverPolicy.StartSequence,
          opt_start_seq: ocs.cursor.stream_seq + 1,
          ack_policy: jsapi_types_1.AckPolicy.None,
          inactive_threshold: (0, internal_1.nanos)(5 * 60 * 1e3),
          num_replicas: 1
        });
        delete conf.metadata;
        return conf;
      }
      async _reset() {
        if (this.messages === void 0) {
          throw new Error("not possible to reset");
        }
        this.delete().catch(() => {
        });
        const conf = this.getConsumerOpts();
        const ci = await this.api.add(this.stream, conf);
        this._info = ci;
        return ci;
      }
      async info(cached = false) {
        if (cached) {
          return Promise.resolve(this._info);
        }
        const { stream_name, name } = this._info;
        this._info = await this.api.info(stream_name, name);
        return this._info;
      }
    };
    exports2.PullConsumerImpl = PullConsumerImpl;
    function validateOverflowPullOptions(opts) {
      if (isOverflowOptions(opts)) {
        (0, jsutil_1.minValidation)("group", opts.group);
        if (opts.group.length > 16) {
          throw internal_1.errors.InvalidArgumentError.format("group", "must be 16 characters or less");
        }
        const { min_pending, min_ack_pending } = opts;
        if (min_pending && typeof min_pending !== "number") {
          throw internal_1.errors.InvalidArgumentError.format(["min_pending"], "must be a number");
        }
        if (min_ack_pending && typeof min_ack_pending !== "number") {
          throw internal_1.errors.InvalidArgumentError.format(["min_ack_pending"], "must be a number");
        }
      }
    }
    function validatePrioritizedPullOptions(opts) {
      if (isPrioritizedOptions(opts)) {
        (0, jsutil_1.minValidation)("group", opts.group);
        if (opts.group.length > 16) {
          throw internal_1.errors.InvalidArgumentError.format("group", "must be 16 characters or less");
        }
        const { priority } = opts;
        if (priority && typeof priority !== "number") {
          throw internal_1.errors.InvalidArgumentError.format(["priority"], "must be a number");
        }
      }
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/pushconsumer.js
var require_pushconsumer = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/pushconsumer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PushConsumerImpl = exports2.PushConsumerMessagesImpl = void 0;
    var jsmsg_1 = require_jsmsg();
    var jsapi_types_1 = require_jsapi_types();
    var types_1 = require_types();
    var internal_1 = require_internal_mod();
    var jserrors_1 = require_jserrors();
    var PushConsumerMessagesImpl = class extends internal_1.QueuedIteratorImpl {
      consumer;
      sub;
      monitor;
      listeners;
      abortOnMissingResource;
      callback;
      ordered;
      cursor;
      namePrefix;
      deliverPrefix;
      serial;
      createFails;
      statusIterator;
      cancelables;
      constructor(c, userOptions = {}, internalOptions = {}) {
        super();
        this.consumer = c;
        this.monitor = null;
        this.listeners = [];
        this.cancelables = [];
        this.abortOnMissingResource = userOptions.abort_on_missing_resource === true;
        this.callback = userOptions.callback || null;
        this.noIterator = this.callback !== null;
        this.namePrefix = null;
        this.deliverPrefix = null;
        this.ordered = internalOptions.ordered === true;
        this.serial = 1;
        if (this.ordered) {
          this.namePrefix = internalOptions.name_prefix ?? `oc_${internal_1.nuid.next()}`;
          this.deliverPrefix = internalOptions.deliver_prefix ?? (0, internal_1.createInbox)(this.consumer.api.nc.options.inboxPrefix);
          this.cursor = { stream_seq: 1, deliver_seq: 0 };
          const startSeq = c._info.config.opt_start_seq || 0;
          this.cursor.stream_seq = startSeq > 0 ? startSeq - 1 : 0;
          this.createFails = 0;
        }
        this.start();
      }
      reset() {
        const { name } = this.consumer._info?.config;
        if (name) {
          this.consumer.api.delete(this.consumer.stream, name).catch(() => {
          });
        }
        const config = this.getConsumerOpts();
        this.cursor.deliver_seq = 0;
        this.consumer.name = config.name;
        this.consumer.serial = this.serial;
        this.consumer.api.nc._resub(this.sub, config.deliver_subject);
        this.consumer.api.add(this.consumer.stream, config).then((ci) => {
          this.createFails = 0;
          this.consumer._info = ci;
          this.notify({ type: "ordered_consumer_recreated", name: ci.name });
        }).catch((err) => {
          this.createFails++;
          if (err.message === "stream not found") {
            this.notify({
              type: "stream_not_found",
              name: this.consumer.stream,
              consumerCreateFails: this.createFails
            });
            if (this.abortOnMissingResource) {
              this.stop(err);
              return;
            }
          }
          if (this.createFails >= 30 && this.received === 0) {
            this.stop(err);
          }
          const bo = (0, internal_1.backoff)();
          const c = (0, internal_1.delay)(bo.backoff(this.createFails));
          c.then(() => {
            if (!this.done) {
              this.reset();
            }
          }).catch(() => {
          }).finally(() => {
            const idx = this.cancelables.indexOf(c);
            if (idx !== -1) {
              this.cancelables = this.cancelables.splice(idx, idx);
            }
          });
          this.cancelables.push(c);
        });
      }
      getConsumerOpts() {
        const src = Object.assign({}, this.consumer._info.config);
        this.serial++;
        const name = `${this.namePrefix}_${this.serial}`;
        return Object.assign(src, {
          name,
          deliver_policy: jsapi_types_1.DeliverPolicy.StartSequence,
          opt_start_seq: this.cursor.stream_seq + 1,
          ack_policy: jsapi_types_1.AckPolicy.None,
          inactive_threshold: (0, internal_1.nanos)(5 * 60 * 1e3),
          num_replicas: 1,
          flow_control: true,
          idle_heartbeat: (0, internal_1.nanos)(30 * 1e3),
          deliver_subject: `${this.deliverPrefix}.${this.serial}`
        });
      }
      closed() {
        return this.iterClosed;
      }
      close() {
        this.stop();
        return this.iterClosed;
      }
      stop(err) {
        if (this.done) {
          return;
        }
        this.statusIterator?.stop();
        this.monitor?.cancel();
        this.monitor = null;
        this.cancelables.forEach((c) => {
          c.cancel();
        });
        Promise.all(this.cancelables).then(() => {
          this.cancelables = [];
        }).catch(() => {
        }).finally(() => {
          this._push(() => {
            super.stop(err);
            this.listeners.forEach((n) => {
              n.stop();
            });
          });
        });
      }
      _push(r) {
        if (!this.callback) {
          super.push(r);
        } else {
          const fn = typeof r === "function" ? r : null;
          try {
            if (!fn) {
              const m = r;
              this.received++;
              this.callback(m);
              this.processed++;
            } else {
              fn();
            }
          } catch (err) {
            this.stop(err);
          }
        }
      }
      status() {
        const iter = new internal_1.QueuedIteratorImpl();
        this.listeners.push(iter);
        return iter;
      }
      start() {
        const { deliver_subject: subject, deliver_group: queue, idle_heartbeat: hbNanos } = this.consumer._info.config;
        if (!subject) {
          throw new Error("bad consumer info");
        }
        if (hbNanos) {
          const ms = (0, internal_1.millis)(hbNanos);
          this.monitor = new internal_1.IdleHeartbeatMonitor(ms, (count) => {
            this.notify({ type: "heartbeats_missed", count });
            if (this.ordered) {
              this.reset();
            }
            return false;
          }, { maxOut: 2 });
          (async () => {
            this.statusIterator = this.consumer.api.nc.status();
            for await (const s of this.statusIterator) {
              switch (s.type) {
                case "disconnect":
                  this.monitor?.cancel();
                  break;
                case "reconnect":
                  this.monitor?.restart();
                  break;
                default:
              }
            }
          })();
        }
        this.sub = this.consumer.api.nc.subscribe(subject, {
          queue,
          callback: (err, msg) => {
            if (err) {
              this.stop(err);
              return;
            }
            this.monitor?.work();
            const isProtocol = this.ordered ? msg.subject.indexOf(this?.deliverPrefix) === 0 : msg.subject === subject;
            if (isProtocol) {
              if (msg.subject !== this.sub.getSubject()) {
                return;
              }
              const status = new jserrors_1.JetStreamStatus(msg);
              if (status.isFlowControlRequest()) {
                this._push(() => {
                  msg.respond();
                  this.notify({ type: "flow_control" });
                });
                return;
              }
              if (status.isIdleHeartbeat()) {
                const lastConsumerSequence = parseInt(msg.headers?.get(types_1.JsHeaders.LastConsumerSeqHdr) || "0");
                const lastStreamSequence = parseInt(msg.headers?.get(types_1.JsHeaders.LastStreamSeqHdr) ?? "0");
                this.notify({
                  type: "heartbeat",
                  lastStreamSequence,
                  lastConsumerSequence
                });
                const maybeStuck = msg.headers?.get(types_1.JsHeaders.ConsumerStalledHdr);
                if (typeof maybeStuck === "string" && maybeStuck !== "") {
                  msg.publisher.publish(maybeStuck, internal_1.Empty);
                }
                return;
              }
              const code = status.code;
              const description = status.description;
              if (status.isConsumerDeleted()) {
                this.notify({ type: "consumer_deleted", code, description });
              }
              if (this.abortOnMissingResource) {
                this._push(() => {
                  this.stop(status.toError());
                });
                return;
              }
            } else {
              const m = (0, jsmsg_1.toJsMsg)(msg);
              if (this.ordered) {
                const dseq = m.info.deliverySequence;
                if (dseq !== this.cursor.deliver_seq + 1) {
                  this.reset();
                  return;
                }
                this.cursor.deliver_seq = dseq;
                this.cursor.stream_seq = m.info.streamSequence;
              }
              this._push(m);
            }
          }
        });
        this.sub.closed.then(() => {
          this._push(() => {
            this.stop();
          });
        });
        this.closed().then(() => {
          this.sub?.unsubscribe();
        });
      }
      notify(n) {
        if (this.listeners.length > 0) {
          (() => {
            this.listeners.forEach((l) => {
              const qi = l;
              if (!qi.done) {
                qi.push(n);
              }
            });
          })();
        }
      }
    };
    exports2.PushConsumerMessagesImpl = PushConsumerMessagesImpl;
    var PushConsumerImpl = class {
      api;
      _info;
      stream;
      name;
      bound;
      ordered;
      started;
      serial;
      opts;
      constructor(api, info, opts = {}) {
        this.api = api;
        this._info = info;
        this.stream = info.stream_name;
        this.name = info.name;
        this.bound = opts.bound === true;
        this.started = false;
        this.opts = opts;
        this.serial = 0;
        this.ordered = opts.ordered || false;
        if (this.ordered) {
          this.serial = 1;
        }
      }
      consume(userOptions = {}) {
        userOptions = { ...userOptions };
        if (this.started) {
          return Promise.reject(new internal_1.errors.InvalidOperationError("consumer already started"));
        }
        if (!this._info.config.deliver_subject) {
          return Promise.reject(new Error("deliver_subject is not set, not a push consumer"));
        }
        if (!this._info.config.deliver_group && this._info.push_bound) {
          return Promise.reject(new internal_1.errors.InvalidOperationError("consumer is already bound"));
        }
        const v = new PushConsumerMessagesImpl(this, userOptions, this.opts);
        this.started = true;
        v.closed().then(() => {
          this.started = false;
        });
        return Promise.resolve(v);
      }
      delete() {
        if (this.bound) {
          return Promise.reject(new internal_1.errors.InvalidOperationError("bound consumers cannot delete"));
        }
        const { stream_name, name } = this._info;
        return this.api.delete(stream_name, name);
      }
      async info(cached) {
        if (this.bound) {
          return Promise.reject(new internal_1.errors.InvalidOperationError("bound consumers cannot info"));
        }
        if (cached) {
          return Promise.resolve(this._info);
        }
        const info = await this.api.info(this.stream, this.name);
        this._info = info;
        return info;
      }
      isPullConsumer() {
        return false;
      }
      isPushConsumer() {
        return true;
      }
    };
    exports2.PushConsumerImpl = PushConsumerImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmstream_api.js
var require_jsmstream_api = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsmstream_api.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.StreamsImpl = exports2.StoredMsgImpl = exports2.StreamAPIImpl = exports2.StreamImpl = exports2.ConsumersImpl = void 0;
    exports2.convertStreamSourceDomain = convertStreamSourceDomain;
    var internal_1 = require_internal_mod();
    var jsbaseclient_api_1 = require_jsbaseclient_api();
    var jslister_1 = require_jslister();
    var jsutil_1 = require_jsutil();
    var types_1 = require_types();
    var jsapi_types_1 = require_jsapi_types();
    var consumer_1 = require_consumer();
    var jsmconsumer_api_1 = require_jsmconsumer_api();
    var pushconsumer_1 = require_pushconsumer();
    var jserrors_1 = require_jserrors();
    function convertStreamSourceDomain(s) {
      if (s === void 0) {
        return void 0;
      }
      const { domain } = s;
      if (domain === void 0) {
        return s;
      }
      const copy = Object.assign({}, s);
      delete copy.domain;
      if (domain === "") {
        return copy;
      }
      if (copy.external) {
        throw internal_1.InvalidArgumentError.format(["domain", "external"], "are mutually exclusive");
      }
      copy.external = { api: `$JS.${domain}.API` };
      return copy;
    }
    var ConsumersImpl = class {
      api;
      notified;
      constructor(api) {
        this.api = api;
        this.notified = false;
      }
      checkVersion() {
        const fv = this.api.nc.features.get(internal_1.Feature.JS_SIMPLIFICATION);
        if (!fv.ok) {
          return Promise.reject(new Error(`consumers framework is only supported on servers ${fv.min} or better`));
        }
        return Promise.resolve();
      }
      async getPushConsumer(stream, name) {
        await this.checkVersion();
        (0, jsutil_1.minValidation)("stream", stream);
        if (typeof name === "string") {
          (0, jsutil_1.minValidation)("name", name);
          const ci = await this.api.info(stream, name);
          if (typeof ci.config.deliver_subject !== "string") {
            return Promise.reject(new Error("not a push consumer"));
          }
          return new pushconsumer_1.PushConsumerImpl(this.api, ci);
        } else if (name === void 0) {
          return this.getOrderedPushConsumer(stream);
        } else if ((0, types_1.isOrderedPushConsumerOptions)(name)) {
          const opts = name;
          return this.getOrderedPushConsumer(stream, opts);
        }
        return Promise.reject(new Error("unsupported push consumer type"));
      }
      async getOrderedPushConsumer(stream, opts = {}) {
        opts = Object.assign({}, opts);
        let { name_prefix, deliver_prefix, filter_subjects } = opts;
        delete opts.deliver_prefix;
        delete opts.name_prefix;
        delete opts.filter_subjects;
        if (typeof opts.opt_start_seq === "number") {
          opts.deliver_policy = jsapi_types_1.DeliverPolicy.StartSequence;
        }
        if (typeof opts.opt_start_time === "string") {
          opts.deliver_policy = jsapi_types_1.DeliverPolicy.StartTime;
        }
        name_prefix = name_prefix || `oc_${internal_1.nuid.next()}`;
        (0, jsutil_1.minValidation)("name_prefix", name_prefix);
        deliver_prefix = deliver_prefix || (0, internal_1.createInbox)(this.api.getOptions().watcherPrefix);
        const cc = Object.assign({}, opts);
        cc.ack_policy = jsapi_types_1.AckPolicy.None;
        cc.inactive_threshold = (0, internal_1.nanos)(5 * 60 * 1e3);
        cc.num_replicas = 1;
        cc.max_deliver = 1;
        cc.flow_control = true;
        cc.idle_heartbeat = (0, internal_1.nanos)(3e4);
        if (Array.isArray(filter_subjects)) {
          cc.filter_subjects = filter_subjects;
        }
        if (typeof filter_subjects === "string") {
          cc.filter_subject = filter_subjects;
        }
        if (typeof cc.filter_subjects === "undefined" && typeof cc.filter_subject === "undefined") {
          cc.filter_subject = ">";
        }
        cc.name = `${name_prefix}_1`;
        cc.deliver_subject = `${deliver_prefix}.1`;
        const ci = await this.api.add(stream, cc);
        const iopts = {
          name_prefix,
          deliver_prefix,
          ordered: true
        };
        return new pushconsumer_1.PushConsumerImpl(this.api, ci, iopts);
      }
      getBoundPushConsumer(opts) {
        if ((0, types_1.isBoundPushConsumerOptions)(opts)) {
          const ci = { config: opts };
          return Promise.resolve(new pushconsumer_1.PushConsumerImpl(this.api, ci, { bound: true }));
        } else {
          return Promise.reject(internal_1.errors.InvalidArgumentError.format("deliver_subject", "is required"));
        }
      }
      async get(stream, name) {
        await this.checkVersion();
        if (typeof name === "string") {
          const ci = await this.api.info(stream, name);
          if (typeof ci.config.deliver_subject === "string") {
            return Promise.reject(new Error("not a pull consumer"));
          } else {
            return new consumer_1.PullConsumerImpl(this.api, ci);
          }
        } else {
          return this.ordered(stream, name);
        }
      }
      getConsumerFromInfo(ci) {
        if (typeof ci.config.deliver_subject === "string") {
          throw new Error("not a pull consumer");
        }
        return new consumer_1.PullConsumerImpl(this.api, ci);
      }
      async ordered(stream, opts = {}) {
        await this.checkVersion();
        const impl = this.api;
        const sapi = new StreamAPIImpl(impl.nc, impl.opts);
        await sapi.info(stream);
        if (typeof opts.name_prefix === "string") {
          (0, jsutil_1.minValidation)("name_prefix", opts.name_prefix);
        }
        opts.name_prefix = opts.name_prefix || internal_1.nuid.next();
        const name = `${opts.name_prefix}_1`;
        const config = {
          name,
          deliver_policy: jsapi_types_1.DeliverPolicy.StartSequence,
          opt_start_seq: opts.opt_start_seq || 1,
          ack_policy: jsapi_types_1.AckPolicy.None,
          inactive_threshold: (0, internal_1.nanos)(5 * 60 * 1e3),
          num_replicas: 1,
          max_deliver: 1,
          mem_storage: true
        };
        if (opts.headers_only === true) {
          config.headers_only = true;
        }
        if (Array.isArray(opts.filter_subjects)) {
          config.filter_subjects = opts.filter_subjects;
        }
        if (typeof opts.filter_subjects === "string") {
          config.filter_subject = opts.filter_subjects;
        }
        if (opts.replay_policy) {
          config.replay_policy = opts.replay_policy;
        }
        config.deliver_policy = opts.deliver_policy || jsapi_types_1.DeliverPolicy.StartSequence;
        if (opts.deliver_policy === jsapi_types_1.DeliverPolicy.All || opts.deliver_policy === jsapi_types_1.DeliverPolicy.LastPerSubject || opts.deliver_policy === jsapi_types_1.DeliverPolicy.New || opts.deliver_policy === jsapi_types_1.DeliverPolicy.Last) {
          delete config.opt_start_seq;
          config.deliver_policy = opts.deliver_policy;
        }
        if (config.deliver_policy === jsapi_types_1.DeliverPolicy.LastPerSubject) {
          if (typeof config.filter_subjects === "undefined" && typeof config.filter_subject === "undefined") {
            config.filter_subject = ">";
          }
        }
        if (opts.opt_start_time) {
          delete config.opt_start_seq;
          config.deliver_policy = jsapi_types_1.DeliverPolicy.StartTime;
          config.opt_start_time = opts.opt_start_time;
        }
        if (opts.inactive_threshold) {
          config.inactive_threshold = (0, internal_1.nanos)(opts.inactive_threshold);
        }
        const ci = await this.api.add(stream, config);
        return Promise.resolve(new consumer_1.PullConsumerImpl(this.api, ci, opts));
      }
    };
    exports2.ConsumersImpl = ConsumersImpl;
    var StreamImpl = class _StreamImpl {
      api;
      _info;
      constructor(api, info) {
        this.api = api;
        this._info = info;
      }
      get name() {
        return this._info.config.name;
      }
      alternates() {
        return this.info().then((si) => {
          return si.alternates ? si.alternates : [];
        });
      }
      async best() {
        await this.info();
        if (this._info.alternates) {
          const asi = await this.api.info(this._info.alternates[0].name);
          return new _StreamImpl(this.api, asi);
        } else {
          return this;
        }
      }
      info(cached = false, opts) {
        if (cached) {
          return Promise.resolve(this._info);
        }
        return this.api.info(this.name, opts).then((si) => {
          this._info = si;
          return this._info;
        });
      }
      getConsumer(name) {
        return new ConsumersImpl(new jsmconsumer_api_1.ConsumerAPIImpl(this.api.nc, this.api.opts)).get(this.name, name);
      }
      getPushConsumer(name) {
        return new ConsumersImpl(new jsmconsumer_api_1.ConsumerAPIImpl(this.api.nc, this.api.opts)).getPushConsumer(this.name, name);
      }
      getMessage(query) {
        return this.api.getMessage(this.name, query);
      }
      deleteMessage(seq, erase = true) {
        return this.api.deleteMessage(this.name, seq, erase);
      }
      resetConsumer(name, seq) {
        return new jsmconsumer_api_1.ConsumerAPIImpl(this.api.nc, this.api.opts).reset(this.name, name, seq);
      }
    };
    exports2.StreamImpl = StreamImpl;
    var StreamAPIImpl = class extends jsbaseclient_api_1.BaseApiClientImpl {
      constructor(nc, opts) {
        super(nc, opts);
      }
      checkStreamConfigVersions(cfg) {
        const nci = this.nc;
        if (cfg.metadata) {
          const { min, ok } = nci.features.get(internal_1.Feature.JS_STREAM_CONSUMER_METADATA);
          if (!ok) {
            throw new Error(`stream 'metadata' requires server ${min}`);
          }
        }
        if (cfg.first_seq) {
          const { min, ok } = nci.features.get(internal_1.Feature.JS_STREAM_FIRST_SEQ);
          if (!ok) {
            throw new Error(`stream 'first_seq' requires server ${min}`);
          }
        }
        if (cfg.subject_transform) {
          const { min, ok } = nci.features.get(internal_1.Feature.JS_STREAM_SUBJECT_TRANSFORM);
          if (!ok) {
            throw new Error(`stream 'subject_transform' requires server ${min}`);
          }
        }
        if (cfg.compression) {
          const { min, ok } = nci.features.get(internal_1.Feature.JS_STREAM_COMPRESSION);
          if (!ok) {
            throw new Error(`stream 'compression' requires server ${min}`);
          }
        }
        if (cfg.consumer_limits) {
          const { min, ok } = nci.features.get(internal_1.Feature.JS_DEFAULT_CONSUMER_LIMITS);
          if (!ok) {
            throw new Error(`stream 'consumer_limits' requires server ${min}`);
          }
        }
        function validateStreamSource(context, src) {
          const count = src?.subject_transforms?.length || 0;
          if (count > 0) {
            const { min, ok } = nci.features.get(internal_1.Feature.JS_STREAM_SOURCE_SUBJECT_TRANSFORM);
            if (!ok) {
              throw new Error(`${context} 'subject_transforms' requires server ${min}`);
            }
          }
        }
        if (cfg.sources) {
          cfg.sources.forEach((src) => {
            validateStreamSource("stream sources", src);
          });
        }
        if (cfg.mirror) {
          validateStreamSource("stream mirror", cfg.mirror);
        }
      }
      // mirrors server/jetstream_versioning.go:setStaticStreamMetadata
      minStreamApi(c) {
        if (c.allow_batched === true || c.mirror?.consumer || c.sources?.some((s) => s.consumer))
          return 4;
        if (c.allow_msg_counter === true || c.allow_atomic === true || c.allow_msg_schedules === true || c.persist_mode === jsapi_types_1.PersistMode.Async)
          return 2;
        if (c.allow_msg_ttl === true || typeof c.subject_delete_marker_ttl === "number" && c.subject_delete_marker_ttl > 0)
          return 1;
        return 0;
      }
      requiredApiOpts(c) {
        if (!this.sendRequiredApiLevel())
          return {};
        const minApiVersion = this.minStreamApi(c);
        return minApiVersion > 0 ? { minApiVersion } : {};
      }
      async add(cfg) {
        this.checkStreamConfigVersions(cfg);
        (0, jsutil_1.validateStreamName)(cfg.name);
        cfg.mirror = convertStreamSourceDomain(cfg.mirror);
        cfg.sources = cfg.sources?.map(convertStreamSourceDomain);
        const r = await this._request(`${this.prefix}.STREAM.CREATE.${cfg.name}`, cfg, this.requiredApiOpts(cfg));
        const si = r;
        this._fixInfo(si);
        return si;
      }
      async delete(stream) {
        (0, jsutil_1.validateStreamName)(stream);
        const r = await this._request(`${this.prefix}.STREAM.DELETE.${stream}`);
        const cr = r;
        return cr.success;
      }
      async update(name, cfg = {}) {
        if (typeof name === "object") {
          const sc = name;
          name = sc.name;
          cfg = sc;
          console.trace(`\x1B[33m >> streams.update(config: StreamConfig) api changed to streams.update(name: string, config: StreamUpdateConfig) - this shim will be removed - update your code.  \x1B[0m`);
        }
        this.checkStreamConfigVersions(cfg);
        (0, jsutil_1.validateStreamName)(name);
        const old = await this.info(name);
        const update = Object.assign(old.config, cfg);
        update.mirror = convertStreamSourceDomain(update.mirror);
        update.sources = update.sources?.map(convertStreamSourceDomain);
        const r = await this._request(`${this.prefix}.STREAM.UPDATE.${name}`, update, this.requiredApiOpts(cfg));
        const si = r;
        this._fixInfo(si);
        return si;
      }
      async info(name, data) {
        (0, jsutil_1.validateStreamName)(name);
        const subj = `${this.prefix}.STREAM.INFO.${name}`;
        const r = await this._request(subj, data);
        let si = r;
        let { total, limit } = si;
        let have = si.state.subjects ? Object.getOwnPropertyNames(si.state.subjects).length : 1;
        if (total && total > have) {
          const infos = [si];
          const paged = data || {};
          let i = 0;
          while (total > have) {
            i++;
            paged.offset = limit * i;
            const r2 = await this._request(subj, paged);
            total = r2.total;
            infos.push(r2);
            const count = Object.getOwnPropertyNames(r2.state.subjects).length;
            have += count;
            if (count < limit) {
              break;
            }
          }
          let subjects = {};
          for (let i2 = 0; i2 < infos.length; i2++) {
            si = infos[i2];
            if (si.state.subjects) {
              subjects = Object.assign(subjects, si.state.subjects);
            }
          }
          si.offset = 0;
          si.total = 0;
          si.limit = 0;
          si.state.subjects = subjects;
        }
        this._fixInfo(si);
        return si;
      }
      list(subject = "") {
        const payload = subject?.length ? { subject } : {};
        const listerFilter = (v) => {
          const slr = v;
          slr.streams.forEach((si) => {
            this._fixInfo(si);
          });
          return slr.streams;
        };
        const subj = `${this.prefix}.STREAM.LIST`;
        return new jslister_1.ListerImpl(subj, listerFilter, this, payload);
      }
      // FIXME: init of sealed, deny_delete, deny_purge shouldn't be necessary
      //  https://github.com/nats-io/nats-server/issues/2633
      _fixInfo(si) {
        si.config.sealed = si.config.sealed || false;
        si.config.deny_delete = si.config.deny_delete || false;
        si.config.deny_purge = si.config.deny_purge || false;
        si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
      }
      async purge(name, opts) {
        if (opts) {
          const { keep, seq } = opts;
          if (typeof keep === "number" && typeof seq === "number") {
            throw internal_1.InvalidArgumentError.format(["keep", "seq"], "are mutually exclusive");
          }
        }
        (0, jsutil_1.validateStreamName)(name);
        const v = await this._request(`${this.prefix}.STREAM.PURGE.${name}`, opts);
        return v;
      }
      async deleteMessage(stream, seq, erase = true) {
        (0, jsutil_1.validateStreamName)(stream);
        const dr = { seq };
        if (!erase) {
          dr.no_erase = true;
        }
        const r = await this._request(`${this.prefix}.STREAM.MSG.DELETE.${stream}`, dr);
        const cr = r;
        return cr.success;
      }
      async getMessage(stream, query) {
        (0, jsutil_1.validateStreamName)(stream);
        try {
          const r = await this._request(`${this.prefix}.STREAM.MSG.GET.${stream}`, query);
          const sm = r;
          return new StoredMsgImpl(sm);
        } catch (err) {
          if (err instanceof jserrors_1.JetStreamApiError && err.code === jserrors_1.JetStreamApiCodes.NoMessageFound) {
            return null;
          }
          return Promise.reject(err);
        }
      }
      find(subject) {
        return this.findStream(subject);
      }
      names(subject = "") {
        const payload = subject?.length ? { subject } : {};
        const listerFilter = (v) => {
          const sr = v;
          return sr.streams;
        };
        const subj = `${this.prefix}.STREAM.NAMES`;
        return new jslister_1.ListerImpl(subj, listerFilter, this, payload);
      }
      async get(name) {
        const si = await this.info(name);
        return Promise.resolve(new StreamImpl(this, si));
      }
    };
    exports2.StreamAPIImpl = StreamAPIImpl;
    var StoredMsgImpl = class {
      _header;
      smr;
      static jc;
      constructor(smr) {
        this.smr = smr;
      }
      get pending() {
        return 0;
      }
      get lastSequence() {
        return 0;
      }
      get subject() {
        return this.smr.message.subject;
      }
      get seq() {
        return this.smr.message.seq;
      }
      get timestamp() {
        return this.smr.message.time;
      }
      get time() {
        return new Date(Date.parse(this.timestamp));
      }
      get data() {
        return this.smr.message.data ? this._parse(this.smr.message.data) : internal_1.Empty;
      }
      get header() {
        if (!this._header) {
          if (this.smr.message.hdrs) {
            const hd = this._parse(this.smr.message.hdrs);
            this._header = internal_1.MsgHdrsImpl.decode(hd);
          } else {
            this._header = (0, internal_1.headers)();
          }
        }
        return this._header;
      }
      _parse(s) {
        const bs = atob(s);
        const len = bs.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = bs.charCodeAt(i);
        }
        return bytes;
      }
      json(reviver) {
        return JSON.parse(new TextDecoder().decode(this.data), reviver);
      }
      string() {
        return internal_1.TD.decode(this.data);
      }
    };
    exports2.StoredMsgImpl = StoredMsgImpl;
    var StreamsImpl = class {
      api;
      constructor(api) {
        this.api = api;
      }
      get(stream) {
        return this.api.info(stream).then((si) => {
          return new StreamImpl(this.api, si);
        });
      }
    };
    exports2.StreamsImpl = StreamsImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsm_direct.js
var require_jsm_direct = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsm_direct.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DirectConsumer = exports2.DirectMsgImpl = exports2.DirectStreamAPIImpl = void 0;
    var jsbaseclient_api_1 = require_jsbaseclient_api();
    var types_1 = require_types();
    var internal_1 = require_internal_mod();
    var jsutil_1 = require_jsutil();
    var jserrors_1 = require_jserrors();
    var DirectStreamAPIImpl = class extends jsbaseclient_api_1.BaseApiClientImpl {
      constructor(nc, opts) {
        super(nc, opts);
      }
      async getMessage(stream, query) {
        (0, jsutil_1.validateStreamName)(stream);
        if ("start_time" in query) {
          const { min, ok } = this.nc.features.get(internal_1.Feature.JS_BATCH_DIRECT_GET);
          if (!ok) {
            throw new Error(`start_time direct option require server ${min}`);
          }
        }
        let qq = query;
        const { last_by_subj } = qq;
        if (last_by_subj) {
          qq = null;
        }
        const payload = qq ? JSON.stringify(qq) : internal_1.Empty;
        const pre = this.opts.apiPrefix || "$JS.API";
        const subj = last_by_subj ? `${pre}.DIRECT.GET.${stream}.${last_by_subj}` : `${pre}.DIRECT.GET.${stream}`;
        const r = await this.nc.request(subj, payload, { timeout: this.timeout });
        if (r.headers?.code !== 0) {
          const status = new jserrors_1.JetStreamStatus(r);
          if (status.isMessageNotFound()) {
            return Promise.resolve(null);
          } else {
            return Promise.reject(status.toError());
          }
        }
        const dm = new DirectMsgImpl(r);
        return Promise.resolve(dm);
      }
      getBatch(stream, opts) {
        opts.batch = opts.batch || 1024;
        return this.get(stream, opts);
      }
      getLastMessagesFor(stream, opts) {
        return this.get(stream, opts);
      }
      get(stream, opts) {
        opts = { ...opts };
        const { min, ok } = this.nc.features.get(internal_1.Feature.JS_BATCH_DIRECT_GET);
        if (!ok) {
          return Promise.reject(new Error(`batch direct require server ${min}`));
        }
        (0, jsutil_1.validateStreamName)(stream);
        const callback = typeof opts.callback === "function" ? opts.callback : null;
        const iter = new internal_1.QueuedIteratorImpl();
        function pushIter(done2, d) {
          if (done2) {
            iter.push(() => {
              done2.err ? iter.stop(done2.err) : iter.stop();
            });
            return;
          }
          iter.push(d);
        }
        function pushCb(done2, m) {
          const cb = callback;
          if (typeof m === "function") {
            m();
            return;
          }
          cb(done2, m);
        }
        if (callback) {
          iter.iterClosed.then((err) => {
            push({ err: err ? err : void 0 }, {});
            sub.unsubscribe();
          });
        }
        const push = callback ? pushCb : pushIter;
        const inbox = (0, internal_1.createInbox)(this.nc.options.inboxPrefix);
        let batchSupported = false;
        const sub = this.nc.subscribe(inbox, {
          timeout: 5e3,
          callback: (err, msg) => {
            if (err) {
              iter.stop(err);
              sub.unsubscribe();
              return;
            }
            const status = jserrors_1.JetStreamStatus.maybeParseStatus(msg);
            if (status) {
              if (status.isNoResults()) {
                push({}, () => {
                  iter.stop();
                });
              }
              if (status.isEndOfBatch()) {
                push({}, () => {
                  iter.stop();
                });
              } else {
                const err2 = status.toError();
                push({ err: err2 }, () => {
                  iter.stop(err2);
                });
              }
              return;
            }
            if (!batchSupported) {
              if (typeof msg.headers?.get("Nats-Num-Pending") !== "string") {
                sub.unsubscribe();
                push({}, () => {
                  iter.stop();
                });
              } else {
                batchSupported = true;
              }
            }
            push(null, new DirectMsgImpl(msg));
          }
        });
        const pre = this.opts.apiPrefix || "$JS.API";
        const subj = `${pre}.DIRECT.GET.${stream}`;
        const payload = JSON.stringify(opts, (key, value) => {
          if ((key === "up_to_time" || key === "start_time") && value instanceof Date) {
            return value.toISOString();
          }
          return value;
        });
        this.nc.publish(subj, payload, { reply: inbox });
        return Promise.resolve(iter);
      }
    };
    exports2.DirectStreamAPIImpl = DirectStreamAPIImpl;
    var DirectMsgImpl = class {
      data;
      header;
      constructor(m) {
        if (!m.headers) {
          throw new Error("headers expected");
        }
        this.data = m.data;
        this.header = m.headers;
      }
      get subject() {
        return this.header.last(types_1.DirectMsgHeaders.Subject);
      }
      get seq() {
        const v = this.header.last(types_1.DirectMsgHeaders.Sequence);
        return typeof v === "string" ? parseInt(v) : 0;
      }
      get time() {
        return new Date(Date.parse(this.timestamp));
      }
      get timestamp() {
        return this.header.last(types_1.DirectMsgHeaders.TimeStamp);
      }
      get stream() {
        return this.header.last(types_1.DirectMsgHeaders.Stream);
      }
      get lastSequence() {
        const v = this.header.last(types_1.DirectMsgHeaders.LastSequence);
        return typeof v === "string" ? parseInt(v) : 0;
      }
      get pending() {
        const v = this.header.last(types_1.DirectMsgHeaders.NumPending);
        return typeof v === "string" ? parseInt(v) : -1;
      }
      json(reviver) {
        return JSON.parse(new TextDecoder().decode(this.data), reviver);
      }
      string() {
        return internal_1.TD.decode(this.data);
      }
    };
    exports2.DirectMsgImpl = DirectMsgImpl;
    function isDirectBatchStartTime(t) {
      return typeof t === "object" && "start_time" in t;
    }
    function isMaxBytes(t) {
      return typeof t === "object" && "max_bytes" in t;
    }
    var DirectConsumer = class {
      stream;
      api;
      cursor;
      listeners;
      start;
      constructor(stream, api, start) {
        this.stream = stream;
        this.api = api;
        this.cursor = { last: 0 };
        this.listeners = [];
        this.start = start;
      }
      getOptions(opts) {
        opts = opts || {};
        const dbo = {};
        if (this.cursor.last === 0) {
          if (isDirectBatchStartTime(this.start)) {
            dbo.start_time = this.start.start_time;
          } else {
            dbo.seq = this.start.seq || 1;
          }
        } else {
          dbo.seq = this.cursor.last + 1;
        }
        if (isMaxBytes(opts)) {
          dbo.max_bytes = opts.max_bytes;
        } else {
          dbo.batch = opts.batch ?? 100;
        }
        return dbo;
      }
      status() {
        const iter = new internal_1.QueuedIteratorImpl();
        this.listeners.push(iter);
        return iter;
      }
      notify(n) {
        if (this.listeners.length > 0) {
          (() => {
            const remove = [];
            this.listeners.forEach((l) => {
              const qi = l;
              if (!qi.done) {
                qi.push(n);
              } else {
                remove.push(qi);
              }
            });
            this.listeners = this.listeners.filter((l) => !remove.includes(l));
          })();
        }
      }
      debug() {
        console.log(this.cursor);
      }
      consume(opts) {
        let pending;
        let requestDone;
        const qi = new internal_1.QueuedIteratorImpl();
        (async () => {
          while (true) {
            if (this.cursor.pending === 0) {
              this.notify({
                type: "debug",
                code: 0,
                description: "sleeping for 2500"
              });
              pending = (0, internal_1.delay)(2500);
              await pending;
            }
            if (qi.done) {
              break;
            }
            requestDone = (0, internal_1.deferred)();
            const dbo = this.getOptions(opts);
            this.notify({
              type: "next",
              options: Object.assign({}, opts)
            });
            dbo.callback = (r, sm) => {
              if (r) {
                if (r.err) {
                  if (r.err instanceof jserrors_1.JetStreamStatusError) {
                    this.notify({
                      type: "debug",
                      code: r.err.code,
                      description: r.err.message
                    });
                  } else {
                    this.notify({
                      type: "debug",
                      code: 0,
                      description: r.err.message
                    });
                  }
                }
                requestDone.resolve();
              } else if (sm.lastSequence > 0 && sm.lastSequence !== this.cursor.last) {
                src.stop();
                requestDone.resolve();
                this.notify({
                  type: "reset",
                  name: "direct"
                });
              } else {
                qi.push(sm);
                qi.received++;
                this.cursor.last = sm.seq;
                this.cursor.pending = sm.pending;
              }
            };
            const src = await this.api.getBatch(this.stream, dbo);
            qi.iterClosed.then(() => {
              src.stop();
              pending?.cancel();
              requestDone?.resolve();
            });
            await requestDone;
          }
        })().catch((err) => {
          qi.stop(err);
        });
        return Promise.resolve(qi);
      }
      async fetch(opts) {
        const dbo = this.getOptions(opts);
        const qi = new internal_1.QueuedIteratorImpl();
        const src = await this.api.get(this.stream, Object.assign({
          callback: (done2, sm) => {
            if (done2) {
              qi.push(() => {
                done2.err ? qi.stop(done2.err) : qi.stop();
              });
            } else if (sm.lastSequence > 0 && sm.lastSequence !== this.cursor.last) {
              qi.push(() => {
                qi.stop();
              });
              src.stop();
            } else {
              qi.push(sm);
              qi.received++;
              this.cursor.last = sm.seq;
              this.cursor.pending = sm.pending;
            }
          }
        }, dbo));
        qi.iterClosed.then(() => {
          src.stop();
        });
        return qi;
      }
      async next() {
        const sm = await this.api.getMessage(this.stream, {
          seq: this.cursor.last + 1
        });
        const seq = sm?.seq;
        if (seq) {
          this.cursor.last = seq;
        }
        return sm;
      }
    };
    exports2.DirectConsumer = DirectConsumer;
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsclient.js
var require_jsclient = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/jsclient.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BatchPublisherImpl = exports2.JetStreamClientImpl = exports2.JetStreamManagerImpl = void 0;
    exports2.startFastIngest = startFastIngest;
    exports2.toJetStreamClient = toJetStreamClient;
    exports2.jetstream = jetstream10;
    exports2.jetstreamManager = jetstreamManager14;
    exports2.scheduleSpecToHeader = scheduleSpecToHeader;
    var jsbaseclient_api_1 = require_jsbaseclient_api();
    var jsmconsumer_api_1 = require_jsmconsumer_api();
    var internal_1 = require_internal_mod();
    var jsmstream_api_1 = require_jsmstream_api();
    var jsapi_types_1 = require_jsapi_types();
    var jserrors_1 = require_jserrors();
    var jsm_direct_1 = require_jsm_direct();
    function startFastIngest(nc, subj, payload, opts, defaultTimeout = 5e3) {
      const { ackInterval, allowGaps, inboxPrefix, maxOutstandingAcks, ...publishOpts } = opts;
      const prefix = inboxPrefix ?? "_INBOX";
      if (!prefix || /\s/.test(prefix) || /[*>]/.test(prefix)) {
        return Promise.reject(new Error(`inboxPrefix must be non-empty, no wildcards or whitespace (got "${prefix}")`));
      }
      const o = {
        ackInterval: ackInterval ?? 10,
        allowGaps,
        inboxPrefix: prefix,
        maxOutstandingAcks: Math.min(3, Math.max(1, maxOutstandingAcks ?? 2))
      };
      const fi = new FastIngestImpl(nc, o, subj, defaultTimeout);
      return fi.start(payload, publishOpts).then(() => fi);
    }
    function buildPublishHeaders(opts) {
      const expect = opts.expect || {};
      const mh = opts.headers || (0, internal_1.headers)();
      if (opts.msgID) {
        mh.set(jsapi_types_1.PubHeaders.MsgIdHdr, opts.msgID);
      }
      if (expect.lastMsgID) {
        mh.set(jsapi_types_1.PubHeaders.ExpectedLastMsgIdHdr, expect.lastMsgID);
      }
      if (expect.streamName) {
        mh.set(jsapi_types_1.PubHeaders.ExpectedStreamHdr, expect.streamName);
      }
      if (typeof expect.lastSequence === "number") {
        mh.set(jsapi_types_1.PubHeaders.ExpectedLastSeqHdr, `${expect.lastSequence}`);
      }
      if (typeof expect.lastSubjectSequence === "number") {
        mh.set(jsapi_types_1.PubHeaders.ExpectedLastSubjectSequenceHdr, `${expect.lastSubjectSequence}`);
      }
      if (expect.lastSubjectSequenceSubject) {
        mh.set(jsapi_types_1.PubHeaders.ExpectedLastSubjectSequenceSubjectHdr, expect.lastSubjectSequenceSubject);
      }
      if (opts.ttl) {
        mh.set(jsapi_types_1.PubHeaders.MessageTTL, `${opts.ttl}`);
      }
      if (opts.schedule && opts.cancelSchedule) {
        throw new Error("schedule and cancelSchedule are mutually exclusive");
      }
      if (opts.schedule) {
        const so = opts.schedule;
        if (so.specification) {
          mh.set(jsapi_types_1.PubHeaders.Schedule, scheduleSpecToHeader(so.specification));
        }
        if (so.target) {
          mh.set(jsapi_types_1.PubHeaders.ScheduleTarget, so.target);
        }
        if (so.source) {
          mh.set(jsapi_types_1.PubHeaders.ScheduleSource, so.source);
        }
        if (so.ttl) {
          mh.set(jsapi_types_1.PubHeaders.ScheduleTTL, so.ttl);
        }
        if (so.timezone) {
          mh.set(jsapi_types_1.PubHeaders.ScheduleTimeZone, so.timezone);
        }
        if (so.rollup) {
          mh.set(jsapi_types_1.PubHeaders.ScheduleRollup, so.rollup);
        }
      }
      if (opts.cancelSchedule) {
        mh.set(jsapi_types_1.PubHeaders.Scheduler, opts.cancelSchedule.scheduleSubject);
        mh.set(jsapi_types_1.PubHeaders.ScheduleNext, "purge");
      }
      return mh;
    }
    function toJetStreamClient(nc) {
      if (typeof nc.nc === "undefined") {
        return jetstream10(nc);
      }
      return nc;
    }
    function jetstream10(nc, opts = {}) {
      return new JetStreamClientImpl(nc, opts);
    }
    async function jetstreamManager14(nc, opts = {}) {
      const adm = new JetStreamManagerImpl(nc, opts);
      if (opts.checkAPI !== false) {
        try {
          await adm.getAccountInfo();
        } catch (err) {
          throw err;
        }
      }
      return adm;
    }
    var JetStreamManagerImpl = class extends jsbaseclient_api_1.BaseApiClientImpl {
      streams;
      consumers;
      direct;
      constructor(nc, opts) {
        super(nc, opts);
        this.streams = new jsmstream_api_1.StreamAPIImpl(nc, opts);
        this.consumers = new jsmconsumer_api_1.ConsumerAPIImpl(nc, opts);
        this.direct = new jsm_direct_1.DirectStreamAPIImpl(nc, opts);
      }
      async getAccountInfo() {
        const r = await this._request(`${this.prefix}.INFO`);
        return r;
      }
      jetstream() {
        return jetstream10(this.nc, this.getOptions());
      }
      advisories() {
        const iter = new internal_1.QueuedIteratorImpl();
        this.nc.subscribe(`$JS.EVENT.ADVISORY.>`, {
          callback: (err, msg) => {
            if (err) {
              throw err;
            }
            try {
              const d = this.parseJsResponse(msg);
              const chunks = d.type.split(".");
              const kind = chunks[chunks.length - 1];
              iter.push({ kind, data: d });
            } catch (err2) {
              iter.stop(err2);
            }
          }
        });
        return iter;
      }
    };
    exports2.JetStreamManagerImpl = JetStreamManagerImpl;
    function scheduleSpecToHeader(spec) {
      if (typeof spec === "string") {
        return spec;
      }
      if (spec instanceof Date) {
        return `@at ${spec.toISOString()}`;
      }
      if ("at" in spec) {
        const iso = spec.at instanceof Date ? spec.at.toISOString() : spec.at;
        return `@at ${iso}`;
      }
      if ("every" in spec) {
        assertEveryAtLeastOneSecond(spec.every);
        return `@every ${spec.every}`;
      }
      if ("cron" in spec) {
        return spec.cron;
      }
      if ("predefined" in spec) {
        return spec.predefined;
      }
      throw new Error("invalid schedule specification");
    }
    function assertEveryAtLeastOneSecond(d) {
      const trimmed = d.trim();
      const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
      let totalMs = 0;
      let pos = 0;
      let m;
      while ((m = re.exec(trimmed)) !== null) {
        if (m.index !== pos)
          break;
        pos += m[0].length;
        const n = parseFloat(m[1]);
        const unit = m[2];
        totalMs += unit === "ns" ? n / 1e6 : unit === "us" || unit === "\xB5s" ? n / 1e3 : unit === "ms" ? n : unit === "s" ? n * 1e3 : unit === "m" ? n * 6e4 : n * 36e5;
      }
      if (trimmed === "" || pos !== trimmed.length) {
        throw new Error(`@every: unrecognized duration format: "${d}"`);
      }
      if (totalMs < 1e3) {
        throw new Error("@every interval must be at least 1s");
      }
    }
    var JetStreamClientImpl = class extends jsbaseclient_api_1.BaseApiClientImpl {
      consumers;
      streams;
      consumerAPI;
      streamAPI;
      constructor(nc, opts) {
        super(nc, opts);
        this.consumerAPI = new jsmconsumer_api_1.ConsumerAPIImpl(nc, opts);
        this.streamAPI = new jsmstream_api_1.StreamAPIImpl(nc, opts);
        this.consumers = new jsmstream_api_1.ConsumersImpl(this.consumerAPI);
        this.streams = new jsmstream_api_1.StreamsImpl(this.streamAPI);
      }
      jetstreamManager(checkAPI) {
        if (checkAPI === void 0) {
          checkAPI = this.opts.checkAPI;
        }
        const opts = Object.assign({}, this.opts, { checkAPI });
        try {
          (0, internal_1.createInbox)(opts.watcherPrefix);
        } catch (err) {
          return Promise.reject(err);
        }
        return jetstreamManager14(this.nc, opts);
      }
      get apiPrefix() {
        return this.prefix;
      }
      startBatch(subj, payload, opts) {
        const d = (0, internal_1.deferred)();
        const bp = new BatchPublisherImpl(this);
        bp.first(subj, payload, opts).then(() => {
          d.resolve(bp);
        }).catch((err) => {
          d.reject(err);
        });
        return d;
      }
      async _publish(subj, data = internal_1.Empty, opts) {
        opts = opts || {};
        opts = { ...opts };
        if (opts.cancelSchedule && opts.cancelSchedule.scheduleSubject === subj) {
          throw new Error("cancelSchedule.scheduleSubject must not equal the publish subject");
        }
        const mh = buildPublishHeaders(opts);
        const to = opts.timeout || this.timeout;
        const ro = {};
        if (to) {
          ro.timeout = to;
        }
        if (opts) {
          ro.headers = mh;
        }
        let { retries } = opts;
        retries = retries || 1;
        const bo = (0, internal_1.backoff)();
        let r = null;
        for (let i = 0; i < retries; i++) {
          try {
            r = await this.nc.request(subj, data, ro);
            break;
          } catch (err) {
            const re = err instanceof internal_1.RequestError ? err : null;
            if ((err instanceof internal_1.errors.TimeoutError || re?.isNoResponders()) && i + 1 < retries) {
              await (0, internal_1.delay)(bo.backoff(i));
            } else {
              throw re?.isNoResponders() ? new jserrors_1.JetStreamNotEnabled(`jetstream is not enabled`, {
                cause: err
              }) : err;
            }
          }
        }
        return r;
      }
      async publish(subj, data = internal_1.Empty, opts) {
        const r = await this._publish(subj, data, opts);
        const pa = this.parseJsResponse(r);
        if (pa.stream === "") {
          throw new jserrors_1.JetStreamError("invalid ack response");
        }
        pa.duplicate = pa.duplicate ? pa.duplicate : false;
        return pa;
      }
    };
    exports2.JetStreamClientImpl = JetStreamClientImpl;
    var BatchPublisherImpl = class {
      nc;
      js;
      id;
      count;
      done;
      constructor(js) {
        this.count = 0;
        this.id = internal_1.nuid.next();
        this.js = js;
        this.nc = this.js.nc;
        this.done = false;
      }
      async first(subj, payload, opts) {
        opts = opts || {};
        opts.headers = opts?.headers || (0, internal_1.headers)();
        opts.headers.set("Nats-Batch-Id", this.id);
        this.count++;
        opts.headers.set("Nats-Batch-Sequence", this.count.toString());
        const r = await this.js._publish(subj, payload, opts);
        if (r.data.length > 0) {
          this.js.parseJsResponse(r);
        }
      }
      add(subj, payload, opts = { ack: false }) {
        if (this.done) {
          throw new Error("batch publisher is done");
        }
        opts.headers = opts?.headers || (0, internal_1.headers)();
        opts.headers.set("Nats-Batch-Id", this.id);
        this.count++;
        opts.headers.set("Nats-Batch-Sequence", this.count.toString());
        const hasAck = "ack" in opts && opts.ack === true;
        if (hasAck) {
          const d = (0, internal_1.deferred)();
          this.js._publish(subj, payload, {
            headers: opts.headers,
            timeout: opts.timeout
          }).then((m) => {
            if (m.data.length > 0) {
              this.js.parseJsResponse(m);
            }
            d.resolve();
          }).catch((err) => {
            this.done = true;
            d.reject(err);
          });
          return d;
        } else {
          return this.nc.publish(subj, payload, { headers: opts.headers });
        }
      }
      async commit(subj, payload, opts = {}) {
        if (this.done) {
          throw new Error("batch publisher is done");
        } else {
          this.done = true;
        }
        opts.headers = opts?.headers || (0, internal_1.headers)();
        opts.headers.set("Nats-Batch-Id", this.id);
        this.count++;
        opts.headers.set("Nats-Batch-Sequence", this.count.toString());
        opts.headers.set("Nats-Batch-Commit", "1");
        const r = await this.js._publish(subj, payload, {
          headers: opts.headers,
          timeout: opts.timeout || 0
        });
        const ack = r.json();
        if (ack.count !== this.count) {
          throw new Error("batch didn't contain number of published messages");
        }
        return ack;
      }
    };
    exports2.BatchPublisherImpl = BatchPublisherImpl;
    var BATCH_CLOSED = "batch closed";
    var FastIngestOp = {
      Start: 0,
      Append: 1,
      Final: 2,
      EOB: 3,
      Ping: 4
    };
    var FastIngestImpl = class {
      batch;
      nc;
      batchSubj;
      gapMode;
      initialFlow;
      seq;
      acked;
      ackInterval;
      inboxPrefix;
      maxOutstandingAcks;
      defaultTimeout;
      gapIter;
      sub;
      pending;
      closed;
      closeErr;
      startDeferred;
      closedDeferred;
      constructor(nc, opts, firstSubj, defaultTimeout) {
        this.nc = nc;
        this.batchSubj = firstSubj;
        this.gapMode = opts.allowGaps ? "ok" : "fail";
        this.initialFlow = opts.ackInterval;
        this.inboxPrefix = opts.inboxPrefix;
        this.maxOutstandingAcks = opts.maxOutstandingAcks;
        this.defaultTimeout = defaultTimeout;
        this.batch = internal_1.nuid.next();
        this.seq = 0;
        this.acked = 0;
        this.ackInterval = opts.ackInterval;
        this.pending = /* @__PURE__ */ new Map();
        this.closed = false;
        this.startDeferred = (0, internal_1.deferred)();
        this.closedDeferred = (0, internal_1.deferred)();
        this.closedDeferred.catch(() => {
        });
        this.startDeferred.catch(() => {
        });
        const inbox = `${this.inboxPrefix}.${this.batch}.>`;
        this.sub = this.nc.subscribe(inbox, {
          callback: (err, msg) => this.route(err, msg)
        });
      }
      replyFor(op, seq) {
        return `${this.inboxPrefix}.${this.batch}.${this.initialFlow}.${this.gapMode}.${seq}.${op}.$FI`;
      }
      start(payload, opts) {
        this.seq = 1;
        const rs = this.replyFor(FastIngestOp.Start, 1);
        const headers3 = opts ? buildPublishHeaders(opts) : void 0;
        this.nc.publish(this.batchSubj, payload, { reply: rs, headers: headers3 });
        return this.deadlineOrClose(this.startDeferred, opts?.timeout ?? this.defaultTimeout);
      }
      deadlineOrClose(p, ms) {
        return (0, internal_1.deadline)(p, ms).catch((err) => {
          if (!this.closed)
            this.close(err);
          throw err;
        });
      }
      route(err, m) {
        if (err) {
          this.close(err);
          return;
        }
        let data;
        try {
          data = (0, jsbaseclient_api_1.parseJsResponse)(m);
        } catch (err2) {
          this.close(err2);
          return;
        }
        if ("batch" in data && typeof data.batch === "string") {
          const ack = data;
          const e = this.pending.get(m.subject);
          if (e && (e.op === FastIngestOp.Final || e.op === FastIngestOp.EOB)) {
            e.deferred.resolve(ack);
            this.pending.delete(m.subject);
          }
          for (const [, entry] of this.pending) {
            if (entry.op === FastIngestOp.Append || entry.op === FastIngestOp.Ping) {
              entry.deferred.resolve({ batchSeq: entry.seq, ackSeq: this.acked });
            } else {
              entry.deferred.reject(new Error(BATCH_CLOSED));
            }
          }
          this.pending.clear();
          this.resolveStart();
          this.closedDeferred.resolve(ack);
          this.closed = true;
          this.gapIter?.stop();
          this.sub.unsubscribe();
          return;
        }
        const typed = data;
        if (typed.type === "gap") {
          if (this.gapIter) {
            const g = data;
            this.gapIter.push({ lastSeq: g.last_seq, seq: g.seq });
          }
          return;
        }
        const fa = data;
        if (typeof fa.msgs === "number")
          this.ackInterval = fa.msgs;
        if (typeof fa.seq === "number" && fa.seq > this.acked) {
          this.acked = fa.seq;
        }
        this.resolveStart();
        const exact = this.pending.get(m.subject);
        if (exact && (exact.op === FastIngestOp.Append || exact.op === FastIngestOp.Ping)) {
          exact.deferred.resolve({ batchSeq: exact.seq, ackSeq: this.acked });
          this.pending.delete(m.subject);
        }
        for (const [rs, e] of this.pending) {
          if (e.op === FastIngestOp.Append && e.seq - this.acked < this.ackInterval * this.maxOutstandingAcks) {
            e.deferred.resolve({ batchSeq: e.seq, ackSeq: this.acked });
            this.pending.delete(rs);
          }
        }
      }
      resolveStart() {
        this.startDeferred.resolve();
      }
      close(err) {
        this.closed = true;
        this.closeErr = err;
        for (const [, e] of this.pending)
          e.deferred.reject(err);
        this.pending.clear();
        this.startDeferred.reject(err);
        this.closedDeferred.reject(err);
        this.gapIter?.stop();
        this.sub.unsubscribe();
      }
      add(subj, payload, opts) {
        if (this.closed)
          return Promise.reject(new Error(BATCH_CLOSED));
        const mySeq = ++this.seq;
        const rs = this.replyFor(FastIngestOp.Append, mySeq);
        const headers3 = opts ? buildPublishHeaders(opts) : void 0;
        this.nc.publish(subj, payload, { reply: rs, headers: headers3 });
        if (mySeq - this.acked < this.ackInterval * this.maxOutstandingAcks) {
          return Promise.resolve({ batchSeq: mySeq, ackSeq: this.acked });
        }
        const d = (0, internal_1.deferred)();
        this.pending.set(rs, { seq: mySeq, op: FastIngestOp.Append, deferred: d });
        return this.deadlineOrClose(d, opts?.timeout ?? this.defaultTimeout);
      }
      last(subj, payload, opts) {
        if (this.closed)
          return Promise.reject(new Error(BATCH_CLOSED));
        const mySeq = ++this.seq;
        const rs = this.replyFor(FastIngestOp.Final, mySeq);
        const d = (0, internal_1.deferred)();
        this.pending.set(rs, { seq: mySeq, op: FastIngestOp.Final, deferred: d });
        const headers3 = opts ? buildPublishHeaders(opts) : void 0;
        this.nc.publish(subj, payload, { reply: rs, headers: headers3 });
        return this.deadlineOrClose(d, opts?.timeout ?? this.defaultTimeout);
      }
      end(opts) {
        if (this.closed)
          return Promise.reject(new Error(BATCH_CLOSED));
        const mySeq = ++this.seq;
        const rs = this.replyFor(FastIngestOp.EOB, mySeq);
        const d = (0, internal_1.deferred)();
        this.pending.set(rs, { seq: mySeq, op: FastIngestOp.EOB, deferred: d });
        const headers3 = opts ? buildPublishHeaders(opts) : void 0;
        this.nc.publish(this.batchSubj, internal_1.Empty, { reply: rs, headers: headers3 });
        return this.deadlineOrClose(d, opts?.timeout ?? this.defaultTimeout);
      }
      ping(timeout = this.defaultTimeout) {
        if (this.closed)
          return Promise.reject(new Error(BATCH_CLOSED));
        const rs = this.replyFor(FastIngestOp.Ping, this.seq);
        const existing = this.pending.get(rs);
        if (existing && existing.op === FastIngestOp.Ping) {
          return (0, internal_1.deadline)(existing.deferred, timeout);
        }
        const d = (0, internal_1.deferred)();
        this.pending.set(rs, { seq: this.seq, op: FastIngestOp.Ping, deferred: d });
        this.nc.publish(this.batchSubj, internal_1.Empty, { reply: rs });
        return this.deadlineOrClose(d, timeout);
      }
      done() {
        return this.closedDeferred;
      }
      gaps() {
        if (!this.gapIter) {
          this.gapIter = new internal_1.QueuedIteratorImpl();
        }
        return this.gapIter;
      }
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/internal_mod.js
var require_internal_mod2 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/internal_mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateStreamName = exports2.jserrors = exports2.JetStreamStatusError = exports2.JetStreamStatus = exports2.JetStreamError = exports2.JetStreamApiError = exports2.JetStreamApiCodes = exports2.isMessageNotFound = exports2.ListerImpl = exports2.StoreCompression = exports2.StorageType = exports2.RetentionPolicy = exports2.ReplayPolicy = exports2.PubHeaders = exports2.PersistMode = exports2.DiscardPolicy = exports2.DeliverPolicy = exports2.AckPolicy = exports2.DirectMsgImpl = exports2.BaseApiClientImpl = exports2.toJetStreamClient = exports2.startFastIngest = exports2.jetstreamManager = exports2.JetStreamClientImpl = exports2.jetstream = exports2.RepublishHeaders = exports2.JsHeaders = exports2.isPushConsumer = exports2.isPullConsumer = exports2.isOrderedPushConsumerOptions = exports2.isBoundPushConsumerOptions = exports2.DirectMsgHeaders = exports2.AdvisoryKind = void 0;
    var types_1 = require_types();
    Object.defineProperty(exports2, "AdvisoryKind", { enumerable: true, get: function() {
      return types_1.AdvisoryKind;
    } });
    Object.defineProperty(exports2, "DirectMsgHeaders", { enumerable: true, get: function() {
      return types_1.DirectMsgHeaders;
    } });
    Object.defineProperty(exports2, "isBoundPushConsumerOptions", { enumerable: true, get: function() {
      return types_1.isBoundPushConsumerOptions;
    } });
    Object.defineProperty(exports2, "isOrderedPushConsumerOptions", { enumerable: true, get: function() {
      return types_1.isOrderedPushConsumerOptions;
    } });
    Object.defineProperty(exports2, "isPullConsumer", { enumerable: true, get: function() {
      return types_1.isPullConsumer;
    } });
    Object.defineProperty(exports2, "isPushConsumer", { enumerable: true, get: function() {
      return types_1.isPushConsumer;
    } });
    Object.defineProperty(exports2, "JsHeaders", { enumerable: true, get: function() {
      return types_1.JsHeaders;
    } });
    Object.defineProperty(exports2, "RepublishHeaders", { enumerable: true, get: function() {
      return types_1.RepublishHeaders;
    } });
    var jsclient_1 = require_jsclient();
    Object.defineProperty(exports2, "jetstream", { enumerable: true, get: function() {
      return jsclient_1.jetstream;
    } });
    Object.defineProperty(exports2, "JetStreamClientImpl", { enumerable: true, get: function() {
      return jsclient_1.JetStreamClientImpl;
    } });
    Object.defineProperty(exports2, "jetstreamManager", { enumerable: true, get: function() {
      return jsclient_1.jetstreamManager;
    } });
    Object.defineProperty(exports2, "startFastIngest", { enumerable: true, get: function() {
      return jsclient_1.startFastIngest;
    } });
    Object.defineProperty(exports2, "toJetStreamClient", { enumerable: true, get: function() {
      return jsclient_1.toJetStreamClient;
    } });
    var jsbaseclient_api_1 = require_jsbaseclient_api();
    Object.defineProperty(exports2, "BaseApiClientImpl", { enumerable: true, get: function() {
      return jsbaseclient_api_1.BaseApiClientImpl;
    } });
    var jsm_direct_1 = require_jsm_direct();
    Object.defineProperty(exports2, "DirectMsgImpl", { enumerable: true, get: function() {
      return jsm_direct_1.DirectMsgImpl;
    } });
    var jsapi_types_1 = require_jsapi_types();
    Object.defineProperty(exports2, "AckPolicy", { enumerable: true, get: function() {
      return jsapi_types_1.AckPolicy;
    } });
    Object.defineProperty(exports2, "DeliverPolicy", { enumerable: true, get: function() {
      return jsapi_types_1.DeliverPolicy;
    } });
    Object.defineProperty(exports2, "DiscardPolicy", { enumerable: true, get: function() {
      return jsapi_types_1.DiscardPolicy;
    } });
    Object.defineProperty(exports2, "PersistMode", { enumerable: true, get: function() {
      return jsapi_types_1.PersistMode;
    } });
    Object.defineProperty(exports2, "PubHeaders", { enumerable: true, get: function() {
      return jsapi_types_1.PubHeaders;
    } });
    Object.defineProperty(exports2, "ReplayPolicy", { enumerable: true, get: function() {
      return jsapi_types_1.ReplayPolicy;
    } });
    Object.defineProperty(exports2, "RetentionPolicy", { enumerable: true, get: function() {
      return jsapi_types_1.RetentionPolicy;
    } });
    Object.defineProperty(exports2, "StorageType", { enumerable: true, get: function() {
      return jsapi_types_1.StorageType;
    } });
    Object.defineProperty(exports2, "StoreCompression", { enumerable: true, get: function() {
      return jsapi_types_1.StoreCompression;
    } });
    var jslister_1 = require_jslister();
    Object.defineProperty(exports2, "ListerImpl", { enumerable: true, get: function() {
      return jslister_1.ListerImpl;
    } });
    var jserrors_1 = require_jserrors();
    Object.defineProperty(exports2, "isMessageNotFound", { enumerable: true, get: function() {
      return jserrors_1.isMessageNotFound;
    } });
    Object.defineProperty(exports2, "JetStreamApiCodes", { enumerable: true, get: function() {
      return jserrors_1.JetStreamApiCodes;
    } });
    Object.defineProperty(exports2, "JetStreamApiError", { enumerable: true, get: function() {
      return jserrors_1.JetStreamApiError;
    } });
    Object.defineProperty(exports2, "JetStreamError", { enumerable: true, get: function() {
      return jserrors_1.JetStreamError;
    } });
    Object.defineProperty(exports2, "JetStreamStatus", { enumerable: true, get: function() {
      return jserrors_1.JetStreamStatus;
    } });
    Object.defineProperty(exports2, "JetStreamStatusError", { enumerable: true, get: function() {
      return jserrors_1.JetStreamStatusError;
    } });
    Object.defineProperty(exports2, "jserrors", { enumerable: true, get: function() {
      return jserrors_1.jserrors;
    } });
    var jsutil_1 = require_jsutil();
    Object.defineProperty(exports2, "validateStreamName", { enumerable: true, get: function() {
      return jsutil_1.validateStreamName;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/mod.js
var require_mod4 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.StoreCompression = exports2.StorageType = exports2.RetentionPolicy = exports2.RepublishHeaders = exports2.ReplayPolicy = exports2.PubHeaders = exports2.PersistMode = exports2.JsHeaders = exports2.JetStreamError = exports2.JetStreamApiError = exports2.JetStreamApiCodes = exports2.isPushConsumer = exports2.isPullConsumer = exports2.DiscardPolicy = exports2.DirectMsgHeaders = exports2.DeliverPolicy = exports2.AdvisoryKind = exports2.AckPolicy = exports2.jetstreamManager = exports2.jetstream = void 0;
    var internal_mod_1 = require_internal_mod2();
    Object.defineProperty(exports2, "jetstream", { enumerable: true, get: function() {
      return internal_mod_1.jetstream;
    } });
    Object.defineProperty(exports2, "jetstreamManager", { enumerable: true, get: function() {
      return internal_mod_1.jetstreamManager;
    } });
    var internal_mod_2 = require_internal_mod2();
    Object.defineProperty(exports2, "AckPolicy", { enumerable: true, get: function() {
      return internal_mod_2.AckPolicy;
    } });
    Object.defineProperty(exports2, "AdvisoryKind", { enumerable: true, get: function() {
      return internal_mod_2.AdvisoryKind;
    } });
    Object.defineProperty(exports2, "DeliverPolicy", { enumerable: true, get: function() {
      return internal_mod_2.DeliverPolicy;
    } });
    Object.defineProperty(exports2, "DirectMsgHeaders", { enumerable: true, get: function() {
      return internal_mod_2.DirectMsgHeaders;
    } });
    Object.defineProperty(exports2, "DiscardPolicy", { enumerable: true, get: function() {
      return internal_mod_2.DiscardPolicy;
    } });
    Object.defineProperty(exports2, "isPullConsumer", { enumerable: true, get: function() {
      return internal_mod_2.isPullConsumer;
    } });
    Object.defineProperty(exports2, "isPushConsumer", { enumerable: true, get: function() {
      return internal_mod_2.isPushConsumer;
    } });
    Object.defineProperty(exports2, "JetStreamApiCodes", { enumerable: true, get: function() {
      return internal_mod_2.JetStreamApiCodes;
    } });
    Object.defineProperty(exports2, "JetStreamApiError", { enumerable: true, get: function() {
      return internal_mod_2.JetStreamApiError;
    } });
    Object.defineProperty(exports2, "JetStreamError", { enumerable: true, get: function() {
      return internal_mod_2.JetStreamError;
    } });
    Object.defineProperty(exports2, "JsHeaders", { enumerable: true, get: function() {
      return internal_mod_2.JsHeaders;
    } });
    Object.defineProperty(exports2, "PersistMode", { enumerable: true, get: function() {
      return internal_mod_2.PersistMode;
    } });
    Object.defineProperty(exports2, "PubHeaders", { enumerable: true, get: function() {
      return internal_mod_2.PubHeaders;
    } });
    Object.defineProperty(exports2, "ReplayPolicy", { enumerable: true, get: function() {
      return internal_mod_2.ReplayPolicy;
    } });
    Object.defineProperty(exports2, "RepublishHeaders", { enumerable: true, get: function() {
      return internal_mod_2.RepublishHeaders;
    } });
    Object.defineProperty(exports2, "RetentionPolicy", { enumerable: true, get: function() {
      return internal_mod_2.RetentionPolicy;
    } });
    Object.defineProperty(exports2, "StorageType", { enumerable: true, get: function() {
      return internal_mod_2.StorageType;
    } });
    Object.defineProperty(exports2, "StoreCompression", { enumerable: true, get: function() {
      return internal_mod_2.StoreCompression;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/nats-base-client.js
var require_nats_base_client = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/nats-base-client.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_internal_mod(), exports2);
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/version.js
var require_version3 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/version.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = void 0;
    exports2.version = "3.4.0";
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/node_transport.js
var require_node_transport = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/node_transport.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NodeTransport = exports2.VERSION = void 0;
    exports2.nodeResolveHost = nodeResolveHost;
    var nats_base_client_1 = require_nats_base_client();
    var node_net_1 = require("node:net");
    var node_tls_1 = require("node:tls");
    var node_path_1 = require("node:path");
    var node_fs_1 = require("node:fs");
    var node_dns_1 = __importDefault(require("node:dns"));
    var version_1 = require_version3();
    exports2.VERSION = version_1.version;
    var LANG = "nats.js";
    var NodeTransport = class {
      socket;
      version;
      lang;
      yields = [];
      signal = (0, nats_base_client_1.deferred)();
      closedNotification = (0, nats_base_client_1.deferred)();
      options;
      connected = false;
      tlsName = "";
      done = false;
      closeError;
      constructor() {
        this.lang = LANG;
        this.version = exports2.VERSION;
      }
      async connect(hp, options) {
        this.tlsName = hp.tlsName;
        this.options = options;
        const { tls } = this.options;
        const { handshakeFirst } = tls || {};
        try {
          if (handshakeFirst === true) {
            this.socket = await this.tlsFirst(hp);
          } else {
            this.socket = await this.dial(hp);
          }
          if (this.done) {
            this.socket?.destroy();
          }
          const info = await this.peekInfo();
          (0, nats_base_client_1.checkOptions)(info, options);
          const { tls_required: tlsRequired, tls_available: tlsAvailable } = info;
          const desired = tlsAvailable === true && options.tls !== null;
          if (!handshakeFirst && (tlsRequired || desired)) {
            this.socket = await this.startTLS();
          }
          if (this.done) {
            this.socket?.destroy();
          }
          if (tlsRequired && this.socket.encrypted !== true) {
            throw nats_base_client_1.errors.InvalidArgumentError.format("tls", "is not available on this server");
          }
          this.connected = true;
          this.setupHandlers();
          this.signal.resolve();
          return Promise.resolve();
        } catch (ex) {
          let err = ex;
          if (!err) {
            err = new nats_base_client_1.errors.ConnectionError("error connecting - node provided an undefined error");
          }
          const { code } = err;
          const perr = code === "ECONNREFUSED" ? new nats_base_client_1.errors.ConnectionError("connection refused", { cause: err }) : err;
          this.socket?.destroy();
          throw perr;
        }
      }
      dial(hp) {
        const d = (0, nats_base_client_1.deferred)();
        let dialError;
        const socket = (0, node_net_1.createConnection)(hp.port, hp.hostname, () => {
          d.resolve(socket);
          socket.removeAllListeners();
        });
        socket.on("error", (err) => {
          dialError = err;
        });
        socket.on("close", () => {
          socket.removeAllListeners();
          d.reject(dialError);
        });
        socket.setNoDelay(true);
        return d;
      }
      get isClosed() {
        return this.done;
      }
      close(err) {
        return this._closed(err, false);
      }
      peekInfo() {
        const d = (0, nats_base_client_1.deferred)();
        let peekError;
        this.socket.on("data", (frame) => {
          this.yields.push(frame);
          const t = nats_base_client_1.DataBuffer.concat(...this.yields);
          const pm = (0, nats_base_client_1.extractProtocolMessage)(t);
          if (pm !== "") {
            try {
              const m = nats_base_client_1.INFO.exec(pm);
              if (!m) {
                throw new Error("unexpected response from server");
              }
              const info = JSON.parse(m[1]);
              d.resolve(info);
            } catch (err) {
              d.reject(err);
            } finally {
              this.socket.removeAllListeners();
            }
          }
        });
        this.socket.on("error", (err) => {
          peekError = err;
        });
        this.socket.on("close", () => {
          this.socket.removeAllListeners();
          d.reject(peekError);
        });
        return d;
      }
      loadFile(fn) {
        if (!fn) {
          return Promise.resolve();
        }
        const d = (0, nats_base_client_1.deferred)();
        try {
          fn = (0, node_path_1.resolve)(fn);
          if (!(0, node_fs_1.existsSync)(fn)) {
            d.reject(new Error(`${fn} doesn't exist`));
          }
          (0, node_fs_1.readFile)(fn, (err, data) => {
            if (err) {
              return d.reject(err);
            }
            d.resolve(data);
          });
        } catch (err) {
          d.reject(err);
        }
        return d;
      }
      async loadClientCerts() {
        const tlsOpts = {};
        const { certFile, cert, caFile, ca, keyFile, key } = this.options.tls;
        try {
          if (certFile) {
            const data = await this.loadFile(certFile);
            if (data) {
              tlsOpts.cert = data;
            }
          } else if (cert) {
            tlsOpts.cert = cert;
          }
          if (keyFile) {
            const data = await this.loadFile(keyFile);
            if (data) {
              tlsOpts.key = data;
            }
          } else if (key) {
            tlsOpts.key = key;
          }
          if (caFile) {
            const data = await this.loadFile(caFile);
            if (data) {
              tlsOpts.ca = [data];
            }
          } else if (ca) {
            tlsOpts.ca = ca;
          }
          return Promise.resolve(tlsOpts);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      async tlsFirst(hp) {
        let tlsError;
        let tlsOpts = {
          servername: this.tlsName,
          rejectUnauthorized: true
        };
        if (this.socket) {
          tlsOpts.socket = this.socket;
        }
        if (typeof this.options.tls === "object") {
          try {
            const certOpts = await this.loadClientCerts() || {};
            tlsOpts = (0, nats_base_client_1.extend)(tlsOpts, this.options.tls, certOpts);
          } catch (err) {
            return Promise.reject(new nats_base_client_1.errors.ConnectionError(err.message, { cause: err }));
          }
        }
        const d = (0, nats_base_client_1.deferred)();
        try {
          const tlsSocket = (0, node_tls_1.connect)(hp.port, hp.hostname, tlsOpts, () => {
            tlsSocket.removeAllListeners();
            d.resolve(tlsSocket);
          });
          tlsSocket.on("error", (err) => {
            tlsError = err;
          });
          tlsSocket.on("secureConnect", () => {
            if (tlsOpts.rejectUnauthorized === false) {
              return;
            }
            if (!tlsSocket.authorized) {
              throw tlsSocket.authorizationError;
            }
          });
          tlsSocket.on("close", () => {
            d.reject(tlsError);
            tlsSocket.removeAllListeners();
          });
          tlsSocket.setNoDelay(true);
        } catch (err) {
          d.reject(new nats_base_client_1.errors.ConnectionError(err.message, { cause: err }));
        }
        return d;
      }
      async startTLS() {
        let tlsError;
        let tlsOpts = {
          socket: this.socket,
          servername: this.tlsName,
          rejectUnauthorized: true
        };
        if (typeof this.options.tls === "object") {
          try {
            const certOpts = await this.loadClientCerts() || {};
            tlsOpts = (0, nats_base_client_1.extend)(tlsOpts, this.options.tls, certOpts);
          } catch (err) {
            return Promise.reject(new nats_base_client_1.errors.ConnectionError(err.message, {
              cause: err
            }));
          }
        }
        const d = (0, nats_base_client_1.deferred)();
        try {
          const tlsSocket = (0, node_tls_1.connect)(tlsOpts, () => {
            tlsSocket.removeAllListeners();
            d.resolve(tlsSocket);
          });
          tlsSocket.on("error", (err) => {
            tlsError = err;
          });
          tlsSocket.on("secureConnect", () => {
            if (tlsOpts.rejectUnauthorized === false) {
              return;
            }
            if (!tlsSocket.authorized) {
              throw tlsSocket.authorizationError;
            }
          });
          tlsSocket.on("close", () => {
            d.reject(tlsError);
            tlsSocket.removeAllListeners();
          });
        } catch (err) {
          d.reject(new nats_base_client_1.errors.ConnectionError(err.message, { cause: err }));
        }
        return d;
      }
      setupHandlers() {
        let connError;
        this.socket.on("data", (frame) => {
          this.yields.push(frame);
          return this.signal.resolve();
        });
        this.socket.on("error", (err) => {
          connError = err;
        });
        this.socket.on("end", () => {
          if (this.socket?.destroyed) {
            return;
          }
          this.socket?.write(new Uint8Array(0), () => {
            this.socket?.end();
          });
        });
        this.socket.on("close", () => {
          this._closed(connError, false);
        });
      }
      [Symbol.asyncIterator]() {
        return this.iterate();
      }
      async *iterate() {
        while (true) {
          if (this.yields.length === 0) {
            await this.signal;
          }
          const yields = this.yields;
          this.yields = [];
          for (let i = 0; i < yields.length; i++) {
            if (this.options.debug) {
              console.info(`> ${(0, nats_base_client_1.render)(yields[i])}`);
            }
            yield yields[i];
          }
          if (this.done) {
            break;
          } else if (this.yields.length === 0) {
            yields.length = 0;
            this.yields = yields;
            this.signal = (0, nats_base_client_1.deferred)();
          }
        }
      }
      discard() {
        this.done = true;
        if (this.socket) {
          try {
            this.socket.removeAllListeners();
            this.socket.destroy();
          } catch {
          }
        }
      }
      disconnect() {
        this._closed(void 0, true).then().catch();
      }
      isEncrypted() {
        return this.socket instanceof node_tls_1.TLSSocket;
      }
      _send(frame) {
        if (this.isClosed || this.socket === void 0) {
          return Promise.resolve();
        }
        if (this.options.debug) {
          console.info(`< ${(0, nats_base_client_1.render)(frame)}`);
        }
        const d = (0, nats_base_client_1.deferred)();
        try {
          this.socket.write(frame, (err) => {
            if (err) {
              if (this.options.debug) {
                console.error(`!!! ${(0, nats_base_client_1.render)(frame)}: ${err}`);
              }
              return d.reject(err);
            }
            return d.resolve();
          });
        } catch (err) {
          if (this.options.debug) {
            console.error(`!!! ${(0, nats_base_client_1.render)(frame)}: ${err}`);
          }
          d.reject(err);
        }
        return d;
      }
      send(frame) {
        const p = this._send(frame);
        p.catch((_err) => {
        });
      }
      async _closed(err, internal = true) {
        if (!this.connected)
          return;
        if (this.done) {
          this.socket?.destroy();
          return;
        }
        this.closeError = err;
        if (!err && this.socket && internal) {
          try {
            await this._send(new TextEncoder().encode(""));
          } catch (err2) {
            if (this.options.debug) {
              console.log("transport close terminated with an error", err2);
            }
          }
        }
        try {
          if (this.socket) {
            this.socket.removeAllListeners();
            this.socket?.destroy();
            this.socket = void 0;
          }
        } catch (err2) {
          console.log(err2);
        }
        this.done = true;
        this.closedNotification.resolve(this.closeError);
      }
      closed() {
        return this.closedNotification;
      }
    };
    exports2.NodeTransport = NodeTransport;
    function nodeResolveHost(s) {
      const ips = (0, nats_base_client_1.deferred)();
      node_dns_1.default.lookup(
        s,
        { all: true },
        //@ts-ignore: callback changes shape when all is true
        (err, address) => {
          if (err) {
            ips.reject(err);
            return;
          }
          const buf = [];
          for (const r of address) {
            buf.push(r.address);
          }
          if (buf.length === 0) {
            buf.push(s);
          }
          ips.resolve(buf);
        }
      );
      return ips;
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/connect.js
var require_connect = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/connect.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.connect = connect8;
    var node_transport_1 = require_node_transport();
    var nats_base_client_1 = require_nats_base_client();
    var nats_base_client_2 = require_nats_base_client();
    function connect8(opts = {}) {
      if ((0, nats_base_client_2.hasWsProtocol)(opts)) {
        return Promise.reject(nats_base_client_2.errors.InvalidArgumentError.format(`servers`, `node client doesn't support websockets, use the 'wsconnect' function instead`));
      }
      (0, nats_base_client_1.setTransportFactory)({
        factory: () => {
          return new node_transport_1.NodeTransport();
        },
        dnsResolveFn: node_transport_1.nodeResolveHost
      });
      return nats_base_client_1.NatsConnectionImpl.connect(opts);
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/mod.js
var require_mod5 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/lib/mod.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.connect = void 0;
    var connect_1 = require_connect();
    Object.defineProperty(exports2, "connect", { enumerable: true, get: function() {
      return connect_1.connect;
    } });
    __exportStar(require_nats_base_client(), exports2);
  }
});

// ../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/index.js
var require_transport_node = __commonJS({
  "../../node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_mod5();
  }
});

// ../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/types.js
var require_types3 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.kvPrefix = exports2.KvWatchInclude = void 0;
    exports2.KvWatchInclude = {
      /**
       * Include the last value for all the keys
       */
      LastValue: "",
      /**
       * Include all available history for all keys
       */
      AllHistory: "history",
      /**
       * Don't include history or last values, only notify
       * of updates
       */
      UpdatesOnly: "updates"
    };
    exports2.kvPrefix = "KV_";
  }
});

// ../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/kv.js
var require_kv = __commonJS({
  "../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/kv.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.KvStatusImpl = exports2.Bucket = exports2.Kvm = exports2.kvOperationHdr = void 0;
    exports2.Base64KeyCodec = Base64KeyCodec;
    exports2.NoopKvCodecs = NoopKvCodecs;
    exports2.defaultBucketOpts = defaultBucketOpts;
    exports2.validateKey = validateKey;
    exports2.validateSearchKey = validateSearchKey;
    exports2.hasWildcards = hasWildcards;
    exports2.validateBucket = validateBucket;
    var internal_1 = require_internal_mod();
    var internal_2 = require_internal_mod2();
    var types_1 = require_types3();
    function Base64KeyCodec() {
      const fn = (key, codec) => {
        const chunks = [];
        for (const t of key.split(".")) {
          switch (t) {
            case ">":
            case "*":
              chunks.push(t);
              break;
            default:
              chunks.push(codec(t));
              break;
          }
        }
        return chunks.join(".");
      };
      return {
        encode(key) {
          return fn(key, btoa);
        },
        decode(bkey) {
          return fn(bkey, atob);
        }
      };
    }
    function NoopKvCodecs() {
      return {
        key: {
          encode(k) {
            return k;
          },
          decode(k) {
            return k;
          }
        },
        value: {
          encode(v) {
            return typeof v === "string" ? new TextEncoder().encode(v) : v;
          },
          decode(v) {
            return v;
          }
        }
      };
    }
    function defaultBucketOpts() {
      return {
        replicas: 1,
        history: 1,
        timeout: 2e3,
        max_bytes: -1,
        maxValueSize: -1,
        codec: NoopKvCodecs(),
        storage: internal_2.StorageType.File
      };
    }
    exports2.kvOperationHdr = "KV-Operation";
    var kvSubjectPrefix = "$KV";
    var validKeyRe = /^[-/=.\w]+$/;
    var validSearchKey = /^[-/=.>*\w]+$/;
    var validBucketRe = /^[-\w]+$/;
    function validateKey(k) {
      if (k.startsWith(".") || k.endsWith(".") || !validKeyRe.test(k)) {
        throw new Error(`invalid key: ${k}`);
      }
    }
    function validateSearchKey(k) {
      if (k.startsWith(".") || k.endsWith(".") || k.includes("..") || !validSearchKey.test(k)) {
        throw new Error(`invalid key: ${k}`);
      }
    }
    function hasWildcards(k) {
      if (k.startsWith(".") || k.endsWith(".")) {
        throw new Error(`invalid key: ${k}`);
      }
      const chunks = k.split(".");
      let hasWildcards2 = false;
      for (let i = 0; i < chunks.length; i++) {
        switch (chunks[i]) {
          case "*":
            hasWildcards2 = true;
            break;
          case ">":
            if (i !== chunks.length - 1) {
              throw new Error(`invalid key: ${k}`);
            }
            hasWildcards2 = true;
            break;
          default:
        }
      }
      return hasWildcards2;
    }
    function validateBucket(name) {
      if (!validBucketRe.test(name)) {
        throw new Error(`invalid bucket name: ${name}`);
      }
    }
    var Kvm11 = class {
      js;
      /**
       * Creates an instance of the Kv that allows you to create and access KV stores.
       * Note that if the argument is a NatsConnection, default JetStream Options are
       * used. If you want to set some options, please provide a JetStreamClient instead.
       * @param nc
       */
      constructor(nc) {
        this.js = (0, internal_2.toJetStreamClient)(nc);
      }
      /**
       * Creates and opens the specified KV. If the KV already exists, it opens the existing KV.
       * @param name
       * @param opts
       */
      create(name, opts = {}) {
        return this.#maybeCreate(name, opts);
      }
      /**
       * Open to the specified KV. If the KV doesn't exist, this API will fail on accessing
       * the KV.
       * @param name
       * @param opts
       */
      open(name, opts = {}) {
        opts.bindOnly = true;
        return this.#maybeCreate(name, opts);
      }
      #maybeCreate(name, opts = {}) {
        const { ok, min } = this.js.nc.features.get(internal_1.Feature.JS_KV);
        if (!ok) {
          return Promise.reject(new Error(`kv is only supported on servers ${min} or better`));
        }
        if (opts.bindOnly) {
          return Bucket3.bind(this.js, name, opts);
        }
        return Bucket3.create(this.js, name, opts);
      }
      /**
       * Lists all available KVs
       */
      list() {
        const filter = (v) => {
          const slr = v;
          const kvStreams = slr.streams.filter((v2) => {
            return v2.config.name.startsWith(types_1.kvPrefix);
          });
          kvStreams.forEach((si) => {
            si.config.sealed = si.config.sealed || false;
            si.config.deny_delete = si.config.deny_delete || false;
            si.config.deny_purge = si.config.deny_purge || false;
            si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
          });
          let cluster = "";
          if (kvStreams.length) {
            cluster = this.js.nc.info?.cluster ?? "";
          }
          return kvStreams.map((si) => {
            return new KvStatusImpl(si, cluster);
          });
        };
        const subj = `${this.js.prefix}.STREAM.LIST`;
        return new internal_2.ListerImpl(subj, filter, this.js);
      }
    };
    exports2.Kvm = Kvm11;
    var Bucket3 = class _Bucket {
      js;
      jsm;
      stream;
      bucket;
      direct;
      codec;
      prefix;
      editPrefix;
      useJsPrefix;
      _prefixLen;
      constructor(bucket, js, jsm) {
        validateBucket(bucket);
        this.js = js;
        this.jsm = jsm;
        this.bucket = bucket;
        this.prefix = kvSubjectPrefix;
        this.editPrefix = "";
        this.useJsPrefix = false;
        this._prefixLen = 0;
      }
      static async create(js, name, opts = {}) {
        validateBucket(name);
        const jsm = await js.jetstreamManager();
        const bucket = new _Bucket(name, js, jsm);
        await bucket.init(opts);
        return bucket;
      }
      static async bind(js, name, opts = {}) {
        const checkAPI = js.getOptions()?.checkAPI || opts.bindOnly === false;
        const jsm = await js.jetstreamManager(checkAPI);
        const info = {
          config: {
            allow_direct: opts.allow_direct
          }
        };
        validateBucket(name);
        const bucket = new _Bucket(name, js, jsm);
        info.config.name = opts.streamName ?? bucket.bucketName();
        Object.assign(bucket, info);
        bucket.stream = info.config.name;
        bucket.codec = opts.codec || NoopKvCodecs();
        bucket.direct = info.config.allow_direct ?? false;
        bucket.initializePrefixes(info);
        return bucket;
      }
      async init(opts = {}) {
        const bo = Object.assign(defaultBucketOpts(), opts);
        this.codec = bo.codec;
        const sc = {};
        this.stream = sc.name = opts.streamName ?? this.bucketName();
        sc.retention = internal_2.RetentionPolicy.Limits;
        sc.max_msgs_per_subject = bo.history;
        if (bo.max_bytes) {
          sc.max_bytes = bo.max_bytes;
        }
        sc.max_msg_size = bo.maxValueSize;
        sc.storage = bo.storage;
        if (opts.placement) {
          sc.placement = opts.placement;
        }
        if (opts.republish) {
          sc.republish = opts.republish;
        }
        if (opts.description) {
          sc.description = opts.description;
        }
        if (opts.markerTTL) {
          sc.allow_msg_ttl = true;
          sc.subject_delete_marker_ttl = (0, internal_1.nanos)(bo.markerTTL);
        }
        if (opts.mirror) {
          const mirror = Object.assign({}, opts.mirror);
          if (!mirror.name.startsWith(types_1.kvPrefix)) {
            mirror.name = `${types_1.kvPrefix}${mirror.name}`;
          }
          sc.mirror = mirror;
          sc.mirror_direct = true;
        } else if (opts.sources) {
          const sources = opts.sources.map((s) => {
            const c = Object.assign({}, s);
            const srcBucketName = c.name.startsWith(types_1.kvPrefix) ? c.name.substring(types_1.kvPrefix.length) : c.name;
            if (!c.name.startsWith(types_1.kvPrefix)) {
              c.name = `${types_1.kvPrefix}${c.name}`;
            }
            if (!s.external && srcBucketName !== this.bucket) {
              c.subject_transforms = [
                { src: `$KV.${srcBucketName}.>`, dest: `$KV.${this.bucket}.>` }
              ];
            }
            return c;
          });
          sc.sources = sources;
          sc.subjects = [this.subjectForBucket()];
        } else {
          sc.subjects = [this.subjectForBucket()];
        }
        if (opts.metadata) {
          sc.metadata = opts.metadata;
        }
        if (typeof opts.compression === "boolean") {
          sc.compression = opts.compression ? internal_2.StoreCompression.S2 : internal_2.StoreCompression.None;
        }
        const nci = this.js.nc;
        const have = nci.getServerVersion();
        const discardNew = have ? (0, internal_1.compare)(have, (0, internal_1.parseSemVer)("2.7.2")) >= 0 : false;
        sc.discard = discardNew ? internal_2.DiscardPolicy.New : internal_2.DiscardPolicy.Old;
        const { ok: direct, min } = nci.features.get(internal_1.Feature.JS_ALLOW_DIRECT);
        if (!direct && opts.allow_direct === true) {
          const v = have ? `${have.major}.${have.minor}.${have.micro}` : "unknown";
          return Promise.reject(new Error(`allow_direct is not available on server version ${v} - requires ${min}`));
        }
        opts.allow_direct = typeof opts.allow_direct === "boolean" ? opts.allow_direct : direct;
        sc.allow_direct = opts.allow_direct;
        this.direct = sc.allow_direct;
        sc.num_replicas = bo.replicas;
        if (bo.ttl) {
          sc.max_age = (0, internal_1.nanos)(bo.ttl);
        }
        sc.allow_rollup_hdrs = true;
        let info;
        try {
          info = await this.jsm.streams.info(sc.name);
          if (!info.config.allow_direct && this.direct === true) {
            this.direct = false;
          }
        } catch (err) {
          if (err.message === "stream not found") {
            info = await this.jsm.streams.add(sc);
          } else {
            throw err;
          }
        }
        this.initializePrefixes(info);
      }
      initializePrefixes(info) {
        this._prefixLen = 0;
        this.prefix = `$KV.${this.bucket}`;
        this.useJsPrefix = this.js.apiPrefix !== "$JS.API";
        const { mirror } = info.config;
        if (mirror) {
          let n = mirror.name;
          if (n.startsWith(types_1.kvPrefix)) {
            n = n.substring(types_1.kvPrefix.length);
          }
          if (mirror.external && mirror.external.api !== "") {
            const mb = mirror.name.substring(types_1.kvPrefix.length);
            this.useJsPrefix = false;
            this.prefix = `$KV.${mb}`;
            this.editPrefix = `${mirror.external.api}.$KV.${n}`;
          } else {
            this.editPrefix = this.prefix;
          }
        }
      }
      bucketName() {
        return this.stream ?? `${types_1.kvPrefix}${this.bucket}`;
      }
      subjectForBucket() {
        return `${this.prefix}.${this.bucket}.>`;
      }
      subjectForKey(k, edit = false) {
        const builder = [];
        if (edit) {
          if (this.useJsPrefix) {
            builder.push(this.js.apiPrefix);
          }
          if (this.editPrefix !== "") {
            builder.push(this.editPrefix);
          } else {
            builder.push(this.prefix);
          }
        } else {
          if (this.prefix) {
            builder.push(this.prefix);
          }
        }
        builder.push(k);
        return builder.join(".");
      }
      fullKeyName(k) {
        if (this.prefix !== "") {
          return `${this.prefix}.${k}`;
        }
        return `${kvSubjectPrefix}.${this.bucket}.${k}`;
      }
      get prefixLen() {
        if (this._prefixLen === 0) {
          this._prefixLen = this.prefix.length + 1;
        }
        return this._prefixLen;
      }
      encodeKey(key) {
        const chunks = [];
        for (const t of key.split(".")) {
          switch (t) {
            case ">":
            case "*":
              chunks.push(t);
              break;
            default:
              chunks.push(this.codec.key.encode(t));
              break;
          }
        }
        return chunks.join(".");
      }
      decodeKey(ekey) {
        const chunks = [];
        for (const t of ekey.split(".")) {
          switch (t) {
            case ">":
            case "*":
              chunks.push(t);
              break;
            default:
              chunks.push(this.codec.key.decode(t));
              break;
          }
        }
        return chunks.join(".");
      }
      validateKey = validateKey;
      validateSearchKey = validateSearchKey;
      hasWildcards = hasWildcards;
      close() {
        return Promise.resolve();
      }
      dataLen(data, h) {
        const slen = h ? h.get(internal_2.JsHeaders.MessageSizeHdr) || "" : "";
        if (slen !== "") {
          return parseInt(slen, 10);
        }
        return data.length;
      }
      smToEntry(sm) {
        return new KvStoredEntryImpl(this.bucket, this.prefixLen, sm, this.codec);
      }
      jmToWatchEntry(jm, isUpdate) {
        return new KvJsMsgEntryImpl(this.bucket, this.prefixLen, jm, isUpdate, this.codec);
      }
      async create(k, data, markerTTL) {
        let firstErr;
        try {
          const opts = { previousSeq: 0 };
          const n = await this._put(k, data, opts, markerTTL);
          return Promise.resolve(n);
        } catch (err) {
          firstErr = err;
          if (err instanceof internal_2.JetStreamApiError) {
            const jserr = err;
            if (jserr.code !== internal_2.JetStreamApiCodes.StreamWrongLastSequence && jserr.code !== internal_2.JetStreamApiCodes.StreamWrongLastSequenceUnknown) {
              return Promise.reject(err);
            }
          }
        }
        let rev = 0;
        try {
          const e = await this.get(k);
          if (e?.operation === "DEL" || e?.operation === "PURGE") {
            rev = e !== null ? e.revision : 0;
            return this._put(k, data, { previousSeq: rev }, markerTTL);
          } else {
            return Promise.reject(firstErr);
          }
        } catch (err) {
          return Promise.reject(err);
        }
      }
      update(k, data, version, timeout) {
        if (version <= 0) {
          throw new Error("version must be greater than 0");
        }
        return this.put(k, data, { previousSeq: version, timeout });
      }
      async _put(k, data, opts = {}, markerTTL) {
        const ek = this.encodeKey(k);
        this.validateKey(ek);
        data = this.codec.value.encode(data);
        const o = { timeout: opts?.timeout };
        if (opts.previousSeq !== void 0) {
          const h = (0, internal_1.headers)();
          o.headers = h;
          h.set(internal_2.PubHeaders.ExpectedLastSubjectSequenceHdr, `${opts.previousSeq}`);
        }
        if (markerTTL) {
          const h = o.headers || (0, internal_1.headers)();
          h.set(internal_2.PubHeaders.MessageTTL, markerTTL);
        }
        try {
          const pa = await this.js.publish(this.subjectForKey(ek, true), data, o);
          return pa.seq;
        } catch (err) {
          return Promise.reject(err);
        }
      }
      put(k, data, opts = {}) {
        return this._put(k, data, opts);
      }
      async get(k, opts) {
        const ek = this.encodeKey(k);
        this.validateKey(ek);
        let arg = { last_by_subj: this.subjectForKey(ek) };
        if (opts && opts.revision > 0) {
          arg = { seq: opts.revision };
        }
        let sm = null;
        try {
          if (this.direct) {
            const direct = this.jsm.direct;
            sm = await direct.getMessage(this.bucketName(), arg);
          } else {
            sm = await this.jsm.streams.getMessage(this.bucketName(), arg);
          }
          if (sm === null) {
            return null;
          }
          const ke = this.smToEntry(sm);
          if (ke.rawKey !== ek) {
            return null;
          }
          return ke;
        } catch (err) {
          throw err;
        }
      }
      purge(k, opts) {
        return this._deleteOrPurge(k, "PURGE", opts);
      }
      delete(k, opts) {
        return this._deleteOrPurge(k, "DEL", opts);
      }
      async purgeDeletes(olderMillis = 30 * 60 * 1e3) {
        const buf = [];
        const i = await this.history({
          key: ">"
        });
        await (async () => {
          for await (const e of i) {
            if (e.operation === "DEL" || e.operation === "PURGE") {
              buf.push(e);
            }
          }
        })().then();
        i.stop();
        const min = Date.now() - olderMillis;
        const proms = buf.map((e) => {
          const subj = this.subjectForKey(e.key);
          if (e.created.getTime() >= min) {
            return this.jsm.streams.purge(this.stream, { filter: subj, keep: 1 });
          } else {
            return this.jsm.streams.purge(this.stream, { filter: subj, keep: 0 });
          }
        });
        const purged = await Promise.all(proms);
        purged.unshift({ success: true, purged: 0 });
        return purged.reduce((pv, cv) => {
          pv.purged += cv.purged;
          return pv;
        });
      }
      async _deleteOrPurge(k, op, opts) {
        if (!this.hasWildcards(k)) {
          return this._doDeleteOrPurge(k, op, opts);
        }
        const iter = await this.keys(k);
        const buf = [];
        for await (const k2 of iter) {
          buf.push(this._doDeleteOrPurge(k2, op));
          if (buf.length === 100) {
            await Promise.all(buf);
            buf.length = 0;
          }
        }
        if (buf.length > 0) {
          await Promise.all(buf);
        }
      }
      async _doDeleteOrPurge(k, op, opts) {
        const ek = this.encodeKey(k);
        this.validateKey(ek);
        const h = (0, internal_1.headers)();
        h.set(exports2.kvOperationHdr, op);
        if (op === "PURGE") {
          const popts = opts;
          h.set(internal_2.JsHeaders.RollupHdr, internal_2.JsHeaders.RollupValueSubject);
          if (typeof popts?.ttl === "string" && popts.ttl !== "") {
            h.set(internal_2.PubHeaders.MessageTTL, `${popts.ttl}`);
          }
        }
        if (opts?.previousSeq) {
          h.set(internal_2.PubHeaders.ExpectedLastSubjectSequenceHdr, `${opts.previousSeq}`);
        }
        await this.js.publish(this.subjectForKey(ek, true), internal_1.Empty, { headers: h });
      }
      _buildCC(k, content, opts = {}) {
        const a = !Array.isArray(k) ? [k] : k;
        let filter_subjects = a.map((k2) => {
          const ek = this.encodeKey(k2);
          this.validateSearchKey(k2);
          return this.fullKeyName(ek);
        });
        let deliver_policy = internal_2.DeliverPolicy.LastPerSubject;
        if (content === types_1.KvWatchInclude.AllHistory) {
          deliver_policy = internal_2.DeliverPolicy.All;
        }
        if (content === types_1.KvWatchInclude.UpdatesOnly) {
          deliver_policy = internal_2.DeliverPolicy.New;
        }
        let filter_subject = void 0;
        if (filter_subjects.length === 1) {
          filter_subject = filter_subjects[0];
          filter_subjects = void 0;
        }
        return Object.assign({
          deliver_policy,
          "ack_policy": internal_2.AckPolicy.None,
          filter_subjects,
          filter_subject,
          "flow_control": true,
          "idle_heartbeat": (0, internal_1.nanos)(5 * 1e3)
        }, opts);
      }
      remove(k) {
        return this.purge(k);
      }
      async history(opts = {}) {
        const k = opts.key ?? ">";
        const co = {};
        co.headers_only = opts.headers_only || false;
        const qi = new internal_1.QueuedIteratorImpl();
        const fn = () => {
          qi.stop();
        };
        const cc = this._buildCC(k, types_1.KvWatchInclude.AllHistory, co);
        const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
        qi._data = oc;
        const info = await oc.info(true);
        if (info.num_pending === 0) {
          qi.push(fn);
          return qi;
        }
        const iter = await oc.consume({
          callback: (m) => {
            const e = this.jmToWatchEntry(m, false);
            qi.push(e);
            qi.received++;
            if (m.info.pending === 0) {
              qi.push(fn);
            }
          }
        });
        iter.closed().then(() => {
          qi.push(fn);
        });
        (async () => {
          for await (const s of iter.status()) {
            switch (s.type) {
              // if we get a heartbeat we got all the keys
              case "heartbeat":
                qi.push(() => {
                  qi.stop();
                });
                break;
            }
          }
        })().then();
        qi.iterClosed.then(() => {
          iter.stop();
        });
        return qi;
      }
      canSetWatcherName() {
        const nci = this.js.nc;
        const { ok } = nci.features.get(internal_1.Feature.JS_NEW_CONSUMER_CREATE_API);
        return ok;
      }
      async watch(opts = {}) {
        const k = opts.key ?? ">";
        const qi = new internal_1.QueuedIteratorImpl();
        const co = {};
        co.headers_only = opts.headers_only || false;
        let content = types_1.KvWatchInclude.LastValue;
        if (opts.include === types_1.KvWatchInclude.AllHistory) {
          content = types_1.KvWatchInclude.AllHistory;
        } else if (opts.include === types_1.KvWatchInclude.UpdatesOnly) {
          content = types_1.KvWatchInclude.UpdatesOnly;
        }
        const ignoreDeletes = opts.ignoreDeletes === true;
        const cc = this._buildCC(k, content, co);
        cc.name = `KV_WATCHER_${internal_1.nuid.next()}`;
        if (opts.resumeFromRevision && opts.resumeFromRevision > 0) {
          cc.deliver_policy = internal_2.DeliverPolicy.StartSequence;
          cc.opt_start_seq = opts.resumeFromRevision;
        }
        const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
        const info = await oc.info(true);
        const count = info.num_pending;
        let isUpdate = content === types_1.KvWatchInclude.UpdatesOnly || count === 0;
        qi._data = oc;
        let i = 0;
        const iter = await oc.consume({
          callback: (m) => {
            if (!isUpdate) {
              i++;
              isUpdate = i >= count;
            }
            const e = this.jmToWatchEntry(m, isUpdate);
            if (ignoreDeletes && e.operation === "DEL") {
              return;
            }
            qi.push(e);
            qi.received++;
          }
        });
        qi.iterClosed.then(() => {
          iter.stop();
        });
        iter.closed().then(() => {
          qi.push(() => {
            qi.stop();
          });
        });
        return qi;
      }
      async keys(k = ">") {
        const keys = new internal_1.QueuedIteratorImpl();
        const cc = this._buildCC(k, types_1.KvWatchInclude.LastValue, {
          headers_only: true
        });
        const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
        const info = await oc.info();
        if (info.num_pending === 0) {
          keys.stop();
          return keys;
        }
        keys._data = oc;
        const iter = await oc.consume({
          callback: (m) => {
            const op = m.headers?.get(exports2.kvOperationHdr);
            if (op !== "DEL" && op !== "PURGE") {
              const key = this.decodeKey(m.subject.substring(this.prefixLen));
              keys.push(key);
            }
            if (m.info.pending === 0) {
              iter.stop();
            }
          }
        });
        (async () => {
          for await (const s of iter.status()) {
            switch (s.type) {
              // if we get a heartbeat we got all the keys
              case "heartbeat":
                keys.push(() => {
                  keys.stop();
                });
                break;
            }
          }
        })().then();
        iter.closed().then(() => {
          keys.push(() => {
            keys.stop();
          });
        });
        keys.iterClosed.then(() => {
          iter.stop();
        });
        return keys;
      }
      purgeBucket(opts) {
        return this.jsm.streams.purge(this.bucketName(), opts);
      }
      destroy() {
        return this.jsm.streams.delete(this.bucketName());
      }
      async status() {
        const nc = this.js.nc;
        const cluster = nc.info?.cluster ?? "";
        const bn = this.bucketName();
        const si = await this.jsm.streams.info(bn);
        return new KvStatusImpl(si, cluster);
      }
    };
    exports2.Bucket = Bucket3;
    var KvStatusImpl = class {
      si;
      cluster;
      constructor(si, cluster = "") {
        this.si = si;
        this.cluster = cluster;
      }
      get bucket() {
        return this.si.config.name.startsWith(types_1.kvPrefix) ? this.si.config.name.substring(types_1.kvPrefix.length) : this.si.config.name;
      }
      get values() {
        return this.si.state.messages;
      }
      get history() {
        return this.si.config.max_msgs_per_subject;
      }
      get ttl() {
        return (0, internal_1.millis)(this.si.config.max_age);
      }
      get markerTTL() {
        if (typeof this.si.config.subject_delete_marker_ttl === "number") {
          return (0, internal_1.millis)(this.si.config.subject_delete_marker_ttl);
        }
        return 0;
      }
      get bucket_location() {
        return this.cluster;
      }
      get backingStore() {
        return this.si.config.storage;
      }
      get storage() {
        return this.si.config.storage;
      }
      get replicas() {
        return this.si.config.num_replicas;
      }
      get description() {
        return this.si.config.description ?? "";
      }
      get maxBucketSize() {
        return this.si.config.max_bytes;
      }
      get maxValueSize() {
        return this.si.config.max_msg_size;
      }
      get max_bytes() {
        return this.si.config.max_bytes;
      }
      get placement() {
        return this.si.config.placement || { cluster: "", tags: [] };
      }
      get placementCluster() {
        return this.si.config.placement?.cluster ?? "";
      }
      get republish() {
        return this.si.config.republish ?? { src: "", dest: "" };
      }
      get streamInfo() {
        return this.si;
      }
      get size() {
        return this.si.state.bytes;
      }
      get metadata() {
        return this.si.config.metadata ?? {};
      }
      get compression() {
        if (this.si.config.compression) {
          return this.si.config.compression !== internal_2.StoreCompression.None;
        }
        return false;
      }
    };
    exports2.KvStatusImpl = KvStatusImpl;
    var KvStoredEntryImpl = class {
      bucket;
      sm;
      prefixLen;
      codec;
      constructor(bucket, prefixLen, sm, codec) {
        this.bucket = bucket;
        this.prefixLen = prefixLen;
        this.sm = sm;
        this.codec = codec;
      }
      get rawKey() {
        return this.sm.subject.substring(this.prefixLen);
      }
      get key() {
        return this.codec.key.decode(this.rawKey);
      }
      get value() {
        return this.codec.value.decode(this.sm.data);
      }
      get delta() {
        return 0;
      }
      get created() {
        return this.sm.time;
      }
      get revision() {
        return this.sm.seq;
      }
      get operation() {
        if (this.sm.header?.has("Nats-Marker-Reason")) {
          const op = this.sm.header?.get("Nats-Marker-Reason");
          if (op === "MaxAge") {
            return "PURGE";
          }
        }
        return this.sm.header?.get(exports2.kvOperationHdr) || "PUT";
      }
      get length() {
        const slen = this.sm.header.get(internal_2.JsHeaders.MessageSizeHdr) || "";
        if (slen !== "") {
          return parseInt(slen, 10);
        }
        return this.sm.data.length;
      }
      json(reviver) {
        return JSON.parse(internal_1.TD.decode(this.value), reviver);
      }
      string() {
        return internal_1.TD.decode(this.value);
      }
    };
    var KvJsMsgEntryImpl = class {
      bucket;
      sm;
      prefixLen;
      update;
      codec;
      constructor(bucket, prefixLen, sm, isUpdate, codec) {
        this.bucket = bucket;
        this.prefixLen = prefixLen;
        this.sm = sm;
        this.update = isUpdate;
        this.codec = codec;
      }
      get rawKey() {
        return this.sm.subject.substring(this.prefixLen);
      }
      get key() {
        return this.codec.key.decode(this.rawKey);
      }
      get value() {
        return this.codec.value.decode(this.sm.data);
      }
      get created() {
        return new Date((0, internal_1.millis)(this.sm.info.timestampNanos));
      }
      get revision() {
        return this.sm.seq;
      }
      get operation() {
        if (this.sm.headers?.has("Nats-Marker-Reason")) {
          const op = this.sm.headers?.get("Nats-Marker-Reason");
          if (op === "MaxAge") {
            return "PURGE";
          }
        }
        return this.sm.headers?.get(exports2.kvOperationHdr) || "PUT";
      }
      get delta() {
        return this.sm.info.pending;
      }
      get length() {
        const slen = this.sm.headers?.get(internal_2.JsHeaders.MessageSizeHdr) || "";
        if (slen !== "") {
          return parseInt(slen, 10);
        }
        return this.sm.data.length;
      }
      get isUpdate() {
        return this.update;
      }
      json(reviver) {
        return JSON.parse(internal_1.TD.decode(this.value), reviver);
      }
      string() {
        return internal_1.TD.decode(this.value);
      }
    };
  }
});

// ../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/internal_mod.js
var require_internal_mod3 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/internal_mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateKey = exports2.validateBucket = exports2.NoopKvCodecs = exports2.Kvm = exports2.defaultBucketOpts = exports2.Bucket = exports2.Base64KeyCodec = exports2.KvWatchInclude = exports2.kvPrefix = void 0;
    var types_1 = require_types3();
    Object.defineProperty(exports2, "kvPrefix", { enumerable: true, get: function() {
      return types_1.kvPrefix;
    } });
    Object.defineProperty(exports2, "KvWatchInclude", { enumerable: true, get: function() {
      return types_1.KvWatchInclude;
    } });
    var kv_1 = require_kv();
    Object.defineProperty(exports2, "Base64KeyCodec", { enumerable: true, get: function() {
      return kv_1.Base64KeyCodec;
    } });
    Object.defineProperty(exports2, "Bucket", { enumerable: true, get: function() {
      return kv_1.Bucket;
    } });
    Object.defineProperty(exports2, "defaultBucketOpts", { enumerable: true, get: function() {
      return kv_1.defaultBucketOpts;
    } });
    Object.defineProperty(exports2, "Kvm", { enumerable: true, get: function() {
      return kv_1.Kvm;
    } });
    Object.defineProperty(exports2, "NoopKvCodecs", { enumerable: true, get: function() {
      return kv_1.NoopKvCodecs;
    } });
    Object.defineProperty(exports2, "validateBucket", { enumerable: true, get: function() {
      return kv_1.validateBucket;
    } });
    Object.defineProperty(exports2, "validateKey", { enumerable: true, get: function() {
      return kv_1.validateKey;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/mod.js
var require_mod6 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+kv@3.4.0/node_modules/@nats-io/kv/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NoopKvCodecs = exports2.Kvm = exports2.defaultBucketOpts = exports2.Bucket = exports2.Base64KeyCodec = exports2.KvWatchInclude = void 0;
    var internal_mod_1 = require_internal_mod3();
    Object.defineProperty(exports2, "KvWatchInclude", { enumerable: true, get: function() {
      return internal_mod_1.KvWatchInclude;
    } });
    var internal_mod_2 = require_internal_mod3();
    Object.defineProperty(exports2, "Base64KeyCodec", { enumerable: true, get: function() {
      return internal_mod_2.Base64KeyCodec;
    } });
    Object.defineProperty(exports2, "Bucket", { enumerable: true, get: function() {
      return internal_mod_2.Bucket;
    } });
    Object.defineProperty(exports2, "defaultBucketOpts", { enumerable: true, get: function() {
      return internal_mod_2.defaultBucketOpts;
    } });
    Object.defineProperty(exports2, "Kvm", { enumerable: true, get: function() {
      return internal_mod_2.Kvm;
    } });
    Object.defineProperty(exports2, "NoopKvCodecs", { enumerable: true, get: function() {
      return internal_mod_2.NoopKvCodecs;
    } });
  }
});

// ../../node_modules/.pnpm/json-canonicalize@2.0.0/node_modules/json-canonicalize/bundles/index.umd.js
var require_index_umd = __commonJS({
  "../../node_modules/.pnpm/json-canonicalize@2.0.0/node_modules/json-canonicalize/bundles/index.umd.js"(exports2, module2) {
    (function(global2, factory) {
      typeof exports2 === "object" && typeof module2 !== "undefined" ? factory(exports2) : typeof define === "function" && define.amd ? define(["exports"], factory) : (global2 = typeof globalThis !== "undefined" ? globalThis : global2 || self, factory(global2.JsonCanonicalize = {}));
    })(exports2, (function(exports3) {
      "use strict";
      var CircularRootPathName = "$";
      function _serialize(obj, options) {
        var buffer = "";
        var vInclude = options && options.include;
        var vExclude = options && options.exclude;
        if (vExclude) {
          if (typeof vExclude === "string")
            vExclude = [vExclude];
        }
        if (vInclude)
          vInclude.sort();
        var visited = /* @__PURE__ */ new WeakMap();
        var allowCircular = options && options.allowCircular;
        var filterUndefined = options && options.filterUndefined;
        var undefinedInArrayToNull = options && options.undefinedInArrayToNull;
        serialize(obj, CircularRootPathName);
        return buffer;
        function serialize(object, path) {
          if (object === null || typeof object !== "object" || object.toJSON != null) {
            buffer += JSON.stringify(object);
          } else if (Array.isArray(object)) {
            var visitedPath = visited.get(object);
            if (visitedPath !== void 0) {
              if (path.startsWith(visitedPath)) {
                if (!allowCircular) {
                  throw new Error("Circular reference detected");
                }
                buffer += '"[Circular:' + visitedPath + ']"';
                return;
              }
            }
            visited.set(object, path);
            buffer += "[";
            var next_1 = false;
            object.forEach(function(element, index) {
              if (next_1) {
                buffer += ",";
              }
              next_1 = true;
              if (undefinedInArrayToNull && element === void 0) {
                element = null;
              }
              serialize(element, path + "[" + index + "]");
            });
            buffer += "]";
          } else {
            var visitedPath = visited.get(object);
            if (visitedPath !== void 0) {
              if (path.startsWith(visitedPath)) {
                if (!allowCircular) {
                  throw new Error("Circular reference detected");
                }
                buffer += '"[Circular:' + visitedPath + ']"';
                return;
              }
            }
            visited.set(object, path);
            buffer += "{";
            var next_2 = false;
            var addProp_1 = function(property) {
              if (vExclude && vExclude.includes(property)) {
                return;
              }
              if (next_2) {
                buffer += ",";
              }
              next_2 = true;
              buffer += JSON.stringify(property);
              buffer += ":";
              serialize(object[property], path + "." + property);
            };
            if (path === CircularRootPathName && vInclude) {
              vInclude.forEach(function(property) {
                if (object.hasOwnProperty(property)) {
                  addProp_1(property);
                }
              });
            } else {
              var vKeys = Object.keys(object);
              if (filterUndefined) {
                vKeys = vKeys.filter(function(k) {
                  return object[k] !== void 0;
                });
              }
              vKeys.sort();
              vKeys.forEach(function(property) {
                addProp_1(property);
              });
            }
            buffer += "}";
          }
        }
      }
      function canonicalize(obj, allowCircular) {
        return _serialize(obj, {
          allowCircular,
          filterUndefined: true,
          undefinedInArrayToNull: true
        });
      }
      function canonicalizeEx2(obj, options) {
        return _serialize(obj, options);
      }
      exports3.canonicalize = canonicalize;
      exports3.canonicalizeEx = canonicalizeEx2;
      Object.defineProperty(exports3, "__esModule", { value: true });
    }));
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/types.js
var require_types4 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.StorageType = void 0;
    var jetstream_1 = require_mod4();
    Object.defineProperty(exports2, "StorageType", { enumerable: true, get: function() {
      return jetstream_1.StorageType;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/base64.js
var require_base64 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/base64.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Base64UrlPaddedCodec = exports2.Base64UrlCodec = exports2.Base64Codec = void 0;
    var Base64Codec = class {
      static encode(bytes) {
        if (typeof bytes === "string") {
          return btoa(bytes);
        }
        const a = Array.from(bytes);
        return btoa(String.fromCharCode(...a));
      }
      static decode(s, binary = false) {
        const bin = atob(s);
        if (!binary) {
          return bin;
        }
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
      }
    };
    exports2.Base64Codec = Base64Codec;
    var Base64UrlCodec = class _Base64UrlCodec {
      static encode(bytes) {
        return _Base64UrlCodec.toB64URLEncoding(Base64Codec.encode(bytes));
      }
      static decode(s, binary = false) {
        return Base64Codec.decode(_Base64UrlCodec.fromB64URLEncoding(s), binary);
      }
      static toB64URLEncoding(b64str) {
        return b64str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      }
      static fromB64URLEncoding(b64str) {
        return b64str.replace(/_/g, "/").replace(/-/g, "+");
      }
    };
    exports2.Base64UrlCodec = Base64UrlCodec;
    var Base64UrlPaddedCodec = class _Base64UrlPaddedCodec {
      static encode(bytes) {
        return _Base64UrlPaddedCodec.toB64URLEncoding(Base64Codec.encode(bytes));
      }
      static decode(s, binary = false) {
        return Base64UrlCodec.decode(_Base64UrlPaddedCodec.fromB64URLEncoding(s), binary);
      }
      static toB64URLEncoding(b64str) {
        return b64str.replace(/\+/g, "-").replace(/\//g, "_");
      }
      static fromB64URLEncoding(b64str) {
        return b64str.replace(/_/g, "/").replace(/-/g, "+");
      }
    };
    exports2.Base64UrlPaddedCodec = Base64UrlPaddedCodec;
  }
});

// ../../node_modules/.pnpm/js-sha256@0.11.1/node_modules/js-sha256/src/sha256.js
var require_sha256 = __commonJS({
  "../../node_modules/.pnpm/js-sha256@0.11.1/node_modules/js-sha256/src/sha256.js"(exports2, module2) {
    (function() {
      "use strict";
      var ERROR = "input is invalid type";
      var WINDOW = typeof window === "object";
      var root = WINDOW ? window : {};
      if (root.JS_SHA256_NO_WINDOW) {
        WINDOW = false;
      }
      var WEB_WORKER = !WINDOW && typeof self === "object";
      var NODE_JS = !root.JS_SHA256_NO_NODE_JS && typeof process === "object" && process.versions && process.versions.node && process.type != "renderer";
      if (NODE_JS) {
        root = global;
      } else if (WEB_WORKER) {
        root = self;
      }
      var COMMON_JS = !root.JS_SHA256_NO_COMMON_JS && typeof module2 === "object" && module2.exports;
      var AMD = typeof define === "function" && define.amd;
      var ARRAY_BUFFER = !root.JS_SHA256_NO_ARRAY_BUFFER && typeof ArrayBuffer !== "undefined";
      var HEX_CHARS = "0123456789abcdef".split("");
      var EXTRA = [-2147483648, 8388608, 32768, 128];
      var SHIFT = [24, 16, 8, 0];
      var K = [
        1116352408,
        1899447441,
        3049323471,
        3921009573,
        961987163,
        1508970993,
        2453635748,
        2870763221,
        3624381080,
        310598401,
        607225278,
        1426881987,
        1925078388,
        2162078206,
        2614888103,
        3248222580,
        3835390401,
        4022224774,
        264347078,
        604807628,
        770255983,
        1249150122,
        1555081692,
        1996064986,
        2554220882,
        2821834349,
        2952996808,
        3210313671,
        3336571891,
        3584528711,
        113926993,
        338241895,
        666307205,
        773529912,
        1294757372,
        1396182291,
        1695183700,
        1986661051,
        2177026350,
        2456956037,
        2730485921,
        2820302411,
        3259730800,
        3345764771,
        3516065817,
        3600352804,
        4094571909,
        275423344,
        430227734,
        506948616,
        659060556,
        883997877,
        958139571,
        1322822218,
        1537002063,
        1747873779,
        1955562222,
        2024104815,
        2227730452,
        2361852424,
        2428436474,
        2756734187,
        3204031479,
        3329325298
      ];
      var OUTPUT_TYPES = ["hex", "array", "digest", "arrayBuffer"];
      var blocks = [];
      if (root.JS_SHA256_NO_NODE_JS || !Array.isArray) {
        Array.isArray = function(obj) {
          return Object.prototype.toString.call(obj) === "[object Array]";
        };
      }
      if (ARRAY_BUFFER && (root.JS_SHA256_NO_ARRAY_BUFFER_IS_VIEW || !ArrayBuffer.isView)) {
        ArrayBuffer.isView = function(obj) {
          return typeof obj === "object" && obj.buffer && obj.buffer.constructor === ArrayBuffer;
        };
      }
      var createOutputMethod = function(outputType, is224) {
        return function(message) {
          return new Sha256(is224, true).update(message)[outputType]();
        };
      };
      var createMethod = function(is224) {
        var method = createOutputMethod("hex", is224);
        if (NODE_JS) {
          method = nodeWrap(method, is224);
        }
        method.create = function() {
          return new Sha256(is224);
        };
        method.update = function(message) {
          return method.create().update(message);
        };
        for (var i = 0; i < OUTPUT_TYPES.length; ++i) {
          var type = OUTPUT_TYPES[i];
          method[type] = createOutputMethod(type, is224);
        }
        return method;
      };
      var nodeWrap = function(method, is224) {
        var crypto2 = require("crypto");
        var Buffer2 = require("buffer").Buffer;
        var algorithm = is224 ? "sha224" : "sha256";
        var bufferFrom;
        if (Buffer2.from && !root.JS_SHA256_NO_BUFFER_FROM) {
          bufferFrom = Buffer2.from;
        } else {
          bufferFrom = function(message) {
            return new Buffer2(message);
          };
        }
        var nodeMethod = function(message) {
          if (typeof message === "string") {
            return crypto2.createHash(algorithm).update(message, "utf8").digest("hex");
          } else {
            if (message === null || message === void 0) {
              throw new Error(ERROR);
            } else if (message.constructor === ArrayBuffer) {
              message = new Uint8Array(message);
            }
          }
          if (Array.isArray(message) || ArrayBuffer.isView(message) || message.constructor === Buffer2) {
            return crypto2.createHash(algorithm).update(bufferFrom(message)).digest("hex");
          } else {
            return method(message);
          }
        };
        return nodeMethod;
      };
      var createHmacOutputMethod = function(outputType, is224) {
        return function(key, message) {
          return new HmacSha256(key, is224, true).update(message)[outputType]();
        };
      };
      var createHmacMethod = function(is224) {
        var method = createHmacOutputMethod("hex", is224);
        method.create = function(key) {
          return new HmacSha256(key, is224);
        };
        method.update = function(key, message) {
          return method.create(key).update(message);
        };
        for (var i = 0; i < OUTPUT_TYPES.length; ++i) {
          var type = OUTPUT_TYPES[i];
          method[type] = createHmacOutputMethod(type, is224);
        }
        return method;
      };
      function Sha256(is224, sharedMemory) {
        if (sharedMemory) {
          blocks[0] = blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
          this.blocks = blocks;
        } else {
          this.blocks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        if (is224) {
          this.h0 = 3238371032;
          this.h1 = 914150663;
          this.h2 = 812702999;
          this.h3 = 4144912697;
          this.h4 = 4290775857;
          this.h5 = 1750603025;
          this.h6 = 1694076839;
          this.h7 = 3204075428;
        } else {
          this.h0 = 1779033703;
          this.h1 = 3144134277;
          this.h2 = 1013904242;
          this.h3 = 2773480762;
          this.h4 = 1359893119;
          this.h5 = 2600822924;
          this.h6 = 528734635;
          this.h7 = 1541459225;
        }
        this.block = this.start = this.bytes = this.hBytes = 0;
        this.finalized = this.hashed = false;
        this.first = true;
        this.is224 = is224;
      }
      Sha256.prototype.update = function(message) {
        if (this.finalized) {
          return;
        }
        var notString, type = typeof message;
        if (type !== "string") {
          if (type === "object") {
            if (message === null) {
              throw new Error(ERROR);
            } else if (ARRAY_BUFFER && message.constructor === ArrayBuffer) {
              message = new Uint8Array(message);
            } else if (!Array.isArray(message)) {
              if (!ARRAY_BUFFER || !ArrayBuffer.isView(message)) {
                throw new Error(ERROR);
              }
            }
          } else {
            throw new Error(ERROR);
          }
          notString = true;
        }
        var code, index = 0, i, length = message.length, blocks2 = this.blocks;
        while (index < length) {
          if (this.hashed) {
            this.hashed = false;
            blocks2[0] = this.block;
            this.block = blocks2[16] = blocks2[1] = blocks2[2] = blocks2[3] = blocks2[4] = blocks2[5] = blocks2[6] = blocks2[7] = blocks2[8] = blocks2[9] = blocks2[10] = blocks2[11] = blocks2[12] = blocks2[13] = blocks2[14] = blocks2[15] = 0;
          }
          if (notString) {
            for (i = this.start; index < length && i < 64; ++index) {
              blocks2[i >>> 2] |= message[index] << SHIFT[i++ & 3];
            }
          } else {
            for (i = this.start; index < length && i < 64; ++index) {
              code = message.charCodeAt(index);
              if (code < 128) {
                blocks2[i >>> 2] |= code << SHIFT[i++ & 3];
              } else if (code < 2048) {
                blocks2[i >>> 2] |= (192 | code >>> 6) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code & 63) << SHIFT[i++ & 3];
              } else if (code < 55296 || code >= 57344) {
                blocks2[i >>> 2] |= (224 | code >>> 12) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code >>> 6 & 63) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code & 63) << SHIFT[i++ & 3];
              } else {
                code = 65536 + ((code & 1023) << 10 | message.charCodeAt(++index) & 1023);
                blocks2[i >>> 2] |= (240 | code >>> 18) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code >>> 12 & 63) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code >>> 6 & 63) << SHIFT[i++ & 3];
                blocks2[i >>> 2] |= (128 | code & 63) << SHIFT[i++ & 3];
              }
            }
          }
          this.lastByteIndex = i;
          this.bytes += i - this.start;
          if (i >= 64) {
            this.block = blocks2[16];
            this.start = i - 64;
            this.hash();
            this.hashed = true;
          } else {
            this.start = i;
          }
        }
        if (this.bytes > 4294967295) {
          this.hBytes += this.bytes / 4294967296 << 0;
          this.bytes = this.bytes % 4294967296;
        }
        return this;
      };
      Sha256.prototype.finalize = function() {
        if (this.finalized) {
          return;
        }
        this.finalized = true;
        var blocks2 = this.blocks, i = this.lastByteIndex;
        blocks2[16] = this.block;
        blocks2[i >>> 2] |= EXTRA[i & 3];
        this.block = blocks2[16];
        if (i >= 56) {
          if (!this.hashed) {
            this.hash();
          }
          blocks2[0] = this.block;
          blocks2[16] = blocks2[1] = blocks2[2] = blocks2[3] = blocks2[4] = blocks2[5] = blocks2[6] = blocks2[7] = blocks2[8] = blocks2[9] = blocks2[10] = blocks2[11] = blocks2[12] = blocks2[13] = blocks2[14] = blocks2[15] = 0;
        }
        blocks2[14] = this.hBytes << 3 | this.bytes >>> 29;
        blocks2[15] = this.bytes << 3;
        this.hash();
      };
      Sha256.prototype.hash = function() {
        var a = this.h0, b = this.h1, c = this.h2, d = this.h3, e = this.h4, f = this.h5, g = this.h6, h = this.h7, blocks2 = this.blocks, j, s0, s1, maj, t1, t2, ch, ab, da, cd, bc;
        for (j = 16; j < 64; ++j) {
          t1 = blocks2[j - 15];
          s0 = (t1 >>> 7 | t1 << 25) ^ (t1 >>> 18 | t1 << 14) ^ t1 >>> 3;
          t1 = blocks2[j - 2];
          s1 = (t1 >>> 17 | t1 << 15) ^ (t1 >>> 19 | t1 << 13) ^ t1 >>> 10;
          blocks2[j] = blocks2[j - 16] + s0 + blocks2[j - 7] + s1 << 0;
        }
        bc = b & c;
        for (j = 0; j < 64; j += 4) {
          if (this.first) {
            if (this.is224) {
              ab = 300032;
              t1 = blocks2[0] - 1413257819;
              h = t1 - 150054599 << 0;
              d = t1 + 24177077 << 0;
            } else {
              ab = 704751109;
              t1 = blocks2[0] - 210244248;
              h = t1 - 1521486534 << 0;
              d = t1 + 143694565 << 0;
            }
            this.first = false;
          } else {
            s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
            s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
            ab = a & b;
            maj = ab ^ a & c ^ bc;
            ch = e & f ^ ~e & g;
            t1 = h + s1 + ch + K[j] + blocks2[j];
            t2 = s0 + maj;
            h = d + t1 << 0;
            d = t1 + t2 << 0;
          }
          s0 = (d >>> 2 | d << 30) ^ (d >>> 13 | d << 19) ^ (d >>> 22 | d << 10);
          s1 = (h >>> 6 | h << 26) ^ (h >>> 11 | h << 21) ^ (h >>> 25 | h << 7);
          da = d & a;
          maj = da ^ d & b ^ ab;
          ch = h & e ^ ~h & f;
          t1 = g + s1 + ch + K[j + 1] + blocks2[j + 1];
          t2 = s0 + maj;
          g = c + t1 << 0;
          c = t1 + t2 << 0;
          s0 = (c >>> 2 | c << 30) ^ (c >>> 13 | c << 19) ^ (c >>> 22 | c << 10);
          s1 = (g >>> 6 | g << 26) ^ (g >>> 11 | g << 21) ^ (g >>> 25 | g << 7);
          cd = c & d;
          maj = cd ^ c & a ^ da;
          ch = g & h ^ ~g & e;
          t1 = f + s1 + ch + K[j + 2] + blocks2[j + 2];
          t2 = s0 + maj;
          f = b + t1 << 0;
          b = t1 + t2 << 0;
          s0 = (b >>> 2 | b << 30) ^ (b >>> 13 | b << 19) ^ (b >>> 22 | b << 10);
          s1 = (f >>> 6 | f << 26) ^ (f >>> 11 | f << 21) ^ (f >>> 25 | f << 7);
          bc = b & c;
          maj = bc ^ b & d ^ cd;
          ch = f & g ^ ~f & h;
          t1 = e + s1 + ch + K[j + 3] + blocks2[j + 3];
          t2 = s0 + maj;
          e = a + t1 << 0;
          a = t1 + t2 << 0;
          this.chromeBugWorkAround = true;
        }
        this.h0 = this.h0 + a << 0;
        this.h1 = this.h1 + b << 0;
        this.h2 = this.h2 + c << 0;
        this.h3 = this.h3 + d << 0;
        this.h4 = this.h4 + e << 0;
        this.h5 = this.h5 + f << 0;
        this.h6 = this.h6 + g << 0;
        this.h7 = this.h7 + h << 0;
      };
      Sha256.prototype.hex = function() {
        this.finalize();
        var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4, h5 = this.h5, h6 = this.h6, h7 = this.h7;
        var hex = HEX_CHARS[h0 >>> 28 & 15] + HEX_CHARS[h0 >>> 24 & 15] + HEX_CHARS[h0 >>> 20 & 15] + HEX_CHARS[h0 >>> 16 & 15] + HEX_CHARS[h0 >>> 12 & 15] + HEX_CHARS[h0 >>> 8 & 15] + HEX_CHARS[h0 >>> 4 & 15] + HEX_CHARS[h0 & 15] + HEX_CHARS[h1 >>> 28 & 15] + HEX_CHARS[h1 >>> 24 & 15] + HEX_CHARS[h1 >>> 20 & 15] + HEX_CHARS[h1 >>> 16 & 15] + HEX_CHARS[h1 >>> 12 & 15] + HEX_CHARS[h1 >>> 8 & 15] + HEX_CHARS[h1 >>> 4 & 15] + HEX_CHARS[h1 & 15] + HEX_CHARS[h2 >>> 28 & 15] + HEX_CHARS[h2 >>> 24 & 15] + HEX_CHARS[h2 >>> 20 & 15] + HEX_CHARS[h2 >>> 16 & 15] + HEX_CHARS[h2 >>> 12 & 15] + HEX_CHARS[h2 >>> 8 & 15] + HEX_CHARS[h2 >>> 4 & 15] + HEX_CHARS[h2 & 15] + HEX_CHARS[h3 >>> 28 & 15] + HEX_CHARS[h3 >>> 24 & 15] + HEX_CHARS[h3 >>> 20 & 15] + HEX_CHARS[h3 >>> 16 & 15] + HEX_CHARS[h3 >>> 12 & 15] + HEX_CHARS[h3 >>> 8 & 15] + HEX_CHARS[h3 >>> 4 & 15] + HEX_CHARS[h3 & 15] + HEX_CHARS[h4 >>> 28 & 15] + HEX_CHARS[h4 >>> 24 & 15] + HEX_CHARS[h4 >>> 20 & 15] + HEX_CHARS[h4 >>> 16 & 15] + HEX_CHARS[h4 >>> 12 & 15] + HEX_CHARS[h4 >>> 8 & 15] + HEX_CHARS[h4 >>> 4 & 15] + HEX_CHARS[h4 & 15] + HEX_CHARS[h5 >>> 28 & 15] + HEX_CHARS[h5 >>> 24 & 15] + HEX_CHARS[h5 >>> 20 & 15] + HEX_CHARS[h5 >>> 16 & 15] + HEX_CHARS[h5 >>> 12 & 15] + HEX_CHARS[h5 >>> 8 & 15] + HEX_CHARS[h5 >>> 4 & 15] + HEX_CHARS[h5 & 15] + HEX_CHARS[h6 >>> 28 & 15] + HEX_CHARS[h6 >>> 24 & 15] + HEX_CHARS[h6 >>> 20 & 15] + HEX_CHARS[h6 >>> 16 & 15] + HEX_CHARS[h6 >>> 12 & 15] + HEX_CHARS[h6 >>> 8 & 15] + HEX_CHARS[h6 >>> 4 & 15] + HEX_CHARS[h6 & 15];
        if (!this.is224) {
          hex += HEX_CHARS[h7 >>> 28 & 15] + HEX_CHARS[h7 >>> 24 & 15] + HEX_CHARS[h7 >>> 20 & 15] + HEX_CHARS[h7 >>> 16 & 15] + HEX_CHARS[h7 >>> 12 & 15] + HEX_CHARS[h7 >>> 8 & 15] + HEX_CHARS[h7 >>> 4 & 15] + HEX_CHARS[h7 & 15];
        }
        return hex;
      };
      Sha256.prototype.toString = Sha256.prototype.hex;
      Sha256.prototype.digest = function() {
        this.finalize();
        var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4, h5 = this.h5, h6 = this.h6, h7 = this.h7;
        var arr = [
          h0 >>> 24 & 255,
          h0 >>> 16 & 255,
          h0 >>> 8 & 255,
          h0 & 255,
          h1 >>> 24 & 255,
          h1 >>> 16 & 255,
          h1 >>> 8 & 255,
          h1 & 255,
          h2 >>> 24 & 255,
          h2 >>> 16 & 255,
          h2 >>> 8 & 255,
          h2 & 255,
          h3 >>> 24 & 255,
          h3 >>> 16 & 255,
          h3 >>> 8 & 255,
          h3 & 255,
          h4 >>> 24 & 255,
          h4 >>> 16 & 255,
          h4 >>> 8 & 255,
          h4 & 255,
          h5 >>> 24 & 255,
          h5 >>> 16 & 255,
          h5 >>> 8 & 255,
          h5 & 255,
          h6 >>> 24 & 255,
          h6 >>> 16 & 255,
          h6 >>> 8 & 255,
          h6 & 255
        ];
        if (!this.is224) {
          arr.push(h7 >>> 24 & 255, h7 >>> 16 & 255, h7 >>> 8 & 255, h7 & 255);
        }
        return arr;
      };
      Sha256.prototype.array = Sha256.prototype.digest;
      Sha256.prototype.arrayBuffer = function() {
        this.finalize();
        var buffer = new ArrayBuffer(this.is224 ? 28 : 32);
        var dataView = new DataView(buffer);
        dataView.setUint32(0, this.h0);
        dataView.setUint32(4, this.h1);
        dataView.setUint32(8, this.h2);
        dataView.setUint32(12, this.h3);
        dataView.setUint32(16, this.h4);
        dataView.setUint32(20, this.h5);
        dataView.setUint32(24, this.h6);
        if (!this.is224) {
          dataView.setUint32(28, this.h7);
        }
        return buffer;
      };
      function HmacSha256(key, is224, sharedMemory) {
        var i, type = typeof key;
        if (type === "string") {
          var bytes = [], length = key.length, index = 0, code;
          for (i = 0; i < length; ++i) {
            code = key.charCodeAt(i);
            if (code < 128) {
              bytes[index++] = code;
            } else if (code < 2048) {
              bytes[index++] = 192 | code >>> 6;
              bytes[index++] = 128 | code & 63;
            } else if (code < 55296 || code >= 57344) {
              bytes[index++] = 224 | code >>> 12;
              bytes[index++] = 128 | code >>> 6 & 63;
              bytes[index++] = 128 | code & 63;
            } else {
              code = 65536 + ((code & 1023) << 10 | key.charCodeAt(++i) & 1023);
              bytes[index++] = 240 | code >>> 18;
              bytes[index++] = 128 | code >>> 12 & 63;
              bytes[index++] = 128 | code >>> 6 & 63;
              bytes[index++] = 128 | code & 63;
            }
          }
          key = bytes;
        } else {
          if (type === "object") {
            if (key === null) {
              throw new Error(ERROR);
            } else if (ARRAY_BUFFER && key.constructor === ArrayBuffer) {
              key = new Uint8Array(key);
            } else if (!Array.isArray(key)) {
              if (!ARRAY_BUFFER || !ArrayBuffer.isView(key)) {
                throw new Error(ERROR);
              }
            }
          } else {
            throw new Error(ERROR);
          }
        }
        if (key.length > 64) {
          key = new Sha256(is224, true).update(key).array();
        }
        var oKeyPad = [], iKeyPad = [];
        for (i = 0; i < 64; ++i) {
          var b = key[i] || 0;
          oKeyPad[i] = 92 ^ b;
          iKeyPad[i] = 54 ^ b;
        }
        Sha256.call(this, is224, sharedMemory);
        this.update(iKeyPad);
        this.oKeyPad = oKeyPad;
        this.inner = true;
        this.sharedMemory = sharedMemory;
      }
      HmacSha256.prototype = new Sha256();
      HmacSha256.prototype.finalize = function() {
        Sha256.prototype.finalize.call(this);
        if (this.inner) {
          this.inner = false;
          var innerHash = this.array();
          Sha256.call(this, this.is224, this.sharedMemory);
          this.update(this.oKeyPad);
          this.update(innerHash);
          Sha256.prototype.finalize.call(this);
        }
      };
      var exports3 = createMethod();
      exports3.sha256 = exports3;
      exports3.sha224 = createMethod(true);
      exports3.sha256.hmac = createHmacMethod();
      exports3.sha224.hmac = createHmacMethod(true);
      if (COMMON_JS) {
        module2.exports = exports3;
      } else {
        root.sha256 = exports3.sha256;
        root.sha224 = exports3.sha224;
        if (AMD) {
          define(function() {
            return exports3;
          });
        }
      }
    })();
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/sha256.js
var require_sha2562 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/sha256.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.setSha256Backend = setSha256Backend;
    exports2.getSha256Backend = getSha256Backend;
    exports2.createSha256 = createSha256;
    var js_sha256_1 = require_sha256();
    var backend = "js";
    var factory = null;
    var initPromise = null;
    function setSha256Backend(b) {
      if (b !== "js" && b !== "native") {
        throw new Error(`unknown sha256 backend: ${b}`);
      }
      if (b === backend)
        return;
      backend = b;
      factory = null;
      initPromise = null;
    }
    function getSha256Backend() {
      return backend;
    }
    function jsFactory() {
      const s = js_sha256_1.sha256.create();
      return {
        update(data) {
          s.update(data);
        },
        digest() {
          return Uint8Array.from(s.digest());
        }
      };
    }
    async function init() {
      if (factory)
        return;
      if (backend === "native") {
        const m = await import("node:crypto");
        if (typeof m?.createHash !== "function") {
          throw new Error("sha256 backend 'native' selected but `node:crypto` is not available in this runtime");
        }
        const create = m.createHash;
        factory = () => {
          const h = create("sha256");
          return {
            update(data) {
              h.update(data);
            },
            digest() {
              return new Uint8Array(h.digest());
            }
          };
        };
        return;
      }
      factory = jsFactory;
    }
    async function createSha256() {
      if (!factory) {
        initPromise = initPromise ?? init();
        await initPromise;
      }
      const f = factory;
      if (!f) {
        throw new Error("sha256 backend reset during init");
      }
      return f();
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/sha_digest.parser.js
var require_sha_digest_parser = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/sha_digest.parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseSha256 = parseSha256;
    exports2.checkSha256 = checkSha256;
    function parseSha256(s) {
      return toByteArray(s);
    }
    function isHex(s) {
      const hexRegex = /^[0-9A-Fa-f]+$/;
      if (!hexRegex.test(s)) {
        return false;
      }
      const isAllUpperCase = /^[0-9A-F]+$/.test(s);
      const isAllLowerCase = /^[0-9a-f]+$/.test(s);
      if (!(isAllUpperCase || isAllLowerCase)) {
        return false;
      }
      return s.length % 2 === 0;
    }
    function isBase64(s) {
      return /^[A-Za-z0-9\-_]*(={0,2})?$/.test(s) || /^[A-Za-z0-9+/]*(={0,2})?$/.test(s);
    }
    function detectEncoding(input) {
      if (isHex(input)) {
        return "hex";
      } else if (isBase64(input)) {
        return "b64";
      }
      return "";
    }
    function hexToByteArray(s) {
      if (s.length % 2 !== 0) {
        throw new Error("hex string must have an even length");
      }
      const a = new Uint8Array(s.length / 2);
      for (let i = 0; i < s.length; i += 2) {
        a[i / 2] = parseInt(s.substring(i, i + 2), 16);
      }
      return a;
    }
    function base64ToByteArray(s) {
      s = s.replace(/-/g, "+");
      s = s.replace(/_/g, "/");
      const sbin = atob(s);
      return Uint8Array.from(sbin, (c) => c.charCodeAt(0));
    }
    function toByteArray(input) {
      const encoding = detectEncoding(input);
      switch (encoding) {
        case "hex":
          return hexToByteArray(input);
        case "b64":
          return base64ToByteArray(input);
      }
      return null;
    }
    function checkSha256(a, b) {
      const aBytes = typeof a === "string" ? parseSha256(a) : a;
      const bBytes = typeof b === "string" ? parseSha256(b) : b;
      if (aBytes === null || bBytes === null) {
        return false;
      }
      if (aBytes.length !== bBytes.length) {
        return false;
      }
      for (let i = 0; i < aBytes.length; i++) {
        if (aBytes[i] !== bBytes[i]) {
          return false;
        }
      }
      return true;
    }
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/objectstore.js
var require_objectstore = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/objectstore.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ObjectStoreImpl = exports2.ObjectStoreStatusImpl = exports2.Objm = exports2.digestType = exports2.osPrefix = void 0;
    exports2.objectStoreStreamName = objectStoreStreamName;
    exports2.objectStoreBucketName = objectStoreBucketName;
    exports2.validateBucket = validateBucket;
    var internal_1 = require_internal_mod();
    var internal_2 = require_internal_mod2();
    var base64_1 = require_base64();
    var sha256_1 = require_sha2562();
    var sha_digest_parser_1 = require_sha_digest_parser();
    exports2.osPrefix = "OBJ_";
    exports2.digestType = "SHA-256=";
    function objectStoreStreamName(bucket) {
      validateBucket(bucket);
      return `${exports2.osPrefix}${bucket}`;
    }
    function objectStoreBucketName(stream) {
      if (stream.startsWith(exports2.osPrefix)) {
        return stream.substring(4);
      }
      return stream;
    }
    var Objm3 = class {
      js;
      /**
       * Creates an instance of the Objm that allows you to create and access ObjectStore.
       * Note that if the argument is a NatsConnection, default JetStream Options are
       * used. If you want to set some options, please provide a JetStreamClient instead.
       * @param nc
       */
      constructor(nc) {
        this.js = (0, internal_2.toJetStreamClient)(nc);
      }
      /**
       * Creates and opens the specified ObjectStore. If the ObjectStore already exists,
       * it opens the existing ObjectStore.
       * @param name
       * @param opts
       */
      create(name, opts = {}) {
        return this.#maybeCreate(name, opts);
      }
      /**
       * Opens the specified ObjectStore
       * @param name
       * @param check - if set to false, it will not check if the ObjectStore exists.
       */
      async open(name, check = true) {
        let doInfo = true;
        let allowBatched = false;
        if (typeof check === "boolean") {
          doInfo = check;
        } else {
          const o = check;
          doInfo = o.check === true;
          allowBatched = o.allowBatched === true;
        }
        const apiLvl = this.js.nc.info?.api_lvl ?? 0;
        if (allowBatched && apiLvl < 4) {
          return Promise.reject(new Error("server does not support batched publishes"));
        }
        const jsm = await this.js.jetstreamManager();
        const os = new ObjectStoreImpl(name, jsm, this.js);
        os.stream = objectStoreStreamName(name);
        if (doInfo) {
          const info = await os._si();
          if (info === null) {
            return Promise.reject(new Error("object store not found"));
          }
          if (allowBatched && info.config.allow_batched !== true) {
            return Promise.reject(new Error("existing bucket does not support batched publishes"));
          }
        }
        os.allowBatched = allowBatched;
        return os;
      }
      #maybeCreate(name, opts = {}) {
        if (typeof crypto?.subtle?.digest !== "function") {
          return Promise.reject(new Error("objectstore: unable to calculate hashes - crypto.subtle.digest with sha256 support is required"));
        }
        const { ok, min } = this.js.nc.features.get(internal_1.Feature.JS_OBJECTSTORE);
        if (!ok) {
          return Promise.reject(new Error(`objectstore is only supported on servers ${min} or better`));
        }
        return ObjectStoreImpl.create(this.js, name, opts);
      }
      /**
       * Returns a list of ObjectStoreStatus for all streams that are identified as
       * being a ObjectStore (that is having names that have the prefix `OBJ_`)
       */
      list() {
        const filter = (v) => {
          const slr = v;
          const streams = slr.streams.filter((v2) => {
            return v2.config.name.startsWith(exports2.osPrefix);
          });
          streams.forEach((si) => {
            si.config.sealed = si.config.sealed || false;
            si.config.deny_delete = si.config.deny_delete || false;
            si.config.deny_purge = si.config.deny_purge || false;
            si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
          });
          return streams.map((si) => {
            return new ObjectStoreStatusImpl(si);
          });
        };
        const subj = `${this.js.prefix}.STREAM.LIST`;
        return new internal_2.ListerImpl(subj, filter, this.js);
      }
    };
    exports2.Objm = Objm3;
    var ObjectStoreStatusImpl = class {
      si;
      backingStore;
      constructor(si) {
        this.si = si;
        this.backingStore = "JetStream";
      }
      get bucket() {
        return objectStoreBucketName(this.si.config.name);
      }
      get description() {
        return this.si.config.description ?? "";
      }
      get ttl() {
        return this.si.config.max_age;
      }
      get storage() {
        return this.si.config.storage;
      }
      get replicas() {
        return this.si.config.num_replicas;
      }
      get sealed() {
        return this.si.config.sealed;
      }
      get size() {
        return this.si.state.bytes;
      }
      get streamInfo() {
        return this.si;
      }
      get metadata() {
        return this.si.config.metadata;
      }
      get compression() {
        if (this.si.config.compression) {
          return this.si.config.compression !== internal_2.StoreCompression.None;
        }
        return false;
      }
    };
    exports2.ObjectStoreStatusImpl = ObjectStoreStatusImpl;
    function validateBucket(name) {
      const validBucketRe = /^[-\w]+$/;
      if (!validBucketRe.test(name)) {
        throw new Error(`invalid bucket name: ${name}`);
      }
    }
    var ObjectInfoImpl = class {
      info;
      hdrs;
      constructor(oi) {
        this.info = oi;
      }
      get name() {
        return this.info.name;
      }
      get description() {
        return this.info.description ?? "";
      }
      get headers() {
        if (!this.hdrs) {
          this.hdrs = internal_1.MsgHdrsImpl.fromRecord(this.info.headers || {});
        }
        return this.hdrs;
      }
      get options() {
        return this.info.options;
      }
      get bucket() {
        return this.info.bucket;
      }
      get chunks() {
        return this.info.chunks;
      }
      get deleted() {
        return this.info.deleted ?? false;
      }
      get digest() {
        return this.info.digest;
      }
      get mtime() {
        return this.info.mtime;
      }
      get nuid() {
        return this.info.nuid;
      }
      get size() {
        return this.info.size;
      }
      get revision() {
        return this.info.revision;
      }
      get metadata() {
        return this.info.metadata || {};
      }
      isLink() {
        return this.info.options?.link !== void 0 && this.info.options?.link !== null;
      }
    };
    function toServerObjectStoreMeta(meta) {
      const v = {
        name: meta.name,
        description: meta.description ?? "",
        options: meta.options,
        metadata: meta.metadata
      };
      if (meta.headers) {
        const mhi = meta.headers;
        v.headers = mhi.toRecord();
      }
      return v;
    }
    function emptyReadableStream() {
      return new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(0));
          c.close();
        }
      });
    }
    var ObjectStoreImpl = class _ObjectStoreImpl {
      jsm;
      js;
      stream;
      name;
      allowBatched = false;
      constructor(name, jsm, js) {
        this.name = name;
        this.jsm = jsm;
        this.js = js;
      }
      _checkNotEmpty(name) {
        if (!name || name.length === 0) {
          return { name, error: new Error("name cannot be empty") };
        }
        return { name };
      }
      async info(name) {
        const info = await this.rawInfo(name);
        return info ? new ObjectInfoImpl(info) : null;
      }
      async list() {
        const buf = [];
        const iter = await this.watch({
          ignoreDeletes: true,
          includeHistory: true,
          //@ts-ignore: hidden
          historyOnly: true
        });
        for await (const info of iter) {
          buf.push(info);
        }
        return Promise.resolve(buf);
      }
      async rawInfo(name) {
        const { name: obj, error } = this._checkNotEmpty(name);
        if (error) {
          return Promise.reject(error);
        }
        const meta = this._metaSubject(obj);
        try {
          const m = await this.jsm.streams.getMessage(this.stream, {
            last_by_subj: meta
          });
          if (m === null) {
            return null;
          }
          const soi = m.json();
          soi.revision = m.seq;
          return soi;
        } catch (err) {
          return Promise.reject(err);
        }
      }
      async _si(opts) {
        try {
          return await this.jsm.streams.info(this.stream, opts);
        } catch (err) {
          if (err instanceof internal_2.JetStreamApiError && err.code === internal_2.JetStreamApiCodes.StreamNotFound) {
            return null;
          }
          return Promise.reject(err);
        }
      }
      async seal() {
        let info = await this._si();
        if (info === null) {
          return Promise.reject(new Error("object store not found"));
        }
        info.config.sealed = true;
        info = await this.jsm.streams.update(this.stream, info.config);
        return Promise.resolve(new ObjectStoreStatusImpl(info));
      }
      async status(opts) {
        const info = await this._si(opts);
        if (info === null) {
          return Promise.reject(new Error("object store not found"));
        }
        return Promise.resolve(new ObjectStoreStatusImpl(info));
      }
      destroy() {
        return this.jsm.streams.delete(this.stream);
      }
      async _put(meta, rs, opts) {
        const jsopts = this.js.getOptions();
        opts = opts || { timeout: jsopts.timeout };
        opts.timeout = opts.timeout || jsopts.timeout;
        opts.previousRevision = opts.previousRevision ?? void 0;
        const { timeout, previousRevision } = opts;
        const maxPayload = this.js.nc.info?.max_payload || 1024;
        meta = meta || {};
        meta.options = meta.options || {};
        let maxChunk = meta.options?.max_chunk_size || 128 * 1024;
        maxChunk = maxChunk > maxPayload ? maxPayload : maxChunk;
        meta.options.max_chunk_size = maxChunk;
        const old = await this.info(meta.name);
        const { name: n, error } = this._checkNotEmpty(meta.name);
        if (error) {
          return Promise.reject(error);
        }
        const id = internal_1.nuid.next();
        const chunkSubj = this._chunkSubject(id);
        const metaSubj = this._metaSubject(n);
        const info = Object.assign({
          bucket: this.name,
          nuid: id,
          size: 0,
          chunks: 0
        }, toServerObjectStoreMeta(meta));
        const d = (0, internal_1.deferred)();
        const db = new internal_1.DataBuffer();
        let fi = null;
        const publishChunk = async (payload) => {
          if (this.allowBatched) {
            if (!fi) {
              fi = await (0, internal_2.startFastIngest)(this.js.nc, chunkSubj, payload, {
                allowGaps: false,
                timeout
              });
            } else {
              await fi.add(chunkSubj, payload, { timeout });
            }
            return;
          }
          await this.js.publish(chunkSubj, payload, { timeout });
        };
        try {
          const reader = rs ? rs.getReader() : null;
          const sha = await (0, sha256_1.createSha256)();
          while (true) {
            const { done: done2, value } = reader ? await reader.read() : { done: true, value: void 0 };
            if (done2) {
              if (db.size() > 0) {
                const payload = db.drain();
                sha.update(payload);
                info.chunks++;
                info.size += payload.length;
                await publishChunk(payload);
              }
              info.mtime = (/* @__PURE__ */ new Date()).toISOString();
              const digest = base64_1.Base64UrlPaddedCodec.encode(sha.digest());
              info.digest = `${exports2.digestType}${digest}`;
              info.deleted = false;
              const h = (0, internal_1.headers)();
              if (typeof previousRevision === "number") {
                h.set(internal_2.PubHeaders.ExpectedLastSubjectSequenceHdr, `${previousRevision}`);
              }
              h.set(internal_2.JsHeaders.RollupHdr, internal_2.JsHeaders.RollupValueSubject);
              const ack = fi ? await fi.last(metaSubj, JSON.stringify(info), {
                headers: h,
                timeout
              }) : await this.js.publish(metaSubj, JSON.stringify(info), {
                headers: h,
                timeout
              });
              info.revision = ack.seq;
              if (old) {
                try {
                  await this.jsm.streams.purge(this.stream, {
                    filter: `$O.${this.name}.C.${old.nuid}`
                  });
                } catch (_err) {
                }
              }
              d.resolve(new ObjectInfoImpl(info));
              break;
            }
            if (value) {
              db.fill(value);
              while (db.size() > maxChunk) {
                info.chunks++;
                info.size += maxChunk;
                const payload = db.drain(meta.options.max_chunk_size);
                sha.update(payload);
                await publishChunk(payload);
              }
            }
          }
        } catch (err) {
          if (fi) {
            try {
              await fi.end();
            } catch (_e) {
            }
          }
          await this.jsm.streams.purge(this.stream, { filter: chunkSubj });
          d.reject(err);
        }
        return d;
      }
      putBlob(meta, data, opts) {
        function readableStreamFrom(data2) {
          return new ReadableStream({
            pull(controller) {
              controller.enqueue(data2);
              controller.close();
            }
          });
        }
        if (data === null) {
          data = new Uint8Array(0);
        }
        return this.put(meta, readableStreamFrom(data), opts);
      }
      put(meta, rs, opts) {
        if (meta?.options?.link) {
          return Promise.reject(new Error("link cannot be set when putting the object in bucket"));
        }
        return this._put(meta, rs, opts);
      }
      async getBlob(name) {
        async function fromReadableStream(rs) {
          const buf = new internal_1.DataBuffer();
          const reader = rs.getReader();
          while (true) {
            const { done: done2, value } = await reader.read();
            if (done2) {
              return buf.drain();
            }
            if (value && value.length) {
              buf.fill(value);
            }
          }
        }
        const r = await this.get(name);
        if (r === null) {
          return Promise.resolve(null);
        }
        const vs = await Promise.all([r.error, fromReadableStream(r.data)]);
        if (vs[0]) {
          return Promise.reject(vs[0]);
        } else {
          return Promise.resolve(vs[1]);
        }
      }
      async get(name) {
        const info = await this.rawInfo(name);
        if (info === null) {
          return Promise.resolve(null);
        }
        if (info.deleted) {
          return Promise.resolve(null);
        }
        if (info.options && info.options.link) {
          const ln = info.options.link.name || "";
          if (ln === "") {
            throw new Error("link is a bucket");
          }
          const os = info.options.link.bucket !== this.name ? await _ObjectStoreImpl.create(this.js, info.options.link.bucket) : this;
          return os.get(ln);
        }
        if (!info.digest.startsWith(exports2.digestType)) {
          return Promise.reject(new Error(`unknown digest type: ${info.digest}`));
        }
        const digest = (0, sha_digest_parser_1.parseSha256)(info.digest.substring(8));
        if (digest === null) {
          return Promise.reject(new Error(`unable to parse digest: ${info.digest}`));
        }
        const d = (0, internal_1.deferred)();
        const r = {
          info: new ObjectInfoImpl(info),
          error: d
        };
        if (info.size === 0) {
          r.data = emptyReadableStream();
          d.resolve(null);
          return Promise.resolve(r);
        }
        const sha = await (0, sha256_1.createSha256)();
        let controller;
        const cc = {};
        cc.filter_subject = `$O.${this.name}.C.${info.nuid}`;
        cc.idle_heartbeat = (0, internal_1.nanos)(3e4);
        cc.flow_control = true;
        const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
        const iter = await oc.consume();
        (async () => {
          for await (const jm of iter) {
            if (jm.data.length > 0) {
              sha.update(jm.data);
              controller.enqueue(jm.data);
            }
            if (jm.info.pending === 0) {
              const computedDigest = sha.digest();
              if (!(0, sha_digest_parser_1.checkSha256)(digest, computedDigest)) {
                const hex = Array.from(computedDigest).map((b) => b.toString(16).padStart(2, "0")).join("");
                controller.error(new Error(`received a corrupt object, digests do not match
  expected: ${info.digest}
  computed: SHA-256 ${hex}`));
              } else {
                controller.close();
              }
              break;
            }
          }
        })().then(() => {
          d.resolve();
        }).catch((err) => {
          controller.error(err);
          d.reject(err);
        });
        r.data = new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel() {
            iter.stop();
          }
        });
        return r;
      }
      linkStore(name, bucket) {
        if (!(bucket instanceof _ObjectStoreImpl)) {
          return Promise.reject("bucket required");
        }
        const osi = bucket;
        const { name: n, error } = this._checkNotEmpty(name);
        if (error) {
          return Promise.reject(error);
        }
        const meta = {
          name: n,
          options: { link: { bucket: osi.name } }
        };
        return this._put(meta, null);
      }
      async link(name, info) {
        const { name: n, error } = this._checkNotEmpty(name);
        if (error) {
          return Promise.reject(error);
        }
        if (info.deleted) {
          return Promise.reject(new Error("src object is deleted"));
        }
        if (info.isLink()) {
          return Promise.reject(new Error("src object is a link"));
        }
        const dest = await this.rawInfo(name);
        if (dest !== null && !dest.deleted) {
          return Promise.reject(new Error("an object already exists with that name"));
        }
        const link = { bucket: info.bucket, name: info.name };
        const mm = {
          name: n,
          bucket: info.bucket,
          options: { link }
        };
        await this.js.publish(this._metaSubject(name), JSON.stringify(mm));
        const i = await this.info(name);
        return Promise.resolve(i);
      }
      async delete(name) {
        const info = await this.rawInfo(name);
        if (info === null) {
          return Promise.resolve({ purged: 0, success: false });
        }
        info.deleted = true;
        info.size = 0;
        info.chunks = 0;
        info.digest = "";
        const h = (0, internal_1.headers)();
        h.set(internal_2.JsHeaders.RollupHdr, internal_2.JsHeaders.RollupValueSubject);
        await this.js.publish(this._metaSubject(info.name), JSON.stringify(info), {
          headers: h
        });
        return this.jsm.streams.purge(this.stream, {
          filter: this._chunkSubject(info.nuid)
        });
      }
      async update(name, meta = {}) {
        const info = await this.rawInfo(name);
        if (info === null) {
          return Promise.reject(new Error("object not found"));
        }
        if (info.deleted) {
          return Promise.reject(new Error("cannot update meta for a deleted object"));
        }
        meta.name = meta.name ?? info.name;
        const { name: n, error } = this._checkNotEmpty(meta.name);
        if (error) {
          return Promise.reject(error);
        }
        if (name !== meta.name) {
          const i = await this.info(meta.name);
          if (i && !i.deleted) {
            return Promise.reject(new Error("an object already exists with that name"));
          }
        }
        meta.name = n;
        const ii = Object.assign({}, info, toServerObjectStoreMeta(meta));
        const ack = await this.js.publish(this._metaSubject(ii.name), JSON.stringify(ii));
        if (name !== meta.name) {
          await this.jsm.streams.purge(this.stream, {
            filter: this._metaSubject(name)
          });
        }
        return Promise.resolve(ack);
      }
      async watch(opts = {}) {
        opts.includeHistory = opts.includeHistory ?? false;
        opts.ignoreDeletes = opts.ignoreDeletes ?? false;
        const historyOnly = opts.historyOnly ?? false;
        const qi = new internal_1.QueuedIteratorImpl();
        const subj = this._metaSubjectAll();
        try {
          await this.jsm.streams.getMessage(this.stream, { last_by_subj: subj });
        } catch (err) {
          if (!(0, internal_2.isMessageNotFound)(err)) {
            qi.stop(err);
          }
        }
        const cc = {};
        cc.name = `OBJ_WATCHER_${internal_1.nuid.next()}`;
        cc.filter_subject = subj;
        if (opts.includeHistory) {
          cc.deliver_policy = internal_2.DeliverPolicy.LastPerSubject;
        } else {
          cc.deliver_policy = internal_2.DeliverPolicy.New;
        }
        const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
        const info = await oc.info(true);
        const count = info.num_pending;
        let isUpdate = cc.deliver_policy === internal_2.DeliverPolicy.New || count === 0;
        qi._data = oc;
        let i = 0;
        const iter = await oc.consume({
          callback: (jm) => {
            if (!isUpdate) {
              i++;
              isUpdate = i >= count;
            }
            const oi = jm.json();
            oi.isUpdate = isUpdate;
            if (oi.deleted && opts.ignoreDeletes === true) {
            } else {
              qi.push(oi);
            }
            if (historyOnly && i === count) {
              iter.stop();
            }
          }
        });
        (async () => {
          for await (const s of iter.status()) {
            switch (s.type) {
              case "heartbeat":
                if (historyOnly) {
                  qi.push(() => {
                    qi.stop();
                  });
                }
            }
          }
        })().then();
        if (historyOnly && count === 0) {
          iter.stop();
        }
        iter.closed().then(() => {
          qi.push(() => {
            qi.stop();
          });
        });
        qi.iterClosed.then(() => {
          iter.stop();
        });
        return qi;
      }
      _chunkSubject(id) {
        return `$O.${this.name}.C.${id}`;
      }
      _metaSubject(n) {
        return `$O.${this.name}.M.${base64_1.Base64UrlPaddedCodec.encode(n)}`;
      }
      _metaSubjectAll() {
        return `$O.${this.name}.M.>`;
      }
      async init(opts = {}) {
        try {
          this.stream = objectStoreStreamName(this.name);
        } catch (err) {
          return Promise.reject(err);
        }
        const max_age = opts?.ttl || 0;
        delete opts.ttl;
        const { replicas } = opts;
        delete opts.replicas;
        const o = opts;
        this.allowBatched = o.allowBatched === true;
        delete o.allowBatched;
        const sc = Object.assign({ max_age }, opts);
        sc.name = this.stream;
        sc.allow_direct = true;
        sc.allow_rollup_hdrs = true;
        sc.num_replicas = replicas || 1;
        sc.discard = internal_2.DiscardPolicy.New;
        sc.subjects = [`$O.${this.name}.C.>`, `$O.${this.name}.M.>`];
        const apiLvl = this.js.nc.info?.api_lvl ?? 0;
        if (this.allowBatched) {
          if (apiLvl < 4) {
            return Promise.reject(new Error("server does not support batched publishes"));
          }
          sc.allow_batched = true;
        }
        if (opts.placement) {
          sc.placement = opts.placement;
        }
        if (opts.metadata) {
          sc.metadata = opts.metadata;
        }
        if (typeof opts.compression === "boolean") {
          sc.compression = opts.compression ? internal_2.StoreCompression.S2 : internal_2.StoreCompression.None;
        }
        let si;
        try {
          si = await this.jsm.streams.info(sc.name);
        } catch (err) {
          if (err.message === "stream not found") {
            si = await this.jsm.streams.add(sc);
          } else {
            throw err;
          }
        }
        if (this.allowBatched && si.config.allow_batched !== true) {
          return Promise.reject(new Error("existing bucket does not support batched publishes"));
        }
        return si;
      }
      static async create(js, name, opts = {}) {
        const jsm = await js.jetstreamManager();
        const os = new _ObjectStoreImpl(name, jsm, js);
        await os.init(opts);
        return os;
      }
    };
    exports2.ObjectStoreImpl = ObjectStoreImpl;
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/internal_mod.js
var require_internal_mod4 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/internal_mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.setSha256Backend = exports2.getSha256Backend = exports2.Base64UrlPaddedCodec = exports2.Base64UrlCodec = exports2.Base64Codec = exports2.Objm = exports2.StorageType = void 0;
    var types_1 = require_types4();
    Object.defineProperty(exports2, "StorageType", { enumerable: true, get: function() {
      return types_1.StorageType;
    } });
    var objectstore_1 = require_objectstore();
    Object.defineProperty(exports2, "Objm", { enumerable: true, get: function() {
      return objectstore_1.Objm;
    } });
    var base64_1 = require_base64();
    Object.defineProperty(exports2, "Base64Codec", { enumerable: true, get: function() {
      return base64_1.Base64Codec;
    } });
    Object.defineProperty(exports2, "Base64UrlCodec", { enumerable: true, get: function() {
      return base64_1.Base64UrlCodec;
    } });
    Object.defineProperty(exports2, "Base64UrlPaddedCodec", { enumerable: true, get: function() {
      return base64_1.Base64UrlPaddedCodec;
    } });
    var sha256_1 = require_sha2562();
    Object.defineProperty(exports2, "getSha256Backend", { enumerable: true, get: function() {
      return sha256_1.getSha256Backend;
    } });
    Object.defineProperty(exports2, "setSha256Backend", { enumerable: true, get: function() {
      return sha256_1.setSha256Backend;
    } });
  }
});

// ../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/mod.js
var require_mod7 = __commonJS({
  "../../node_modules/.pnpm/@nats-io+obj@3.4.0/node_modules/@nats-io/obj/lib/mod.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.setSha256Backend = exports2.getSha256Backend = exports2.Base64UrlPaddedCodec = exports2.Base64UrlCodec = exports2.Base64Codec = exports2.Objm = exports2.StorageType = void 0;
    var internal_mod_1 = require_internal_mod4();
    Object.defineProperty(exports2, "StorageType", { enumerable: true, get: function() {
      return internal_mod_1.StorageType;
    } });
    var internal_mod_2 = require_internal_mod4();
    Object.defineProperty(exports2, "Objm", { enumerable: true, get: function() {
      return internal_mod_2.Objm;
    } });
    var internal_mod_3 = require_internal_mod4();
    Object.defineProperty(exports2, "Base64Codec", { enumerable: true, get: function() {
      return internal_mod_3.Base64Codec;
    } });
    Object.defineProperty(exports2, "Base64UrlCodec", { enumerable: true, get: function() {
      return internal_mod_3.Base64UrlCodec;
    } });
    Object.defineProperty(exports2, "Base64UrlPaddedCodec", { enumerable: true, get: function() {
      return internal_mod_3.Base64UrlPaddedCodec;
    } });
    var internal_mod_4 = require_internal_mod4();
    Object.defineProperty(exports2, "getSha256Backend", { enumerable: true, get: function() {
      return internal_mod_4.getSha256Backend;
    } });
    Object.defineProperty(exports2, "setSha256Backend", { enumerable: true, get: function() {
      return internal_mod_4.setSha256Backend;
    } });
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/identity.js"(exports2) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports2.ALIAS = ALIAS;
    exports2.DOC = DOC;
    exports2.MAP = MAP;
    exports2.NODE_TYPE = NODE_TYPE;
    exports2.PAIR = PAIR;
    exports2.SCALAR = SCALAR;
    exports2.SEQ = SEQ;
    exports2.hasAnchor = hasAnchor;
    exports2.isAlias = isAlias;
    exports2.isCollection = isCollection;
    exports2.isDocument = isDocument;
    exports2.isMap = isMap;
    exports2.isNode = isNode;
    exports2.isPair = isPair;
    exports2.isScalar = isScalar;
    exports2.isSeq = isSeq;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/visit.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports2.visit = visit;
    exports2.visitAsync = visitAsync;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/directives.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports2.Directives = Directives;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/anchors.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports2.anchorIsValid = anchorIsValid;
    exports2.anchorNames = anchorNames;
    exports2.createNodeAnchors = createNodeAnchors;
    exports2.findNewAnchor = findNewAnchor;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/applyReviver.js"(exports2) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports2.applyReviver = applyReviver;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/toJS.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports2.toJS = toJS;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Node.js"(exports2) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports2.NodeBase = NodeBase;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Alias.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports2.Alias = Alias;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports2.Scalar = Scalar;
    exports2.isScalarValue = isScalarValue;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/createNode.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports2.createNode = createNode;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Collection.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports2.Collection = Collection;
    exports2.collectionFromPath = collectionFromPath;
    exports2.isEmptyPath = isEmptyPath;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyComment.js"(exports2) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports2.indentComment = indentComment;
    exports2.lineComment = lineComment;
    exports2.stringifyComment = stringifyComment;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/foldFlowLines.js"(exports2) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports2.FOLD_BLOCK = FOLD_BLOCK;
    exports2.FOLD_FLOW = FOLD_FLOW;
    exports2.FOLD_QUOTED = FOLD_QUOTED;
    exports2.foldFlowLines = foldFlowLines;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyString.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports2.stringifyString = stringifyString;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringify.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports2.createStringifyContext = createStringifyContext;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyPair.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports2.stringifyPair = stringifyPair;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/log.js"(exports2) {
    "use strict";
    var node_process = require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports2.debug = debug;
    exports2.warn = warn;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports2.addMergeToJSMap = addMergeToJSMap;
    exports2.isMergeKey = isMergeKey;
    exports2.merge = merge;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports2) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports2.addPairToJSMap = addPairToJSMap;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Pair.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports2.Pair = Pair;
    exports2.createPair = createPair;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyCollection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports2.stringifyCollection = stringifyCollection;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLMap.js"(exports2) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports2.YAMLMap = YAMLMap;
    exports2.findPair = findPair;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/map.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports2.map = map;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLSeq.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports2.YAMLSeq = YAMLSeq;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/seq.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports2.seq = seq;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/string.js"(exports2) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports2.string = string;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/null.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports2.nullTag = nullTag;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports2.boolTag = boolTag;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyNumber.js"(exports2) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports2.stringifyNumber = stringifyNumber;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/json/schema.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports2.schema = schema;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports2) {
    "use strict";
    var node_buffer = require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports2.binary = binary;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports2.createPairs = createPairs;
    exports2.pairs = pairs;
    exports2.resolvePairs = resolvePairs;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports2.YAMLOMap = YAMLOMap;
    exports2.omap = omap;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports2.falseTag = falseTag;
    exports2.trueTag = trueTag;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intBin = intBin;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports2.YAMLSet = YAMLSet;
    exports2.set = set;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports2.floatTime = floatTime;
    exports2.intTime = intTime;
    exports2.timestamp = timestamp;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/tags.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports2.coreKnownTags = coreKnownTags;
    exports2.getTags = getTags;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/Schema.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports2.Schema = Schema;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyDocument.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports2.stringifyDocument = stringifyDocument;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/Document.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports2.Document = Document;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/errors.js
var require_errors2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/errors.js"(exports2) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports2.YAMLError = YAMLError;
    exports2.YAMLParseError = YAMLParseError;
    exports2.YAMLWarning = YAMLWarning;
    exports2.prettifyError = prettifyError;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-props.js"(exports2) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token2 of tokens) {
        if (reqSpace) {
          if (token2.type !== "space" && token2.type !== "newline" && token2.type !== "comma")
            onError(token2.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token2.type !== "comment" && token2.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token2.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token2.source.includes("	")) {
              tab = token2;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token2.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token2.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token2.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token2;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token2, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token2.source.endsWith(":"))
              onError(token2.offset + token2.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token2, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token2, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token2.source} indicator`);
            if (found)
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.source} in ${flow ?? "collection"}`);
            found = token2;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token2, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token2;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports2.resolveProps = resolveProps;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-contains-newline.js"(exports2) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports2.containsNewline = containsNewline;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports2) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports2.flowIndentCheck = flowIndentCheck;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-map-includes.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports2.mapIncludes = mapIncludes;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-map.js"(exports2) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports2.resolveBlockMap = resolveBlockMap;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-seq.js"(exports2) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports2.resolveBlockSeq = resolveBlockSeq;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-end.js"(exports2) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep = "";
        for (const token2 of end) {
          const { source, type } = token2;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
              hasSpace = true;
              break;
            default:
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports2.resolveEnd = resolveEnd;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token2) => token2 && (token2.type === "block-map" || token2.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports2.resolveFlowCollection = resolveFlowCollection;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token2, onError, tagName, tag) {
      const coll = token2.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token2, onError, tag) : token2.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token2, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token2, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token2, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token2.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token2.type === "block-map" ? "map" : token2.type === "block-seq" ? "seq" : token2.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token2, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token2, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token2, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports2.composeCollection = composeCollection;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value += "\n";
          else
            sep = "\n";
        } else {
          value += sep + content;
          sep = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token2 = props[i];
        switch (token2.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token2.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token2, "MISSING_CHAR", message);
            }
            length += token2.source.length;
            comment = token2.source.substring(1);
            break;
          case "error":
            onError(token2, "UNEXPECTED_TOKEN", token2.message);
            length += token2.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token2.type}`;
            onError(token2, "UNEXPECTED_TOKEN", message);
            const ts = token2.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports2.resolveBlockScalar = resolveBlockScalar;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + match[1];
          sep = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports2.resolveFlowScalar = resolveFlowScalar;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token2, tagToken, onError) {
      const { value, type, comment, range } = token2.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token2, onError) : resolveFlowScalar.resolveFlowScalar(token2, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token2.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token2, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token2, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token2, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports2.composeScalar = composeScalar;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports2) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports2.emptyScalarPosition = emptyScalarPosition;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-node.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token2, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token2.type) {
        case "alias":
          node = composeAlias(ctx, token2, onError);
          if (anchor || tag)
            onError(token2, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token2, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token2, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token2, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token2.type === "error" ? token2.message : `Unsupported token (type: ${token2.type})`;
          onError(token2, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token2.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token2, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token2.type === "scalar" && token2.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token2;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token2 = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token2, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports2.composeEmptyNode = composeEmptyNode;
    exports2.composeNode = composeNode;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-doc.js"(exports2) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports2.composeDoc = composeDoc;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors2();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token2 of tokens)
          yield* this.next(token2);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token2) {
        if (node_process.env.LOG_STREAM)
          console.dir(token2, { depth: null });
        switch (token2.type) {
          case "directive":
            this.directives.add(token2.source, (offset, message, warning) => {
              const pos = getErrorPos(token2);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token2.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token2, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token2, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token2.source);
            break;
          case "error": {
            const msg = token2.source ? `${token2.message}: ${JSON.stringify(token2.source)}` : token2.message;
            const error = new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token2.end, token2.offset + token2.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", `Unsupported token ${token2.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports2.Composer = Composer;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-scalar.js"(exports2) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors2();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token2, strict = true, onError) {
      if (token2) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token2.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token2, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token2, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token2, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token2 ? token2.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token2.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token2.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token2, source);
          break;
        case '"':
          setFlowScalarValue(token2, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token2, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token2, source, "scalar");
      }
    }
    function setBlockScalarValue(token2, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token2.type === "block-scalar") {
        const header = token2.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token2.source = body;
      } else {
        const { offset } = token2;
        const indent = "indent" in token2 ? token2.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token2 ? token2.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token2))
          if (key !== "type" && key !== "offset")
            delete token2[key];
        Object.assign(token2, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token2, source, type) {
      switch (token2.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token2.type = type;
          token2.source = source;
          break;
        case "block-scalar": {
          const end = token2.props.slice(1);
          let oa = source.length;
          if (token2.props[0].type === "block-scalar-header")
            oa -= token2.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token2.props;
          Object.assign(token2, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token2.offset + source.length;
          const nl = { type: "newline", offset, indent: token2.indent, source: "\n" };
          delete token2.items;
          Object.assign(token2, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token2 ? token2.indent : -1;
          const end = "end" in token2 && Array.isArray(token2.end) ? token2.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token2))
            if (key !== "type" && key !== "offset")
              delete token2[key];
          Object.assign(token2, { type, indent, source, end });
        }
      }
    }
    exports2.createScalarToken = createScalarToken;
    exports2.resolveAsScalar = resolveAsScalar;
    exports2.setScalarValue = setScalarValue;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-stringify.js"(exports2) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token2) {
      switch (token2.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token2.props)
            res += stringifyToken(tok);
          return res + token2.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token2.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token2.start.source;
          for (const item of token2.items)
            res += stringifyItem(item);
          for (const st of token2.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token2);
          if (token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token2.source;
          if ("end" in token2 && token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports2.stringify = stringify;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-visit.js"(exports2) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token2 = item[field];
        if (token2 && "items" in token2) {
          for (let i = 0; i < token2.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token2.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token2.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports2.visit = visit;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst.js"(exports2) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token2) => !!token2 && "items" in token2;
    var isScalar = (token2) => !!token2 && (token2.type === "scalar" || token2.type === "single-quoted-scalar" || token2.type === "double-quoted-scalar" || token2.type === "block-scalar");
    function prettyToken(token2) {
      switch (token2) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token2);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports2.createScalarToken = cstScalar.createScalarToken;
    exports2.resolveAsScalar = cstScalar.resolveAsScalar;
    exports2.setScalarValue = cstScalar.setScalarValue;
    exports2.stringify = cstStringify.stringify;
    exports2.visit = cstVisit.visit;
    exports2.BOM = BOM;
    exports2.DOCUMENT = DOCUMENT;
    exports2.FLOW_END = FLOW_END;
    exports2.SCALAR = SCALAR;
    exports2.isCollection = isCollection;
    exports2.isScalar = isScalar;
    exports2.prettyToken = prettyToken;
    exports2.tokenType = tokenType;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/lexer.js"(exports2) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports2.Lexer = Lexer;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/line-counter.js"(exports2) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports2.LineCounter = LineCounter;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/parser.js
var require_parser2 = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/parser.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token2) {
      switch (token2?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token2 = error ?? this.stack.pop();
        if (!token2) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token2;
        } else {
          const top = this.peek(1);
          if (token2.type === "block-scalar") {
            token2.indent = "indent" in top ? top.indent : 0;
          } else if (token2.type === "flow-collection" && top.type === "document") {
            token2.indent = 0;
          }
          if (token2.type === "flow-collection")
            fixFlowSeqItems(token2);
          switch (top.type) {
            case "document":
              top.value = token2;
              break;
            case "block-scalar":
              top.props.push(token2);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token2, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token2;
              } else {
                Object.assign(it, { key: token2, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token2 });
              else
                it.value = token2;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token2, sep: [] });
              else if (it.sep)
                it.value = token2;
              else
                Object.assign(it, { key: token2, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token2);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token2.type === "block-map" || token2.type === "block-seq")) {
            const last = token2.items[token2.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token2.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token2.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token2.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token2) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token2.end)
              token2.end.push(this.sourceToken);
            else
              token2.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports2.Parser = Parser;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/public-api.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors2();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser2();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports2.parse = parse;
    exports2.parseAllDocuments = parseAllDocuments;
    exports2.parseDocument = parseDocument;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors2();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser2();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports2.Composer = composer.Composer;
    exports2.Document = Document.Document;
    exports2.Schema = Schema.Schema;
    exports2.YAMLError = errors.YAMLError;
    exports2.YAMLParseError = errors.YAMLParseError;
    exports2.YAMLWarning = errors.YAMLWarning;
    exports2.Alias = Alias.Alias;
    exports2.isAlias = identity.isAlias;
    exports2.isCollection = identity.isCollection;
    exports2.isDocument = identity.isDocument;
    exports2.isMap = identity.isMap;
    exports2.isNode = identity.isNode;
    exports2.isPair = identity.isPair;
    exports2.isScalar = identity.isScalar;
    exports2.isSeq = identity.isSeq;
    exports2.Pair = Pair.Pair;
    exports2.Scalar = Scalar.Scalar;
    exports2.YAMLMap = YAMLMap.YAMLMap;
    exports2.YAMLSeq = YAMLSeq.YAMLSeq;
    exports2.CST = cst;
    exports2.Lexer = lexer.Lexer;
    exports2.LineCounter = lineCounter.LineCounter;
    exports2.Parser = parser.Parser;
    exports2.parse = publicApi.parse;
    exports2.parseAllDocuments = publicApi.parseAllDocuments;
    exports2.parseDocument = publicApi.parseDocument;
    exports2.stringify = publicApi.stringify;
    exports2.visit = visit.visit;
    exports2.visitAsync = visit.visitAsync;
  }
});

// ../connector-core/dist/relay.js
var import_node_net2 = require("node:net");

// ../../packages/core/dist/launch-material.js
var import_node_fs = require("node:fs");

// ../../packages/core/dist/secret-fs.js
var isWin = process.platform === "win32";

// ../../packages/core/dist/launch-material.js
var LAUNCH_MATERIAL_ENV = "COTAL_LAUNCH_MATERIAL";
function readLaunchMaterial(path) {
  let raw;
  try {
    if (process.platform !== "win32") {
      const mode = (0, import_node_fs.statSync)(path).mode & 511;
      if (mode & 63)
        throw new Error(`is readable beyond its owner (mode ${mode.toString(8)}) - refusing to read connection material out of a file other local users can open`);
    }
    raw = (0, import_node_fs.readFileSync)(path, "utf8");
  } catch (e) {
    throw new Error(`launch material: cannot read ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`launch material: ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`launch material: ${path} must contain a JSON object`);
  return validate(parsed, path);
}
function validate(raw, path) {
  const material = {};
  const str = (key) => {
    const v = raw[key];
    if (v === void 0)
      return;
    if (typeof v !== "string" || !v.trim())
      throw new Error(`launch material: ${path} has a ${key} that is not a non-empty string`);
    material[key] = v;
  };
  str("servers");
  str("creds");
  str("token");
  str("controlToken");
  if (raw.eventsRequired !== void 0) {
    if (raw.eventsRequired !== true)
      throw new Error(`launch material: ${path} has eventsRequired that is not exactly true`);
    material.eventsRequired = true;
  }
  if (raw.userAuth !== void 0) {
    const u = raw.userAuth;
    if (typeof u !== "object" || u === null || Array.isArray(u))
      throw new Error(`launch material: ${path} has a userAuth that is not an object`);
    const { owner, actor, sentinelCredsPath, bearerCmd } = u;
    const named = { owner, actor, sentinelCredsPath };
    for (const [k, v] of Object.entries(named))
      if (typeof v !== "string" || !v.trim())
        throw new Error(`launch material: ${path} has a userAuth.${k} that is not a non-empty string`);
    if (!Array.isArray(bearerCmd) || bearerCmd.length === 0 || !bearerCmd.every((a) => typeof a === "string" && a))
      throw new Error(`launch material: ${path} has a userAuth.bearerCmd that is not a non-empty array of strings`);
    material.userAuth = {
      owner,
      actor,
      sentinelCredsPath,
      bearerCmd
    };
  }
  if (Object.keys(material).length === 0)
    throw new Error(`launch material: ${path} carries nothing this reader recognises. A launch that references material and supplies none is a broken launcher, not an open-mode launch, so it is refused rather than defaulted.`);
  return material;
}

// ../connector-core/dist/session-env.js
var DIRECT_MATERIAL_VARS = [
  "COTAL_CREDS",
  "COTAL_SERVERS",
  "COTAL_TOKEN",
  "COTAL_OWNER",
  "COTAL_ACTOR",
  "COTAL_SENTINEL_CREDS",
  "COTAL_BEARER_CMD",
  "COTAL_EVENTS_REQUIRED",
  // The control token belongs here for a reason that is not symmetry. Once a launcher-spawned seat
  // carries a material pointer in its environment, anything that INHERITS that environment and then
  // sets COTAL_CONTROL_TOKEN by hand has two answers for one question, and controlFromEnv would
  // silently prefer the inherited one - handing a process the OUTER seat's control endpoint while
  // its own explicit token sat unused. That is not hypothetical: it is what a test harness spreading
  // `...process.env` does, and this whole change exists because that spread used to be invisible.
  "COTAL_CONTROL_TOKEN",
  // A join link is connection material in one string: it carries the server, the auth and the space.
  // Left off this list, a launch with both a material file and a link resolved the conflict by
  // precedence and said nothing, which is the same silent answer to "who is this session" that the
  // credential pair is refused for.
  "COTAL_LINK"
];
function readMaterial(env) {
  const path = env[LAUNCH_MATERIAL_ENV]?.trim();
  if (!path)
    return void 0;
  const direct = DIRECT_MATERIAL_VARS.filter((k) => env[k]?.trim());
  if (direct.length)
    throw new Error(`COTAL config: this launch carries connection material BOTH as ${LAUNCH_MATERIAL_ENV} and as ${direct.join(", ")}. One launch carries one identity plane - drop the direct variables, or drop the material file.`);
  return readLaunchMaterial(path);
}
function controlFromEnv(env = process.env) {
  const path = env.COTAL_CONTROL_SOCKET?.trim();
  const token2 = readMaterial(env)?.controlToken ?? env.COTAL_CONTROL_TOKEN?.trim();
  if (path && token2)
    return { path, token: token2 };
  if (!path && !token2)
    return void 0;
  if (path)
    throw new Error("COTAL config: COTAL_CONTROL_SOCKET is set but no control token could be resolved - neither the launch material nor COTAL_CONTROL_TOKEN carries one. Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.");
  throw new Error("COTAL config: a control token was supplied but COTAL_CONTROL_SOCKET is unset, so there is no socket to authenticate against. Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.");
}
function hasIdentity(env = process.env) {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
}

// ../../packages/core/dist/subjects.js
function assertValidOwnerToken(owner) {
  if (typeof owner !== "string" || !/^[A-Za-z0-9_]+$/.test(owner))
    throw new Error(`invalid owner/actor token "${owner}": must be a single NATS-safe token ([A-Za-z0-9_]) - no dots, '*', '>', or '-'. A separator or wildcard in an id is lane breakout or aliasing, and '-' is reserved as the principal name-form separator, so it is rejected rather than silently rewritten.`);
  return owner;
}
var LIFECYCLE_TOKEN = /^[a-z0-9]{26,32}$/;
function assertLifecycleToken(v, what = "lifecycleUid") {
  if (!LIFECYCLE_TOKEN.test(v))
    throw new Error(`${what} "${v}" is not a valid lifecycle token ([a-z0-9]{26,32})`);
  return v;
}

// ../../packages/core/dist/endpoint-subjects.js
var RESERVED_COMMANDS = Object.freeze(["describe", "cancel"]);
var ENDPOINT_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
var COMMAND = /^[a-z0-9-]{1,32}$/;
var ID = /^[A-Za-z0-9_-]{1,64}$/;
function endpointToken(name) {
  const labels = name.split(".");
  for (const l of labels) {
    if (!ENDPOINT_LABEL.test(l))
      throw new Error(`endpoint name label "${l}" in "${name}" is not DNS-shaped ([a-z0-9]([a-z0-9-]*[a-z0-9])?)`);
  }
  const tok = labels.join("_");
  if (tok.length > 64)
    throw new Error(`endpoint name token "${tok}" exceeds 64 characters`);
  return tok;
}
function assertIdToken(v, what = "id") {
  if (!ID.test(v))
    throw new Error(`${what} "${v}" is not a valid id token ([A-Za-z0-9_-]{1,64})`);
  return v;
}
function assertPoolToken(pool) {
  if (!COMMAND.test(pool))
    throw new Error(`pool "${pool}" is not a valid pool token ([a-z0-9-]{1,32})`);
  return pool;
}
function assertBoundedOwner(v, what) {
  assertValidOwnerToken(v);
  if (v.length > 64)
    throw new Error(`${what} "${v}" exceeds 64 characters`);
  return v;
}
var EP_AUTHZ_MODES = Object.freeze(["self", "owner", "any", "child", "ledger", "handle", "exact"]);
var AUTHZ_SET = new Set(EP_AUTHZ_MODES);

// ../../packages/core/dist/endpoint-binding.js
var import_jetstream2 = __toESM(require_mod4(), 1);
var import_transport_node2 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/endpoint-records.js
var import_kv = __toESM(require_mod6(), 1);

// ../../packages/core/dist/canonical.js
var import_node_crypto = require("node:crypto");
var import_json_canonicalize = __toESM(require_index_umd(), 1);
var DIGEST_PREFIX = "sha256:";
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 56320 && n <= 57343))
        return true;
      i++;
    } else if (c >= 56320 && c <= 57343) {
      return true;
    }
  }
  return false;
}
function assertInterchangeable(v, path) {
  if (v === null)
    return;
  switch (typeof v) {
    case "string":
      if (hasLoneSurrogate(v))
        throw new Error(`canonicalJson: lone surrogate in string at ${path} (I-JSON violation)`);
      return;
    case "number":
      if (!Number.isFinite(v))
        throw new Error(`canonicalJson: non-finite number at ${path}`);
      return;
    case "boolean":
      return;
    case "undefined":
      throw new Error(`canonicalJson: undefined at ${path} (strict mode never coerces to null)`);
    case "object": {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype)
          throw new Error(`canonicalJson: non-ordinary array at ${path} (a subclassed/exotic array canonicalizes through projections)`);
        for (const k of Reflect.ownKeys(v)) {
          if (typeof k !== "string")
            throw new Error(`canonicalJson: symbol-keyed own property on array at ${path} (invisible to canonicalization; refusing the projection)`);
          if (k === "length")
            continue;
          if (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length)
            throw new Error(`canonicalJson: non-index own property "${k}" on array at ${path} (invisible to canonicalization; refusing the projection)`);
        }
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (d === void 0)
            throw new Error(`canonicalJson: hole at ${path}[${i}] (a hole would be coerced to null; refusing the projection)`);
          if (!d.enumerable || d.get !== void 0 || d.set !== void 0)
            throw new Error(`canonicalJson: non-enumerable or accessor element at ${path}[${i}] (refusing the projection)`);
          assertInterchangeable(v[i], `${path}[${i}]`);
        }
        return;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new Error(`canonicalJson: non-plain object at ${path} (a class/exotic instance canonicalizes through projections like toJSON; only plain data objects are interchangeable)`);
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== "string")
          throw new Error(`canonicalJson: symbol-keyed own property at ${path} (invisible to canonicalization; refusing the projection)`);
        if (hasLoneSurrogate(k))
          throw new Error(`canonicalJson: lone surrogate in key at ${path}.${k}`);
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d.enumerable)
          throw new Error(`canonicalJson: non-enumerable own property "${k}" at ${path} (invisible to canonicalization; refusing the projection)`);
        if (d.get !== void 0 || d.set !== void 0)
          throw new Error(`canonicalJson: accessor property "${k}" at ${path} (a getter is code, not data; refusing the projection)`);
        assertInterchangeable(v[k], `${path}.${k}`);
      }
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}
function canonicalJson(value) {
  assertInterchangeable(value, "$");
  return (0, import_json_canonicalize.canonicalizeEx)(value, { undefinedInArrayToNull: false });
}
function contractDigest(value) {
  return DIGEST_PREFIX + (0, import_node_crypto.createHash)("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ../../packages/core/dist/safe-pattern.js
var CHOICE_SAT = 1 << 20;

// ../../packages/core/dist/endpoint-error.js
var EP_ERROR_CODES = Object.freeze([
  "bad-request",
  "unsupported-version",
  "op-mismatch",
  "class-mismatch",
  "target-mismatch",
  "sender-mismatch",
  "unauthenticated",
  "permission-denied",
  "not-found",
  "already-exists",
  "conflict",
  "contract-mismatch",
  "contract-invalid",
  "failed-precondition",
  "deadline-exceeded",
  "cancelled",
  "expired",
  "unavailable",
  "unimplemented",
  "resource-exhausted",
  "internal"
]);
var EpEnvelopeError = class extends Error {
  code;
  details;
  outcome;
  constructor(code, message, details, outcome) {
    super(message);
    this.code = code;
    this.details = details;
    this.outcome = outcome;
    this.name = "EpEnvelopeError";
  }
  toEpError() {
    return {
      code: this.code,
      message: this.message,
      ...this.details ? { details: this.details } : {},
      ...this.outcome ? { outcome: this.outcome } : {}
    };
  }
};

// ../../packages/core/dist/contract-manifest.js
var HEX64 = /^[0-9a-f]{64}$/;
function contractRefToHex(ref) {
  const hex = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref;
  if (!HEX64.test(hex))
    throw new EpEnvelopeError("contract-invalid", `contract reference ${JSON.stringify(ref)} is not a sha256 digest; a garbled reference never resolves (SPEC 13.7)`);
  return hex;
}
var sha256Ref = (hex) => `sha256:${hex}`;
function buildContractClosureManifest(rootRef, memberRefs) {
  const root = sha256Ref(contractRefToHex(rootRef));
  const members = [...new Set(memberRefs.map((r) => sha256Ref(contractRefToHex(r))))].sort();
  return { v: 1, root, members };
}

// ../../packages/core/dist/schema-profile.js
var SCHEMA_PROFILE = Object.freeze({
  /** One schema document's canonical form, bytes. */
  maxDocumentBytes: 256 * 1024,
  /** The complete resolved closure (root + digest-referenced members), bytes. */
  maxClosureBytes: 1024 * 1024,
  /** Structural nesting depth of any document. */
  maxDepth: 32,
  // THERE IS DELIBERATELY NO SUBSCHEMA-NODE BOUND HERE, and this note is the guard on that: a node
  // ceiling was proposed twice, and the second attempt was killed by the measurement it asked for.
  //
  // The proposal was to refuse a "pathological" schema by counting subschema nodes before compiling
  // — deterministic, host-independent, and unlike a timer, immune to the machine. Two bases were
  // offered for the constant, and both are dead:
  //
  //   COST. There is no knee. Compile cost varies by an ORDER OF MAGNITUDE across schema shapes at a
  //   single node count, the spread itself grows with node count, and no two measurements of one
  //   cell have ever agreed. NO FIGURE IS QUOTED HERE ON PURPOSE. Six runs of the same quantity
  //   across four parties spanned a factor of six, agreeing only where one had read another's number
  //   first, so any single ratio in this comment would be an unreplicated observation presented as a
  //   measurement. Node count is a sound bound and a poor predictor: a single scalar is set by the
  //   worst family and refuses the best, rejecting a cheap union while admitting a far costlier
  //   object schema. THAT SHAPE is what defeats the proposal, and unlike a ratio it survives a re-run
  //   on another host. To see the numbers for your host, run the probe named below.
  //
  //   CRASH. A 2048-node patterned-properties document was observed to RangeError in Ajv's codegen
  //   at ~186KB — inside `maxDocumentBytes` — which looked like a hard edge worth standing in front
  //   of. It is not an edge — not because it is unstable (re-measured for #1551: the SAME 2062-
  //   property/187545-byte document RangeErrors 15/15 fresh processes at this profile's default
  //   stack, and the reported cold-then-warm-compiles pattern did not reproduce once) — but because
  //   the edge is a function of the STACK BUDGET, not the schema: it moves linearly with
  //   `--stack-size` (measured 256KB→~460, 8MB default→~2050, on the pin this profile ships;
  //   flattening ajv's codegen with `allErrors: true` moves the same edge to roughly 3.4x wider at
  //   any given stack budget, never removes it) and by a fraction of a property per extra caller
  //   frame burned before the compile call. A frozen node-count constant cannot express an edge that
  //   moves with the CALLER's stack depth, which is outside this module's control.
  //
  //   AND THE VALUE WAS UNSAFE ON AN AXIS NOBODY MEASURED. Under `node --stack-size=256` a 512-node
  //   object RangeErrors, while 384 compiles — so the proposed `maxSchemaNodes: 512` did not hold
  //   at a supported process configuration. A bound that is not a bound across the axes it ships on
  //   is not a bound.
  //
  // WHAT STANDS IN ITS PLACE is what was doing the work the whole time: `maxDocumentBytes` and
  // `maxClosureBytes`, `maxDepth`, `maxRefChain`, `maxPatternChars`, the admitted-vocabulary
  // refusal, and — for exactly the codegen overflow above — the compile-error catch in
  // `compileWithinBudget`, which normalises a stack overflow to `contract-invalid` naming the
  // COMPILER's generated-code shape and the property count that triggered it, never the caller's
  // schema (#1551). That set refuses everything it refused before; removing an unfounded bound only
  // LOOSENS, and
  // loosening cannot break a contract that was already valid.
  //
  // BEFORE PROPOSING ONE AGAIN, run `implementations/manager/smoke/_probe-nodecount-rejected.ts`.
  // It MEASURES the spread and the crash boundary on your host, against the compiler that actually
  // ships, and reports no stored figures of its own. The first version of
  // this ceiling was derived from a corpus THE CEILING ITSELF BOUNDED — every synthetic above the
  // line was refused, so the calibration reported that nothing measured had exceeded the budget,
  // and the number was unfalsifiable the moment it shipped. Measure above the line, or do not set
  // the line.
  /** Digest-reference chain depth (root → member → member …). */
  maxRefChain: 32,
  /** Compile budget per closure, ms. */
  compileBudgetMs: 100,
  /** Bounded pattern complexity: max characters of any `pattern` / `patternProperties` regex. */
  maxPatternChars: 256,
  /** Per-value validation budget at the serving boundary, ms (§13.8 reference). REPORTED on the
   *  request path, not enforced — no available instrument can justify refusing a caller on it; see
   *  `reportValidateBudget` in endpoint-envelope.ts. */
  validateBudgetMs: 10,
  /** Compiled-schema cache entries (the SPEC's reference 256-entry LRU). */
  compiledCacheEntries: 256
});
var AJV_PROFILE_OPTIONS = Object.freeze({
  strict: false,
  // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
  // PINNED TRUE, not ajv's `false` default, for the flat code shape it produces (#1551).
  // `allErrors: false` makes ajv nest one continuation `if` per property in the generated
  // validator, so the compile of a wide object schema overflows the host call stack at a width
  // set by the STACK BUDGET, not by any ceiling this profile enforces — every document this
  // profile admits (bytes, depth, ref-chain, pattern length, vocabulary) can still fail to
  // compile purely on shape. `allErrors: true` builds the same validations as a flat sequence
  // instead, which does not remove the stack-bounded ceiling (ajv's codegen still recurses while
  // it builds the code tree) but moves it about 3.4x wider at any given stack budget: measured on
  // this pin, default 8MB stack SMALLEST_FAIL moved from 2055 properties to 6946, and
  // `--stack-size=256` moved from 494 to 1769 (one host, Node 24; the ratio is the stable
  // quantity, not the absolute counts — re-measure with a child process per candidate width, one
  // `--stack-size` per row, per issue #1551's method).
  //
  // Safe to flip only because it changes NO VERDICT this profile's own checks depend on: ajv
  // orders keyword/property evaluation identically regardless of `allErrors`, so `errors[0]` —
  // the only field any caller-facing message reads (`endpoint-envelope.ts` firstErrorDetail,
  // `endpoint-traits.ts` readSchema) — is byte-identical between the two settings for every
  // schema/instance pair tried, and `packages/core/smoke/schema-profile.smoke.ts`'s full 67-check
  // suite (every `refuses`/`ok` assertion, including the pattern safe-subset gate and the
  // admitted-vocabulary walk) passes unchanged under either setting. Nothing on the wire ever
  // reads ajv's full `errors` array, only its first entry, so `allErrors`'s extra collected
  // errors are never observed by a caller. If a future change makes any of that no longer true —
  // a caller starts reading `errors.length`, or a verdict diverges between the settings — this
  // pin must be re-measured before it stays.
  allErrors: true,
  validateFormats: false,
  loadSchema: void 0,
  // PINNED, never inherited from Ajv's default: the safe-pattern analyzer models `/u`
  // semantics exactly (astral atoms, surrogate refusals), so the engine MUST compile
  // `pattern` with the `u` flag. If this ever flipped, patterns would be proven under one
  // grammar and executed under another (an admitting under-approximation).
  unicodeRegExp: true,
  // PINNED for the same reason as `unicodeRegExp`, and discovered the same way — by checking what
  // an inherited default actually does rather than assuming it does nothing.
  //
  // Ajv defaults this to TRUE (`ajv@8.20.0/dist/core.js:83`), and with it on, a referenced schema
  // with no refs of its own is INLINED INTO ITS REFERRER'S GENERATED CODE. A closure is compiled by
  // ONE `ajv.compile` on the root, with members merely `addSchema`'d — so under inlining the
  // codegen units are NOT one-per-document: leaf members merge upward into the root's function.
  //
  // THE PER-DOCUMENT BOUNDS DEPEND ON THAT NOT HAPPENING. `maxDocumentBytes` and `maxDepth` are
  // enforced per document, and they are worth something only if a document is what gets compiled.
  // Under inlining, N members each comfortably inside the per-document bounds become ONE generated
  // function that no per-document bound describes — the check keeps passing while the thing it
  // claims to bound stops existing. `maxClosureBytes` still caps the aggregate, so this is not a
  // hole; it is the difference between a bound that means what it says and one that happens to be
  // covered by a neighbour.
  //
  // It is also observably load-bearing rather than theoretically so: flipping it changes compile
  // cost and changes the outcome of a high-fanout closure that otherwise compiles. `false` costs a
  // function call per referenced schema at validation time and buys the structural guarantee that
  // each referenced schema is its own compiled unit. On a DoS boundary a deterministic structure is
  // worth more than inlining's marginal speed.
  inlineRefs: false
});
function singleDocumentClosure(root) {
  const manifest = buildContractClosureManifest(contractDigest(root), []);
  return { manifest, closureDigest: contractDigest(manifest) };
}
var VOID_SCHEMA = Object.freeze({ type: "null" });
var VOID_SCHEMA_ARTIFACT_DIGEST = contractDigest(VOID_SCHEMA);
var VOID_SCHEMA_DIGEST = singleDocumentClosure(VOID_SCHEMA).closureDigest;
var SCHEMA_VALUED_KEYS = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "contentSchema", "additionalItems"];
var SCHEMA_VALUED_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];
var SCHEMA_VALUED_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
var SCALAR_KEYS = [
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "format",
  "contentEncoding",
  "contentMediaType",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "$comment",
  "$id",
  "$schema",
  "$ref",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$vocabulary"
];
var ADMITTED = /* @__PURE__ */ new Set([...SCHEMA_VALUED_KEYS, ...SCHEMA_VALUED_MAP_KEYS, ...SCHEMA_VALUED_LIST_KEYS, ...SCALAR_KEYS]);

// ../../packages/core/dist/endpoint-envelope.js
var EP_ERROR_SET = new Set(EP_ERROR_CODES);
var LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
var EXTENSION_CODE = new RegExp(`^${LABEL}(\\.${LABEL}){2,}$`);

// ../../packages/core/dist/endpoint-records.js
var qEndpoint = { name: "endpoint", assert: (v) => endpointToken(v) };
var qOwner = (name) => ({ name, assert: (v) => assertBoundedOwner(v, name) });
var qUid = (name) => ({ name, assert: (v) => assertLifecycleToken(v, name) });
var qId = (name) => ({ name, assert: (v) => assertIdToken(v, name) });
var LIFECYCLE_HEAD = {
  kind: "lifecycle",
  qualifiers: [qOwner("owner"), qOwner("actor")],
  split: false,
  writers: { spec: "minting-manager-commit", status: "minting-manager-commit" },
  mediation: "mediated"
};
var UID_RESERVATION = {
  kind: "uid",
  qualifiers: [qUid("lifecycleUid")],
  split: false,
  writers: { spec: "minting-authority", status: "minting-authority" },
  mediation: "mediated"
};
var OBLIGATION_EP_SENTINEL = "ep";
var OBLIGATION = {
  kind: "oblig",
  qualifiers: [
    { name: "targetUid", assert: (v) => v === OBLIGATION_EP_SENTINEL ? v : assertLifecycleToken(v, "targetUid") },
    qEndpoint,
    qOwner("cOwner"),
    qOwner("cActor"),
    qUid("cUid"),
    qId("id")
  ],
  split: false,
  writers: { spec: "admission-mediator", status: "admission-mediator" },
  mediation: "mediated"
};
var POLICY_VERSION = {
  kind: "policy",
  qualifiers: [qEndpoint, {
    name: "digestHex",
    assert: (v) => {
      if (!/^[0-9a-f]{64}$/.test(v))
        throw new Error(`policy digest ${JSON.stringify(v)} is not 64 lowercase hex chars (SPEC 13.7)`);
      return v;
    }
  }],
  split: false,
  writers: { spec: "provisioner-registration", status: "provisioner-registration" },
  mediation: "mediated"
};
var RETIREMENT_FRONTIER = {
  kind: "frontier",
  qualifiers: [qUid("lifecycleUid")],
  split: false,
  writers: { spec: "minting-authority", status: "minting-authority" },
  mediation: "mediated"
};
var GOVERN_HEAD = {
  kind: "govern",
  qualifiers: [qEndpoint],
  split: false,
  writers: { spec: "provisioner-registration", status: "provisioner-registration" },
  mediation: "mediated"
};
var RECORD_KINDS = {
  svc: {
    kind: "svc",
    qualifiers: [qEndpoint, qUid("instanceId")],
    split: true,
    writers: { spec: "provisioner-registration", status: "instance-commit-epoch-fenced" },
    mediation: "mediated"
  },
  signer: {
    kind: "signer",
    qualifiers: [qId("keyId")],
    split: true,
    writers: { spec: "operator-registry", status: "operator-registry" },
    mediation: "mediated"
  },
  handle: {
    // Issuer-namespaced (§13.9): two issuers can never collide or cross-revoke.
    kind: "handle",
    qualifiers: [qId("issuerKeyId"), qId("id")],
    split: true,
    writers: { spec: "issuer-create-only", status: "issuer-or-operator-monotonic" },
    mediation: "mediated"
  },
  contracts: {
    // Advisory browse index; `describe` is authoritative. Readers fail loud on invalid state.
    kind: "contracts",
    qualifiers: [qEndpoint],
    split: true,
    writers: { spec: "instance", status: "instance" },
    mediation: "direct"
  },
  goal: {
    kind: "goal",
    qualifiers: [qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("goalId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  goalidx: {
    // The MANAGER-ENDPOINT reconcile index (P2 item 2 must-5, Q-B): one atomic unsplit key per
    // IN-FLIGHT action goal, `goalidx.<e>.<cOwner>.<cActor>.<cUid>.<goalId>`, written CREATE-ONLY
    // by the goal-writer BEFORE the goal bind and DELETED at the terminal. It is the endpoint's
    // OWN durable list of accepted-but-unterminal goals: a successor incarnation (a manager
    // restart takes a fresh instanceId, so the in-memory acceptance map is gone) enumerates
    // `goalidx.<e>.>` over the provisioner and settles every orphan, never dropping an accepted
    // goal. NARROW by construction: a dedicated index the goal-writer alone writes — NOT a broad
    // read over the caller-scoped `goal.<triple>.>` records (the rejected sealed-scanner option).
    // The value carries the goal ref coordinates so the sweep rebuilds the GoalRef without parsing
    // owner/actor tokens out of the key.
    kind: "goalidx",
    qualifiers: [qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("goalId")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  goaleff: {
    // The at-most-one-launch election for ONE accepted action (§ S1): an atomic unsplit key,
    // written CREATE-ONLY by the effects executor that wins it and advanced by revision-CAS through
    // its phases. `<gen>` is the accepted submission's EPJ `sourceSeq` — the sequence it was
    // delivered at, carried verbatim into the acceptance fact — and it is the ONLY discriminator
    // available at the earliest coordinate: the sibling `goalidx` row is created BEFORE the bind
    // and therefore before any decision fact exists, so no decision sequence can key it.
    // The generation token also keeps this kind OUT of the one-use-forever trap `goalidx` is in: a
    // lawful later acceptance under the same `goalId` gets a different `<gen>`, so it takes a fresh
    // key rather than colliding with a permanent tombstone.
    kind: "goaleff",
    qualifiers: [qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("goalId"), qId("gen")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  epname: {
    // The durable claim on ONE agent name (§ S2): an atomic unsplit key, keyed by the NAME and NOT
    // by a caller triple, because the thing being made exclusive IS the name — two callers racing
    // for it must contend on one key, which a caller-scoped grammar would prevent by construction.
    kind: "epname",
    qualifiers: [qEndpoint, qId("nameToken")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  epmig: {
    // The endpoint's cutover manifest (§ S5): an atomic unsplit key, ONE per endpoint — never one
    // per caller and never one per run. It is the inventory a migration is performed against and
    // the durable record of the cutover runs performed against it, which is what stops a RUN
    // generation being reused by a later run. That run generation is scoped to cutover and is key
    // material nowhere else: the `<gen>` token on `goaleff` is the accepted submission's EPJ
    // `sourceSeq` and only that, and `goal`/`goalidx`/`goal….result` carry no generation at all.
    // Calling this "the durable source of the name generation" is what gave two different counters
    // one name, and two implementations reading it that way key the same election differently and
    // never meet inside it.
    kind: "epmig",
    qualifiers: [qEndpoint],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  cp: {
    kind: "cp",
    qualifiers: [qEndpoint, qId("token")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  lease: {
    // The item's acceptance identity (§13.2) keys the lease.
    kind: "lease",
    qualifiers: [qEndpoint, { name: "pool", assert: assertPoolToken }, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("id")],
    split: true,
    writers: { spec: "pool-owner-lease-command", status: "pool-owner-lease-command" },
    mediation: "mediated"
  },
  run: {
    // The WORKFLOW RUN record: `run.<endpoint>.<runId>`, the last-value-wins state beside the
    // append-only step journal on WFJ. The journal says what happened; this says what the run IS.
    //
    // It is a record rather than a journal entry precisely because it is last-value-wins: the
    // lease holder, the run's state, the artifact refs, and — the part that must never be
    // recomputed — the PIN SET resolved once at run start: seed, startedAt, yieldEvery, stepBudget,
    // effectCeiling, languageVersion. Every one of those selects which effects run, so a resume
    // reads them back and binds them rather than re-deriving them from its own host: `startedAt`
    // is the run's logical epoch, and a resumed run that took the resuming machine's clock would
    // measure an elapsed time the recorded run never saw.
    //
    // `<endpoint>` leads because the driver is hosted by an endpoint (the manager daemon), so a
    // retirement drain and a per-endpoint enumeration both work by prefix. It is a CORE kind and
    // not a registration: `registerRecordKind` reserves single-label names for core.
    kind: "run",
    qualifiers: [qEndpoint, qId("runId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  answer: {
    // The CHECKPOINT ANSWER: `answer.<endpoint>.<token>.<answerId>`, the payload half of a
    // checkpoint resume. The one-use settle fact stays the small arbiter of the race and NAMES the
    // answerId it accepted; this is where the value and the artifact digest live.
    //
    // `<answerId>` is in the KEY rather than one slot per token because a workflow checkpoint's
    // holder is the run driver and every resolver presents as it: keyed by presenter, two racing
    // resolvers overwrite one slot and the settle fact selects whichever wrote last instead of the
    // one that won. Per-answer keys plus a named winner is the discriminator that key lacked.
    //
    // ATOMIC and create-only: an answer is one thing that happened, written once before its token
    // is presented, never updated and never deleted.
    kind: "answer",
    qualifiers: [qEndpoint, qId("token"), qId("answerId")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  notice: {
    // The RUN NOTICE: `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>`, one bounded decision
    // record written onto the run and addressed to one agent, rendered ahead of that agent's next
    // turn. It is a record and NOT a channel post on purpose: a notice is program-authored bytes
    // moving toward an agent's context, and a channel post would put the program into the
    // conversation as a participant.
    //
    // `<addresseeId>` is DERIVED from the agent's name rather than being the name: an agent name is
    // dotted and a dot is the key separator, so a raw name would silently re-tokenize the key into
    // a different shape. The reader holds the handle and re-derives the same id, so per-addressee
    // enumeration is still one prefix scan.
    //
    // SPLIT because consumption is a fact somebody else establishes later: the spec is the notice
    // (immutable, create-only — a notice is something the program decided) and the status is its
    // consumption, which migrate reads to refuse moving a run whose notice has not landed yet.
    kind: "notice",
    qualifiers: [qEndpoint, qId("runId"), qId("addresseeId"), qId("noticeId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  program: {
    // The RUN PROGRAM: `program.<endpoint>.<runId>`, the source a run was started from, recorded
    // beside its spec so a resume, a takeover, or a hosting daemon's restart needs no file from
    // anybody. It is a record and not a field of the spec because the two are decided by
    // different principals at different times: the spec's pins are the driver's, resolved once at
    // activation, while the source is the author's, and a resume that hands over DIFFERENT source
    // is a fork rather than a resume (§14.5), which is a comparison this record exists to make.
    //
    // ATOMIC and create-only: what a run was started from is one fact, written once by the driver
    // that pinned the run and never updated. Run-pinned by key (`<endpoint>.<runId>`), so a
    // driver's grant can name exactly its own run's source and no other's.
    kind: "program",
    qualifiers: [qEndpoint, qId("runId")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  migration: {
    // The MIGRATION: `migration.<endpoint>.<runId>.<migrationId>`, one run's move onto edited
    // source — what the walk found, which refusals a person overrode, and who they were.
    //
    // ITS OWN KIND BECAUSE IT IS NEITHER HALF OF THE RUN RECORD. A run's spec is what the run IS,
    // decided once; its status is what the run is DOING, rewritten by every driver heartbeat. A
    // migration is neither: it is append-only history with an actor on it, and a run can be
    // migrated more than once. Last-value-wins would let the second migration erase the first's
    // history; create-only on the run record would collide with the run's own spec.
    //
    // `<migrationId>` is DERIVED FROM THE REPORT'S CONTENT, and that is not a stylistic choice: a
    // migration is decided from a dry walk that may be re-run after a crash, so the same decision
    // must land on the same record rather than filing a second one — and a counter would need a
    // reader-writer to allocate it, which is a second arbiter for a fact the content already
    // determines. The same reasoning as `notice`, for the same reason.
    //
    // SPLIT because deciding and APPLYING are different acts by different parties at different
    // times: the spec is the report (immutable — what the check found), the status is the commit
    // (create-only — which driver actually advanced the run, decided by the CAS and by nothing
    // else, so two drivers racing to apply one migration cannot both believe they did).
    kind: "migration",
    qualifiers: [qEndpoint, qId("runId"), qId("migrationId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated"
  },
  lifecycle: {
    // The optional per-UID append-only audit detail — never the authority (that is the HEAD).
    kind: "lifecycle",
    qualifiers: [qOwner("owner"), qOwner("actor"), qUid("lifecycleUid")],
    split: true,
    writers: { spec: "minting-manager-commit", status: "minting-manager-commit" },
    mediation: "mediated"
  }
};
var AUTHORITY_KIND_DEFS = [
  LIFECYCLE_HEAD,
  UID_RESERVATION,
  GOVERN_HEAD,
  OBLIGATION,
  POLICY_VERSION,
  RETIREMENT_FRONTIER
];
function freezeDef(def) {
  for (const q of def.qualifiers)
    Object.freeze(q);
  Object.freeze(def.qualifiers);
  Object.freeze(def.writers);
  return Object.freeze(def);
}
var registry = /* @__PURE__ */ new Map();
for (const def of [...Object.values(RECORD_KINDS), ...AUTHORITY_KIND_DEFS]) {
  freezeDef(def);
  const list = registry.get(def.kind) ?? [];
  list.push(def);
  registry.set(def.kind, list);
}
Object.freeze(AUTHORITY_KIND_DEFS);
Object.freeze(RECORD_KINDS);
var AUTHORITY_DEF_SET = new Set(AUTHORITY_KIND_DEFS);

// ../../packages/core/dist/endpoint-journal.js
var import_transport_node = __toESM(require_transport_node(), 1);
var IDEMPOTENCY_HORIZON_MS_DEFAULT = 24 * 60 * 60 * 1e3;
var RESULT_RETENTION_MS_DEFAULT = 24 * 60 * 60 * 1e3;
var RECEIPT_RETENTION_MS_DEFAULT = 90 * 24 * 60 * 60 * 1e3;

// ../../packages/core/dist/issued-authority.js
var import_jetstream = __toESM(require_mod4(), 1);
var AUTHORITY_STORE_IMMUTABLE_FLAGS = Object.freeze({ allow_rollup_hdrs: false, deny_delete: true, deny_purge: true });
var WRITE_ONCE_PER_KEY = Object.freeze({ max_msgs_per_subject: 1, discard: import_jetstream.DiscardPolicy.New, discard_new_per_subject: true });
var APPEND_ONLY_PER_KEY = Object.freeze({ max_msgs_per_subject: -1 });
var enc = new TextEncoder();
var dec = new TextDecoder("utf-8", { fatal: true });

// ../../packages/core/dist/run-admission.js
var enc2 = new TextEncoder();
var dec2 = new TextDecoder("utf-8", { fatal: true });

// ../../packages/core/dist/endpoint-binding.js
var EP_SUBMISSION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var EP_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var EP_INGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var EP_TIMER_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1e3;
var EP_AUTH_MARKER_TTL_MS = 60 * 60 * 1e3;
var AUTHORITY_HEAD_ARITY = new Map(AUTHORITY_KIND_DEFS.map((d) => [d.kind, 1 + d.qualifiers.length]));

// ../../packages/core/dist/endpoint-grants.js
var BASELINE_DELIVERY_ENDPOINT = "delivery";
var BASELINE_DELIVERY_COMMANDS = Object.freeze(["join", "leave", "list"]);
var BASELINE_LIFECYCLE_ENDPOINT = "manager";
var BASELINE_SELF_LIFECYCLE_COMMANDS = Object.freeze(["stop", "turn-pending", "turn-yield", "run-answer"]);
var SPAWN_CREATE_COMMANDS = Object.freeze(["spawn"]);
var SPAWN_OWNER_LIFECYCLE_COMMANDS = Object.freeze(["despawn", "attach"]);
var OPERATOR_SEAT_COMMANDS = Object.freeze(["input", "turn"]);
var SPAWN_SERVICE_COMMANDS = Object.freeze(["define-persona", "inspect", "list-personas", "show-persona", "goal-result"]);
var RUN_WRITE_COMMANDS = Object.freeze(["run-start", "run-resume"]);
var RUN_READ_COMMANDS = Object.freeze(["run-status", "run-ps"]);
var MANAGER_READ_COMMANDS = Object.freeze(["status", "ps", "slots", "inspect", "models", "list-personas", "show-persona", "goal-result"]);
var MANAGER_ADMIN_COMMANDS = Object.freeze([
  "purge",
  "launch",
  "resume-preserved",
  "commit-resume",
  "finalize-resume",
  "prepare-preservation",
  "commit-preservation",
  "abort-preservation",
  "transcript-receive"
]);
var GOAL_BEARING_COMMANDS = Object.freeze(["spawn", "launch"]);
var GOAL_BEARING_SET = new Set(GOAL_BEARING_COMMANDS);
var REPEAT_SAFE_COMMANDS = Object.freeze({
  [BASELINE_LIFECYCLE_ENDPOINT]: Object.freeze(["status", "ps", "slots", "inspect", "list-personas", "show-persona", "run-status", "run-ps", "goal-result"]),
  [BASELINE_DELIVERY_ENDPOINT]: Object.freeze(["list"])
});
var REPEAT_SAFE_SNAP = new Map(Object.entries(REPEAT_SAFE_COMMANDS).map(([endpoint, commands]) => [endpoint, new Set(commands)]));
var DELIVERY_COMMANDS_SNAP = Object.freeze([...BASELINE_DELIVERY_COMMANDS]);
var SELF_LIFECYCLE_SNAP = Object.freeze([...BASELINE_SELF_LIFECYCLE_COMMANDS]);
var SPAWN_CREATE_SNAP = Object.freeze([...SPAWN_CREATE_COMMANDS]);
var SPAWN_OWNER_SNAP = Object.freeze([...SPAWN_OWNER_LIFECYCLE_COMMANDS]);
var OPERATOR_SEAT_SNAP = Object.freeze([...OPERATOR_SEAT_COMMANDS]);
var SPAWN_SERVICE_SNAP = Object.freeze([...SPAWN_SERVICE_COMMANDS]);
var RUN_WRITE_SNAP = Object.freeze([...RUN_WRITE_COMMANDS]);
var RUN_READ_SNAP = Object.freeze([...RUN_READ_COMMANDS]);
var MANAGER_READ_SNAP = Object.freeze([...MANAGER_READ_COMMANDS]);
var MANAGER_ADMIN_SNAP = Object.freeze([...MANAGER_ADMIN_COMMANDS]);

// ../../packages/core/dist/lifecycle-state.js
var dec3 = new TextDecoder();

// ../../packages/core/dist/lifecycle-saga.js
var enc3 = new TextEncoder();
var dec4 = new TextDecoder();

// ../../packages/core/dist/endpoint-cluster.js
var TRAIT_GUARDED = "ai.cotal.guarded";
var TRAIT_PRICED = "ai.cotal.priced";
var GOVERNED_TRAIT_URNS = Object.freeze([TRAIT_GUARDED, TRAIT_PRICED]);

// ../../packages/core/dist/evict.js
var import_transport_node3 = __toESM(require_transport_node(), 1);

// ../../node_modules/.pnpm/@nats-io+jwt@0.0.10-5/node_modules/@nats-io/jwt/esm/jwt.js
var Types;
(function(Types2) {
  Types2["Operator"] = "operator";
  Types2["Account"] = "account";
  Types2["User"] = "user";
  Types2["Activation"] = "activation";
  Types2["AuthorizationResponse"] = "authorization_response";
})(Types || (Types = {}));
(function(nacl2) {
  "use strict";
  var u64 = function(h, l) {
    this.hi = h | 0 >>> 0;
    this.lo = l | 0 >>> 0;
  };
  var gf = function(init) {
    var i, r = new Float64Array(16);
    if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
    return r;
  };
  var randombytes = function() {
    throw new Error("no PRNG");
  };
  var _0 = new Uint8Array(16);
  var _9 = new Uint8Array(32);
  _9[0] = 9;
  var gf0 = gf(), gf1 = gf([
    1
  ]), _121665 = gf([
    56129,
    1
  ]), D = gf([
    30883,
    4953,
    19914,
    30187,
    55467,
    16705,
    2637,
    112,
    59544,
    30585,
    16505,
    36039,
    65139,
    11119,
    27886,
    20995
  ]), D2 = gf([
    61785,
    9906,
    39828,
    60374,
    45398,
    33411,
    5274,
    224,
    53552,
    61171,
    33010,
    6542,
    64743,
    22239,
    55772,
    9222
  ]), X = gf([
    54554,
    36645,
    11616,
    51542,
    42930,
    38181,
    51040,
    26924,
    56412,
    64982,
    57905,
    49316,
    21502,
    52590,
    14035,
    8553
  ]), Y = gf([
    26200,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214
  ]), I = gf([
    41136,
    18958,
    6951,
    50414,
    58488,
    44335,
    6150,
    12099,
    55207,
    15867,
    153,
    11085,
    57099,
    20417,
    9344,
    11139
  ]);
  function L32(x, c) {
    return x << c | x >>> 32 - c;
  }
  function ld32(x, i) {
    var u = x[i + 3] & 255;
    u = u << 8 | x[i + 2] & 255;
    u = u << 8 | x[i + 1] & 255;
    return u << 8 | x[i + 0] & 255;
  }
  function dl64(x, i) {
    var h = x[i] << 24 | x[i + 1] << 16 | x[i + 2] << 8 | x[i + 3];
    var l = x[i + 4] << 24 | x[i + 5] << 16 | x[i + 6] << 8 | x[i + 7];
    return new u64(h, l);
  }
  function st32(x, j, u) {
    var i;
    for (i = 0; i < 4; i++) {
      x[j + i] = u & 255;
      u >>>= 8;
    }
  }
  function ts64(x, i, u) {
    x[i] = u.hi >> 24 & 255;
    x[i + 1] = u.hi >> 16 & 255;
    x[i + 2] = u.hi >> 8 & 255;
    x[i + 3] = u.hi & 255;
    x[i + 4] = u.lo >> 24 & 255;
    x[i + 5] = u.lo >> 16 & 255;
    x[i + 6] = u.lo >> 8 & 255;
    x[i + 7] = u.lo & 255;
  }
  function vn(x, xi, y, yi, n) {
    var i, d = 0;
    for (i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
    return (1 & d - 1 >>> 8) - 1;
  }
  function crypto_verify_16(x, xi, y, yi) {
    return vn(x, xi, y, yi, 16);
  }
  function crypto_verify_32(x, xi, y, yi) {
    return vn(x, xi, y, yi, 32);
  }
  function core(out, inp, k, c, h) {
    var w = new Uint32Array(16), x = new Uint32Array(16), y = new Uint32Array(16), t = new Uint32Array(4);
    var i, j, m;
    for (i = 0; i < 4; i++) {
      x[5 * i] = ld32(c, 4 * i);
      x[1 + i] = ld32(k, 4 * i);
      x[6 + i] = ld32(inp, 4 * i);
      x[11 + i] = ld32(k, 16 + 4 * i);
    }
    for (i = 0; i < 16; i++) y[i] = x[i];
    for (i = 0; i < 20; i++) {
      for (j = 0; j < 4; j++) {
        for (m = 0; m < 4; m++) t[m] = x[(5 * j + 4 * m) % 16];
        t[1] ^= L32(t[0] + t[3] | 0, 7);
        t[2] ^= L32(t[1] + t[0] | 0, 9);
        t[3] ^= L32(t[2] + t[1] | 0, 13);
        t[0] ^= L32(t[3] + t[2] | 0, 18);
        for (m = 0; m < 4; m++) w[4 * j + (j + m) % 4] = t[m];
      }
      for (m = 0; m < 16; m++) x[m] = w[m];
    }
    if (h) {
      for (i = 0; i < 16; i++) x[i] = x[i] + y[i] | 0;
      for (i = 0; i < 4; i++) {
        x[5 * i] = x[5 * i] - ld32(c, 4 * i) | 0;
        x[6 + i] = x[6 + i] - ld32(inp, 4 * i) | 0;
      }
      for (i = 0; i < 4; i++) {
        st32(out, 4 * i, x[5 * i]);
        st32(out, 16 + 4 * i, x[6 + i]);
      }
    } else {
      for (i = 0; i < 16; i++) st32(out, 4 * i, x[i] + y[i] | 0);
    }
  }
  function crypto_core_salsa20(out, inp, k, c) {
    core(out, inp, k, c, false);
    return 0;
  }
  function crypto_core_hsalsa20(out, inp, k, c) {
    core(out, inp, k, c, true);
    return 0;
  }
  var sigma = new Uint8Array([
    101,
    120,
    112,
    97,
    110,
    100,
    32,
    51,
    50,
    45,
    98,
    121,
    116,
    101,
    32,
    107
  ]);
  function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
    var z = new Uint8Array(16), x = new Uint8Array(64);
    var u, i;
    if (!b) return 0;
    for (i = 0; i < 16; i++) z[i] = 0;
    for (i = 0; i < 8; i++) z[i] = n[i];
    while (b >= 64) {
      crypto_core_salsa20(x, z, k, sigma);
      for (i = 0; i < 64; i++) c[cpos + i] = (m ? m[mpos + i] : 0) ^ x[i];
      u = 1;
      for (i = 8; i < 16; i++) {
        u = u + (z[i] & 255) | 0;
        z[i] = u & 255;
        u >>>= 8;
      }
      b -= 64;
      cpos += 64;
      if (m) mpos += 64;
    }
    if (b > 0) {
      crypto_core_salsa20(x, z, k, sigma);
      for (i = 0; i < b; i++) c[cpos + i] = (m ? m[mpos + i] : 0) ^ x[i];
    }
    return 0;
  }
  function crypto_stream_salsa20(c, cpos, d, n, k) {
    return crypto_stream_salsa20_xor(c, cpos, null, 0, d, n, k);
  }
  function crypto_stream(c, cpos, d, n, k) {
    var s = new Uint8Array(32);
    crypto_core_hsalsa20(s, n, k, sigma);
    return crypto_stream_salsa20(c, cpos, d, n.subarray(16), s);
  }
  function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
    var s = new Uint8Array(32);
    crypto_core_hsalsa20(s, n, k, sigma);
    return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, n.subarray(16), s);
  }
  function add1305(h, c) {
    var j, u = 0;
    for (j = 0; j < 17; j++) {
      u = u + (h[j] + c[j] | 0) | 0;
      h[j] = u & 255;
      u >>>= 8;
    }
  }
  var minusp = new Uint32Array([
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    252
  ]);
  function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
    var s, i, j, u;
    var x = new Uint32Array(17), r = new Uint32Array(17), h = new Uint32Array(17), c = new Uint32Array(17), g = new Uint32Array(17);
    for (j = 0; j < 17; j++) r[j] = h[j] = 0;
    for (j = 0; j < 16; j++) r[j] = k[j];
    r[3] &= 15;
    r[4] &= 252;
    r[7] &= 15;
    r[8] &= 252;
    r[11] &= 15;
    r[12] &= 252;
    r[15] &= 15;
    while (n > 0) {
      for (j = 0; j < 17; j++) c[j] = 0;
      for (j = 0; j < 16 && j < n; ++j) c[j] = m[mpos + j];
      c[j] = 1;
      mpos += j;
      n -= j;
      add1305(h, c);
      for (i = 0; i < 17; i++) {
        x[i] = 0;
        for (j = 0; j < 17; j++) x[i] = x[i] + h[j] * (j <= i ? r[i - j] : 320 * r[i + 17 - j] | 0) | 0 | 0;
      }
      for (i = 0; i < 17; i++) h[i] = x[i];
      u = 0;
      for (j = 0; j < 16; j++) {
        u = u + h[j] | 0;
        h[j] = u & 255;
        u >>>= 8;
      }
      u = u + h[16] | 0;
      h[16] = u & 3;
      u = 5 * (u >>> 2) | 0;
      for (j = 0; j < 16; j++) {
        u = u + h[j] | 0;
        h[j] = u & 255;
        u >>>= 8;
      }
      u = u + h[16] | 0;
      h[16] = u;
    }
    for (j = 0; j < 17; j++) g[j] = h[j];
    add1305(h, minusp);
    s = -(h[16] >>> 7) | 0;
    for (j = 0; j < 17; j++) h[j] ^= s & (g[j] ^ h[j]);
    for (j = 0; j < 16; j++) c[j] = k[j + 16];
    c[16] = 0;
    add1305(h, c);
    for (j = 0; j < 16; j++) out[outpos + j] = h[j];
    return 0;
  }
  function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
    var x = new Uint8Array(16);
    crypto_onetimeauth(x, 0, m, mpos, n, k);
    return crypto_verify_16(h, hpos, x, 0);
  }
  function crypto_secretbox(c, m, d, n, k) {
    var i;
    if (d < 32) return -1;
    crypto_stream_xor(c, 0, m, 0, d, n, k);
    crypto_onetimeauth(c, 16, c, 32, d - 32, c);
    for (i = 0; i < 16; i++) c[i] = 0;
    return 0;
  }
  function crypto_secretbox_open(m, c, d, n, k) {
    var i;
    var x = new Uint8Array(32);
    if (d < 32) return -1;
    crypto_stream(x, 0, 32, n, k);
    if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0) return -1;
    crypto_stream_xor(m, 0, c, 0, d, n, k);
    for (i = 0; i < 32; i++) m[i] = 0;
    return 0;
  }
  function set25519(r, a) {
    var i;
    for (i = 0; i < 16; i++) r[i] = a[i] | 0;
  }
  function car25519(o) {
    var c;
    var i;
    for (i = 0; i < 16; i++) {
      o[i] += 65536;
      c = Math.floor(o[i] / 65536);
      o[(i + 1) * (i < 15 ? 1 : 0)] += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0);
      o[i] -= c * 65536;
    }
  }
  function sel25519(p, q, b) {
    var t, c = ~(b - 1);
    for (var i = 0; i < 16; i++) {
      t = c & (p[i] ^ q[i]);
      p[i] ^= t;
      q[i] ^= t;
    }
  }
  function pack25519(o, n) {
    var i, j, b;
    var m = gf(), t = gf();
    for (i = 0; i < 16; i++) t[i] = n[i];
    car25519(t);
    car25519(t);
    car25519(t);
    for (j = 0; j < 2; j++) {
      m[0] = t[0] - 65517;
      for (i = 1; i < 15; i++) {
        m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
        m[i - 1] &= 65535;
      }
      m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
      b = m[15] >> 16 & 1;
      m[14] &= 65535;
      sel25519(t, m, 1 - b);
    }
    for (i = 0; i < 16; i++) {
      o[2 * i] = t[i] & 255;
      o[2 * i + 1] = t[i] >> 8;
    }
  }
  function neq25519(a, b) {
    var c = new Uint8Array(32), d = new Uint8Array(32);
    pack25519(c, a);
    pack25519(d, b);
    return crypto_verify_32(c, 0, d, 0);
  }
  function par25519(a) {
    var d = new Uint8Array(32);
    pack25519(d, a);
    return d[0] & 1;
  }
  function unpack25519(o, n) {
    var i;
    for (i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
    o[15] &= 32767;
  }
  function A(o, a, b) {
    var i;
    for (i = 0; i < 16; i++) o[i] = a[i] + b[i] | 0;
  }
  function Z(o, a, b) {
    var i;
    for (i = 0; i < 16; i++) o[i] = a[i] - b[i] | 0;
  }
  function M(o, a, b) {
    var i, j, t = new Float64Array(31);
    for (i = 0; i < 31; i++) t[i] = 0;
    for (i = 0; i < 16; i++) {
      for (j = 0; j < 16; j++) {
        t[i + j] += a[i] * b[j];
      }
    }
    for (i = 0; i < 15; i++) {
      t[i] += 38 * t[i + 16];
    }
    for (i = 0; i < 16; i++) o[i] = t[i];
    car25519(o);
    car25519(o);
  }
  function S(o, a) {
    M(o, a, a);
  }
  function inv25519(o, i) {
    var c = gf();
    var a;
    for (a = 0; a < 16; a++) c[a] = i[a];
    for (a = 253; a >= 0; a--) {
      S(c, c);
      if (a !== 2 && a !== 4) M(c, c, i);
    }
    for (a = 0; a < 16; a++) o[a] = c[a];
  }
  function pow2523(o, i) {
    var c = gf();
    var a;
    for (a = 0; a < 16; a++) c[a] = i[a];
    for (a = 250; a >= 0; a--) {
      S(c, c);
      if (a !== 1) M(c, c, i);
    }
    for (a = 0; a < 16; a++) o[a] = c[a];
  }
  function crypto_scalarmult(q, n, p) {
    var z = new Uint8Array(32);
    var x = new Float64Array(80), r, i;
    var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
    for (i = 0; i < 31; i++) z[i] = n[i];
    z[31] = n[31] & 127 | 64;
    z[0] &= 248;
    unpack25519(x, p);
    for (i = 0; i < 16; i++) {
      b[i] = x[i];
      d[i] = a[i] = c[i] = 0;
    }
    a[0] = d[0] = 1;
    for (i = 254; i >= 0; --i) {
      r = z[i >>> 3] >>> (i & 7) & 1;
      sel25519(a, b, r);
      sel25519(c, d, r);
      A(e, a, c);
      Z(a, a, c);
      A(c, b, d);
      Z(b, b, d);
      S(d, e);
      S(f, a);
      M(a, c, a);
      M(c, b, e);
      A(e, a, c);
      Z(a, a, c);
      S(b, a);
      Z(c, d, f);
      M(a, c, _121665);
      A(a, a, d);
      M(c, c, a);
      M(a, d, f);
      M(d, b, x);
      S(b, e);
      sel25519(a, b, r);
      sel25519(c, d, r);
    }
    for (i = 0; i < 16; i++) {
      x[i + 16] = a[i];
      x[i + 32] = c[i];
      x[i + 48] = b[i];
      x[i + 64] = d[i];
    }
    var x32 = x.subarray(32);
    var x16 = x.subarray(16);
    inv25519(x32, x32);
    M(x16, x16, x32);
    pack25519(q, x16);
    return 0;
  }
  function crypto_scalarmult_base(q, n) {
    return crypto_scalarmult(q, n, _9);
  }
  function crypto_box_keypair(y, x) {
    randombytes(x, 32);
    return crypto_scalarmult_base(y, x);
  }
  function crypto_box_beforenm(k, y, x) {
    var s = new Uint8Array(32);
    crypto_scalarmult(s, x, y);
    return crypto_core_hsalsa20(k, _0, s, sigma);
  }
  var crypto_box_afternm = crypto_secretbox;
  var crypto_box_open_afternm = crypto_secretbox_open;
  function crypto_box(c, m, d, n, y, x) {
    var k = new Uint8Array(32);
    crypto_box_beforenm(k, y, x);
    return crypto_box_afternm(c, m, d, n, k);
  }
  function crypto_box_open(m, c, d, n, y, x) {
    var k = new Uint8Array(32);
    crypto_box_beforenm(k, y, x);
    return crypto_box_open_afternm(m, c, d, n, k);
  }
  function add64() {
    var a = 0, b = 0, c = 0, d = 0, m16 = 65535, l, h, i;
    for (i = 0; i < arguments.length; i++) {
      l = arguments[i].lo;
      h = arguments[i].hi;
      a += l & m16;
      b += l >>> 16;
      c += h & m16;
      d += h >>> 16;
    }
    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;
    return new u64(c & m16 | d << 16, a & m16 | b << 16);
  }
  function shr64(x, c) {
    return new u64(x.hi >>> c, x.lo >>> c | x.hi << 32 - c);
  }
  function xor64() {
    var l = 0, h = 0, i;
    for (i = 0; i < arguments.length; i++) {
      l ^= arguments[i].lo;
      h ^= arguments[i].hi;
    }
    return new u64(h, l);
  }
  function R(x, c) {
    var h, l, c1 = 32 - c;
    if (c < 32) {
      h = x.hi >>> c | x.lo << c1;
      l = x.lo >>> c | x.hi << c1;
    } else if (c < 64) {
      h = x.lo >>> c | x.hi << c1;
      l = x.hi >>> c | x.lo << c1;
    }
    return new u64(h, l);
  }
  function Ch(x, y, z) {
    var h = x.hi & y.hi ^ ~x.hi & z.hi, l = x.lo & y.lo ^ ~x.lo & z.lo;
    return new u64(h, l);
  }
  function Maj(x, y, z) {
    var h = x.hi & y.hi ^ x.hi & z.hi ^ y.hi & z.hi, l = x.lo & y.lo ^ x.lo & z.lo ^ y.lo & z.lo;
    return new u64(h, l);
  }
  function Sigma0(x) {
    return xor64(R(x, 28), R(x, 34), R(x, 39));
  }
  function Sigma1(x) {
    return xor64(R(x, 14), R(x, 18), R(x, 41));
  }
  function sigma0(x) {
    return xor64(R(x, 1), R(x, 8), shr64(x, 7));
  }
  function sigma1(x) {
    return xor64(R(x, 19), R(x, 61), shr64(x, 6));
  }
  var K = [
    new u64(1116352408, 3609767458),
    new u64(1899447441, 602891725),
    new u64(3049323471, 3964484399),
    new u64(3921009573, 2173295548),
    new u64(961987163, 4081628472),
    new u64(1508970993, 3053834265),
    new u64(2453635748, 2937671579),
    new u64(2870763221, 3664609560),
    new u64(3624381080, 2734883394),
    new u64(310598401, 1164996542),
    new u64(607225278, 1323610764),
    new u64(1426881987, 3590304994),
    new u64(1925078388, 4068182383),
    new u64(2162078206, 991336113),
    new u64(2614888103, 633803317),
    new u64(3248222580, 3479774868),
    new u64(3835390401, 2666613458),
    new u64(4022224774, 944711139),
    new u64(264347078, 2341262773),
    new u64(604807628, 2007800933),
    new u64(770255983, 1495990901),
    new u64(1249150122, 1856431235),
    new u64(1555081692, 3175218132),
    new u64(1996064986, 2198950837),
    new u64(2554220882, 3999719339),
    new u64(2821834349, 766784016),
    new u64(2952996808, 2566594879),
    new u64(3210313671, 3203337956),
    new u64(3336571891, 1034457026),
    new u64(3584528711, 2466948901),
    new u64(113926993, 3758326383),
    new u64(338241895, 168717936),
    new u64(666307205, 1188179964),
    new u64(773529912, 1546045734),
    new u64(1294757372, 1522805485),
    new u64(1396182291, 2643833823),
    new u64(1695183700, 2343527390),
    new u64(1986661051, 1014477480),
    new u64(2177026350, 1206759142),
    new u64(2456956037, 344077627),
    new u64(2730485921, 1290863460),
    new u64(2820302411, 3158454273),
    new u64(3259730800, 3505952657),
    new u64(3345764771, 106217008),
    new u64(3516065817, 3606008344),
    new u64(3600352804, 1432725776),
    new u64(4094571909, 1467031594),
    new u64(275423344, 851169720),
    new u64(430227734, 3100823752),
    new u64(506948616, 1363258195),
    new u64(659060556, 3750685593),
    new u64(883997877, 3785050280),
    new u64(958139571, 3318307427),
    new u64(1322822218, 3812723403),
    new u64(1537002063, 2003034995),
    new u64(1747873779, 3602036899),
    new u64(1955562222, 1575990012),
    new u64(2024104815, 1125592928),
    new u64(2227730452, 2716904306),
    new u64(2361852424, 442776044),
    new u64(2428436474, 593698344),
    new u64(2756734187, 3733110249),
    new u64(3204031479, 2999351573),
    new u64(3329325298, 3815920427),
    new u64(3391569614, 3928383900),
    new u64(3515267271, 566280711),
    new u64(3940187606, 3454069534),
    new u64(4118630271, 4000239992),
    new u64(116418474, 1914138554),
    new u64(174292421, 2731055270),
    new u64(289380356, 3203993006),
    new u64(460393269, 320620315),
    new u64(685471733, 587496836),
    new u64(852142971, 1086792851),
    new u64(1017036298, 365543100),
    new u64(1126000580, 2618297676),
    new u64(1288033470, 3409855158),
    new u64(1501505948, 4234509866),
    new u64(1607167915, 987167468),
    new u64(1816402316, 1246189591)
  ];
  function crypto_hashblocks(x, m, n) {
    var z = [], b = [], a = [], w = [], t, i, j;
    for (i = 0; i < 8; i++) z[i] = a[i] = dl64(x, 8 * i);
    var pos = 0;
    while (n >= 128) {
      for (i = 0; i < 16; i++) w[i] = dl64(m, 8 * i + pos);
      for (i = 0; i < 80; i++) {
        for (j = 0; j < 8; j++) b[j] = a[j];
        t = add64(a[7], Sigma1(a[4]), Ch(a[4], a[5], a[6]), K[i], w[i % 16]);
        b[7] = add64(t, Sigma0(a[0]), Maj(a[0], a[1], a[2]));
        b[3] = add64(b[3], t);
        for (j = 0; j < 8; j++) a[(j + 1) % 8] = b[j];
        if (i % 16 === 15) {
          for (j = 0; j < 16; j++) {
            w[j] = add64(w[j], w[(j + 9) % 16], sigma0(w[(j + 1) % 16]), sigma1(w[(j + 14) % 16]));
          }
        }
      }
      for (i = 0; i < 8; i++) {
        a[i] = add64(a[i], z[i]);
        z[i] = a[i];
      }
      pos += 128;
      n -= 128;
    }
    for (i = 0; i < 8; i++) ts64(x, 8 * i, z[i]);
    return n;
  }
  var iv = new Uint8Array([
    106,
    9,
    230,
    103,
    243,
    188,
    201,
    8,
    187,
    103,
    174,
    133,
    132,
    202,
    167,
    59,
    60,
    110,
    243,
    114,
    254,
    148,
    248,
    43,
    165,
    79,
    245,
    58,
    95,
    29,
    54,
    241,
    81,
    14,
    82,
    127,
    173,
    230,
    130,
    209,
    155,
    5,
    104,
    140,
    43,
    62,
    108,
    31,
    31,
    131,
    217,
    171,
    251,
    65,
    189,
    107,
    91,
    224,
    205,
    25,
    19,
    126,
    33,
    121
  ]);
  function crypto_hash(out, m, n) {
    var h = new Uint8Array(64), x = new Uint8Array(256);
    var i, b = n;
    for (i = 0; i < 64; i++) h[i] = iv[i];
    crypto_hashblocks(h, m, n);
    n %= 128;
    for (i = 0; i < 256; i++) x[i] = 0;
    for (i = 0; i < n; i++) x[i] = m[b - n + i];
    x[n] = 128;
    n = 256 - 128 * (n < 112 ? 1 : 0);
    x[n - 9] = 0;
    ts64(x, n - 8, new u64(b / 536870912 | 0, b << 3));
    crypto_hashblocks(h, x, n);
    for (i = 0; i < 64; i++) out[i] = h[i];
    return 0;
  }
  function add(p, q) {
    var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
    Z(a, p[1], p[0]);
    Z(t, q[1], q[0]);
    M(a, a, t);
    A(b, p[0], p[1]);
    A(t, q[0], q[1]);
    M(b, b, t);
    M(c, p[3], q[3]);
    M(c, c, D2);
    M(d, p[2], q[2]);
    A(d, d, d);
    Z(e, b, a);
    Z(f, d, c);
    A(g, d, c);
    A(h, b, a);
    M(p[0], e, f);
    M(p[1], h, g);
    M(p[2], g, f);
    M(p[3], e, h);
  }
  function cswap(p, q, b) {
    var i;
    for (i = 0; i < 4; i++) {
      sel25519(p[i], q[i], b);
    }
  }
  function pack(r, p) {
    var tx = gf(), ty = gf(), zi = gf();
    inv25519(zi, p[2]);
    M(tx, p[0], zi);
    M(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= par25519(tx) << 7;
  }
  function scalarmult(p, q, s) {
    var b, i;
    set25519(p[0], gf0);
    set25519(p[1], gf1);
    set25519(p[2], gf1);
    set25519(p[3], gf0);
    for (i = 255; i >= 0; --i) {
      b = s[i / 8 | 0] >> (i & 7) & 1;
      cswap(p, q, b);
      add(q, p);
      add(p, p);
      cswap(p, q, b);
    }
  }
  function scalarbase(p, s) {
    var q = [
      gf(),
      gf(),
      gf(),
      gf()
    ];
    set25519(q[0], X);
    set25519(q[1], Y);
    set25519(q[2], gf1);
    M(q[3], X, Y);
    scalarmult(p, q, s);
  }
  function crypto_sign_keypair(pk, sk, seeded) {
    var d = new Uint8Array(64);
    var p = [
      gf(),
      gf(),
      gf(),
      gf()
    ];
    var i;
    if (!seeded) randombytes(sk, 32);
    crypto_hash(d, sk, 32);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;
    scalarbase(p, d);
    pack(pk, p);
    for (i = 0; i < 32; i++) sk[i + 32] = pk[i];
    return 0;
  }
  var L = new Float64Array([
    237,
    211,
    245,
    92,
    26,
    99,
    18,
    88,
    214,
    156,
    247,
    162,
    222,
    249,
    222,
    20,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    16
  ]);
  function modL(r, x) {
    var carry, i, j, k;
    for (i = 63; i >= 32; --i) {
      carry = 0;
      for (j = i - 32, k = i - 12; j < k; ++j) {
        x[j] += carry - 16 * x[i] * L[j - (i - 32)];
        carry = Math.floor((x[j] + 128) / 256);
        x[j] -= carry * 256;
      }
      x[j] += carry;
      x[i] = 0;
    }
    carry = 0;
    for (j = 0; j < 32; j++) {
      x[j] += carry - (x[31] >> 4) * L[j];
      carry = x[j] >> 8;
      x[j] &= 255;
    }
    for (j = 0; j < 32; j++) x[j] -= carry * L[j];
    for (i = 0; i < 32; i++) {
      x[i + 1] += x[i] >> 8;
      r[i] = x[i] & 255;
    }
  }
  function reduce(r) {
    var x = new Float64Array(64), i;
    for (i = 0; i < 64; i++) x[i] = r[i];
    for (i = 0; i < 64; i++) r[i] = 0;
    modL(r, x);
  }
  function crypto_sign(sm, m, n, sk) {
    var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
    var i, j, x = new Float64Array(64);
    var p = [
      gf(),
      gf(),
      gf(),
      gf()
    ];
    crypto_hash(d, sk, 32);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;
    var smlen = n + 64;
    for (i = 0; i < n; i++) sm[64 + i] = m[i];
    for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];
    crypto_hash(r, sm.subarray(32), n + 32);
    reduce(r);
    scalarbase(p, r);
    pack(sm, p);
    for (i = 32; i < 64; i++) sm[i] = sk[i];
    crypto_hash(h, sm, n + 64);
    reduce(h);
    for (i = 0; i < 64; i++) x[i] = 0;
    for (i = 0; i < 32; i++) x[i] = r[i];
    for (i = 0; i < 32; i++) {
      for (j = 0; j < 32; j++) {
        x[i + j] += h[i] * d[j];
      }
    }
    modL(sm.subarray(32), x);
    return smlen;
  }
  function unpackneg(r, p) {
    var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
    set25519(r[2], gf1);
    unpack25519(r[1], p);
    S(num, r[1]);
    M(den, num, D);
    Z(num, num, r[2]);
    A(den, r[2], den);
    S(den2, den);
    S(den4, den2);
    M(den6, den4, den2);
    M(t, den6, num);
    M(t, t, den);
    pow2523(t, t);
    M(t, t, num);
    M(t, t, den);
    M(t, t, den);
    M(r[0], t, den);
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) M(r[0], r[0], I);
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) return -1;
    if (par25519(r[0]) === p[31] >> 7) Z(r[0], gf0, r[0]);
    M(r[3], r[0], r[1]);
    return 0;
  }
  function crypto_sign_open(m, sm, n, pk) {
    var i;
    var t = new Uint8Array(32), h = new Uint8Array(64);
    var p = [
      gf(),
      gf(),
      gf(),
      gf()
    ], q = [
      gf(),
      gf(),
      gf(),
      gf()
    ];
    if (n < 64) return -1;
    if (unpackneg(q, pk)) return -1;
    for (i = 0; i < n; i++) m[i] = sm[i];
    for (i = 0; i < 32; i++) m[i + 32] = pk[i];
    crypto_hash(h, m, n);
    reduce(h);
    scalarmult(p, q, h);
    scalarbase(q, sm.subarray(32));
    add(p, q);
    pack(t, p);
    n -= 64;
    if (crypto_verify_32(sm, 0, t, 0)) {
      for (i = 0; i < n; i++) m[i] = 0;
      return -1;
    }
    for (i = 0; i < n; i++) m[i] = sm[i + 64];
    return n;
  }
  var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
  nacl2.lowlevel = {
    crypto_core_hsalsa20,
    crypto_stream_xor,
    crypto_stream,
    crypto_stream_salsa20_xor,
    crypto_stream_salsa20,
    crypto_onetimeauth,
    crypto_onetimeauth_verify,
    crypto_verify_16,
    crypto_verify_32,
    crypto_secretbox,
    crypto_secretbox_open,
    crypto_scalarmult,
    crypto_scalarmult_base,
    crypto_box_beforenm,
    crypto_box_afternm,
    crypto_box,
    crypto_box_open,
    crypto_box_keypair,
    crypto_hash,
    crypto_sign,
    crypto_sign_keypair,
    crypto_sign_open,
    crypto_secretbox_KEYBYTES,
    crypto_secretbox_NONCEBYTES,
    crypto_secretbox_ZEROBYTES,
    crypto_secretbox_BOXZEROBYTES,
    crypto_scalarmult_BYTES,
    crypto_scalarmult_SCALARBYTES,
    crypto_box_PUBLICKEYBYTES,
    crypto_box_SECRETKEYBYTES,
    crypto_box_BEFORENMBYTES,
    crypto_box_NONCEBYTES,
    crypto_box_ZEROBYTES,
    crypto_box_BOXZEROBYTES,
    crypto_sign_BYTES,
    crypto_sign_PUBLICKEYBYTES,
    crypto_sign_SECRETKEYBYTES,
    crypto_sign_SEEDBYTES,
    crypto_hash_BYTES,
    gf,
    D,
    L,
    pack25519,
    unpack25519,
    M,
    A,
    S,
    Z,
    pow2523,
    add,
    set25519,
    modL,
    scalarmult,
    scalarbase
  };
  function checkLengths(k, n) {
    if (k.length !== crypto_secretbox_KEYBYTES) throw new Error("bad key size");
    if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error("bad nonce size");
  }
  function checkBoxLengths(pk, sk) {
    if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error("bad public key size");
    if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
  }
  function checkArrayTypes() {
    for (var i = 0; i < arguments.length; i++) {
      if (!(arguments[i] instanceof Uint8Array)) throw new TypeError("unexpected type, use Uint8Array");
    }
  }
  function cleanup(arr) {
    for (var i = 0; i < arr.length; i++) arr[i] = 0;
  }
  nacl2.randomBytes = function(n) {
    var b = new Uint8Array(n);
    randombytes(b, n);
    return b;
  };
  nacl2.secretbox = function(msg, nonce, key) {
    checkArrayTypes(msg, nonce, key);
    checkLengths(key, nonce);
    var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
    var c = new Uint8Array(m.length);
    for (var i = 0; i < msg.length; i++) m[i + crypto_secretbox_ZEROBYTES] = msg[i];
    crypto_secretbox(c, m, m.length, nonce, key);
    return c.subarray(crypto_secretbox_BOXZEROBYTES);
  };
  nacl2.secretbox.open = function(box, nonce, key) {
    checkArrayTypes(box, nonce, key);
    checkLengths(key, nonce);
    var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
    var m = new Uint8Array(c.length);
    for (var i = 0; i < box.length; i++) c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
    if (c.length < 32) return null;
    if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0) return null;
    return m.subarray(crypto_secretbox_ZEROBYTES);
  };
  nacl2.secretbox.keyLength = crypto_secretbox_KEYBYTES;
  nacl2.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
  nacl2.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
  nacl2.scalarMult = function(n, p) {
    checkArrayTypes(n, p);
    if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
    if (p.length !== crypto_scalarmult_BYTES) throw new Error("bad p size");
    var q = new Uint8Array(crypto_scalarmult_BYTES);
    crypto_scalarmult(q, n, p);
    return q;
  };
  nacl2.scalarMult.base = function(n) {
    checkArrayTypes(n);
    if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
    var q = new Uint8Array(crypto_scalarmult_BYTES);
    crypto_scalarmult_base(q, n);
    return q;
  };
  nacl2.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
  nacl2.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
  nacl2.box = function(msg, nonce, publicKey, secretKey) {
    var k = nacl2.box.before(publicKey, secretKey);
    return nacl2.secretbox(msg, nonce, k);
  };
  nacl2.box.before = function(publicKey, secretKey) {
    checkArrayTypes(publicKey, secretKey);
    checkBoxLengths(publicKey, secretKey);
    var k = new Uint8Array(crypto_box_BEFORENMBYTES);
    crypto_box_beforenm(k, publicKey, secretKey);
    return k;
  };
  nacl2.box.after = nacl2.secretbox;
  nacl2.box.open = function(msg, nonce, publicKey, secretKey) {
    var k = nacl2.box.before(publicKey, secretKey);
    return nacl2.secretbox.open(msg, nonce, k);
  };
  nacl2.box.open.after = nacl2.secretbox.open;
  nacl2.box.keyPair = function() {
    var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
    var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
    crypto_box_keypair(pk, sk);
    return {
      publicKey: pk,
      secretKey: sk
    };
  };
  nacl2.box.keyPair.fromSecretKey = function(secretKey) {
    checkArrayTypes(secretKey);
    if (secretKey.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
    var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
    crypto_scalarmult_base(pk, secretKey);
    return {
      publicKey: pk,
      secretKey: new Uint8Array(secretKey)
    };
  };
  nacl2.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
  nacl2.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
  nacl2.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
  nacl2.box.nonceLength = crypto_box_NONCEBYTES;
  nacl2.box.overheadLength = nacl2.secretbox.overheadLength;
  nacl2.sign = function(msg, secretKey) {
    checkArrayTypes(msg, secretKey);
    if (secretKey.length !== crypto_sign_SECRETKEYBYTES) throw new Error("bad secret key size");
    var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
    crypto_sign(signedMsg, msg, msg.length, secretKey);
    return signedMsg;
  };
  nacl2.sign.open = function(signedMsg, publicKey) {
    checkArrayTypes(signedMsg, publicKey);
    if (publicKey.length !== crypto_sign_PUBLICKEYBYTES) throw new Error("bad public key size");
    var tmp = new Uint8Array(signedMsg.length);
    var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey);
    if (mlen < 0) return null;
    var m = new Uint8Array(mlen);
    for (var i = 0; i < m.length; i++) m[i] = tmp[i];
    return m;
  };
  nacl2.sign.detached = function(msg, secretKey) {
    var signedMsg = nacl2.sign(msg, secretKey);
    var sig = new Uint8Array(crypto_sign_BYTES);
    for (var i = 0; i < sig.length; i++) sig[i] = signedMsg[i];
    return sig;
  };
  nacl2.sign.detached.verify = function(msg, sig, publicKey) {
    checkArrayTypes(msg, sig, publicKey);
    if (sig.length !== crypto_sign_BYTES) throw new Error("bad signature size");
    if (publicKey.length !== crypto_sign_PUBLICKEYBYTES) throw new Error("bad public key size");
    var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
    var m = new Uint8Array(crypto_sign_BYTES + msg.length);
    var i;
    for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
    for (i = 0; i < msg.length; i++) sm[i + crypto_sign_BYTES] = msg[i];
    return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
  };
  nacl2.sign.keyPair = function() {
    var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
    var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
    crypto_sign_keypair(pk, sk);
    return {
      publicKey: pk,
      secretKey: sk
    };
  };
  nacl2.sign.keyPair.fromSecretKey = function(secretKey) {
    checkArrayTypes(secretKey);
    if (secretKey.length !== crypto_sign_SECRETKEYBYTES) throw new Error("bad secret key size");
    var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
    for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32 + i];
    return {
      publicKey: pk,
      secretKey: new Uint8Array(secretKey)
    };
  };
  nacl2.sign.keyPair.fromSeed = function(seed) {
    checkArrayTypes(seed);
    if (seed.length !== crypto_sign_SEEDBYTES) throw new Error("bad seed size");
    var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
    var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
    for (var i = 0; i < 32; i++) sk[i] = seed[i];
    crypto_sign_keypair(pk, sk, true);
    return {
      publicKey: pk,
      secretKey: sk
    };
  };
  nacl2.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
  nacl2.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
  nacl2.sign.seedLength = crypto_sign_SEEDBYTES;
  nacl2.sign.signatureLength = crypto_sign_BYTES;
  nacl2.hash = function(msg) {
    checkArrayTypes(msg);
    var h = new Uint8Array(crypto_hash_BYTES);
    crypto_hash(h, msg, msg.length);
    return h;
  };
  nacl2.hash.hashLength = crypto_hash_BYTES;
  nacl2.verify = function(x, y) {
    checkArrayTypes(x, y);
    if (x.length === 0 || y.length === 0) return false;
    if (x.length !== y.length) return false;
    return vn(x, 0, y, 0, x.length) === 0 ? true : false;
  };
  nacl2.setPRNG = function(fn) {
    randombytes = fn;
  };
  (function() {
    var crypto2 = typeof globalThis !== "undefined" ? globalThis.crypto || globalThis.msCrypto : null;
    if (crypto2 && crypto2.getRandomValues) {
      var QUOTA = 65536;
      nacl2.setPRNG(function(x, n) {
        var i, v = new Uint8Array(n);
        for (i = 0; i < n; i += QUOTA) {
          crypto2.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
        }
        for (i = 0; i < n; i++) x[i] = v[i];
        cleanup(v);
      });
    } else if (typeof require !== "undefined") {
      crypto2 = require("crypto");
      if (crypto2 && crypto2.randomBytes) {
        nacl2.setPRNG(function(x, n) {
          var i, v = crypto2.randomBytes(n);
          for (i = 0; i < n; i++) x[i] = v[i];
          cleanup(v);
        });
      }
    }
  })();
})(typeof module !== "undefined" && module.exports ? module.exports : globalThis.nacl = globalThis.nacl || {});
var nacl = typeof module !== "undefined" && module.exports ? module.exports : globalThis.nacl;
var denoHelper = {
  fromSeed: nacl.sign.keyPair.fromSeed,
  sign: nacl.sign.detached,
  verify: nacl.sign.detached.verify,
  randomBytes: nacl.randomBytes,
  scalarBaseMultiply: nacl.scalarMult.base,
  seal: nacl.box,
  open: nacl.box.open
};
var helper;
function setEd25519Helper(lib) {
  helper = lib;
}
var crc16tab = new Uint16Array([
  0,
  4129,
  8258,
  12387,
  16516,
  20645,
  24774,
  28903,
  33032,
  37161,
  41290,
  45419,
  49548,
  53677,
  57806,
  61935,
  4657,
  528,
  12915,
  8786,
  21173,
  17044,
  29431,
  25302,
  37689,
  33560,
  45947,
  41818,
  54205,
  50076,
  62463,
  58334,
  9314,
  13379,
  1056,
  5121,
  25830,
  29895,
  17572,
  21637,
  42346,
  46411,
  34088,
  38153,
  58862,
  62927,
  50604,
  54669,
  13907,
  9842,
  5649,
  1584,
  30423,
  26358,
  22165,
  18100,
  46939,
  42874,
  38681,
  34616,
  63455,
  59390,
  55197,
  51132,
  18628,
  22757,
  26758,
  30887,
  2112,
  6241,
  10242,
  14371,
  51660,
  55789,
  59790,
  63919,
  35144,
  39273,
  43274,
  47403,
  23285,
  19156,
  31415,
  27286,
  6769,
  2640,
  14899,
  10770,
  56317,
  52188,
  64447,
  60318,
  39801,
  35672,
  47931,
  43802,
  27814,
  31879,
  19684,
  23749,
  11298,
  15363,
  3168,
  7233,
  60846,
  64911,
  52716,
  56781,
  44330,
  48395,
  36200,
  40265,
  32407,
  28342,
  24277,
  20212,
  15891,
  11826,
  7761,
  3696,
  65439,
  61374,
  57309,
  53244,
  48923,
  44858,
  40793,
  36728,
  37256,
  33193,
  45514,
  41451,
  53516,
  49453,
  61774,
  57711,
  4224,
  161,
  12482,
  8419,
  20484,
  16421,
  28742,
  24679,
  33721,
  37784,
  41979,
  46042,
  49981,
  54044,
  58239,
  62302,
  689,
  4752,
  8947,
  13010,
  16949,
  21012,
  25207,
  29270,
  46570,
  42443,
  38312,
  34185,
  62830,
  58703,
  54572,
  50445,
  13538,
  9411,
  5280,
  1153,
  29798,
  25671,
  21540,
  17413,
  42971,
  47098,
  34713,
  38840,
  59231,
  63358,
  50973,
  55100,
  9939,
  14066,
  1681,
  5808,
  26199,
  30326,
  17941,
  22068,
  55628,
  51565,
  63758,
  59695,
  39368,
  35305,
  47498,
  43435,
  22596,
  18533,
  30726,
  26663,
  6336,
  2273,
  14466,
  10403,
  52093,
  56156,
  60223,
  64286,
  35833,
  39896,
  43963,
  48026,
  19061,
  23124,
  27191,
  31254,
  2801,
  6864,
  10931,
  14994,
  64814,
  60687,
  56684,
  52557,
  48554,
  44427,
  40424,
  36297,
  31782,
  27655,
  23652,
  19525,
  15522,
  11395,
  7392,
  3265,
  61215,
  65342,
  53085,
  57212,
  44955,
  49082,
  36825,
  40952,
  28183,
  32310,
  20053,
  24180,
  11923,
  16050,
  3793,
  7920
]);
var NKeysErrorCode;
(function(NKeysErrorCode2) {
  NKeysErrorCode2["InvalidPrefixByte"] = "nkeys: invalid prefix byte";
  NKeysErrorCode2["InvalidKey"] = "nkeys: invalid key";
  NKeysErrorCode2["InvalidPublicKey"] = "nkeys: invalid public key";
  NKeysErrorCode2["InvalidSeedLen"] = "nkeys: invalid seed length";
  NKeysErrorCode2["InvalidSeed"] = "nkeys: invalid seed";
  NKeysErrorCode2["InvalidCurveSeed"] = "nkeys: invalid curve seed";
  NKeysErrorCode2["InvalidCurveKey"] = "nkeys: not a valid curve key";
  NKeysErrorCode2["InvalidCurveOperation"] = "nkeys: curve key is not valid for sign/verify";
  NKeysErrorCode2["InvalidNKeyOperation"] = "keys: only curve key can seal/open";
  NKeysErrorCode2["InvalidEncoding"] = "nkeys: invalid encoded key";
  NKeysErrorCode2["InvalidRecipient"] = "nkeys: not a valid recipient public curve key";
  NKeysErrorCode2["InvalidEncrypted"] = "nkeys: encrypted input is not valid";
  NKeysErrorCode2["CannotSign"] = "nkeys: cannot sign, no private key available";
  NKeysErrorCode2["PublicKeyOnly"] = "nkeys: no seed or private key available";
  NKeysErrorCode2["InvalidChecksum"] = "nkeys: invalid checksum";
  NKeysErrorCode2["SerializationError"] = "nkeys: serialization error";
  NKeysErrorCode2["ApiError"] = "nkeys: api error";
  NKeysErrorCode2["ClearedPair"] = "nkeys: pair is cleared";
})(NKeysErrorCode || (NKeysErrorCode = {}));
var Prefix;
(function(Prefix2) {
  Prefix2[Prefix2["Unknown"] = -1] = "Unknown";
  Prefix2[Prefix2["Seed"] = 144] = "Seed";
  Prefix2[Prefix2["Private"] = 120] = "Private";
  Prefix2[Prefix2["Operator"] = 112] = "Operator";
  Prefix2[Prefix2["Server"] = 104] = "Server";
  Prefix2[Prefix2["Cluster"] = 16] = "Cluster";
  Prefix2[Prefix2["Account"] = 0] = "Account";
  Prefix2[Prefix2["User"] = 160] = "User";
  Prefix2[Prefix2["Curve"] = 184] = "Curve";
})(Prefix || (Prefix = {}));
setEd25519Helper(denoHelper);
var Algorithms;
(function(Algorithms2) {
  Algorithms2["v1"] = "ed25519";
  Algorithms2["v2"] = "ed25519-nkey";
})(Algorithms || (Algorithms = {}));

// ../../packages/core/dist/identity.js
var import_nkeys = __toESM(require_mod2(), 1);

// ../../packages/core/dist/endpoint-service.js
var SOURCE_CHAIN_ID = "[A-Za-z0-9_-]{1,64}";
var SOURCE_CHAIN_ELEMENT = new RegExp(`^(root|handle\\.${SOURCE_CHAIN_ID}\\.${SOURCE_CHAIN_ID}|session\\.${SOURCE_CHAIN_ID})$`);

// ../../packages/core/dist/endpoint-signing.js
var import_nkeys2 = __toESM(require_mod2(), 1);
var ANCHOR_ROLES = Object.freeze([
  "handles",
  "traits",
  "receipts",
  "resume",
  "sessions",
  "authz-slots",
  "obligations",
  "payments"
]);

// ../../packages/core/dist/endpoint-checkpoint.js
var import_jetstream3 = __toESM(require_mod4(), 1);
var import_transport_node4 = __toESM(require_transport_node(), 1);
var MAX_SCHEDULE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

// ../../packages/core/dist/endpoint-action.js
var import_jetstream5 = __toESM(require_mod4(), 1);
var import_transport_node6 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/endpoint-receipt.js
var import_jetstream4 = __toESM(require_mod4(), 1);
var import_transport_node5 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/endpoint-action.js
var BRANDED_CONTEXTS = /* @__PURE__ */ new WeakSet();
function assertCtx(ctx) {
  if (!BRANDED_CONTEXTS.has(ctx))
    throw new EpEnvelopeError("failed-precondition", `the action context was not constructed by actionContext(); a hand-assembled resource bundle never authorizes - the space bond is constructed, not asserted (SPEC 13.4)`);
}
var GUARD_CLEARANCES = /* @__PURE__ */ new WeakMap();
var clearanceMintClaimed = false;
function claimGuardClearanceMint() {
  if (clearanceMintClaimed)
    throw new EpEnvelopeError("permission-denied", "the guard-clearance mint is already claimed by THE gate; a guarded goal's edge into running opens only through it (SPEC 13.6)");
  clearanceMintClaimed = true;
  return (ctx, goalId) => {
    assertCtx(ctx);
    const clearance = Object.freeze({ goalId: assertIdToken(goalId, "goalId") });
    GUARD_CLEARANCES.set(clearance, ctx);
    return clearance;
  };
}
var GOAL_STATES = Object.freeze(["accepted", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "expired", "uncertain"]);
var GOAL_TERMINAL_STATES = Object.freeze(["succeeded", "failed", "cancelled", "expired", "uncertain"]);

// ../../packages/core/dist/endpoint-guard.js
var mintGuardClearance = claimGuardClearanceMint();

// ../../packages/core/dist/endpoint-traits.js
var TRAIT_SELECTORS = Object.freeze(["cluster", "command", "attribute", "event"]);

// ../../packages/core/dist/endpoint-publish-denial.js
var import_transport_node7 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/endpoint-invoke.js
var import_transport_node9 = __toESM(require_transport_node(), 1);
var import_jetstream7 = __toESM(require_mod4(), 1);

// ../../packages/core/dist/endpoint-contract-store.js
var import_jetstream6 = __toESM(require_mod4(), 1);
var import_transport_node8 = __toESM(require_transport_node(), 1);
var CONTRACT_ARTIFACT_MAX_BYTES = 256 * 1024;
var CONTRACT_CLOSURE_MAX_BYTES = 1024 * 1024;

// ../../packages/core/dist/endpoint-invoke.js
var dec5 = new TextDecoder();
var enc4 = new TextEncoder();

// ../../packages/core/dist/endpoint-work.js
var import_jetstream8 = __toESM(require_mod4(), 1);
var import_transport_node10 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/run-journal.js
var import_jetstream9 = __toESM(require_mod4(), 1);
var import_transport_node11 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/endpoint-goaleff.js
var COMMON_FIELDS = ["v", "executor", "attemptId", "ts", "phase"];
var PHASE_FIELDS = {
  claimed: COMMON_FIELDS,
  launching: [...COMMON_FIELDS, "addr"],
  launched: [...COMMON_FIELDS, "addr"],
  settled: [...COMMON_FIELDS, "addr"]
  // `addr` optional here, and ONLY here
};

// ../../packages/core/dist/endpoint-epname.js
var BASE = ["v", "ts", "state", "claimant"];
var STATE_FIELDS = {
  claimed: BASE,
  launching: [...BASE, "lifecycleUid", "launchAttemptId", "executor"],
  live: [...BASE, "lifecycleUid", "runtimeOwner"],
  preserved: [...BASE, "lifecycleUid", "runtimeOwner"],
  relaunching: [...BASE, "lifecycleUid", "launchAttemptId", "executor"],
  draining: [...BASE, "lifecycleUid", "runtimeOwner", "enteredAt"],
  released: BASE
};

// ../../packages/core/dist/endpoint-serve-kv.js
var enc5 = new TextEncoder();
var dec6 = new TextDecoder();

// ../../packages/core/dist/endpoint-handle.js
var HANDLE_MAX_LIVE_TTL_MS = 24 * 60 * 60 * 1e3;
var HANDLE_MAX_STURDY_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var HANDLE_MAX_BYTES = 64 * 1024;

// ../../packages/core/dist/endpoint-session.js
var SESSION_GRANT_MAX_TTL_MS = 24 * 60 * 60 * 1e3;
var SESSION_GRANT_MAX_BYTES = 16 * 1024;
var SESSION_TERMINAL_STATES = Object.freeze(["closed", "expired", "superseded", "retired"]);
var TERMINAL_STATE_SNAP = new Set(SESSION_TERMINAL_STATES);

// ../../packages/core/dist/session-terminal-frames.js
var MAX_B64_CHARS = 4 * 1024 * 1024;
var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_INV = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++)
    m[B64_ALPHABET.charCodeAt(i)] = i;
  return m;
})();

// ../../packages/core/dist/endpoint-virtual.js
var import_jetstream10 = __toESM(require_mod4(), 1);
var td = new TextDecoder();

// ../../packages/core/dist/signing-key-rotation.js
var RENEW_AT_FRACTION = 1 / 3;
var OVERLAP_MS = 10 * 60 * 1e3;

// ../../packages/core/dist/streams.js
var import_jetstream15 = __toESM(require_mod4(), 1);
var import_transport_node16 = __toESM(require_transport_node(), 1);
var import_kv7 = __toESM(require_mod6(), 1);
var import_obj = __toESM(require_mod7(), 1);

// ../../packages/core/dist/broker-floor.js
var BROKER_FLOOR = Object.freeze({ major: 2, minor: 12 });

// ../../packages/core/dist/acls.js
var import_kv6 = __toESM(require_mod6(), 1);

// ../../packages/core/dist/kv-scan.js
var import_internal2 = __toESM(require_internal_mod3(), 1);
var import_jetstream13 = __toESM(require_mod4(), 1);

// ../../packages/core/dist/endpoint.js
var import_transport_node14 = __toESM(require_transport_node(), 1);
var import_nats_core = __toESM(require_mod3(), 1);

// ../../packages/core/dist/liveness.js
var LIVENESS_PLANES = Object.freeze(["manager", "delivery"]);

// ../../packages/core/dist/endpoint.js
var import_jetstream11 = __toESM(require_mod4(), 1);
var import_jetstream12 = __toESM(require_mod4(), 1);
var import_kv5 = __toESM(require_mod6(), 1);
var import_internal = __toESM(require_internal_mod3(), 1);

// ../../packages/core/dist/members.js
var import_kv2 = __toESM(require_mod6(), 1);

// ../../packages/core/dist/lease.js
var import_kv3 = __toESM(require_mod6(), 1);
var import_transport_node12 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/channels.js
var import_kv4 = __toESM(require_mod6(), 1);
var import_transport_node13 = __toESM(require_transport_node(), 1);

// ../../packages/core/dist/backup-config.js
var import_jetstream14 = __toESM(require_mod4(), 1);
var import_transport_node15 = __toESM(require_transport_node(), 1);
var DEFAULT_DUPLICATE_WINDOW = (0, import_transport_node15.nanos)(2 * 60 * 1e3);
var BACKUP_PLANE3_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1e3;
var PLANE3_DUPLICATE_WINDOW = (0, import_transport_node15.nanos)(BACKUP_PLANE3_DEDUP_WINDOW_MS);

// ../../packages/core/dist/streams.js
var PRESENCE_STORAGE = import_jetstream15.StorageType.Memory;
var MANAGER_LEASE_TTL_MS = 1e4;
var MANAGER_LEASE_RENEW_MS = MANAGER_LEASE_TTL_MS / 4;
var MEMBERSHIP_MAX_BYTES = 64 * 1024 * 1024;
var LEGACY_ARTIFACT_STORE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

// ../../packages/core/dist/provision.js
var import_nkeys3 = __toESM(require_mod2(), 1);

// ../../packages/core/dist/run-driver-grants.js
var PLACEMENT_COMMANDS = Object.freeze(["describe", "resolve-cwd", "spawn"]);

// ../../packages/core/dist/transfer.js
var import_nats_core2 = __toESM(require_mod3(), 1);
var import_jetstream16 = __toESM(require_mod4(), 1);
var import_obj2 = __toESM(require_mod7(), 1);
var TRANSFER_CHUNK_MAX = 128 * 1024;
var HEADER_ROOM = 4 * 1024;

// ../../packages/core/dist/backup.js
var import_jetstream17 = __toESM(require_mod4(), 1);
var import_transport_node17 = __toESM(require_transport_node(), 1);
var DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60 * 1e3;

// ../../packages/core/dist/provision.js
var FIVE_MINUTES = 5 * 60;
var MAX_CONTROL_LINE_BYTES = 65536;
var CONNECT_ENVELOPE_OVERHEAD_BYTES = 512;
var MAX_MINTED_JWT_BYTES = MAX_CONTROL_LINE_BYTES - CONNECT_ENVELOPE_OVERHEAD_BYTES;
var STANDING_RENEWABLE_TTL_SEC = 24 * 60 * 60;
var ROTATION_RENEWED_TTL_SEC = 30 * 24 * 60 * 60;
var CREDENTIAL_LIFETIMES = {
  agent: { class: "mixed", note: "manager children, foreground spawn/join, and cotal mint static outputs all use this profile; split or repair flow required before default exp" },
  "manager-caller": { class: "mixed", note: "short-lived user-auth view bound to the bearer expiry and one manager instance" },
  observer: { class: "static-operator-managed", note: "out-of-band dashboard/audit credential from cotal mint" },
  admin: { class: "static-operator-managed", note: "out-of-band elevated dashboard/audit credential from cotal mint" },
  supervisor: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's always-on endpoint; the manager holds the DATA seed and self-remints via the endpoint creds source" },
  delivery: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "server-side Plane-3 daemon; seed-less - the manager re-signs .cotal/delivery.creds for the SAME nkey, requests delivery-admin reloadCreds for explicit adoption, and the endpoint source re-read is only a backstop" },
  "membership-rw": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "membership feed writer; seed-less - the manager re-signs the membership-rw.creds store key for the SAME nkey, the feed adopts it on a 75% preflight-proven renewal timer (its active self-heal), and delivery-admin reloadCreds is the explicit adoption on top" },
  provisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "setup/spawn provisioning window only" },
  deprovisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "target-pinned teardown window only" },
  "retirement-requester": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one despawn's retirement request window; request+reply only" },
  "lifecycle-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one static lifecycle operation's 13.1 state-write window (activation / terminal / renewal ledger append)" },
  "endpoint-serve-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one endpoint registration/serve-mint window (13.1 epgate CAS + epcred stage/revoke + eprepair cursor for one (endpoint, instanceId))" },
  operator: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "send/dm/join/probe-style operator command" },
  purger: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "history purge command" },
  backup: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline snapshot phase; exact stream and delivery subject, memory-only" },
  restore: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline restore initiation or exact-ID upload phase, memory-only" },
  probe: { class: "one-shot", defaultTtlSeconds: 60, note: "connect-only preflight" },
  "channel-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "channel registry mutation command" },
  "channel-purger": { class: "mixed", note: "one-shot for CLI, standing inside web; split or renewal required before default exp" },
  teardown: { class: "one-shot", note: "space teardown can be long/destructive; needs TTL budget/remint guard before default exp" },
  "control-caller-privileged": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "ps/start control call" },
  "control-caller-admin": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "stop/attach admin control call" },
  deployer: { class: "one-shot", note: "manifest deploy spans planning/launch/ledger; needs near-expiry guard or remint before default exp" },
  "endpoint-serve": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "per-instance endpoint serve credential (SPEC 13.9); the managing authority re-mints on renewal and on takeover (new epoch), and the 13.1 barrier revokes the superseded one" },
  "goal-writer": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "self-mediated goal-writer for spawn-as-action; the manager re-mints for the SAME nkey on renewal, disjoint from the serve credential" },
  "session-caller": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session console/CLI caller cred: rails-only for ONE \xA713.6 session; TTL-BOUND to the session (the face mints with expiresAt = the session exp; the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred" },
  "session-serving": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session SERVING cred: rails-only for ONE \xA713.6 session, the mirror of session-caller with the directions swapped; minted at redemption and TTL-BOUND to the session (the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred, and the session's terminal revokes this one by name" },
  "session-ledger": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's session LEDGER: the dedicated sessions-bucket `session.<id>` rows and NOTHING else - no session rail of any shape. Standing because SPEC 13.6 makes it the durable revocation authority that must survive the serving endpoint; the manager re-mints for the SAME nkey on the half-TTL loop (the goal-writer precedent)" },
  "run-driver": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "one workflow run's driver, per takeover attempt (SPEC 14.6): the hosting manager mints it when it takes the run over and re-mints for the SAME nkey on renewal; a new takeover mints a new one" },
  "run-mediator": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "trusted workflow host operations, bound to one run and attempt; kept on the hosting process's connection" },
  "run-operator": { class: "one-shot", defaultTtlSeconds: 60, note: "one served run-status / run-ps / run-answer call (SPEC 14.3): the hosting manager mints it per call on its own connection, never the serve rails; 60s bounds a copied cred to a minute" },
  issuer: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one issuance's evidence stage/release or one lifecycle terminal's issuance retirement (SPEC 13.15)" },
  "run-admitter": { class: "one-shot", defaultTtlSeconds: 60, note: "one hosted run's admission record create, or its revocation marker (SPEC 14.8); 60s bounds a copied cred to a minute" },
  "transfer-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one carried resume per CLI call: one object's chunk and meta subjects in one instance's transfer bucket" },
  "transfer-reader": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one transcript-receive or sweep over the minting instance's own transfer bucket" },
  "endpoint-evictor": { class: "one-shot", defaultTtlSeconds: 60, note: "one re-registration's verify-evict window: a scoped delivery-admin caller that kicks+verifies the SUPERSEDED serve family before the epoch advances; 60s bounds a copied cred to a minute" },
  "remote-manager": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "auth-service", note: "the scoped remote manager lifecycle: own lease/presence plus same-owner agent provisioning; issued only by the typed supervise protocol, never by cotal mint or a raw view/profile string" },
  "membership-observer": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account CONNZ observer; NOT online-renewable ($SYS seed dies at `up`) - bounded exp, renewed only by rotateSystemAccount + broker restart; doctor warns near expiry" },
  "connection-evictor": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account KICK-only live-eviction cred; same rotation-renewed posture as the observer" }
};
for (const p of Object.values(CREDENTIAL_LIFETIMES))
  Object.freeze(p);
Object.freeze(CREDENTIAL_LIFETIMES);
var LIFETIME_TTL_SNAP = new Map(Object.entries(CREDENTIAL_LIFETIMES).map(([k, p]) => [k, p.defaultTtlSeconds]));
var BASE_LIMITS = {
  subs: -1,
  conn: -1,
  leaf: -1,
  imports: -1,
  exports: -1,
  data: -1,
  payload: -1,
  wildcards: true
};
var DATA_LIMITS = { ...BASE_LIMITS, mem_storage: -1, disk_storage: -1 };
var SYS_LIMITS = { ...BASE_LIMITS, mem_storage: 0, disk_storage: 0 };

// ../../packages/core/dist/space-auth.js
var import_nkeys4 = __toESM(require_mod2(), 1);

// ../../packages/core/dist/membership-feed.js
var import_transport_node18 = __toESM(require_transport_node(), 1);
var import_kv8 = __toESM(require_mod6(), 1);

// ../../packages/core/dist/agent-file.js
var import_yaml = __toESM(require_dist(), 1);

// ../../packages/core/dist/spaces.js
var import_transport_node19 = __toESM(require_transport_node(), 1);
var import_jetstream18 = __toESM(require_mod4(), 1);
var import_kv9 = __toESM(require_mod6(), 1);

// ../../packages/core/dist/loopback.js
var import_node_net = require("node:net");
var LOOPBACK = new import_node_net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

// ../../packages/core/dist/managed-handoff.js
var TARGET_FIELDS = ["space", "owner", "actor", "lifecycleUid"];
var STRING_FIELDS = [...TARGET_FIELDS, "kind", "server", "authProvider", "exchangeUrl", "sentinelCreds", "actorToken"];
var LIST_FIELDS = ["subscribe", "allowSubscribe", "allowPublish"];
var FIELDS = /* @__PURE__ */ new Set([...STRING_FIELDS, ...LIST_FIELDS, "tlsRequired", "idp", "policy"]);

// ../../packages/core/dist/registry.js
var import_node_async_hooks = require("node:async_hooks");
var Registry = class {
  #byKey = /* @__PURE__ */ new Map();
  /** While a stage is active in the CURRENT async context, {@link register} writes there instead of
   *  the live map (invisible to resolve/all until commit). `AsyncLocalStorage` propagates the stage
   *  through the import's awaits but NOT into unrelated concurrent async work. */
  #stage = new import_node_async_hooks.AsyncLocalStorage();
  /** Register one or more extensions, all-or-nothing. A duplicate `kind:name` (already live, already
   *  staged, or repeated within this call) throws BEFORE any of the batch is applied. During a
   *  {@link runStaged} import the batch lands in the per-import stage (invisible); otherwise it lands
   *  live. */
  register(...exts) {
    const stage = this.#stage.getStore();
    const keys = exts.map((ext) => `${ext.kind}:${ext.name}`);
    const seen = /* @__PURE__ */ new Set();
    for (const key of keys) {
      if (this.#byKey.has(key) || (stage?.has(key) ?? false) || seen.has(key))
        throw new Error(`extension already registered: ${key}`);
      seen.add(key);
    }
    const target = stage ?? this.#byKey;
    exts.forEach((ext, i) => target.set(keys[i], ext));
  }
  /** Remove one extension by kind + name; returns whether it was registered. Generic teardown; it
   *  knows nothing about what a kind means. */
  unregister(kind, name) {
    return this.#byKey.delete(`${kind}:${name}`);
  }
  /**
   * Run `load` (typically a self-registering `import()`) with the registrations it makes STAGED
   * (invisible to {@link resolve}/{@link all}) and return them for the caller to validate against the
   * manifest-advertised keys, then {@link commitStaged}. A throw/rejection propagates and the stage is
   * DISCARDED: those registrations never touched the live registry, and no unrelated live registration
   * is affected. Callers still SERIALIZE loads so two imports never share a validation window.
   */
  async runStaged(load) {
    const stage = /* @__PURE__ */ new Map();
    const value = await this.#stage.run(stage, load);
    return { value, staged: [...stage.values()] };
  }
  /** Publish previously-staged registrations to the live registry, atomically (all-or-nothing,
   *  re-checked against the live map, which may have changed since staging). */
  commitStaged(staged) {
    const keys = staged.map((ext) => `${ext.kind}:${ext.name}`);
    for (const key of keys)
      if (this.#byKey.has(key))
        throw new Error(`extension already registered: ${key}`);
    staged.forEach((ext, i) => this.#byKey.set(keys[i], ext));
  }
  /** Whether a committed extension exists for kind + name (staged registrations are invisible here,
   *  like {@link resolve}). A boolean probe that never throws. */
  has(kind, name) {
    return this.#byKey.has(`${kind}:${name}`);
  }
  /** Resolve one extension by kind + name. Unknown throws. Staged (uncommitted) registrations are
   *  invisible here; only committed ones resolve. */
  resolve(kind, name) {
    const ext = this.#byKey.get(`${kind}:${name}`);
    if (!ext)
      throw new Error(`no ${kind} registered for "${name}"`);
    return ext;
  }
  all(kind) {
    const values = [...this.#byKey.values()];
    return kind === void 0 ? values : values.filter((e) => e.kind === kind);
  }
};
var registry2 = new Registry();

// ../../packages/core/dist/remote-manager-authority.js
var MANAGED_AGENT_RUNTIME_STATES = Object.freeze(["reserved", "creating", "bound", "create-unknown", "closing", "closed"]);
var MANAGED_AGENT_RUNTIME_READINESS = Object.freeze(["ready", "bound-not-ready", "none"]);
var MANAGED_AGENT_RETIREMENT_PHASES = Object.freeze(["intent", "released", "retired", "deprovisioned", "terminal"]);

// ../../packages/core/dist/agui-kind.js
var AGUI_EVENT_TYPE = Object.freeze({
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  CUSTOM: "CUSTOM"
});

// ../../packages/core/dist/run-host.js
var RUN_ACTIVATION_WAIT_MS = 15e3;
var RUN_LAUNCH_DEADLINE_MS = RUN_ACTIVATION_WAIT_MS + 1e4;

// ../../packages/core/dist/issuer-session.js
var import_jetstream19 = __toESM(require_mod4(), 1);
var import_kv10 = __toESM(require_mod6(), 1);

// ../connector-core/dist/control.js
var HANDOFF_RECEIPT = '{"handoff":"ok"}\n';
var MAX_FRAME_BYTES = 1 << 20;

// ../connector-core/dist/relay.js
var TIMEOUT_MS = 2e3;
var CONNECT_RETRY_INITIAL_MS = 25;
var CONNECT_RETRY_MAX_MS = 250;
var isRetryableConnectError = (error) => {
  const code = error instanceof Error ? error.code : void 0;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EAGAIN", "EBUSY"].includes(code ?? "");
};
var isSessionStart = (event) => event !== null && typeof event === "object" && event.hook_event_name === "SessionStart";
var warned = false;
function warnOnce(message) {
  if (warned)
    return;
  warned = true;
  try {
    process.stderr.write(`[cotal-connector] ${message}
`);
  } catch {
  }
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY)
      return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => d += c);
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}
function done(out, confirm) {
  const exit = () => process.exit(0);
  const t = out.trim();
  if (!t)
    return exit();
  process.stdout.on("error", () => exit());
  process.stdout.write(t + "\n", (err) => {
    if (err || !confirm)
      return exit();
    confirm(exit);
  });
  setTimeout(exit, 1e3);
}
async function runHookRelay() {
  if (!hasIdentity())
    return done("");
  let control;
  try {
    control = controlFromEnv();
  } catch {
    warnOnce("this session's control endpoint could not be resolved: the launch material is missing, unreadable, readable beyond its owner, malformed, or contradicted by direct COTAL_ variables. Lifecycle relays are disabled for this session, so presence will not advance and queued peer messages will not be injected. Check COTAL_LAUNCH_MATERIAL and COTAL_CONTROL_SOCKET.");
    return done("");
  }
  if (!control)
    return done("");
  const { path, token: token2 } = control;
  const raw = (await readStdin()).trim() || "{}";
  let event = {};
  try {
    event = JSON.parse(raw);
  } catch {
  }
  const startupCritical = isSessionStart(event);
  let sock;
  let settled = false;
  let retryDelayMs = CONNECT_RETRY_INITIAL_MS;
  const drop = (candidate = sock) => {
    try {
      candidate?.destroy();
    } catch {
    }
  };
  const settle = () => {
    if (settled)
      return false;
    settled = true;
    clearTimeout(timer);
    return true;
  };
  const finish = (out) => {
    if (!settle())
      return;
    drop();
    done(out);
  };
  const finishWithReceipt = (out, candidate) => {
    if (!settle())
      return;
    done(out, (then) => {
      try {
        candidate.write(HANDOFF_RECEIPT, () => {
          drop(candidate);
          then();
        });
      } catch {
        then();
      }
    });
  };
  const timer = setTimeout(() => finish(""), TIMEOUT_MS);
  const retryLater = () => {
    const wait = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, CONNECT_RETRY_MAX_MS);
    setTimeout(dial, wait);
  };
  const dial = () => {
    if (settled)
      return;
    const candidate = (0, import_node_net2.connect)(path);
    sock = candidate;
    let connected = false;
    let reply = "";
    candidate.setEncoding("utf8");
    candidate.on("connect", () => {
      if (settled || sock !== candidate)
        return;
      connected = true;
      try {
        candidate.write(JSON.stringify({ token: token2, event, handoff: true }) + "\n");
      } catch {
        finish("");
      }
    });
    candidate.on("data", (d) => {
      if (settled || sock !== candidate)
        return;
      reply += d;
      const nl = reply.indexOf("\n");
      if (nl >= 0)
        finishWithReceipt(reply.slice(0, nl), candidate);
    });
    candidate.on("error", (error) => {
      if (settled || sock !== candidate)
        return;
      if (!connected && startupCritical && isRetryableConnectError(error)) {
        drop(candidate);
        retryLater();
        return;
      }
      finish("");
    });
    candidate.on("end", () => {
      if (settled || sock !== candidate)
        return;
      finish(reply);
    });
  };
  dial();
}

// src/hook.ts
void runHookRelay().catch(() => process.exit(0));
/*! Bundled license information:

js-sha256/src/sha256.js:
  (**
   * [js-sha256]{@link https://github.com/emn178/js-sha256}
   *
   * @version 0.11.1
   * @author Chen, Yi-Cyuan [emn178@gmail.com]
   * @copyright Chen, Yi-Cyuan 2014-2025
   * @license MIT
   *)
*/
