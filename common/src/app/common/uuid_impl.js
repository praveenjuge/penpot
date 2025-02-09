/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS INC
 */
"use strict";

goog.require("cljs.core");
goog.require("app.common.encoding_impl");
goog.provide("app.common.uuid_impl");

goog.scope(function() {
  const core = cljs.core;
  const global = goog.global;
  const encoding  = app.common.encoding_impl;
  const self = app.common.uuid_impl;

  const timeRef = 1640995200000; // ms since 2022-01-01T00:00:00

  const fill = (() => {
    if (typeof global.crypto !== "undefined" &&
        typeof global.crypto.getRandomValues !== "undefined") {
      return (buf) => {
        global.crypto.getRandomValues(buf);
        return buf;
      };
    } else if (typeof require === "function") {
      const crypto = require("crypto");
      const randomBytes = crypto["randomBytes"];

      return (buf) => {
        const bytes = randomBytes(buf.length);
        buf.set(bytes)
        return buf;
      };
    } else {
      // FALLBACK
      console.warn("No SRNG available, switching back to Math.random.");

      return (buf) => {
        for (let i = 0, r; i < buf.length; i++) {
          if ((i & 0x03) === 0) { r = Math.random() * 0x100000000; }
          buf[i] = r >>> ((i & 0x03) << 3) & 0xff;
        }
        return buf;
      };
    }
  })();

  function toHexString(buf) {
    const hexMap = encoding.hexMap;
    let i = 0;
    return  (hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] + '-' +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] + '-' +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] + '-' +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] + '-' +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]] +
             hexMap[buf[i++]]);
  };

  function getBigUint64(view, byteOffset, le) {
    const a = view.getUint32(byteOffset, le);
    const b = view.getUint32(byteOffset + 4, le);
    const leMask = Number(!!le);
    const beMask = Number(!le);
    return ((BigInt(a * beMask + b * leMask) << 32n) |
            (BigInt(a * leMask + b * beMask)));
  }

  function setBigUint64(view, byteOffset, value, le) {
    const hi = Number(value >> 32n);
    const lo = Number(value & 0xffffffffn);
    if (le) {
      view.setUint32(byteOffset + 4, hi, le);
      view.setUint32(byteOffset, lo, le);
    }
    else {
      view.setUint32(byteOffset, hi, le);
      view.setUint32(byteOffset + 4, lo, le);
    }
  }

  function currentTimestamp(timeRef) {
    return BigInt.asUintN(64, "" + (Date.now() - timeRef));
  }

  const tmpBuff = new ArrayBuffer(8);
  const tmpView = new DataView(tmpBuff);
  const tmpInt8 = new Uint8Array(tmpBuff);

  function nextLong() {
    fill(tmpInt8);
    return getBigUint64(tmpView, 0, false);
  }

  self.shortID = (function () {
    const buff  = new ArrayBuffer(8);
    const int8 = new Uint8Array(buff);
    const view  = new DataView(buff);

    const base = 0x0000_0000_0000_0000n;

    return function shortID(ts) {
      const tss = currentTimestamp(timeRef);
      const msb = (base
                   | (nextLong() & 0xffff_ffff_0000_0000n)
                   | (tss & 0x0000_0000_ffff_ffffn));
      setBigUint64(view, 0, msb, false);
      return encoding.toBase62(int8);
    };
  })();

  self.v4 = (function () {
    const arr = new Uint8Array(16);

    return function v4() {
      fill(arr);
      arr[6] = (arr[6] & 0x0f) | 0x40;
      arr[8] = (arr[8] & 0x3f) | 0x80;
      return core.uuid(encoding.bufferToHex(arr, true));
    };
  })();

  self.v8 = (function () {
    const buff = new ArrayBuffer(16);
    const int8 = new Uint8Array(buff);
    const view = new DataView(buff);

    const maxCs = 0x0000_0000_0000_3fffn; // 14 bits space

    let countCs = 0n;
    let lastRd  = 0n;
    let lastCs  = 0n;
    let lastTs  = 0n;
    let baseMsb = 0x0000_0000_0000_8000n;
    let baseLsb = 0x8000_0000_0000_0000n;

    lastRd = nextLong() & 0xffff_ffff_ffff_f0ffn;
    lastCs = nextLong() & maxCs;

    const create = function create(ts, lastRd, lastCs) {
      const msb = (baseMsb
                   | (lastRd & 0xffff_ffff_ffff_0fffn));

      const lsb = (baseLsb
                   | ((ts << 14n) & 0x3fff_ffff_ffff_c000n)
                   | lastCs);

      setBigUint64(view, 0, msb, false);
      setBigUint64(view, 8, lsb, false);

      return core.uuid(encoding.bufferToHex(int8, true));
    };

    const factory = function v8() {
      while (true) {
        let ts = currentTimestamp(timeRef);

        // Protect from clock regression
        if ((ts - lastTs) < 0) {
          lastRd = (lastRd
                    & 0x0000_0000_0000_0f00n
                    | (nextLong() & 0xffff_ffff_ffff_f0ffn));
          countCs = 0n;
          continue;
        }

        if (lastTs === ts) {
          if (countCs < maxCs) {
            lastCs = (lastCs + 1n) & maxCs;
            countCs++;
          } else {
            continue;
          }
        } else {
          lastTs = ts;
          lastCs = nextLong() & maxCs;
          countCs = 0;
        }

        return create(ts, lastRd, lastCs);
      }
    };

    const setTag = (tag) => {
      tag = BigInt.asUintN(64, "" + tag);
      if (tag > 0x0000_0000_0000_000fn) {
        throw new Error("illegal arguments: tag value should fit in 4bits");
      }

      lastRd = (lastRd
                & 0xffff_ffff_ffff_f0ffn
                | ((tag << 8) & 0x0000_0000_0000_0f00n));
    };

    factory.create = create;
    factory.setTag = setTag;
    return factory;
  })();

  self.short_v8 = function(uuid) {
    const buff = encoding.hexToBuffer(uuid);
    const short =  new Uint8Array(buff, 4);
    return encoding.bufferToBase62(short);
  };

  self.custom = function formatAsUUID(mostSigBits, leastSigBits) {
    const most = mostSigBits.toString("16").padStart(16, "0");
    const least = leastSigBits.toString("16").padStart(16, "0");
    return `${most.substring(0, 8)}-${most.substring(8, 12)}-${most.substring(12)}-${least.substring(0, 4)}-${least.substring(4)}`;
  };

  self.get_u32 = (function() {
    const UUID_BYTE_SIZE = 16;
    const ab = new ArrayBuffer(UUID_BYTE_SIZE);
    const u32buffer = new Uint32Array(ab);
    const HYPHEN = '-'.charCodeAt(0);
    const A = 'a'.charCodeAt(0);
    const A_SUB = A - 10;
    const ZERO = '0'.charCodeAt(0);
    const MAX_DIGIT = 8;
    const HALF_BITS = 4;
    return function(uuid) {
      let digit = 0;
      let numDigit = 0;
      let u32index = 0;
      let u32 = 0;
      for (let i = 0; i < uuid.length; i++) {
        const charCode = uuid.charCodeAt(i);
        if (charCode === HYPHEN) continue;
        if (charCode >= A) {
          digit = charCode - A_SUB;
        } else {
          digit = charCode - ZERO;
        }
        numDigit++;
        const bitPos = (MAX_DIGIT - numDigit) * HALF_BITS;
        u32 |= (digit << bitPos);
        if (numDigit === MAX_DIGIT) {
          u32buffer[u32index++] = u32;
          u32 = 0;
          numDigit = 0;
        }
      }
      return u32buffer;
    }
  })();
});
