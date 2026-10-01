var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var _t2, _e2, _a, _b;
typeof window < "u" && (window.__svelte || (window.__svelte = { v: /* @__PURE__ */ new Set() })).v.add("5");
const nr = 2, sr = "[", or = "]", Qe = {}, K = Symbol(), ii = false, Z = 2, vi = 4, kt = 8, Ht = 16, ye = 32, Ie = 64, bt = 128, G = 256, pt = 512, H = 1024, Ce = 2048, Ke = 4096, vt = 8192, St = 16384, ar = 32768, lr = 65536, ur = 1 << 19, mi = 1 << 20, dt = Symbol("$state"), dr = Symbol("legacy props");
var wi = Array.isArray, cr = Array.prototype.indexOf, fr = Array.from, mt = Object.keys, wt = Object.defineProperty, ze = Object.getOwnPropertyDescriptor, hr = Object.getOwnPropertyDescriptors, br = Object.prototype, pr = Array.prototype, gi = Object.getPrototypeOf;
function _i(t) {
  for (var e = 0; e < t.length; e++)
    t[e]();
}
let tt = [], zt = [];
function xi() {
  var t = tt;
  tt = [], _i(t);
}
function vr() {
  var t = zt;
  zt = [], _i(t);
}
function jt(t) {
  tt.length === 0 && queueMicrotask(xi), tt.push(t);
}
function ri() {
  tt.length > 0 && xi(), zt.length > 0 && vr();
}
function yi(t) {
  return t === this.v;
}
function mr(t, e) {
  return t != t ? e == e : t !== e || t !== null && typeof t == "object" || typeof t == "function";
}
function wr(t) {
  return !mr(t, this.v);
}
function gr(t) {
  throw new Error("https://svelte.dev/e/effect_in_teardown");
}
function _r() {
  throw new Error("https://svelte.dev/e/effect_in_unowned_derived");
}
function xr(t) {
  throw new Error("https://svelte.dev/e/effect_orphan");
}
function yr() {
  throw new Error("https://svelte.dev/e/effect_update_depth_exceeded");
}
function Cr() {
  throw new Error("https://svelte.dev/e/hydration_failed");
}
function Er() {
  throw new Error("https://svelte.dev/e/state_descriptors_fixed");
}
function kr() {
  throw new Error("https://svelte.dev/e/state_prototype_fixed");
}
function Sr() {
  throw new Error("https://svelte.dev/e/state_unsafe_local_read");
}
function Dr() {
  throw new Error("https://svelte.dev/e/state_unsafe_mutation");
}
let Tr = false;
function se(t, e) {
  var i = {
    f: 0,
    // TODO ideally we could skip this altogether, but it causes type errors
    v: t,
    reactions: null,
    equals: yi,
    rv: 0,
    wv: 0
  };
  return i;
}
function Ft(t) {
  return /* @__PURE__ */ Rr(se(t));
}
// @__NO_SIDE_EFFECTS__
function Ci(t, e = false) {
  const i = se(t);
  return e || (i.equals = wr), i;
}
// @__NO_SIDE_EFFECTS__
function Rr(t) {
  return k !== null && !X && (k.f & Z) !== 0 && (oe === null ? Fr([t]) : oe.push(t)), t;
}
function q(t, e) {
  return k !== null && !X && Hi() && (k.f & (Z | Ht)) !== 0 && // If the source was created locally within the current derived, then
  // we allow the mutation.
  (oe === null || !oe.includes(t)) && Dr(), $r(t, e);
}
function $r(t, e) {
  return t.equals(e) || (t.v, t.v = e, t.wv = Fi(), Ei(t, Ce), D !== null && (D.f & H) !== 0 && (D.f & (ye | Ie)) === 0 && (de === null ? Mr([t]) : de.push(t))), e;
}
function Ei(t, e) {
  var i = t.reactions;
  if (i !== null)
    for (var r = i.length, n = 0; n < r; n++) {
      var o = i[n], d = o.f;
      (d & Ce) === 0 && (fe(o, e), (d & (H | G)) !== 0 && ((d & Z) !== 0 ? Ei(
        /** @type {Derived} */
        o,
        Ke
      ) : Zt(
        /** @type {Effect} */
        o
      )));
    }
}
// @__NO_SIDE_EFFECTS__
function ki(t) {
  var e = Z | Ce, i = k !== null && (k.f & Z) !== 0 ? (
    /** @type {Derived} */
    k
  ) : null;
  return D === null || i !== null && (i.f & G) !== 0 ? e |= G : D.f |= mi, {
    ctx: B,
    deps: null,
    effects: null,
    equals: yi,
    f: e,
    fn: t,
    reactions: null,
    rv: 0,
    v: (
      /** @type {V} */
      null
    ),
    wv: 0,
    parent: i ?? D
  };
}
function Si(t) {
  var e = t.effects;
  if (e !== null) {
    t.effects = null;
    for (var i = 0; i < e.length; i += 1)
      xe(
        /** @type {Effect} */
        e[i]
      );
  }
}
function Ar(t) {
  for (var e = t.parent; e !== null; ) {
    if ((e.f & Z) === 0)
      return (
        /** @type {Effect} */
        e
      );
    e = e.parent;
  }
  return null;
}
function Or(t) {
  var e, i = D;
  _e(Ar(t));
  try {
    Si(t), e = Ni(t);
  } finally {
    _e(i);
  }
  return e;
}
function Di(t) {
  var e = Or(t), i = (we || (t.f & G) !== 0) && t.deps !== null ? Ke : H;
  fe(t, i), t.equals(e) || (t.v = e, t.wv = Fi());
}
function Gt(t) {
  console.warn("https://svelte.dev/e/hydration_mismatch");
}
let J = false;
function at(t) {
  J = t;
}
let I;
function gt(t) {
  if (t === null)
    throw Gt(), Qe;
  return I = t;
}
function Ti() {
  return gt(
    /** @type {TemplateNode} */
    /* @__PURE__ */ Dt(I)
  );
}
function Mt(t) {
  if (J) {
    if (/* @__PURE__ */ Dt(I) !== null)
      throw Gt(), Qe;
    I = t;
  }
}
function De(t, e = null, i) {
  if (typeof t != "object" || t === null || dt in t)
    return t;
  const r = gi(t);
  if (r !== br && r !== pr)
    return t;
  var n = /* @__PURE__ */ new Map(), o = wi(t), d = se(0);
  o && n.set("length", se(
    /** @type {any[]} */
    t.length
  ));
  var b;
  return new Proxy(
    /** @type {any} */
    t,
    {
      defineProperty(c, p, h) {
        (!("value" in h) || h.configurable === false || h.enumerable === false || h.writable === false) && Er();
        var m = n.get(p);
        return m === void 0 ? (m = se(h.value), n.set(p, m)) : q(m, De(h.value, b)), true;
      },
      deleteProperty(c, p) {
        var h = n.get(p);
        if (h === void 0)
          p in c && n.set(p, se(K));
        else {
          if (o && typeof p == "string") {
            var m = (
              /** @type {Source<number>} */
              n.get("length")
            ), s = Number(p);
            Number.isInteger(s) && s < m.v && q(m, s);
          }
          q(h, K), ni(d);
        }
        return true;
      },
      get(c, p, h) {
        var _a2;
        if (p === dt)
          return t;
        var m = n.get(p), s = p in c;
        if (m === void 0 && (!s || ((_a2 = ze(c, p)) == null ? void 0 : _a2.writable)) && (m = se(De(s ? c[p] : K, b)), n.set(p, m)), m !== void 0) {
          var l = U(m);
          return l === K ? void 0 : l;
        }
        return Reflect.get(c, p, h);
      },
      getOwnPropertyDescriptor(c, p) {
        var h = Reflect.getOwnPropertyDescriptor(c, p);
        if (h && "value" in h) {
          var m = n.get(p);
          m && (h.value = U(m));
        } else if (h === void 0) {
          var s = n.get(p), l = s == null ? void 0 : s.v;
          if (s !== void 0 && l !== K)
            return {
              enumerable: true,
              configurable: true,
              value: l,
              writable: true
            };
        }
        return h;
      },
      has(c, p) {
        var _a2;
        if (p === dt)
          return true;
        var h = n.get(p), m = h !== void 0 && h.v !== K || Reflect.has(c, p);
        if (h !== void 0 || D !== null && (!m || ((_a2 = ze(c, p)) == null ? void 0 : _a2.writable))) {
          h === void 0 && (h = se(m ? De(c[p], b) : K), n.set(p, h));
          var s = U(h);
          if (s === K)
            return false;
        }
        return m;
      },
      set(c, p, h, m) {
        var _a2;
        var s = n.get(p), l = p in c;
        if (o && p === "length")
          for (var a = h; a < /** @type {Source<number>} */
          s.v; a += 1) {
            var u = n.get(a + "");
            u !== void 0 ? q(u, K) : a in c && (u = se(K), n.set(a + "", u));
          }
        s === void 0 ? (!l || ((_a2 = ze(c, p)) == null ? void 0 : _a2.writable)) && (s = se(void 0), q(s, De(h, b)), n.set(p, s)) : (l = s.v !== K, q(s, De(h, b)));
        var f = Reflect.getOwnPropertyDescriptor(c, p);
        if ((f == null ? void 0 : f.set) && f.set.call(m, h), !l) {
          if (o && typeof p == "string") {
            var $ = (
              /** @type {Source<number>} */
              n.get("length")
            ), A = Number(p);
            Number.isInteger(A) && A >= $.v && q($, A + 1);
          }
          ni(d);
        }
        return true;
      },
      ownKeys(c) {
        U(d);
        var p = Reflect.ownKeys(c).filter((s) => {
          var l = n.get(s);
          return l === void 0 || l.v !== K;
        });
        for (var [h, m] of n)
          m.v !== K && !(h in c) && p.push(h);
        return p;
      },
      setPrototypeOf() {
        kr();
      }
    }
  );
}
function ni(t, e = 1) {
  q(t, t.v + e);
}
var si, Ri, $i, Ai;
function It() {
  if (si === void 0) {
    si = window, Ri = /Firefox/.test(navigator.userAgent);
    var t = Element.prototype, e = Node.prototype;
    $i = ze(e, "firstChild").get, Ai = ze(e, "nextSibling").get, t.__click = void 0, t.__className = void 0, t.__attributes = null, t.__styles = null, t.__e = void 0, Text.prototype.__t = void 0;
  }
}
function Oi(t = "") {
  return document.createTextNode(t);
}
// @__NO_SIDE_EFFECTS__
function _t(t) {
  return $i.call(t);
}
// @__NO_SIDE_EFFECTS__
function Dt(t) {
  return Ai.call(t);
}
function Nt(t, e) {
  if (!J)
    return /* @__PURE__ */ _t(t);
  var i = (
    /** @type {TemplateNode} */
    /* @__PURE__ */ _t(I)
  );
  return i === null && (i = I.appendChild(Oi())), gt(i), i;
}
function Lr(t) {
  t.textContent = "";
}
let ct = false, xt = false, yt = null, ft = false, Yt = false;
function oi(t) {
  Yt = t;
}
let et = [];
let k = null, X = false;
function ge(t) {
  k = t;
}
let D = null;
function _e(t) {
  D = t;
}
let oe = null;
function Fr(t) {
  oe = t;
}
let P = null, V = 0, de = null;
function Mr(t) {
  de = t;
}
let Li = 1, Ct = 0, we = false;
function Fi() {
  return ++Li;
}
function Tt(t) {
  var _a2;
  var e = t.f;
  if ((e & Ce) !== 0)
    return true;
  if ((e & Ke) !== 0) {
    var i = t.deps, r = (e & G) !== 0;
    if (i !== null) {
      var n, o, d = (e & pt) !== 0, b = r && D !== null && !we, c = i.length;
      if (d || b) {
        var p = (
          /** @type {Derived} */
          t
        ), h = p.parent;
        for (n = 0; n < c; n++)
          o = i[n], (d || !((_a2 = o == null ? void 0 : o.reactions) == null ? void 0 : _a2.includes(p))) && (o.reactions ?? (o.reactions = [])).push(p);
        d && (p.f ^= pt), b && h !== null && (h.f & G) === 0 && (p.f ^= G);
      }
      for (n = 0; n < c; n++)
        if (o = i[n], Tt(
          /** @type {Derived} */
          o
        ) && Di(
          /** @type {Derived} */
          o
        ), o.wv > t.wv)
          return true;
    }
    (!r || D !== null && !we) && fe(t, H);
  }
  return false;
}
function Nr(t, e) {
  for (var i = e; i !== null; ) {
    if ((i.f & bt) !== 0)
      try {
        i.fn(t);
        return;
      } catch {
        i.f ^= bt;
      }
    i = i.parent;
  }
  throw ct = false, t;
}
function Pr(t) {
  return (t.f & St) === 0 && (t.parent === null || (t.parent.f & bt) === 0);
}
function Rt(t, e, i, r) {
  if (ct) {
    if (i === null && (ct = false), Pr(e))
      throw t;
    return;
  }
  i !== null && (ct = true);
  {
    Nr(t, e);
    return;
  }
}
function Mi(t, e, i = true) {
  var r = t.reactions;
  if (r !== null)
    for (var n = 0; n < r.length; n++) {
      var o = r[n];
      (o.f & Z) !== 0 ? Mi(
        /** @type {Derived} */
        o,
        e,
        false
      ) : e === o && (i ? fe(o, Ce) : (o.f & H) !== 0 && fe(o, Ke), Zt(
        /** @type {Effect} */
        o
      ));
    }
}
function Ni(t) {
  var _a2;
  var e = P, i = V, r = de, n = k, o = we, d = oe, b = B, c = X, p = t.f;
  P = /** @type {null | Value[]} */
  null, V = 0, de = null, we = (p & G) !== 0 && (X || !ft || k === null), k = (p & (ye | Ie)) === 0 ? t : null, oe = null, ai(t.ctx), X = false, Ct++;
  try {
    var h = (
      /** @type {Function} */
      (0, t.fn)()
    ), m = t.deps;
    if (P !== null) {
      var s;
      if (Et(t, V), m !== null && V > 0)
        for (m.length = V + P.length, s = 0; s < P.length; s++)
          m[V + s] = P[s];
      else
        t.deps = m = P;
      if (!we)
        for (s = V; s < m.length; s++)
          ((_a2 = m[s]).reactions ?? (_a2.reactions = [])).push(t);
    } else m !== null && V < m.length && (Et(t, V), m.length = V);
    if (Hi() && de !== null && !X && m !== null && (t.f & (Z | Ke | Ce)) === 0)
      for (s = 0; s < /** @type {Source[]} */
      de.length; s++)
        Mi(
          de[s],
          /** @type {Effect} */
          t
        );
    return n !== null && Ct++, h;
  } finally {
    P = e, V = i, de = r, k = n, we = o, oe = d, ai(b), X = c;
  }
}
function Ur(t, e) {
  let i = e.reactions;
  if (i !== null) {
    var r = cr.call(i, t);
    if (r !== -1) {
      var n = i.length - 1;
      n === 0 ? i = e.reactions = null : (i[r] = i[n], i.pop());
    }
  }
  i === null && (e.f & Z) !== 0 && // Destroying a child effect while updating a parent effect can cause a dependency to appear
  // to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
  // allows us to skip the expensive work of disconnecting and immediately reconnecting it
  (P === null || !P.includes(e)) && (fe(e, Ke), (e.f & (G | pt)) === 0 && (e.f ^= pt), Si(
    /** @type {Derived} **/
    e
  ), Et(
    /** @type {Derived} **/
    e,
    0
  ));
}
function Et(t, e) {
  var i = t.deps;
  if (i !== null)
    for (var r = e; r < i.length; r++)
      Ur(t, i[r]);
}
function Xt(t) {
  var e = t.f;
  if ((e & St) === 0) {
    fe(t, H);
    var i = D, r = B, n = ft;
    D = t, ft = true;
    try {
      (e & Ht) !== 0 ? Jr(t) : zi(t), Bi(t);
      var o = Ni(t);
      t.teardown = typeof o == "function" ? o : null, t.wv = Li;
      var d = t.deps, b;
      ii && Tr && t.f & Ce;
    } catch (c) {
      Rt(c, t, i, r || t.ctx);
    } finally {
      ft = n, D = i;
    }
  }
}
function Br() {
  try {
    yr();
  } catch (t) {
    if (yt !== null)
      Rt(t, yt, null);
    else
      throw t;
  }
}
function Pi() {
  try {
    for (var t = 0; et.length > 0; ) {
      t++ > 1e3 && Br();
      var e = et, i = e.length;
      et = [];
      for (var r = 0; r < i; r++) {
        var n = e[r];
        (n.f & H) === 0 && (n.f ^= H);
        var o = Ir(n);
        zr(o);
      }
    }
  } finally {
    xt = false, yt = null;
  }
}
function zr(t) {
  var e = t.length;
  if (e !== 0)
    for (var i = 0; i < e; i++) {
      var r = t[i];
      if ((r.f & (St | vt)) === 0)
        try {
          Tt(r) && (Xt(r), r.deps === null && r.first === null && r.nodes_start === null && (r.teardown === null ? Ii(r) : r.fn = null));
        } catch (n) {
          Rt(n, r, null, r.ctx);
        }
    }
}
function Zt(t) {
  xt || (xt = true, queueMicrotask(Pi));
  for (var e = yt = t; e.parent !== null; ) {
    e = e.parent;
    var i = e.f;
    if ((i & (Ie | ye)) !== 0) {
      if ((i & H) === 0) return;
      e.f ^= H;
    }
  }
  et.push(e);
}
function Ir(t) {
  for (var e = [], i = t.first; i !== null; ) {
    var r = i.f, n = (r & ye) !== 0, o = n && (r & H) !== 0;
    if (!o && (r & vt) === 0) {
      if ((r & vi) !== 0)
        e.push(i);
      else if (n)
        i.f ^= H;
      else {
        var d = k;
        try {
          k = i, Tt(i) && Xt(i);
        } catch (p) {
          Rt(p, i, null, i.ctx);
        } finally {
          k = d;
        }
      }
      var b = i.first;
      if (b !== null) {
        i = b;
        continue;
      }
    }
    var c = i.parent;
    for (i = i.next; i === null && c !== null; )
      i = c.next, c = c.parent;
  }
  return e;
}
function Ye(t) {
  var e;
  for (ri(); et.length > 0; )
    xt = true, Pi(), ri();
  return (
    /** @type {T} */
    e
  );
}
function U(t) {
  var e = t.f, i = (e & Z) !== 0;
  if (k !== null && !X) {
    oe !== null && oe.includes(t) && Sr();
    var r = k.deps;
    t.rv < Ct && (t.rv = Ct, P === null && r !== null && r[V] === t ? V++ : P === null ? P = [t] : (!we || !P.includes(t)) && P.push(t));
  } else if (i && /** @type {Derived} */
  t.deps === null && /** @type {Derived} */
  t.effects === null) {
    var n = (
      /** @type {Derived} */
      t
    ), o = n.parent;
    o !== null && (o.f & G) === 0 && (n.f ^= G);
  }
  return i && (n = /** @type {Derived} */
  t, Tt(n) && Di(n)), t.v;
}
function $t(t) {
  var e = X;
  try {
    return X = true, t();
  } finally {
    X = e;
  }
}
const Kr = -7169;
function fe(t, e) {
  t.f = t.f & Kr | e;
}
function Wr(t) {
  D === null && k === null && xr(), k !== null && (k.f & G) !== 0 && D === null && _r(), Yt && gr();
}
function Vr(t, e) {
  var i = e.last;
  i === null ? e.last = e.first = t : (i.next = t, t.prev = i, e.last = t);
}
function Te(t, e, i, r = true) {
  var n = (t & Ie) !== 0, o = D, d = {
    ctx: B,
    deps: null,
    nodes_start: null,
    nodes_end: null,
    f: t | Ce,
    first: null,
    fn: e,
    last: null,
    next: null,
    parent: n ? null : o,
    prev: null,
    teardown: null,
    transitions: null,
    wv: 0
  };
  if (i)
    try {
      Xt(d), d.f |= ar;
    } catch (p) {
      throw xe(d), p;
    }
  else e !== null && Zt(d);
  var b = i && d.deps === null && d.first === null && d.nodes_start === null && d.teardown === null && (d.f & (mi | bt)) === 0;
  if (!b && !n && r && (o !== null && Vr(d, o), k !== null && (k.f & Z) !== 0)) {
    var c = (
      /** @type {Derived} */
      k
    );
    (c.effects ?? (c.effects = [])).push(d);
  }
  return d;
}
function qr(t) {
  const e = Te(kt, null, false);
  return fe(e, H), e.teardown = t, e;
}
function Hr(t) {
  Wr();
  var e = D !== null && (D.f & ye) !== 0 && B !== null && !B.m;
  if (e) {
    var i = (
      /** @type {ComponentContext} */
      B
    );
    (i.e ?? (i.e = [])).push({
      fn: t,
      effect: D,
      reaction: k
    });
  } else {
    var r = Jt(t);
    return r;
  }
}
function jr(t) {
  const e = Te(Ie, t, true);
  return () => {
    xe(e);
  };
}
function Gr(t) {
  const e = Te(Ie, t, true);
  return (i = {}) => new Promise((r) => {
    i.outro ? Qr(e, () => {
      xe(e), r(void 0);
    }) : (xe(e), r(void 0));
  });
}
function Jt(t) {
  return Te(vi, t, false);
}
function Ui(t) {
  return Te(kt, t, true);
}
function Yr(t, e = [], i = ki) {
  const r = e.map(i);
  return Xr(() => t(...r.map(U)));
}
function Xr(t, e = 0) {
  return Te(kt | Ht | e, t, true);
}
function Zr(t, e = true) {
  return Te(kt | ye, t, true, e);
}
function Bi(t) {
  var e = t.teardown;
  if (e !== null) {
    const i = Yt, r = k;
    oi(true), ge(null);
    try {
      e.call(null);
    } finally {
      oi(i), ge(r);
    }
  }
}
function zi(t, e = false) {
  var i = t.first;
  for (t.first = t.last = null; i !== null; ) {
    var r = i.next;
    xe(i, e), i = r;
  }
}
function Jr(t) {
  for (var e = t.first; e !== null; ) {
    var i = e.next;
    (e.f & ye) === 0 && xe(e), e = i;
  }
}
function xe(t, e = true) {
  var i = false;
  if ((e || (t.f & ur) !== 0) && t.nodes_start !== null) {
    for (var r = t.nodes_start, n = t.nodes_end; r !== null; ) {
      var o = r === n ? null : (
        /** @type {TemplateNode} */
        /* @__PURE__ */ Dt(r)
      );
      r.remove(), r = o;
    }
    i = true;
  }
  zi(t, e && !i), Et(t, 0), fe(t, St);
  var d = t.transitions;
  if (d !== null)
    for (const c of d)
      c.stop();
  Bi(t);
  var b = t.parent;
  b !== null && b.first !== null && Ii(t), t.next = t.prev = t.teardown = t.ctx = t.deps = t.fn = t.nodes_start = t.nodes_end = null;
}
function Ii(t) {
  var e = t.parent, i = t.prev, r = t.next;
  i !== null && (i.next = r), r !== null && (r.prev = i), e !== null && (e.first === t && (e.first = r), e.last === t && (e.last = i));
}
function Qr(t, e) {
  var i = [];
  Ki(t, i, true), en(i, () => {
    xe(t), e && e();
  });
}
function en(t, e) {
  var i = t.length;
  if (i > 0) {
    var r = () => --i || e();
    for (var n of t)
      n.out(r);
  } else
    e();
}
function Ki(t, e, i) {
  if ((t.f & vt) === 0) {
    if (t.f ^= vt, t.transitions !== null)
      for (const d of t.transitions)
        (d.is_global || i) && e.push(d);
    for (var r = t.first; r !== null; ) {
      var n = r.next, o = (r.f & lr) !== 0 || (r.f & ye) !== 0;
      Ki(r, e, o ? i : false), r = n;
    }
  }
}
function Wi(t) {
  throw new Error("https://svelte.dev/e/lifecycle_outside_component");
}
let B = null;
function ai(t) {
  B = t;
}
function Vi(t, e = false, i) {
  B = {
    p: B,
    c: null,
    e: null,
    m: false,
    s: t,
    x: null,
    l: null
  };
}
function qi(t) {
  const e = B;
  if (e !== null) {
    t !== void 0 && (e.x = t);
    const d = e.e;
    if (d !== null) {
      var i = D, r = k;
      e.e = null;
      try {
        for (var n = 0; n < d.length; n++) {
          var o = d[n];
          _e(o.effect), ge(o.reaction), Jt(o.fn);
        }
      } finally {
        _e(i), ge(r);
      }
    }
    B = e.p, e.m = true;
  }
  return t || /** @type {T} */
  {};
}
function Hi() {
  return true;
}
const tn = ["touchstart", "touchmove"];
function rn(t) {
  return tn.includes(t);
}
function nn(t) {
  var e = k, i = D;
  ge(null), _e(null);
  try {
    return t();
  } finally {
    ge(e), _e(i);
  }
}
const ji = /* @__PURE__ */ new Set(), Kt = /* @__PURE__ */ new Set();
function sn(t, e, i, r = {}) {
  function n(o) {
    if (r.capture || Xe.call(e, o), !o.cancelBubble)
      return nn(() => i == null ? void 0 : i.call(this, o));
  }
  return t.startsWith("pointer") || t.startsWith("touch") || t === "wheel" ? jt(() => {
    e.addEventListener(t, n, r);
  }) : e.addEventListener(t, n, r), n;
}
function lt(t, e, i, r, n) {
  var o = { capture: r, passive: n }, d = sn(t, e, i, o);
  (e === document.body || e === window || e === document) && qr(() => {
    e.removeEventListener(t, d, o);
  });
}
function on(t) {
  for (var e = 0; e < t.length; e++)
    ji.add(t[e]);
  for (var i of Kt)
    i(t);
}
function Xe(t) {
  var _a2;
  var e = this, i = (
    /** @type {Node} */
    e.ownerDocument
  ), r = t.type, n = ((_a2 = t.composedPath) == null ? void 0 : _a2.call(t)) || [], o = (
    /** @type {null | Element} */
    n[0] || t.target
  ), d = 0, b = t.__root;
  if (b) {
    var c = n.indexOf(b);
    if (c !== -1 && (e === document || e === /** @type {any} */
    window)) {
      t.__root = e;
      return;
    }
    var p = n.indexOf(e);
    if (p === -1)
      return;
    c <= p && (d = c);
  }
  if (o = /** @type {Element} */
  n[d] || t.target, o !== e) {
    wt(t, "currentTarget", {
      configurable: true,
      get() {
        return o || i;
      }
    });
    var h = k, m = D;
    ge(null), _e(null);
    try {
      for (var s, l = []; o !== null; ) {
        var a = o.assignedSlot || o.parentNode || /** @type {any} */
        o.host || null;
        try {
          var u = o["__" + r];
          if (u !== void 0 && (!/** @type {any} */
          o.disabled || // DOM could've been updated already by the time this is reached, so we check this as well
          // -> the target could not have been disabled because it emits the event in the first place
          t.target === o))
            if (wi(u)) {
              var [f, ...$] = u;
              f.apply(o, [t, ...$]);
            } else
              u.call(o, t);
        } catch (A) {
          s ? l.push(A) : s = A;
        }
        if (t.cancelBubble || a === e || a === null)
          break;
        o = a;
      }
      if (s) {
        for (let A of l)
          queueMicrotask(() => {
            throw A;
          });
        throw s;
      }
    } finally {
      t.__root = e, delete t.currentTarget, ge(h), _e(m);
    }
  }
}
function an(t) {
  var e = document.createElement("template");
  return e.innerHTML = t, e.content;
}
function Wt(t, e) {
  var i = (
    /** @type {Effect} */
    D
  );
  i.nodes_start === null && (i.nodes_start = t, i.nodes_end = e);
}
// @__NO_SIDE_EFFECTS__
function ln(t, e) {
  var i = (e & nr) !== 0, r, n = !t.startsWith("<!>");
  return () => {
    if (J)
      return Wt(I, null), I;
    r === void 0 && (r = an(n ? t : "<!>" + t), r = /** @type {Node} */
    /* @__PURE__ */ _t(r));
    var o = (
      /** @type {TemplateNode} */
      i || Ri ? document.importNode(r, true) : r.cloneNode(true)
    );
    return Wt(o, o), o;
  };
}
function Gi(t, e) {
  if (J) {
    D.nodes_end = I, Ti();
    return;
  }
  t !== null && t.before(
    /** @type {Node} */
    e
  );
}
function Yi(t, e) {
  return Xi(t, e);
}
function un(t, e) {
  It(), e.intro = e.intro ?? false;
  const i = e.target, r = J, n = I;
  try {
    for (var o = (
      /** @type {TemplateNode} */
      /* @__PURE__ */ _t(i)
    ); o && (o.nodeType !== 8 || /** @type {Comment} */
    o.data !== sr); )
      o = /** @type {TemplateNode} */
      /* @__PURE__ */ Dt(o);
    if (!o)
      throw Qe;
    at(true), gt(
      /** @type {Comment} */
      o
    ), Ti();
    const d = Xi(t, { ...e, anchor: o });
    if (I === null || I.nodeType !== 8 || /** @type {Comment} */
    I.data !== or)
      throw Gt(), Qe;
    return at(false), /**  @type {Exports} */
    d;
  } catch (d) {
    if (d === Qe)
      return e.recover === false && Cr(), It(), Lr(i), at(false), Yi(t, e);
    throw d;
  } finally {
    at(r), gt(n);
  }
}
const Ue = /* @__PURE__ */ new Map();
function Xi(t, { target: e, anchor: i, props: r = {}, events: n, context: o, intro: d = true }) {
  It();
  var b = /* @__PURE__ */ new Set(), c = (m) => {
    for (var s = 0; s < m.length; s++) {
      var l = m[s];
      if (!b.has(l)) {
        b.add(l);
        var a = rn(l);
        e.addEventListener(l, Xe, { passive: a });
        var u = Ue.get(l);
        u === void 0 ? (document.addEventListener(l, Xe, { passive: a }), Ue.set(l, 1)) : Ue.set(l, u + 1);
      }
    }
  };
  c(fr(ji)), Kt.add(c);
  var p = void 0, h = Gr(() => {
    var m = i ?? e.appendChild(Oi());
    return Zr(() => {
      if (o) {
        Vi({});
        var s = (
          /** @type {ComponentContext} */
          B
        );
        s.c = o;
      }
      n && (r.$$events = n), J && Wt(
        /** @type {TemplateNode} */
        m,
        null
      ), p = t(m, r) || {}, J && (D.nodes_end = I), o && qi();
    }), () => {
      var _a2;
      for (var s of b) {
        e.removeEventListener(s, Xe);
        var l = (
          /** @type {number} */
          Ue.get(s)
        );
        --l === 0 ? (document.removeEventListener(s, Xe), Ue.delete(s)) : Ue.set(s, l);
      }
      Kt.delete(c), m !== i && ((_a2 = m.parentNode) == null ? void 0 : _a2.removeChild(m));
    };
  });
  return Vt.set(p, h), p;
}
let Vt = /* @__PURE__ */ new WeakMap();
function dn(t, e) {
  const i = Vt.get(t);
  return i ? (Vt.delete(t), i(e)) : Promise.resolve();
}
function cn(t, e) {
  jt(() => {
    var i = t.getRootNode(), r = (
      /** @type {ShadowRoot} */
      i.host ? (
        /** @type {ShadowRoot} */
        i
      ) : (
        /** @type {Document} */
        i.head ?? /** @type {Document} */
        i.ownerDocument.head
      )
    );
    if (!r.querySelector("#" + e.hash)) {
      const n = document.createElement("style");
      n.id = e.hash, n.textContent = e.code, r.appendChild(n);
    }
  });
}
const li = [...` 	
\r\f\xA0\v\uFEFF`];
function fn(t, e, i) {
  var r = t == null ? "" : "" + t;
  if (r = r ? r + " " + e : e, i) {
    for (var n in i)
      if (i[n])
        r = r ? r + " " + n : n;
      else if (r.length)
        for (var o = n.length, d = 0; (d = r.indexOf(n, d)) >= 0; ) {
          var b = d + o;
          (d === 0 || li.includes(r[d - 1])) && (b === r.length || li.includes(r[b])) ? r = (d === 0 ? "" : r.substring(0, d)) + r.substring(b + 1) : d = b;
        }
  }
  return r === "" ? null : r;
}
function hn(t, e, i, r, n, o) {
  var d = t.__className;
  if (J || d !== i) {
    var b = fn(i, r, o);
    (!J || b !== t.getAttribute("class")) && (b == null ? t.removeAttribute("class") : t.className = b), t.__className = i;
  } else if (o)
    for (var c in o) {
      var p = !!o[c];
      (n == null || p !== !!n[c]) && t.classList.toggle(c, p);
    }
  return o;
}
function ui(t, e, i, r) {
  var n = t.__attributes ?? (t.__attributes = {});
  J && (n[e] = t.getAttribute(e)), n[e] !== (n[e] = i) && ("__styles" in t && (t.__styles = {}), i == null ? t.removeAttribute(e) : typeof i != "string" && bn(t).includes(e) ? t[e] = i : t.setAttribute(e, i));
}
var di = /* @__PURE__ */ new Map();
function bn(t) {
  var e = di.get(t.nodeName);
  if (e) return e;
  di.set(t.nodeName, e = []);
  for (var i, r = t, n = Element.prototype; n !== r; ) {
    i = hr(r);
    for (var o in i)
      i[o].set && e.push(o);
    r = gi(r);
  }
  return e;
}
function ci(t, e) {
  return t === e || (t == null ? void 0 : t[dt]) === e;
}
function Pt(t = {}, e, i, r) {
  return Jt(() => {
    var n, o;
    return Ui(() => {
      n = o, o = [], $t(() => {
        t !== i(...o) && (e(t, ...o), n && ci(i(...n), t) && e(null, ...n));
      });
    }), () => {
      jt(() => {
        o && ci(i(...o), t) && e(null, ...o);
      });
    };
  }), t;
}
function Zi(t) {
  B === null && Wi(), Hr(() => {
    const e = $t(t);
    if (typeof e == "function") return (
      /** @type {() => void} */
      e
    );
  });
}
function pn(t) {
  B === null && Wi(), Zi(() => () => $t(t));
}
function ut(t, e, i, r) {
  var n;
  n = /** @type {V} */
  t[e];
  var o = (
    /** @type {V} */
    r
  ), d = true, b = false, c = () => (b = true, d && (d = false, o = /** @type {V} */
  r), o), p;
  p = () => {
    var l = (
      /** @type {V} */
      t[e]
    );
    return l === void 0 ? c() : (d = true, b = false, l);
  };
  var h = false, m = /* @__PURE__ */ Ci(n), s = /* @__PURE__ */ ki(() => {
    var l = p(), a = U(m);
    return h ? (h = false, a) : m.v = l;
  });
  return function(l, a) {
    if (arguments.length > 0) {
      const u = a ? U(s) : l;
      return s.equals(u) || (h = true, q(m, u), b && o !== void 0 && (o = u), $t(() => U(s))), l;
    }
    return U(s);
  };
}
function vn(t) {
  return new mn(t);
}
class mn {
  /**
   * @param {ComponentConstructorOptions & {
   *  component: any;
   * }} options
   */
  constructor(e) {
    /** @type {any} */
    __privateAdd(this, _t2);
    /** @type {Record<string, any>} */
    __privateAdd(this, _e2);
    var _a2;
    var i = /* @__PURE__ */ new Map(), r = (o, d) => {
      var b = /* @__PURE__ */ Ci(d);
      return i.set(o, b), b;
    };
    const n = new Proxy(
      { ...e.props || {}, $$events: {} },
      {
        get(o, d) {
          return U(i.get(d) ?? r(d, Reflect.get(o, d)));
        },
        has(o, d) {
          return d === dr ? true : (U(i.get(d) ?? r(d, Reflect.get(o, d))), Reflect.has(o, d));
        },
        set(o, d, b) {
          return q(i.get(d) ?? r(d, b), b), Reflect.set(o, d, b);
        }
      }
    );
    __privateSet(this, _e2, (e.hydrate ? un : Yi)(e.component, {
      target: e.target,
      anchor: e.anchor,
      props: n,
      context: e.context,
      intro: e.intro ?? false,
      recover: e.recover
    })), (!((_a2 = e == null ? void 0 : e.props) == null ? void 0 : _a2.$$host) || e.sync === false) && Ye(), __privateSet(this, _t2, n.$$events);
    for (const o of Object.keys(__privateGet(this, _e2)))
      o === "$set" || o === "$destroy" || o === "$on" || wt(this, o, {
        get() {
          return __privateGet(this, _e2)[o];
        },
        /** @param {any} value */
        set(d) {
          __privateGet(this, _e2)[o] = d;
        },
        enumerable: true
      });
    __privateGet(this, _e2).$set = /** @param {Record<string, any>} next */
    (o) => {
      Object.assign(n, o);
    }, __privateGet(this, _e2).$destroy = () => {
      dn(__privateGet(this, _e2));
    };
  }
  /** @param {Record<string, any>} props */
  $set(e) {
    __privateGet(this, _e2).$set(e);
  }
  /**
   * @param {string} event
   * @param {(...args: any[]) => any} callback
   * @returns {any}
   */
  $on(e, i) {
    __privateGet(this, _t2)[e] = __privateGet(this, _t2)[e] || [];
    const r = (...n) => i.call(this, ...n);
    return __privateGet(this, _t2)[e].push(r), () => {
      __privateGet(this, _t2)[e] = __privateGet(this, _t2)[e].filter(
        /** @param {any} fn */
        (n) => n !== r
      );
    };
  }
  $destroy() {
    __privateGet(this, _e2).$destroy();
  }
}
_t2 = new WeakMap();
_e2 = new WeakMap();
let Ji;
typeof HTMLElement == "function" && (Ji = class extends HTMLElement {
  /**
   * @param {*} $$componentCtor
   * @param {*} $$slots
   * @param {*} use_shadow_dom
   */
  constructor(t, e, i) {
    super();
    /** The Svelte component constructor */
    __publicField(this, "$$ctor");
    /** Slots */
    __publicField(this, "$$s");
    /** @type {any} The Svelte component instance */
    __publicField(this, "$$c");
    /** Whether or not the custom element is connected */
    __publicField(this, "$$cn", false);
    /** @type {Record<string, any>} Component props data */
    __publicField(this, "$$d", {});
    /** `true` if currently in the process of reflecting component props back to attributes */
    __publicField(this, "$$r", false);
    /** @type {Record<string, CustomElementPropDefinition>} Props definition (name, reflected, type etc) */
    __publicField(this, "$$p_d", {});
    /** @type {Record<string, EventListenerOrEventListenerObject[]>} Event listeners */
    __publicField(this, "$$l", {});
    /** @type {Map<EventListenerOrEventListenerObject, Function>} Event listener unsubscribe functions */
    __publicField(this, "$$l_u", /* @__PURE__ */ new Map());
    /** @type {any} The managed render effect for reflecting attributes */
    __publicField(this, "$$me");
    this.$$ctor = t, this.$$s = e, i && this.attachShadow({ mode: "open" });
  }
  /**
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} listener
   * @param {boolean | AddEventListenerOptions} [options]
   */
  addEventListener(t, e, i) {
    if (this.$$l[t] = this.$$l[t] || [], this.$$l[t].push(e), this.$$c) {
      const r = this.$$c.$on(t, e);
      this.$$l_u.set(e, r);
    }
    super.addEventListener(t, e, i);
  }
  /**
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} listener
   * @param {boolean | AddEventListenerOptions} [options]
   */
  removeEventListener(t, e, i) {
    if (super.removeEventListener(t, e, i), this.$$c) {
      const r = this.$$l_u.get(e);
      r && (r(), this.$$l_u.delete(e));
    }
  }
  async connectedCallback() {
    if (this.$$cn = true, !this.$$c) {
      let t = function(r) {
        return (n) => {
          const o = document.createElement("slot");
          r !== "default" && (o.name = r), Gi(n, o);
        };
      };
      if (await Promise.resolve(), !this.$$cn || this.$$c)
        return;
      const e = {}, i = wn(this);
      for (const r of this.$$s)
        r in i && (r === "default" && !this.$$d.children ? (this.$$d.children = t(r), e.default = true) : e[r] = t(r));
      for (const r of this.attributes) {
        const n = this.$$g_p(r.name);
        n in this.$$d || (this.$$d[n] = ht(n, r.value, this.$$p_d, "toProp"));
      }
      for (const r in this.$$p_d)
        !(r in this.$$d) && this[r] !== void 0 && (this.$$d[r] = this[r], delete this[r]);
      this.$$c = vn({
        component: this.$$ctor,
        target: this.shadowRoot || this,
        props: {
          ...this.$$d,
          $$slots: e,
          $$host: this
        }
      }), this.$$me = jr(() => {
        Ui(() => {
          var _a2;
          this.$$r = true;
          for (const r of mt(this.$$c)) {
            if (!((_a2 = this.$$p_d[r]) == null ? void 0 : _a2.reflect)) continue;
            this.$$d[r] = this.$$c[r];
            const n = ht(
              r,
              this.$$d[r],
              this.$$p_d,
              "toAttribute"
            );
            n == null ? this.removeAttribute(this.$$p_d[r].attribute || r) : this.setAttribute(this.$$p_d[r].attribute || r, n);
          }
          this.$$r = false;
        });
      });
      for (const r in this.$$l)
        for (const n of this.$$l[r]) {
          const o = this.$$c.$on(r, n);
          this.$$l_u.set(n, o);
        }
      this.$$l = {};
    }
  }
  // We don't need this when working within Svelte code, but for compatibility of people using this outside of Svelte
  // and setting attributes through setAttribute etc, this is helpful
  /**
   * @param {string} attr
   * @param {string} _oldValue
   * @param {string} newValue
   */
  attributeChangedCallback(t, e, i) {
    var _a2;
    this.$$r || (t = this.$$g_p(t), this.$$d[t] = ht(t, i, this.$$p_d, "toProp"), (_a2 = this.$$c) == null ? void 0 : _a2.$set({ [t]: this.$$d[t] }));
  }
  disconnectedCallback() {
    this.$$cn = false, Promise.resolve().then(() => {
      !this.$$cn && this.$$c && (this.$$c.$destroy(), this.$$me(), this.$$c = void 0);
    });
  }
  /**
   * @param {string} attribute_name
   */
  $$g_p(t) {
    return mt(this.$$p_d).find(
      (e) => this.$$p_d[e].attribute === t || !this.$$p_d[e].attribute && e.toLowerCase() === t
    ) || t;
  }
});
function ht(t, e, i, r) {
  var _a2;
  const n = (_a2 = i[t]) == null ? void 0 : _a2.type;
  if (e = n === "Boolean" && typeof e != "boolean" ? e != null : e, !r || !i[t])
    return e;
  if (r === "toAttribute")
    switch (n) {
      case "Object":
      case "Array":
        return e == null ? null : JSON.stringify(e);
      case "Boolean":
        return e ? "" : null;
      case "Number":
        return e ?? null;
      default:
        return e;
    }
  else
    switch (n) {
      case "Object":
      case "Array":
        return e && JSON.parse(e);
      case "Boolean":
        return e;
      // conversion already handled above
      case "Number":
        return e != null ? +e : e;
      default:
        return e;
    }
}
function wn(t) {
  const e = {};
  return t.childNodes.forEach((i) => {
    e[
      /** @type {Element} node */
      i.slot || "default"
    ] = true;
  }), e;
}
function gn(t, e, i, r, n, o) {
  let d = class extends Ji {
    constructor() {
      super(t, i, n), this.$$p_d = e;
    }
    static get observedAttributes() {
      return mt(e).map(
        (b) => (e[b].attribute || b).toLowerCase()
      );
    }
  };
  return mt(e).forEach((b) => {
    wt(d.prototype, b, {
      get() {
        return this.$$c && b in this.$$c ? this.$$c[b] : this.$$d[b];
      },
      set(c) {
        var _a2;
        c = ht(b, c, e), this.$$d[b] = c;
        var p = this.$$c;
        if (p) {
          var h = (_a2 = ze(p, b)) == null ? void 0 : _a2.get;
          h ? p[b] = c : p.$set({ [b]: c });
        }
      }
    });
  }), r.forEach((b) => {
    wt(d.prototype, b, {
      get() {
        var _a2;
        return (_a2 = this.$$c) == null ? void 0 : _a2[b];
      }
    });
  }), o && (d = o(d)), t.element = /** @type {any} */
  d, d;
}
class _n {
  constructor() {
    __publicField(this, "verbose", false);
  }
  info(e) {
    this.verbose && console.log(e);
  }
  error(e, i) {
    this.verbose && console.error(e, i);
  }
}
const L = new _n();
function xn(t) {
  return t && t.__esModule && Object.prototype.hasOwnProperty.call(t, "default") ? t.default : t;
}
var Ze = { exports: {} }, yn = Ze.exports, fi;
function Cn() {
  return fi || (fi = 1, (function(t, e) {
    (function(i, r) {
      var n = "1.0.41", o = "", d = "?", b = "function", c = "undefined", p = "object", h = "string", m = "major", s = "model", l = "name", a = "type", u = "vendor", f = "version", $ = "architecture", A = "console", w = "mobile", _ = "tablet", O = "smarttv", F = "wearable", Q = "embedded", ae = 500, Ee = "Amazon", he = "Apple", it = "ASUS", rt = "BlackBerry", ee = "Browser", Re = "Chrome", At = "Edge", $e = "Firefox", Ae = "Google", We = "Honor", nt = "Huawei", Ot = "Lenovo", Oe = "LG", Ve = "Microsoft", qe = "Motorola", Le = "Nvidia", st = "OnePlus", ke = "Opera", be = "OPPO", pe = "Samsung", He = "Sharp", te = "Sony", le = "Xiaomi", Fe = "Zebra", Me = "Facebook", j = "Chromium OS", v = "Mac OS", T = " Browser", M = function(y, C) {
        var x = {};
        for (var S in y)
          C[S] && C[S].length % 2 === 0 ? x[S] = C[S].concat(y[S]) : x[S] = y[S];
        return x;
      }, R = function(y) {
        for (var C = {}, x = 0; x < y.length; x++)
          C[y[x].toUpperCase()] = y[x];
        return C;
      }, z = function(y, C) {
        return typeof y === h ? N(C).indexOf(N(y)) !== -1 : false;
      }, N = function(y) {
        return y.toLowerCase();
      }, ve = function(y) {
        return typeof y === h ? y.replace(/[^\d\.]/g, o).split(".")[0] : r;
      }, Ne = function(y, C) {
        if (typeof y === h)
          return y = y.replace(/^\s\s*/, o), typeof C === c ? y : y.substring(0, ae);
      }, je = function(y, C) {
        for (var x = 0, S, ue, ie, E, g, re; x < C.length && !g; ) {
          var Lt = C[x], ti = C[x + 1];
          for (S = ue = 0; S < Lt.length && !g && Lt[S]; )
            if (g = Lt[S++].exec(y), g)
              for (ie = 0; ie < ti.length; ie++)
                re = g[++ue], E = ti[ie], typeof E === p && E.length > 0 ? E.length === 2 ? typeof E[1] == b ? this[E[0]] = E[1].call(this, re) : this[E[0]] = E[1] : E.length === 3 ? typeof E[1] === b && !(E[1].exec && E[1].test) ? this[E[0]] = re ? E[1].call(this, re, E[2]) : r : this[E[0]] = re ? re.replace(E[1], E[2]) : r : E.length === 4 && (this[E[0]] = re ? E[3].call(this, re.replace(E[1], E[2])) : r) : this[E] = re || r;
          x += 2;
        }
      }, Ge = function(y, C) {
        for (var x in C)
          if (typeof C[x] === p && C[x].length > 0) {
            for (var S = 0; S < C[x].length; S++)
              if (z(C[x][S], y))
                return x === d ? r : x;
          } else if (z(C[x], y))
            return x === d ? r : x;
        return C.hasOwnProperty("*") ? C["*"] : y;
      }, rr = {
        "1.0": "/8",
        "1.2": "/1",
        "1.3": "/3",
        "2.0": "/412",
        "2.0.2": "/416",
        "2.0.3": "/417",
        "2.0.4": "/419",
        "?": "/"
      }, Qt = {
        ME: "4.90",
        "NT 3.11": "NT3.51",
        "NT 4.0": "NT4.0",
        2e3: "NT 5.0",
        XP: ["NT 5.1", "NT 5.2"],
        Vista: "NT 6.0",
        7: "NT 6.1",
        8: "NT 6.2",
        "8.1": "NT 6.3",
        10: ["NT 6.4", "NT 10.0"],
        RT: "ARM"
      }, ei = {
        browser: [
          [
            /\b(?:crmo|crios)\/([\w\.]+)/i
            // Chrome for Android/iOS
          ],
          [f, [l, "Chrome"]],
          [
            /edg(?:e|ios|a)?\/([\w\.]+)/i
            // Microsoft Edge
          ],
          [f, [l, "Edge"]],
          [
            // Presto based
            /(opera mini)\/([-\w\.]+)/i,
            // Opera Mini
            /(opera [mobiletab]{3,6})\b.+version\/([-\w\.]+)/i,
            // Opera Mobi/Tablet
            /(opera)(?:.+version\/|[\/ ]+)([\w\.]+)/i
            // Opera
          ],
          [l, f],
          [
            /opios[\/ ]+([\w\.]+)/i
            // Opera mini on iphone >= 8.0
          ],
          [f, [l, ke + " Mini"]],
          [
            /\bop(?:rg)?x\/([\w\.]+)/i
            // Opera GX
          ],
          [f, [l, ke + " GX"]],
          [
            /\bopr\/([\w\.]+)/i
            // Opera Webkit
          ],
          [f, [l, ke]],
          [
            // Mixed
            /\bb[ai]*d(?:uhd|[ub]*[aekoprswx]{5,6})[\/ ]?([\w\.]+)/i
            // Baidu
          ],
          [f, [l, "Baidu"]],
          [
            /\b(?:mxbrowser|mxios|myie2)\/?([-\w\.]*)\b/i
            // Maxthon
          ],
          [f, [l, "Maxthon"]],
          [
            /(kindle)\/([\w\.]+)/i,
            // Kindle
            /(lunascape|maxthon|netfront|jasmine|blazer|sleipnir)[\/ ]?([\w\.]*)/i,
            // Lunascape/Maxthon/Netfront/Jasmine/Blazer/Sleipnir
            // Trident based
            /(avant|iemobile|slim(?:browser|boat|jet))[\/ ]?([\d\.]*)/i,
            // Avant/IEMobile/SlimBrowser/SlimBoat/Slimjet
            /(?:ms|\()(ie) ([\w\.]+)/i,
            // Internet Explorer
            // Blink/Webkit/KHTML based                                         // Flock/RockMelt/Midori/Epiphany/Silk/Skyfire/Bolt/Iron/Iridium/PhantomJS/Bowser/QupZilla/Falkon
            /(flock|rockmelt|midori|epiphany|silk|skyfire|ovibrowser|bolt|iron|vivaldi|iridium|phantomjs|bowser|qupzilla|falkon|rekonq|puffin|brave|whale(?!.+naver)|qqbrowserlite|duckduckgo|klar|helio|(?=comodo_)?dragon)\/([-\w\.]+)/i,
            // Rekonq/Puffin/Brave/Whale/QQBrowserLite/QQ//Vivaldi/DuckDuckGo/Klar/Helio/Dragon
            /(heytap|ovi|115)browser\/([\d\.]+)/i,
            // HeyTap/Ovi/115
            /(weibo)__([\d\.]+)/i
            // Weibo
          ],
          [l, f],
          [
            /quark(?:pc)?\/([-\w\.]+)/i
            // Quark
          ],
          [f, [l, "Quark"]],
          [
            /\bddg\/([\w\.]+)/i
            // DuckDuckGo
          ],
          [f, [l, "DuckDuckGo"]],
          [
            /(?:\buc? ?browser|(?:juc.+)ucweb)[\/ ]?([\w\.]+)/i
            // UCBrowser
          ],
          [f, [l, "UC" + ee]],
          [
            /microm.+\bqbcore\/([\w\.]+)/i,
            // WeChat Desktop for Windows Built-in Browser
            /\bqbcore\/([\w\.]+).+microm/i,
            /micromessenger\/([\w\.]+)/i
            // WeChat
          ],
          [f, [l, "WeChat"]],
          [
            /konqueror\/([\w\.]+)/i
            // Konqueror
          ],
          [f, [l, "Konqueror"]],
          [
            /trident.+rv[: ]([\w\.]{1,9})\b.+like gecko/i
            // IE11
          ],
          [f, [l, "IE"]],
          [
            /ya(?:search)?browser\/([\w\.]+)/i
            // Yandex
          ],
          [f, [l, "Yandex"]],
          [
            /slbrowser\/([\w\.]+)/i
            // Smart Lenovo Browser
          ],
          [f, [l, "Smart Lenovo " + ee]],
          [
            /(avast|avg)\/([\w\.]+)/i
            // Avast/AVG Secure Browser
          ],
          [[l, /(.+)/, "$1 Secure " + ee], f],
          [
            /\bfocus\/([\w\.]+)/i
            // Firefox Focus
          ],
          [f, [l, $e + " Focus"]],
          [
            /\bopt\/([\w\.]+)/i
            // Opera Touch
          ],
          [f, [l, ke + " Touch"]],
          [
            /coc_coc\w+\/([\w\.]+)/i
            // Coc Coc Browser
          ],
          [f, [l, "Coc Coc"]],
          [
            /dolfin\/([\w\.]+)/i
            // Dolphin
          ],
          [f, [l, "Dolphin"]],
          [
            /coast\/([\w\.]+)/i
            // Opera Coast
          ],
          [f, [l, ke + " Coast"]],
          [
            /miuibrowser\/([\w\.]+)/i
            // MIUI Browser
          ],
          [f, [l, "MIUI" + T]],
          [
            /fxios\/([\w\.-]+)/i
            // Firefox for iOS
          ],
          [f, [l, $e]],
          [
            /\bqihoobrowser\/?([\w\.]*)/i
            // 360
          ],
          [f, [l, "360"]],
          [
            /\b(qq)\/([\w\.]+)/i
            // QQ
          ],
          [[l, /(.+)/, "$1Browser"], f],
          [
            /(oculus|sailfish|huawei|vivo|pico)browser\/([\w\.]+)/i
          ],
          [[l, /(.+)/, "$1" + T], f],
          [
            // Oculus/Sailfish/HuaweiBrowser/VivoBrowser/PicoBrowser
            /samsungbrowser\/([\w\.]+)/i
            // Samsung Internet
          ],
          [f, [l, pe + " Internet"]],
          [
            /metasr[\/ ]?([\d\.]+)/i
            // Sogou Explorer
          ],
          [f, [l, "Sogou Explorer"]],
          [
            /(sogou)mo\w+\/([\d\.]+)/i
            // Sogou Mobile
          ],
          [[l, "Sogou Mobile"], f],
          [
            /(electron)\/([\w\.]+) safari/i,
            // Electron-based App
            /(tesla)(?: qtcarbrowser|\/(20\d\d\.[-\w\.]+))/i,
            // Tesla
            /m?(qqbrowser|2345(?=browser|chrome|explorer))\w*[\/ ]?v?([\w\.]+)/i
            // QQ/2345
          ],
          [l, f],
          [
            /(lbbrowser|rekonq)/i,
            // LieBao Browser/Rekonq
            /\[(linkedin)app\]/i
            // LinkedIn App for iOS & Android
          ],
          [l],
          [
            /ome\/([\w\.]+) \w* ?(iron) saf/i,
            // Iron
            /ome\/([\w\.]+).+qihu (360)[es]e/i
            // 360
          ],
          [f, l],
          [
            // WebView
            /((?:fban\/fbios|fb_iab\/fb4a)(?!.+fbav)|;fbav\/([\w\.]+);)/i
            // Facebook App for iOS & Android
          ],
          [[l, Me], f],
          [
            /(Klarna)\/([\w\.]+)/i,
            // Klarna Shopping Browser for iOS & Android
            /(kakao(?:talk|story))[\/ ]([\w\.]+)/i,
            // Kakao App
            /(naver)\(.*?(\d+\.[\w\.]+).*\)/i,
            // Naver InApp
            /(daum)apps[\/ ]([\w\.]+)/i,
            // Daum App
            /safari (line)\/([\w\.]+)/i,
            // Line App for iOS
            /\b(line)\/([\w\.]+)\/iab/i,
            // Line App for Android
            /(alipay)client\/([\w\.]+)/i,
            // Alipay
            /(twitter)(?:and| f.+e\/([\w\.]+))/i,
            // Twitter
            /(chromium|instagram|snapchat)[\/ ]([-\w\.]+)/i
            // Chromium/Instagram/Snapchat
          ],
          [l, f],
          [
            /\bgsa\/([\w\.]+) .*safari\//i
            // Google Search Appliance on iOS
          ],
          [f, [l, "GSA"]],
          [
            /musical_ly(?:.+app_?version\/|_)([\w\.]+)/i
            // TikTok
          ],
          [f, [l, "TikTok"]],
          [
            /headlesschrome(?:\/([\w\.]+)| )/i
            // Chrome Headless
          ],
          [f, [l, Re + " Headless"]],
          [
            / wv\).+(chrome)\/([\w\.]+)/i
            // Chrome WebView
          ],
          [[l, Re + " WebView"], f],
          [
            /droid.+ version\/([\w\.]+)\b.+(?:mobile safari|safari)/i
            // Android Browser
          ],
          [f, [l, "Android " + ee]],
          [
            /(chrome|omniweb|arora|[tizenoka]{5} ?browser)\/v?([\w\.]+)/i
            // Chrome/OmniWeb/Arora/Tizen/Nokia
          ],
          [l, f],
          [
            /version\/([\w\.\,]+) .*mobile\/\w+ (safari)/i
            // Mobile Safari
          ],
          [f, [l, "Mobile Safari"]],
          [
            /version\/([\w(\.|\,)]+) .*(mobile ?safari|safari)/i
            // Safari & Safari Mobile
          ],
          [f, l],
          [
            /webkit.+?(mobile ?safari|safari)(\/[\w\.]+)/i
            // Safari < 3.0
          ],
          [l, [f, Ge, rr]],
          [
            /(webkit|khtml)\/([\w\.]+)/i
          ],
          [l, f],
          [
            // Gecko based
            /(navigator|netscape\d?)\/([-\w\.]+)/i
            // Netscape
          ],
          [[l, "Netscape"], f],
          [
            /(wolvic|librewolf)\/([\w\.]+)/i
            // Wolvic/LibreWolf
          ],
          [l, f],
          [
            /mobile vr; rv:([\w\.]+)\).+firefox/i
            // Firefox Reality
          ],
          [f, [l, $e + " Reality"]],
          [
            /ekiohf.+(flow)\/([\w\.]+)/i,
            // Flow
            /(swiftfox)/i,
            // Swiftfox
            /(icedragon|iceweasel|camino|chimera|fennec|maemo browser|minimo|conkeror)[\/ ]?([\w\.\+]+)/i,
            // IceDragon/Iceweasel/Camino/Chimera/Fennec/Maemo/Minimo/Conkeror
            /(seamonkey|k-meleon|icecat|iceape|firebird|phoenix|palemoon|basilisk|waterfox)\/([-\w\.]+)$/i,
            // Firefox/SeaMonkey/K-Meleon/IceCat/IceApe/Firebird/Phoenix
            /(firefox)\/([\w\.]+)/i,
            // Other Firefox-based
            /(mozilla)\/([\w\.]+) .+rv\:.+gecko\/\d+/i,
            // Mozilla
            // Other
            /(amaya|dillo|doris|icab|ladybird|lynx|mosaic|netsurf|obigo|polaris|w3m|(?:go|ice|up)[\. ]?browser)[-\/ ]?v?([\w\.]+)/i,
            // Polaris/Lynx/Dillo/iCab/Doris/Amaya/w3m/NetSurf/Obigo/Mosaic/Go/ICE/UP.Browser/Ladybird
            /\b(links) \(([\w\.]+)/i
            // Links
          ],
          [l, [f, /_/g, "."]],
          [
            /(cobalt)\/([\w\.]+)/i
            // Cobalt
          ],
          [l, [f, /master.|lts./, ""]]
        ],
        cpu: [
          [
            /\b((amd|x|x86[-_]?|wow|win)64)\b/i
            // AMD64 (x64)
          ],
          [[$, "amd64"]],
          [
            /(ia32(?=;))/i,
            // IA32 (quicktime)
            /\b((i[346]|x)86)(pc)?\b/i
            // IA32 (x86)
          ],
          [[$, "ia32"]],
          [
            /\b(aarch64|arm(v?[89]e?l?|_?64))\b/i
            // ARM64
          ],
          [[$, "arm64"]],
          [
            /\b(arm(v[67])?ht?n?[fl]p?)\b/i
            // ARMHF
          ],
          [[$, "armhf"]],
          [
            // PocketPC mistakenly identified as PowerPC
            /( (ce|mobile); ppc;|\/[\w\.]+arm\b)/i
          ],
          [[$, "arm"]],
          [
            /((ppc|powerpc)(64)?)( mac|;|\))/i
            // PowerPC
          ],
          [[$, /ower/, o, N]],
          [
            / sun4\w[;\)]/i
            // SPARC
          ],
          [[$, "sparc"]],
          [
            /\b(avr32|ia64(?=;)|68k(?=\))|\barm(?=v([1-7]|[5-7]1)l?|;|eabi)|(irix|mips|sparc)(64)?\b|pa-risc)/i
            // IA64, 68K, ARM/64, AVR/32, IRIX/64, MIPS/64, SPARC/64, PA-RISC
          ],
          [[$, N]]
        ],
        device: [
          [
            //////////////////////////
            // MOBILES & TABLETS
            /////////////////////////
            // Samsung
            /\b(sch-i[89]0\d|shw-m380s|sm-[ptx]\w{2,4}|gt-[pn]\d{2,4}|sgh-t8[56]9|nexus 10)/i
          ],
          [s, [u, pe], [a, _]],
          [
            /\b((?:s[cgp]h|gt|sm)-(?![lr])\w+|sc[g-]?[\d]+a?|galaxy nexus)/i,
            /samsung[- ]((?!sm-[lr])[-\w]+)/i,
            /sec-(sgh\w+)/i
          ],
          [s, [u, pe], [a, w]],
          [
            // Apple
            /(?:\/|\()(ip(?:hone|od)[\w, ]*)(?:\/|;)/i
            // iPod/iPhone
          ],
          [s, [u, he], [a, w]],
          [
            /\((ipad);[-\w\),; ]+apple/i,
            // iPad
            /applecoremedia\/[\w\.]+ \((ipad)/i,
            /\b(ipad)\d\d?,\d\d?[;\]].+ios/i
          ],
          [s, [u, he], [a, _]],
          [
            /(macintosh);/i
          ],
          [s, [u, he]],
          [
            // Sharp
            /\b(sh-?[altvz]?\d\d[a-ekm]?)/i
          ],
          [s, [u, He], [a, w]],
          [
            // Honor
            /\b((?:brt|eln|hey2?|gdi|jdn)-a?[lnw]09|(?:ag[rm]3?|jdn2|kob2)-a?[lw]0[09]hn)(?: bui|\)|;)/i
          ],
          [s, [u, We], [a, _]],
          [
            /honor([-\w ]+)[;\)]/i
          ],
          [s, [u, We], [a, w]],
          [
            // Huawei
            /\b((?:ag[rs][2356]?k?|bah[234]?|bg[2o]|bt[kv]|cmr|cpn|db[ry]2?|jdn2|got|kob2?k?|mon|pce|scm|sht?|[tw]gr|vrd)-[ad]?[lw][0125][09]b?|605hw|bg2-u03|(?:gem|fdr|m2|ple|t1)-[7a]0[1-4][lu]|t1-a2[13][lw]|mediapad[\w\. ]*(?= bui|\)))\b(?!.+d\/s)/i
          ],
          [s, [u, nt], [a, _]],
          [
            /(?:huawei)([-\w ]+)[;\)]/i,
            /\b(nexus 6p|\w{2,4}e?-[atu]?[ln][\dx][012359c][adn]?)\b(?!.+d\/s)/i
          ],
          [s, [u, nt], [a, w]],
          [
            // Xiaomi
            /oid[^\)]+; (2[\dbc]{4}(182|283|rp\w{2})[cgl]|m2105k81a?c)(?: bui|\))/i,
            /\b((?:red)?mi[-_ ]?pad[\w- ]*)(?: bui|\))/i
            // Mi Pad tablets
          ],
          [[s, /_/g, " "], [u, le], [a, _]],
          [
            /\b(poco[\w ]+|m2\d{3}j\d\d[a-z]{2})(?: bui|\))/i,
            // Xiaomi POCO
            /\b; (\w+) build\/hm\1/i,
            // Xiaomi Hongmi 'numeric' models
            /\b(hm[-_ ]?note?[_ ]?(?:\d\w)?) bui/i,
            // Xiaomi Hongmi
            /\b(redmi[\-_ ]?(?:note|k)?[\w_ ]+)(?: bui|\))/i,
            // Xiaomi Redmi
            /oid[^\)]+; (m?[12][0-389][01]\w{3,6}[c-y])( bui|; wv|\))/i,
            // Xiaomi Redmi 'numeric' models
            /\b(mi[-_ ]?(?:a\d|one|one[_ ]plus|note lte|max|cc)?[_ ]?(?:\d?\w?)[_ ]?(?:plus|se|lite|pro)?)(?: bui|\))/i,
            // Xiaomi Mi
            / ([\w ]+) miui\/v?\d/i
          ],
          [[s, /_/g, " "], [u, le], [a, w]],
          [
            // OPPO
            /; (\w+) bui.+ oppo/i,
            /\b(cph[12]\d{3}|p(?:af|c[al]|d\w|e[ar])[mt]\d0|x9007|a101op)\b/i
          ],
          [s, [u, be], [a, w]],
          [
            /\b(opd2(\d{3}a?))(?: bui|\))/i
          ],
          [s, [u, Ge, { OnePlus: ["304", "403", "203"], "*": be }], [a, _]],
          [
            // Vivo
            /vivo (\w+)(?: bui|\))/i,
            /\b(v[12]\d{3}\w?[at])(?: bui|;)/i
          ],
          [s, [u, "Vivo"], [a, w]],
          [
            // Realme
            /\b(rmx[1-3]\d{3})(?: bui|;|\))/i
          ],
          [s, [u, "Realme"], [a, w]],
          [
            // Motorola
            /\b(milestone|droid(?:[2-4x]| (?:bionic|x2|pro|razr))?:?( 4g)?)\b[\w ]+build\//i,
            /\bmot(?:orola)?[- ](\w*)/i,
            /((?:moto(?! 360)[\w\(\) ]+|xt\d{3,4}|nexus 6)(?= bui|\)))/i
          ],
          [s, [u, qe], [a, w]],
          [
            /\b(mz60\d|xoom[2 ]{0,2}) build\//i
          ],
          [s, [u, qe], [a, _]],
          [
            // LG
            /((?=lg)?[vl]k\-?\d{3}) bui| 3\.[-\w; ]{10}lg?-([06cv9]{3,4})/i
          ],
          [s, [u, Oe], [a, _]],
          [
            /(lm(?:-?f100[nv]?|-[\w\.]+)(?= bui|\))|nexus [45])/i,
            /\blg[-e;\/ ]+((?!browser|netcast|android tv|watch)\w+)/i,
            /\blg-?([\d\w]+) bui/i
          ],
          [s, [u, Oe], [a, w]],
          [
            // Lenovo
            /(ideatab[-\w ]+|602lv|d-42a|a101lv|a2109a|a3500-hv|s[56]000|pb-6505[my]|tb-?x?\d{3,4}(?:f[cu]|xu|[av])|yt\d?-[jx]?\d+[lfmx])( bui|;|\)|\/)/i,
            /lenovo ?(b[68]0[08]0-?[hf]?|tab(?:[\w- ]+?)|tb[\w-]{6,7})( bui|;|\)|\/)/i
          ],
          [s, [u, Ot], [a, _]],
          [
            // Nokia
            /(nokia) (t[12][01])/i
          ],
          [u, s, [a, _]],
          [
            /(?:maemo|nokia).*(n900|lumia \d+|rm-\d+)/i,
            /nokia[-_ ]?(([-\w\. ]*))/i
          ],
          [[s, /_/g, " "], [a, w], [u, "Nokia"]],
          [
            // Google
            /(pixel (c|tablet))\b/i
            // Google Pixel C/Tablet
          ],
          [s, [u, Ae], [a, _]],
          [
            /droid.+; (pixel[\daxl ]{0,6})(?: bui|\))/i
            // Google Pixel
          ],
          [s, [u, Ae], [a, w]],
          [
            // Sony
            /droid.+; (a?\d[0-2]{2}so|[c-g]\d{4}|so[-gl]\w+|xq-a\w[4-7][12])(?= bui|\).+chrome\/(?![1-6]{0,1}\d\.))/i
          ],
          [s, [u, te], [a, w]],
          [
            /sony tablet [ps]/i,
            /\b(?:sony)?sgp\w+(?: bui|\))/i
          ],
          [[s, "Xperia Tablet"], [u, te], [a, _]],
          [
            // OnePlus
            / (kb2005|in20[12]5|be20[12][59])\b/i,
            /(?:one)?(?:plus)? (a\d0\d\d)(?: b|\))/i
          ],
          [s, [u, st], [a, w]],
          [
            // Amazon
            /(alexa)webm/i,
            /(kf[a-z]{2}wi|aeo(?!bc)\w\w)( bui|\))/i,
            // Kindle Fire without Silk / Echo Show
            /(kf[a-z]+)( bui|\)).+silk\//i
            // Kindle Fire HD
          ],
          [s, [u, Ee], [a, _]],
          [
            /((?:sd|kf)[0349hijorstuw]+)( bui|\)).+silk\//i
            // Fire Phone
          ],
          [[s, /(.+)/g, "Fire Phone $1"], [u, Ee], [a, w]],
          [
            // BlackBerry
            /(playbook);[-\w\),; ]+(rim)/i
            // BlackBerry PlayBook
          ],
          [s, u, [a, _]],
          [
            /\b((?:bb[a-f]|st[hv])100-\d)/i,
            /\(bb10; (\w+)/i
            // BlackBerry 10
          ],
          [s, [u, rt], [a, w]],
          [
            // Asus
            /(?:\b|asus_)(transfo[prime ]{4,10} \w+|eeepc|slider \w+|nexus 7|padfone|p00[cj])/i
          ],
          [s, [u, it], [a, _]],
          [
            / (z[bes]6[027][012][km][ls]|zenfone \d\w?)\b/i
          ],
          [s, [u, it], [a, w]],
          [
            // HTC
            /(nexus 9)/i
            // HTC Nexus 9
          ],
          [s, [u, "HTC"], [a, _]],
          [
            /(htc)[-;_ ]{1,2}([\w ]+(?=\)| bui)|\w+)/i,
            // HTC
            // ZTE
            /(zte)[- ]([\w ]+?)(?: bui|\/|\))/i,
            /(alcatel|geeksphone|nexian|panasonic(?!(?:;|\.))|sony(?!-bra))[-_ ]?([-\w]*)/i
            // Alcatel/GeeksPhone/Nexian/Panasonic/Sony
          ],
          [u, [s, /_/g, " "], [a, w]],
          [
            // TCL
            /droid [\w\.]+; ((?:8[14]9[16]|9(?:0(?:48|60|8[01])|1(?:3[27]|66)|2(?:6[69]|9[56])|466))[gqswx])\w*(\)| bui)/i
          ],
          [s, [u, "TCL"], [a, _]],
          [
            // itel
            /(itel) ((\w+))/i
          ],
          [[u, N], s, [a, Ge, { tablet: ["p10001l", "w7001"], "*": "mobile" }]],
          [
            // Acer
            /droid.+; ([ab][1-7]-?[0178a]\d\d?)/i
          ],
          [s, [u, "Acer"], [a, _]],
          [
            // Meizu
            /droid.+; (m[1-5] note) bui/i,
            /\bmz-([-\w]{2,})/i
          ],
          [s, [u, "Meizu"], [a, w]],
          [
            // Ulefone
            /; ((?:power )?armor(?:[\w ]{0,8}))(?: bui|\))/i
          ],
          [s, [u, "Ulefone"], [a, w]],
          [
            // Energizer
            /; (energy ?\w+)(?: bui|\))/i,
            /; energizer ([\w ]+)(?: bui|\))/i
          ],
          [s, [u, "Energizer"], [a, w]],
          [
            // Cat
            /; cat (b35);/i,
            /; (b15q?|s22 flip|s48c|s62 pro)(?: bui|\))/i
          ],
          [s, [u, "Cat"], [a, w]],
          [
            // Smartfren
            /((?:new )?andromax[\w- ]+)(?: bui|\))/i
          ],
          [s, [u, "Smartfren"], [a, w]],
          [
            // Nothing
            /droid.+; (a(?:015|06[35]|142p?))/i
          ],
          [s, [u, "Nothing"], [a, w]],
          [
            // Archos
            /; (x67 5g|tikeasy \w+|ac[1789]\d\w+)( b|\))/i,
            /archos ?(5|gamepad2?|([\w ]*[t1789]|hello) ?\d+[\w ]*)( b|\))/i
          ],
          [s, [u, "Archos"], [a, _]],
          [
            /archos ([\w ]+)( b|\))/i,
            /; (ac[3-6]\d\w{2,8})( b|\))/i
          ],
          [s, [u, "Archos"], [a, w]],
          [
            // MIXED
            /(imo) (tab \w+)/i,
            // IMO
            /(infinix) (x1101b?)/i
            // Infinix XPad
          ],
          [u, s, [a, _]],
          [
            /(blackberry|benq|palm(?=\-)|sonyericsson|acer|asus(?! zenw)|dell|jolla|meizu|motorola|polytron|infinix|tecno|micromax|advan)[-_ ]?([-\w]*)/i,
            // BlackBerry/BenQ/Palm/Sony-Ericsson/Acer/Asus/Dell/Meizu/Motorola/Polytron/Infinix/Tecno/Micromax/Advan
            /; (hmd|imo) ([\w ]+?)(?: bui|\))/i,
            // HMD/IMO
            /(hp) ([\w ]+\w)/i,
            // HP iPAQ
            /(microsoft); (lumia[\w ]+)/i,
            // Microsoft Lumia
            /(lenovo)[-_ ]?([-\w ]+?)(?: bui|\)|\/)/i,
            // Lenovo
            /(oppo) ?([\w ]+) bui/i
            // OPPO
          ],
          [u, s, [a, w]],
          [
            /(kobo)\s(ereader|touch)/i,
            // Kobo
            /(hp).+(touchpad(?!.+tablet)|tablet)/i,
            // HP TouchPad
            /(kindle)\/([\w\.]+)/i,
            // Kindle
            /(nook)[\w ]+build\/(\w+)/i,
            // Nook
            /(dell) (strea[kpr\d ]*[\dko])/i,
            // Dell Streak
            /(le[- ]+pan)[- ]+(\w{1,9}) bui/i,
            // Le Pan Tablets
            /(trinity)[- ]*(t\d{3}) bui/i,
            // Trinity Tablets
            /(gigaset)[- ]+(q\w{1,9}) bui/i,
            // Gigaset Tablets
            /(vodafone) ([\w ]+)(?:\)| bui)/i
            // Vodafone
          ],
          [u, s, [a, _]],
          [
            /(surface duo)/i
            // Surface Duo
          ],
          [s, [u, Ve], [a, _]],
          [
            /droid [\d\.]+; (fp\du?)(?: b|\))/i
            // Fairphone
          ],
          [s, [u, "Fairphone"], [a, w]],
          [
            /(u304aa)/i
            // AT&T
          ],
          [s, [u, "AT&T"], [a, w]],
          [
            /\bsie-(\w*)/i
            // Siemens
          ],
          [s, [u, "Siemens"], [a, w]],
          [
            /\b(rct\w+) b/i
            // RCA Tablets
          ],
          [s, [u, "RCA"], [a, _]],
          [
            /\b(venue[\d ]{2,7}) b/i
            // Dell Venue Tablets
          ],
          [s, [u, "Dell"], [a, _]],
          [
            /\b(q(?:mv|ta)\w+) b/i
            // Verizon Tablet
          ],
          [s, [u, "Verizon"], [a, _]],
          [
            /\b(?:barnes[& ]+noble |bn[rt])([\w\+ ]*) b/i
            // Barnes & Noble Tablet
          ],
          [s, [u, "Barnes & Noble"], [a, _]],
          [
            /\b(tm\d{3}\w+) b/i
          ],
          [s, [u, "NuVision"], [a, _]],
          [
            /\b(k88) b/i
            // ZTE K Series Tablet
          ],
          [s, [u, "ZTE"], [a, _]],
          [
            /\b(nx\d{3}j) b/i
            // ZTE Nubia
          ],
          [s, [u, "ZTE"], [a, w]],
          [
            /\b(gen\d{3}) b.+49h/i
            // Swiss GEN Mobile
          ],
          [s, [u, "Swiss"], [a, w]],
          [
            /\b(zur\d{3}) b/i
            // Swiss ZUR Tablet
          ],
          [s, [u, "Swiss"], [a, _]],
          [
            /\b((zeki)?tb.*\b) b/i
            // Zeki Tablets
          ],
          [s, [u, "Zeki"], [a, _]],
          [
            /\b([yr]\d{2}) b/i,
            /\b(dragon[- ]+touch |dt)(\w{5}) b/i
            // Dragon Touch Tablet
          ],
          [[u, "Dragon Touch"], s, [a, _]],
          [
            /\b(ns-?\w{0,9}) b/i
            // Insignia Tablets
          ],
          [s, [u, "Insignia"], [a, _]],
          [
            /\b((nxa|next)-?\w{0,9}) b/i
            // NextBook Tablets
          ],
          [s, [u, "NextBook"], [a, _]],
          [
            /\b(xtreme\_)?(v(1[045]|2[015]|[3469]0|7[05])) b/i
            // Voice Xtreme Phones
          ],
          [[u, "Voice"], s, [a, w]],
          [
            /\b(lvtel\-)?(v1[12]) b/i
            // LvTel Phones
          ],
          [[u, "LvTel"], s, [a, w]],
          [
            /\b(ph-1) /i
            // Essential PH-1
          ],
          [s, [u, "Essential"], [a, w]],
          [
            /\b(v(100md|700na|7011|917g).*\b) b/i
            // Envizen Tablets
          ],
          [s, [u, "Envizen"], [a, _]],
          [
            /\b(trio[-\w\. ]+) b/i
            // MachSpeed Tablets
          ],
          [s, [u, "MachSpeed"], [a, _]],
          [
            /\btu_(1491) b/i
            // Rotor Tablets
          ],
          [s, [u, "Rotor"], [a, _]],
          [
            /((?:tegranote|shield t(?!.+d tv))[\w- ]*?)(?: b|\))/i
            // Nvidia Tablets
          ],
          [s, [u, Le], [a, _]],
          [
            /(sprint) (\w+)/i
            // Sprint Phones
          ],
          [u, s, [a, w]],
          [
            /(kin\.[onetw]{3})/i
            // Microsoft Kin
          ],
          [[s, /\./g, " "], [u, Ve], [a, w]],
          [
            /droid.+; (cc6666?|et5[16]|mc[239][23]x?|vc8[03]x?)\)/i
            // Zebra
          ],
          [s, [u, Fe], [a, _]],
          [
            /droid.+; (ec30|ps20|tc[2-8]\d[kx])\)/i
          ],
          [s, [u, Fe], [a, w]],
          [
            ///////////////////
            // SMARTTVS
            ///////////////////
            /smart-tv.+(samsung)/i
            // Samsung
          ],
          [u, [a, O]],
          [
            /hbbtv.+maple;(\d+)/i
          ],
          [[s, /^/, "SmartTV"], [u, pe], [a, O]],
          [
            /(nux; netcast.+smarttv|lg (netcast\.tv-201\d|android tv))/i
            // LG SmartTV
          ],
          [[u, Oe], [a, O]],
          [
            /(apple) ?tv/i
            // Apple TV
          ],
          [u, [s, he + " TV"], [a, O]],
          [
            /crkey/i
            // Google Chromecast
          ],
          [[s, Re + "cast"], [u, Ae], [a, O]],
          [
            /droid.+aft(\w+)( bui|\))/i
            // Fire TV
          ],
          [s, [u, Ee], [a, O]],
          [
            /(shield \w+ tv)/i
            // Nvidia Shield TV
          ],
          [s, [u, Le], [a, O]],
          [
            /\(dtv[\);].+(aquos)/i,
            /(aquos-tv[\w ]+)\)/i
            // Sharp
          ],
          [s, [u, He], [a, O]],
          [
            /(bravia[\w ]+)( bui|\))/i
            // Sony
          ],
          [s, [u, te], [a, O]],
          [
            /(mi(tv|box)-?\w+) bui/i
            // Xiaomi
          ],
          [s, [u, le], [a, O]],
          [
            /Hbbtv.*(technisat) (.*);/i
            // TechniSAT
          ],
          [u, s, [a, O]],
          [
            /\b(roku)[\dx]*[\)\/]((?:dvp-)?[\d\.]*)/i,
            // Roku
            /hbbtv\/\d+\.\d+\.\d+ +\([\w\+ ]*; *([\w\d][^;]*);([^;]*)/i
            // HbbTV devices
          ],
          [[u, Ne], [s, Ne], [a, O]],
          [
            // SmartTV from Unidentified Vendors
            /droid.+; ([\w- ]+) (?:android tv|smart[- ]?tv)/i
          ],
          [s, [a, O]],
          [
            /\b(android tv|smart[- ]?tv|opera tv|tv; rv:)\b/i
          ],
          [[a, O]],
          [
            ///////////////////
            // CONSOLES
            ///////////////////
            /(ouya)/i,
            // Ouya
            /(nintendo) ([wids3utch]+)/i
            // Nintendo
          ],
          [u, s, [a, A]],
          [
            /droid.+; (shield)( bui|\))/i
            // Nvidia Portable
          ],
          [s, [u, Le], [a, A]],
          [
            /(playstation \w+)/i
            // Playstation
          ],
          [s, [u, te], [a, A]],
          [
            /\b(xbox(?: one)?(?!; xbox))[\); ]/i
            // Microsoft Xbox
          ],
          [s, [u, Ve], [a, A]],
          [
            ///////////////////
            // WEARABLES
            ///////////////////
            /\b(sm-[lr]\d\d[0156][fnuw]?s?|gear live)\b/i
            // Samsung Galaxy Watch
          ],
          [s, [u, pe], [a, F]],
          [
            /((pebble))app/i,
            // Pebble
            /(asus|google|lg|oppo) ((pixel |zen)?watch[\w ]*)( bui|\))/i
            // Asus ZenWatch / LG Watch / Pixel Watch
          ],
          [u, s, [a, F]],
          [
            /(ow(?:19|20)?we?[1-3]{1,3})/i
            // Oppo Watch
          ],
          [s, [u, be], [a, F]],
          [
            /(watch)(?: ?os[,\/]|\d,\d\/)[\d\.]+/i
            // Apple Watch
          ],
          [s, [u, he], [a, F]],
          [
            /(opwwe\d{3})/i
            // OnePlus Watch
          ],
          [s, [u, st], [a, F]],
          [
            /(moto 360)/i
            // Motorola 360
          ],
          [s, [u, qe], [a, F]],
          [
            /(smartwatch 3)/i
            // Sony SmartWatch
          ],
          [s, [u, te], [a, F]],
          [
            /(g watch r)/i
            // LG G Watch R
          ],
          [s, [u, Oe], [a, F]],
          [
            /droid.+; (wt63?0{2,3})\)/i
          ],
          [s, [u, Fe], [a, F]],
          [
            ///////////////////
            // XR
            ///////////////////
            /droid.+; (glass) \d/i
            // Google Glass
          ],
          [s, [u, Ae], [a, F]],
          [
            /(pico) (4|neo3(?: link|pro)?)/i
            // Pico
          ],
          [u, s, [a, F]],
          [
            /; (quest( \d| pro)?)/i
            // Oculus Quest
          ],
          [s, [u, Me], [a, F]],
          [
            ///////////////////
            // EMBEDDED
            ///////////////////
            /(tesla)(?: qtcarbrowser|\/[-\w\.]+)/i
            // Tesla
          ],
          [u, [a, Q]],
          [
            /(aeobc)\b/i
            // Echo Dot
          ],
          [s, [u, Ee], [a, Q]],
          [
            /(homepod).+mac os/i
            // Apple HomePod
          ],
          [s, [u, he], [a, Q]],
          [
            /windows iot/i
          ],
          [[a, Q]],
          [
            ////////////////////
            // MIXED (GENERIC)
            ///////////////////
            /droid .+?; ([^;]+?)(?: bui|; wv\)|\) applew).+? mobile safari/i
            // Android Phones from Unidentified Vendors
          ],
          [s, [a, w]],
          [
            /droid .+?; ([^;]+?)(?: bui|\) applew).+?(?! mobile) safari/i
            // Android Tablets from Unidentified Vendors
          ],
          [s, [a, _]],
          [
            /\b((tablet|tab)[;\/]|focus\/\d(?!.+mobile))/i
            // Unidentifiable Tablet
          ],
          [[a, _]],
          [
            /(phone|mobile(?:[;\/]| [ \w\/\.]*safari)|pda(?=.+windows ce))/i
            // Unidentifiable Mobile
          ],
          [[a, w]],
          [
            /droid .+?; ([\w\. -]+)( bui|\))/i
            // Generic Android Device
          ],
          [s, [u, "Generic"]]
        ],
        engine: [
          [
            /windows.+ edge\/([\w\.]+)/i
            // EdgeHTML
          ],
          [f, [l, At + "HTML"]],
          [
            /(arkweb)\/([\w\.]+)/i
            // ArkWeb
          ],
          [l, f],
          [
            /webkit\/537\.36.+chrome\/(?!27)([\w\.]+)/i
            // Blink
          ],
          [f, [l, "Blink"]],
          [
            /(presto)\/([\w\.]+)/i,
            // Presto
            /(webkit|trident|netfront|netsurf|amaya|lynx|w3m|goanna|servo)\/([\w\.]+)/i,
            // WebKit/Trident/NetFront/NetSurf/Amaya/Lynx/w3m/Goanna/Servo
            /ekioh(flow)\/([\w\.]+)/i,
            // Flow
            /(khtml|tasman|links)[\/ ]\(?([\w\.]+)/i,
            // KHTML/Tasman/Links
            /(icab)[\/ ]([23]\.[\d\.]+)/i,
            // iCab
            /\b(libweb)/i
            // LibWeb
          ],
          [l, f],
          [
            /ladybird\//i
          ],
          [[l, "LibWeb"]],
          [
            /rv\:([\w\.]{1,9})\b.+(gecko)/i
            // Gecko
          ],
          [f, l]
        ],
        os: [
          [
            // Windows
            /microsoft (windows) (vista|xp)/i
            // Windows (iTunes)
          ],
          [l, f],
          [
            /(windows (?:phone(?: os)?|mobile|iot))[\/ ]?([\d\.\w ]*)/i
            // Windows Phone
          ],
          [l, [f, Ge, Qt]],
          [
            /windows nt 6\.2; (arm)/i,
            // Windows RT
            /windows[\/ ]([ntce\d\. ]+\w)(?!.+xbox)/i,
            /(?:win(?=3|9|n)|win 9x )([nt\d\.]+)/i
          ],
          [[f, Ge, Qt], [l, "Windows"]],
          [
            // iOS/macOS
            /[adehimnop]{4,7}\b(?:.*os ([\w]+) like mac|; opera)/i,
            // iOS
            /(?:ios;fbsv\/|iphone.+ios[\/ ])([\d\.]+)/i,
            /cfnetwork\/.+darwin/i
          ],
          [[f, /_/g, "."], [l, "iOS"]],
          [
            /(mac os x) ?([\w\. ]*)/i,
            /(macintosh|mac_powerpc\b)(?!.+haiku)/i
            // Mac OS
          ],
          [[l, v], [f, /_/g, "."]],
          [
            // Mobile OSes
            /droid ([\w\.]+)\b.+(android[- ]x86|harmonyos)/i
            // Android-x86/HarmonyOS
          ],
          [f, l],
          [
            /(ubuntu) ([\w\.]+) like android/i
            // Ubuntu Touch
          ],
          [[l, /(.+)/, "$1 Touch"], f],
          [
            // Android/Blackberry/WebOS/QNX/Bada/RIM/KaiOS/Maemo/MeeGo/S40/Sailfish OS/OpenHarmony/Tizen
            /(android|bada|blackberry|kaios|maemo|meego|openharmony|qnx|rim tablet os|sailfish|series40|symbian|tizen|webos)\w*[-\/; ]?([\d\.]*)/i
          ],
          [l, f],
          [
            /\(bb(10);/i
            // BlackBerry 10
          ],
          [f, [l, rt]],
          [
            /(?:symbian ?os|symbos|s60(?=;)|series ?60)[-\/ ]?([\w\.]*)/i
            // Symbian
          ],
          [f, [l, "Symbian"]],
          [
            /mozilla\/[\d\.]+ \((?:mobile|tablet|tv|mobile; [\w ]+); rv:.+ gecko\/([\w\.]+)/i
            // Firefox OS
          ],
          [f, [l, $e + " OS"]],
          [
            /web0s;.+rt(tv)/i,
            /\b(?:hp)?wos(?:browser)?\/([\w\.]+)/i
            // WebOS
          ],
          [f, [l, "webOS"]],
          [
            /watch(?: ?os[,\/]|\d,\d\/)([\d\.]+)/i
            // watchOS
          ],
          [f, [l, "watchOS"]],
          [
            // Google Chromecast
            /crkey\/([\d\.]+)/i
            // Google Chromecast
          ],
          [f, [l, Re + "cast"]],
          [
            /(cros) [\w]+(?:\)| ([\w\.]+)\b)/i
            // Chromium OS
          ],
          [[l, j], f],
          [
            // Smart TVs
            /panasonic;(viera)/i,
            // Panasonic Viera
            /(netrange)mmh/i,
            // Netrange
            /(nettv)\/(\d+\.[\w\.]+)/i,
            // NetTV
            // Console
            /(nintendo|playstation) ([wids345portablevuch]+)/i,
            // Nintendo/Playstation
            /(xbox); +xbox ([^\);]+)/i,
            // Microsoft Xbox (360, One, X, S, Series X, Series S)
            // Other
            /\b(joli|palm)\b ?(?:os)?\/?([\w\.]*)/i,
            // Joli/Palm
            /(mint)[\/\(\) ]?(\w*)/i,
            // Mint
            /(mageia|vectorlinux)[; ]/i,
            // Mageia/VectorLinux
            /([kxln]?ubuntu|debian|suse|opensuse|gentoo|arch(?= linux)|slackware|fedora|mandriva|centos|pclinuxos|red ?hat|zenwalk|linpus|raspbian|plan 9|minix|risc os|contiki|deepin|manjaro|elementary os|sabayon|linspire)(?: gnu\/linux)?(?: enterprise)?(?:[- ]linux)?(?:-gnu)?[-\/ ]?(?!chrom|package)([-\w\.]*)/i,
            // Ubuntu/Debian/SUSE/Gentoo/Arch/Slackware/Fedora/Mandriva/CentOS/PCLinuxOS/RedHat/Zenwalk/Linpus/Raspbian/Plan9/Minix/RISCOS/Contiki/Deepin/Manjaro/elementary/Sabayon/Linspire
            /(hurd|linux)(?: arm\w*| x86\w*| ?)([\w\.]*)/i,
            // Hurd/Linux
            /(gnu) ?([\w\.]*)/i,
            // GNU
            /\b([-frentopcghs]{0,5}bsd|dragonfly)[\/ ]?(?!amd|[ix346]{1,2}86)([\w\.]*)/i,
            // FreeBSD/NetBSD/OpenBSD/PC-BSD/GhostBSD/DragonFly
            /(haiku) (\w+)/i
            // Haiku
          ],
          [l, f],
          [
            /(sunos) ?([\w\.\d]*)/i
            // Solaris
          ],
          [[l, "Solaris"], f],
          [
            /((?:open)?solaris)[-\/ ]?([\w\.]*)/i,
            // Solaris
            /(aix) ((\d)(?=\.|\)| )[\w\.])*/i,
            // AIX
            /\b(beos|os\/2|amigaos|morphos|openvms|fuchsia|hp-ux|serenityos)/i,
            // BeOS/OS2/AmigaOS/MorphOS/OpenVMS/Fuchsia/HP-UX/SerenityOS
            /(unix) ?([\w\.]*)/i
            // UNIX
          ],
          [l, f]
        ]
      }, Y = function(y, C) {
        if (typeof y === p && (C = y, y = r), !(this instanceof Y))
          return new Y(y, C).getResult();
        var x = typeof i !== c && i.navigator ? i.navigator : r, S = y || (x && x.userAgent ? x.userAgent : o), ue = x && x.userAgentData ? x.userAgentData : r, ie = C ? M(ei, C) : ei, E = x && x.userAgent == S;
        return this.getBrowser = function() {
          var g = {};
          return g[l] = r, g[f] = r, je.call(g, S, ie.browser), g[m] = ve(g[f]), E && x && x.brave && typeof x.brave.isBrave == b && (g[l] = "Brave"), g;
        }, this.getCPU = function() {
          var g = {};
          return g[$] = r, je.call(g, S, ie.cpu), g;
        }, this.getDevice = function() {
          var g = {};
          return g[u] = r, g[s] = r, g[a] = r, je.call(g, S, ie.device), E && !g[a] && ue && ue.mobile && (g[a] = w), E && g[s] == "Macintosh" && x && typeof x.standalone !== c && x.maxTouchPoints && x.maxTouchPoints > 2 && (g[s] = "iPad", g[a] = _), g;
        }, this.getEngine = function() {
          var g = {};
          return g[l] = r, g[f] = r, je.call(g, S, ie.engine), g;
        }, this.getOS = function() {
          var g = {};
          return g[l] = r, g[f] = r, je.call(g, S, ie.os), E && !g[l] && ue && ue.platform && ue.platform != "Unknown" && (g[l] = ue.platform.replace(/chrome os/i, j).replace(/macos/i, v)), g;
        }, this.getResult = function() {
          return {
            ua: this.getUA(),
            browser: this.getBrowser(),
            engine: this.getEngine(),
            os: this.getOS(),
            device: this.getDevice(),
            cpu: this.getCPU()
          };
        }, this.getUA = function() {
          return S;
        }, this.setUA = function(g) {
          return S = typeof g === h && g.length > ae ? Ne(g, ae) : g, this;
        }, this.setUA(S), this;
      };
      Y.VERSION = n, Y.BROWSER = R([l, f, m]), Y.CPU = R([$]), Y.DEVICE = R([s, u, a, A, w, O, _, F, Q]), Y.ENGINE = Y.OS = R([l, f]), t.exports && (e = t.exports = Y), e.UAParser = Y;
      var Pe = typeof i !== c && (i.jQuery || i.Zepto);
      if (Pe && !Pe.ua) {
        var ot = new Y();
        Pe.ua = ot.getResult(), Pe.ua.get = function() {
          return ot.getUA();
        }, Pe.ua.set = function(y) {
          ot.setUA(y);
          var C = ot.getResult();
          for (var x in C)
            Pe.ua[x] = C[x];
        };
      }
    })(typeof window == "object" ? window : yn);
  })(Ze, Ze.exports)), Ze.exports;
}
var En = Cn();
const kn = /* @__PURE__ */ xn(En), Sn = new kn(), Qi = Sn.getResult(), Dn = (_a = Qi.engine.name) == null ? void 0 : _a.toLowerCase(), hi = Number((_b = Qi.engine.version) == null ? void 0 : _b.split(".")[0]), Ut = {
  "0x0001": "Escape",
  "0x0002": "Digit1",
  "0x0003": "Digit2",
  "0x0004": "Digit3",
  "0x0005": "Digit4",
  "0x0006": "Digit5",
  "0x0007": "Digit6",
  "0x0008": "Digit7",
  "0x0009": "Digit8",
  "0x000A": "Digit9",
  "0x000B": "Digit0",
  "0x000C": "Minus",
  "0x000D": "Equal",
  "0x000E": "Backspace",
  "0x000F": "Tab",
  "0x0010": "KeyQ",
  "0x0011": "KeyW",
  "0x0012": "KeyE",
  "0x0013": "KeyR",
  "0x0014": "KeyT",
  "0x0015": "KeyY",
  "0x0016": "KeyU",
  "0x0017": "KeyI",
  "0x0018": "KeyO",
  "0x0019": "KeyP",
  "0x001A": "BracketLeft",
  "0x001B": "BracketRight",
  "0x001C": "Enter",
  "0x001D": "ControlLeft",
  "0x001E": "KeyA",
  "0x001F": "KeyS",
  "0x0020": "KeyD",
  "0x0021": "KeyF",
  "0x0022": "KeyG",
  "0x0023": "KeyH",
  "0x0024": "KeyJ",
  "0x0025": "KeyK",
  "0x0026": "KeyL",
  "0x0027": "Semicolon",
  "0x0028": "Quote",
  "0x0029": "Backquote",
  "0x002A": "ShiftLeft",
  "0x002B": "Backslash",
  "0x002C": "KeyZ",
  "0x002D": "KeyX",
  "0x002E": "KeyC",
  "0x002F": "KeyV",
  "0x0030": "KeyB",
  "0x0031": "KeyN",
  "0x0032": "KeyM",
  "0x0033": "Comma",
  "0x0034": "Period",
  "0x0035": "Slash",
  "0x0036": "ShiftRight",
  "0x0037": "NumpadMultiply",
  "0x0038": "AltLeft",
  "0x0039": "Space",
  "0x003A": "CapsLock",
  "0x003B": "F1",
  "0x003C": "F2",
  "0x003D": "F3",
  "0x003E": "F4",
  "0x003F": "F5",
  "0x0040": "F6",
  "0x0041": "F7",
  "0x0042": "F8",
  "0x0043": "F9",
  "0x0044": "F10",
  "0x0045": "Pause",
  "0x0046": "ScrollLock",
  "0x0047": "Numpad7",
  "0x0048": "Numpad8",
  "0x0049": "Numpad9",
  "0x004A": "NumpadSubtract",
  "0x004B": "Numpad4",
  "0x004C": "Numpad5",
  "0x004D": "Numpad6",
  "0x004E": "NumpadAdd",
  "0x004F": "Numpad1",
  "0x0050": "Numpad2",
  "0x0051": "Numpad3",
  "0x0052": "Numpad0",
  "0x0053": "NumpadDecimal",
  "0x0056": "IntlBackslash",
  "0x0057": "F11",
  "0x0058": "F12",
  "0x0059": "NumpadEqual",
  "0x0064": "F13",
  "0x0065": "F14",
  "0x0066": "F15",
  "0x0067": "F16",
  "0x0068": "F17",
  "0x0069": "F18",
  "0x006A": "F19",
  "0x006B": "F20",
  "0x006C": "F21",
  "0x006D": "F22",
  "0x006E": "F23",
  "0x0070": "KanaMode",
  "0x0071": "Lang2",
  "0x0072": "Lang1",
  "0x0073": "IntlRo",
  "0x0076": "F24",
  "0x0079": "Convert",
  "0x007B": "NonConvert",
  "0x007D": "IntlYen",
  "0x007E": "NumpadComma",
  "0xE010": "MediaTrackPrevious",
  "0xE019": "MediaTrackNext",
  "0xE01C": "NumpadEnter",
  "0xE01D": "ControlRight",
  "0xE021": "LaunchApp2",
  "0xE022": "MediaPlayPause",
  "0xE024": "MediaStop",
  "0xE032": "BrowserHome",
  "0xE035": "NumpadDivide",
  "0xE037": "PrintScreen",
  "0xE038": "AltRight",
  "0xE045": "NumLock",
  "0xE046": "Pause",
  "0xE047": "Home",
  "0xE048": "ArrowUp",
  "0xE049": "PageUp",
  "0xE04B": "ArrowLeft",
  "0xE04D": "ArrowRight",
  "0xE04F": "End",
  "0xE050": "ArrowDown",
  "0xE051": "PageDown",
  "0xE052": "Insert",
  "0xE053": "Delete",
  "0xE05D": "ContextMenu",
  "0xE05E": "Power",
  "0xE065": "BrowserSearch",
  "0xE066": "BrowserFavorites",
  "0xE067": "BrowserRefresh",
  "0xE068": "BrowserStop",
  "0xE069": "BrowserForward",
  "0xE06A": "BrowserBack",
  "0xE06B": "LaunchApp1",
  "0xE06C": "LaunchMail",
  "0xE06D": "MediaSelect"
}, bi = {
  "0x0077": "Lang4",
  "0x0078": "Lang3",
  "0xE008": "Undo",
  "0xE00A": "Paste",
  "0xE017": "Cut",
  "0xE018": "Copy",
  "0xE020": "AudioVolumeMute",
  "0xE02C": "Eject",
  "0xE02E": "AudioVolumeDown",
  "0xE030": "AudioVolumeUp",
  "0xE03B": "Help",
  "0xE05B": "MetaLeft",
  "0xE05C": "MetaRight",
  "0xE05F": "Sleep",
  "0xE063": "WakeUp"
}, Tn = {
  "0x0054": "PrintScreen",
  "0xE020": "VolumeMute",
  // The documentation says it's 'AudioVolumeMute', but the actual test shows that it's 'VolumeMute'.
  "0xE02E": "VolumeDown",
  "0xE030": "VolumeUp",
  "0xE05B": hi > 117 ? "MetaLeft" : "OSLeft",
  "0xE05C": hi > 117 ? "MetaRight" : "OSRight"
}, Rn = {
  blink: Bt({ ...Ut, ...bi }),
  gecko: Bt({ ...Ut, ...Tn }),
  webkit: Bt({ ...Ut, ...bi })
};
function Bt(t) {
  const e = {};
  for (const [i, r] of Object.entries(t))
    e[r] = i;
  return e;
}
const pi = function(t) {
  const e = Rn[Dn];
  return parseInt(e[t], 16);
};
var qt = /* @__PURE__ */ ((t) => (t.CTRL_LEFT = "ControlLeft", t.SHIFT_LEFT = "ShiftLeft", t.SHIFT_RIGHT = "ShiftRight", t.ALT_LEFT = "AltLeft", t.CTRL_RIGHT = "ControlRight", t.ALT_RIGHT = "AltRight", t.ControlLeft = "ControlLeft", t.ShiftLeft = "ShiftLeft", t.ShiftRight = "ShiftRight", t.AltLeft = "AltLeft", t.ControlRight = "ControlRight", t.AltRight = "AltRight", t))(qt || {}), Be = /* @__PURE__ */ ((t) => (t.CAPS_LOCK = "CapsLock", t.NUM_LOCK = "NumLock", t.SCROLL_LOCK = "ScrollLock", t.KANA_MODE = "KanaMode", t.CapsLock = "CapsLock", t.ScrollLock = "ScrollLock", t.NumLock = "NumLock", t.KanaMode = "KanaMode", t))(Be || {}), ce = /* @__PURE__ */ ((t) => (t[t.CTRL_ALT_DEL = 0] = "CTRL_ALT_DEL", t[t.META = 1] = "META", t[t.CTRL_C = 2] = "CTRL_C", t[t.CTRL_V = 3] = "CTRL_V", t))(ce || {}), me = /* @__PURE__ */ ((t) => (t[t.Fit = 1] = "Fit", t[t.Full = 2] = "Full", t[t.Real = 3] = "Real", t))(me || {}), Je = /* @__PURE__ */ ((t) => (t[t.Pixel = 0] = "Pixel", t[t.Line = 1] = "Line", t[t.Page = 2] = "Page", t))(Je || {});
class $n {
  constructor(e, i, r) {
    __publicField(this, "username");
    __publicField(this, "password");
    __publicField(this, "destination");
    __publicField(this, "proxyAddress");
    __publicField(this, "serverDomain");
    __publicField(this, "authToken");
    __publicField(this, "desktopSize");
    __publicField(this, "extensions");
    this.username = e.username, this.password = e.password, this.proxyAddress = i.address, this.authToken = i.authToken, this.destination = r.destination, this.serverDomain = r.serverDomain, this.extensions = r.extensions, this.desktopSize = r.desktopSize;
  }
}
class An {
  /**
   * Creates a new ConfigBuilder instance.
   */
  constructor() {
    __publicField(this, "username", "");
    __publicField(this, "password", "");
    __publicField(this, "destination", "");
    __publicField(this, "proxyAddress", "");
    __publicField(this, "serverDomain", "");
    __publicField(this, "authToken", "");
    __publicField(this, "desktopSize");
    __publicField(this, "extensions", []);
  }
  /**
   * Optional parameter
   *
   * @param username - The username to use for authentication
   * @returns The builder instance for method chaining
   */
  withUsername(e) {
    return this.username = e, this;
  }
  /**
   * Optional parameter
   *
   * @param password - The password for authentication
   * @returns The builder instance for method chaining
   */
  withPassword(e) {
    return this.password = e, this;
  }
  /**
   * Required parameter
   *
   * @param destination - The destination address to connect to
   * @returns The builder instance for method chaining
   */
  withDestination(e) {
    return this.destination = e, this;
  }
  /**
   * Required parameter
   *
   * @param proxyAddress - The address of the proxy server
   * @returns The builder instance for method chaining
   */
  withProxyAddress(e) {
    return this.proxyAddress = e, this;
  }
  /**
   * Optional parameter
   *
   * @param serverDomain - The server domain to connect to
   * @returns The builder instance for method chaining
   */
  withServerDomain(e) {
    return this.serverDomain = e, this;
  }
  /**
   * Required parameter
   *
   * @param authToken - JWT token to connect to the proxy
   * @returns The builder instance for method chaining
   */
  withAuthToken(e) {
    return this.authToken = e, this;
  }
  /**
   * Optional parameter
   *
   * @param ext - The extension
   * @returns The builder instance for method chaining
   */
  withExtension(e) {
    return this.extensions.push(e), this;
  }
  /**
   * Optional
   *
   * @param desktopSize - The desktop size configuration object
   * @returns The builder instance for method chaining
   */
  withDesktopSize(e) {
    return this.desktopSize = e, this;
  }
  /**
   * Builds a new Config instance.
   *
   * @throws {Error} If required parameters (destination, proxyAddress, authToken) are not set
   * @returns A new Config instance with the configured values
   */
  build() {
    if (this.destination === "")
      throw new Error("destination has to be specified");
    if (this.proxyAddress === "")
      throw new Error("proxy address has to be specified");
    if (this.authToken === "")
      throw new Error("authentication token has to be specified");
    const e = { username: this.username, password: this.password }, i = { address: this.proxyAddress, authToken: this.authToken }, r = {
      destination: this.destination,
      serverDomain: this.serverDomain,
      extensions: this.extensions,
      desktopSize: this.desktopSize
    };
    return new $n(e, i, r);
  }
}
class Se {
  constructor() {
    __publicField(this, "subscribers");
    this.subscribers = [];
  }
  subscribe(e) {
    this.subscribers.push(e);
  }
  publish(e) {
    for (const i of this.subscribers)
      i(e);
  }
}
class On {
  constructor(e) {
    __publicField(this, "module");
    __publicField(this, "canvas");
    __publicField(this, "keyboardUnicodeMode", false);
    __publicField(this, "backendSupportsUnicodeKeyboardShortcuts");
    __publicField(this, "onRemoteClipboardChanged");
    __publicField(this, "onForceClipboardUpdate");
    __publicField(this, "onCanvasResized");
    __publicField(this, "onWarningCallback");
    __publicField(this, "onClipboardRemoteUpdate");
    __publicField(this, "fileTransferProvider");
    __publicField(this, "cursorHasOverride", false);
    __publicField(this, "lastCursorStyle", "default");
    __publicField(this, "enableClipboard", true);
    __publicField(this, "_autoClipboard", true);
    __publicField(this, "sessionStartedObservable", new Se());
    /// Published when the session ends: shut down, or its run() returned.
    __publicField(this, "sessionEndedObservable", new Se());
    __publicField(this, "resizeObservable", new Se());
    __publicField(this, "session");
    __publicField(this, "modifierKeyPressed", []);
    __publicField(this, "mousePositionObservable", new Se());
    __publicField(this, "changeVisibilityObservable", new Se());
    __publicField(this, "scaleObservable", new Se());
    __publicField(this, "dynamicResizeObservable", new Se());
    this.module = e, L.info("Web bridge initialized.");
  }
  get autoClipboard() {
    return this._autoClipboard;
  }
  // If set to false, the clipboard will not be enabled and the callbacks will not be registered to the Rust side
  setEnableClipboard(e) {
    this.enableClipboard = e;
  }
  // If set to true, automatic clipboard synchronization with the server is enabled.
  //
  // If set to false, then the client must invoke `PublicAPI.saveRemoteClipboardData` and
  // `PublicAPI.sendClipboardData` to write to clipboard and to send clipboard data to the server.
  setEnableAutoClipboard(e) {
    this._autoClipboard = e;
  }
  /// Callback to set the local clipboard content to data received from the remote.
  setOnRemoteClipboardChanged(e) {
    this.onRemoteClipboardChanged = e;
  }
  /// Callback which is called when the remote requests a forced clipboard update (e.g. on
  /// clipboard initialization sequence)
  setOnForceClipboardUpdate(e) {
    this.onForceClipboardUpdate = e;
  }
  /// Callback which is called when the canvas is resized.
  setOnCanvasResized(e) {
    this.onCanvasResized = e;
  }
  /// Callback which is called when the warning event is emitted.
  setOnWarningCallback(e) {
    this.onWarningCallback = e;
  }
  /// Callback which is called when the clipboard remote update event is emitted.
  setOnClipboardRemoteUpdate(e) {
    this.onClipboardRemoteUpdate = e;
  }
  /**
   * Enable file transfer support. Must be called before connect().
   * Implicitly enables clipboard (required for file transfer protocol).
   *
   * @param provider - Protocol-specific file transfer provider (e.g., RdpFileTransferProvider)
   * @returns The same provider, for chaining
   */
  enableFileTransfer(e) {
    var _a2;
    return (_a2 = this.fileTransferProvider) == null ? void 0 : _a2.dispose(), this.fileTransferProvider = e, this.enableClipboard = true, e;
  }
  mouseIn(e) {
    if (!this.session) return;
    this.syncModifier(e);
    const r = [
      [1, 0],
      // left button
      [2, 2],
      // right button
      [4, 1]
      // middle button
    ].filter(([n]) => (e.buttons & n) === 0).map(([, n]) => this.module.DeviceEvent.mouseButtonReleased(n));
    r.length > 0 && this.doTransactionFromDeviceEvents(r);
  }
  mouseOut(e) {
    this.releaseAllInputs();
  }
  focusLost() {
    this.releaseAllInputs();
  }
  sendKeyboardEvent(e) {
    this.sendKeyboard(e);
  }
  shutdown() {
    var _a2;
    const e = this.session;
    this.session = void 0, this.sessionEndedObservable.publish(null), (_a2 = this.fileTransferProvider) == null ? void 0 : _a2.dispose(), e == null ? void 0 : e.shutdown();
  }
  mouseButtonState(e, i, r) {
    r && e.preventDefault();
    const n = i ? this.module.DeviceEvent.mouseButtonPressed : this.module.DeviceEvent.mouseButtonReleased;
    this.doTransactionFromDeviceEvents([n(e.button)]);
  }
  updateMousePosition(e) {
    this.doTransactionFromDeviceEvents([this.module.DeviceEvent.mouseMove(e.x, e.y)]), this.mousePositionObservable.publish(e);
  }
  configBuilder() {
    return new An();
  }
  async connect(e) {
    var _a2;
    const i = new this.module.SessionBuilder();
    if (i.proxyAddress(e.proxyAddress), i.destination(e.destination), i.serverDomain(e.serverDomain), i.password(e.password), i.authToken(e.authToken), i.username(e.username), i.renderCanvas(this.canvas), i.setCursorStyleCallbackContext(this), i.setCursorStyleCallback(this.setCursorStyleCallback), e.extensions.forEach((o) => {
      i.extension(o);
    }), this.onRemoteClipboardChanged != null && this.enableClipboard && i.remoteClipboardChangedCallback(this.onRemoteClipboardChanged), this.onForceClipboardUpdate != null && this.enableClipboard && i.forceClipboardUpdateCallback(this.onForceClipboardUpdate), this.fileTransferProvider != null && this.enableClipboard)
      for (const o of this.fileTransferProvider.getBuilderExtensions())
        i.extension(o);
    this.onCanvasResized != null && i.canvasResizedCallback(this.onCanvasResized), e.desktopSize != null && i.desktopSize(
      new this.module.DesktopSize(e.desktopSize.width, e.desktopSize.height)
    );
    const r = await i.connect();
    this.session = r, (_a2 = this.fileTransferProvider) == null ? void 0 : _a2.setSession(r), this.resizeObservable.publish({
      desktopSize: r.desktopSize(),
      sessionId: 0
    }), this.sessionStartedObservable.publish(null);
    const n = async () => {
      try {
        return L.info("Starting the session."), await r.run();
      } finally {
        this.session === r && (this.session = void 0, this.sessionEndedObservable.publish(null)), this.setVisibility(false);
      }
    };
    return {
      sessionId: 0,
      initialDesktopSize: r.desktopSize(),
      websocketPort: 0,
      run: n
    };
  }
  sendSpecialCombination(e) {
    switch (e) {
      case ce.CTRL_ALT_DEL:
        this.ctrlAltDel();
        break;
      case ce.META:
        this.sendMeta();
        break;
      case ce.CTRL_C:
        this.sendCtrlC();
        break;
      case ce.CTRL_V:
        this.sendCtrlV();
        break;
    }
  }
  rotation_unit_from_wheel_event(e) {
    switch (e.deltaMode) {
      case e.DOM_DELTA_PIXEL:
        return Je.Pixel;
      case e.DOM_DELTA_LINE:
        return Je.Line;
      case e.DOM_DELTA_PAGE:
        return Je.Page;
      default:
        return Je.Pixel;
    }
  }
  mouseWheel(e) {
    const i = e.deltaY !== 0, r = i ? e.deltaY : e.deltaX, n = this.rotation_unit_from_wheel_event(e);
    this.doTransactionFromDeviceEvents([
      this.module.DeviceEvent.wheelRotations(i, -r, n)
    ]);
  }
  emitWarningEvent(e) {
    var _a2;
    (_a2 = this.onWarningCallback) == null ? void 0 : _a2.call(this, e);
  }
  emitClipboardRemoteUpdateEvent() {
    var _a2;
    (_a2 = this.onClipboardRemoteUpdate) == null ? void 0 : _a2.call(this);
  }
  setVisibility(e) {
    this.changeVisibilityObservable.publish(e);
  }
  setScale(e) {
    this.scaleObservable.publish(e);
  }
  /// Whether this session's component has the keyboard focus within the page, which can show several sessions.
  hasFocus() {
    var _a2;
    const e = (_a2 = this.canvas) == null ? void 0 : _a2.getRootNode();
    return e instanceof ShadowRoot ? e.host === document.activeElement : true;
  }
  setCanvas(e) {
    this.canvas = e;
  }
  resizeDynamic(e, i, r) {
    var _a2;
    this.dynamicResizeObservable.publish({ width: e, height: i }), (_a2 = this.session) == null ? void 0 : _a2.resize(e, i, r);
  }
  /// Triggered by the browser when local clipboard is updated. Clipboard backend should
  /// cache the content and send it to the server when it is requested.
  onClipboardChanged(e) {
    return (async () => {
      var _a2;
      await ((_a2 = this.session) == null ? void 0 : _a2.onClipboardPaste(e));
    })();
  }
  onClipboardChangedEmpty() {
    return (async () => {
      var _a2;
      await ((_a2 = this.session) == null ? void 0 : _a2.onClipboardPaste(new this.module.ClipboardData()));
    })();
  }
  setKeyboardUnicodeMode(e) {
    this.keyboardUnicodeMode = e;
  }
  setCursorStyleOverride(e) {
    e == null ? (this.canvas.style.cursor = this.lastCursorStyle, this.cursorHasOverride = false) : (this.canvas.style.cursor = e, this.cursorHasOverride = true);
  }
  invokeExtension(e) {
    var _a2;
    (_a2 = this.session) == null ? void 0 : _a2.invokeExtension(e);
  }
  releaseAllInputs() {
    var _a2;
    (_a2 = this.session) == null ? void 0 : _a2.releaseAllInputs();
  }
  supportsUnicodeKeyboardShortcuts() {
    var _a2, _b2;
    return this.backendSupportsUnicodeKeyboardShortcuts !== void 0 ? this.backendSupportsUnicodeKeyboardShortcuts : ((_a2 = this.session) == null ? void 0 : _a2.supportsUnicodeKeyboardShortcuts) ? (this.backendSupportsUnicodeKeyboardShortcuts = (_b2 = this.session) == null ? void 0 : _b2.supportsUnicodeKeyboardShortcuts(), this.backendSupportsUnicodeKeyboardShortcuts) : true;
  }
  sendKeyboard(e) {
    e.preventDefault();
    let i, r;
    e.type === "keydown" ? (i = this.module.DeviceEvent.keyPressed, r = this.module.DeviceEvent.unicodePressed) : e.type === "keyup" && (i = this.module.DeviceEvent.keyReleased, r = this.module.DeviceEvent.unicodeReleased);
    let n = true;
    if (!this.supportsUnicodeKeyboardShortcuts()) {
      for (const b of ["Alt", "Control", "Meta", "AltGraph", "OS"])
        if (e.getModifierState(b)) {
          n = false;
          break;
        }
    }
    const o = e.code in qt, d = e.code in Be;
    if (o && this.updateModifierKeyState(e), d && this.syncModifier(e), !e.repeat || !o && !d) {
      const b = pi(e.code), c = Number.isNaN(b);
      if (!this.keyboardUnicodeMode && i && !c) {
        this.doTransactionFromDeviceEvents([i(b)]);
        return;
      }
      if (this.keyboardUnicodeMode && r && i) {
        if (["Dead", "Unidentified"].indexOf(e.key) != -1)
          return;
        const p = pi(e.key);
        Number.isNaN(p) && e.key.length === 1 && !o && n ? this.doTransactionFromDeviceEvents([r(e.key)]) : c || this.doTransactionFromDeviceEvents([i(b)]);
        return;
      }
    }
  }
  setCursorStyleCallback(e, i, r, n) {
    let o;
    switch (e) {
      case "hidden": {
        o = "none";
        break;
      }
      case "default": {
        o = "default";
        break;
      }
      case "url": {
        if (i == null || r == null || n == null) {
          console.error("Invalid custom cursor parameters.");
          return;
        }
        const d = new Image();
        d.src = i;
        const b = Math.round(r), c = Math.round(n);
        o = `url(${i}) ${b} ${c}, default`;
        break;
      }
      default: {
        console.error(`Unsupported cursor style: ${e}.`);
        return;
      }
    }
    this.lastCursorStyle = o, this.cursorHasOverride || (this.canvas.style.cursor = o);
  }
  syncModifier(e) {
    var _a2;
    const i = e.getModifierState(Be.CAPS_LOCK), r = e.getModifierState(Be.NUM_LOCK), n = e.getModifierState(Be.SCROLL_LOCK), o = e.getModifierState(Be.KANA_MODE);
    (_a2 = this.session) == null ? void 0 : _a2.synchronizeLockKeys(
      n,
      r,
      i,
      o
    );
  }
  updateModifierKeyState(e) {
    const i = qt[e.code];
    this.modifierKeyPressed.indexOf(i) === -1 ? this.modifierKeyPressed.push(i) : e.type === "keyup" && this.modifierKeyPressed.splice(this.modifierKeyPressed.indexOf(i), 1);
  }
  doTransactionFromDeviceEvents(e) {
    var _a2;
    const i = new this.module.InputTransaction();
    e.forEach((r) => i.addEvent(r)), (_a2 = this.session) == null ? void 0 : _a2.applyInputs(i);
  }
  ctrlAltDel() {
    const e = parseInt("0x001D", 16), i = parseInt("0x0038", 16), r = parseInt("0xE053", 16);
    this.doTransactionFromDeviceEvents([
      this.module.DeviceEvent.keyPressed(e),
      this.module.DeviceEvent.keyPressed(i),
      this.module.DeviceEvent.keyPressed(r),
      this.module.DeviceEvent.keyReleased(e),
      this.module.DeviceEvent.keyReleased(i),
      this.module.DeviceEvent.keyReleased(r)
    ]);
  }
  sendMeta() {
    const e = parseInt("0xE05B", 16);
    this.doTransactionFromDeviceEvents([
      this.module.DeviceEvent.keyPressed(e),
      this.module.DeviceEvent.keyReleased(e)
    ]);
  }
  sendCtrlC() {
    const e = parseInt("0x001D", 16), i = parseInt("0x002E", 16);
    this.doTransactionFromDeviceEvents([
      this.module.DeviceEvent.keyPressed(e),
      this.module.DeviceEvent.keyPressed(i),
      this.module.DeviceEvent.keyReleased(i),
      this.module.DeviceEvent.keyReleased(e)
    ]);
  }
  sendCtrlV() {
    const e = parseInt("0x001D", 16), i = parseInt("0x002F", 16);
    this.doTransactionFromDeviceEvents([
      this.module.DeviceEvent.keyPressed(e),
      this.module.DeviceEvent.keyPressed(i),
      this.module.DeviceEvent.keyReleased(i),
      this.module.DeviceEvent.keyReleased(e)
    ]);
  }
}
class Ln {
  constructor(e, i) {
    __publicField(this, "remoteDesktopService");
    __publicField(this, "clipboardService");
    this.remoteDesktopService = e, this.clipboardService = i;
  }
  configBuilder() {
    return this.remoteDesktopService.configBuilder();
  }
  connect(e) {
    return L.info("Initializing connection."), this.remoteDesktopService.connect(e);
  }
  ctrlAltDel() {
    this.remoteDesktopService.sendSpecialCombination(ce.CTRL_ALT_DEL);
  }
  metaKey() {
    this.remoteDesktopService.sendSpecialCombination(ce.META);
  }
  ctrlC() {
    this.remoteDesktopService.sendSpecialCombination(ce.CTRL_C);
  }
  ctrlV() {
    this.remoteDesktopService.sendSpecialCombination(ce.CTRL_V);
  }
  // Keys for this session whether or not its canvas has the focus, for a host that routes the keyboard itself (the
  // same keys to several sessions, for one). Handled as the canvas's own: codes as scancodes, modifiers kept in sync.
  sendKeyboardEvent(e) {
    this.remoteDesktopService.sendKeyboardEvent(e);
  }
  setVisibility(e) {
    L.info(`Change component visibility to: ${e}`), this.remoteDesktopService.setVisibility(e);
  }
  setScale(e) {
    this.remoteDesktopService.setScale(e);
  }
  shutdown() {
    this.remoteDesktopService.shutdown();
  }
  setKeyboardUnicodeMode(e) {
    this.remoteDesktopService.setKeyboardUnicodeMode(e);
  }
  setCursorStyleOverride(e) {
    this.remoteDesktopService.setCursorStyleOverride(e);
  }
  resize(e, i, r) {
    this.remoteDesktopService.resizeDynamic(e, i, r);
  }
  setEnableClipboard(e) {
    this.remoteDesktopService.setEnableClipboard(e);
  }
  setEnableAutoClipboard(e) {
    this.remoteDesktopService.setEnableAutoClipboard(e);
  }
  setOnWarningCallback(e) {
    this.remoteDesktopService.setOnWarningCallback(e);
  }
  setOnClipboardRemoteUpdateCallback(e) {
    this.remoteDesktopService.setOnClipboardRemoteUpdate(e);
  }
  async saveRemoteClipboardData() {
    return await this.clipboardService.saveRemoteClipboardData();
  }
  async sendClipboardData() {
    return await this.clipboardService.sendClipboardData();
  }
  invokeExtension(e) {
    this.remoteDesktopService.invokeExtension(e);
  }
  enableFileTransfer(e) {
    const i = e.onUploadStarted, r = e.onUploadFinished;
    return e.onUploadStarted = () => {
      i == null ? void 0 : i(), this.clipboardService.suppressMonitoring();
    }, e.onUploadFinished = () => {
      this.clipboardService.resumeMonitoring(), r == null ? void 0 : r();
    }, this.remoteDesktopService.enableFileTransfer(e);
  }
  getExposedFunctions() {
    return {
      setVisibility: this.setVisibility.bind(this),
      configBuilder: this.configBuilder.bind(this),
      connect: this.connect.bind(this),
      onWarningCallback: this.setOnWarningCallback.bind(this),
      onClipboardRemoteUpdateCallback: this.setOnClipboardRemoteUpdateCallback.bind(this),
      setScale: this.setScale.bind(this),
      ctrlAltDel: this.ctrlAltDel.bind(this),
      metaKey: this.metaKey.bind(this),
      ctrlC: this.ctrlC.bind(this),
      ctrlV: this.ctrlV.bind(this),
      sendKeyboardEvent: this.sendKeyboardEvent.bind(this),
      shutdown: this.shutdown.bind(this),
      setKeyboardUnicodeMode: this.setKeyboardUnicodeMode.bind(this),
      setCursorStyleOverride: this.setCursorStyleOverride.bind(this),
      resize: this.resize.bind(this),
      setEnableClipboard: this.setEnableClipboard.bind(this),
      setEnableAutoClipboard: this.setEnableAutoClipboard.bind(this),
      saveRemoteClipboardData: this.saveRemoteClipboardData.bind(this),
      sendClipboardData: this.sendClipboardData.bind(this),
      invokeExtension: this.invokeExtension.bind(this),
      enableFileTransfer: this.enableFileTransfer.bind(this)
    };
  }
}
var W = /* @__PURE__ */ ((t) => (t[t.Full = 0] = "Full", t[t.TextOnly = 1] = "TextOnly", t[t.TextOnlyServerOnly = 2] = "TextOnlyServerOnly", t[t.None = 3] = "None", t))(W || {}), er = /* @__PURE__ */ ((t) => (t[t.General = 0] = "General", t[t.WrongPassword = 1] = "WrongPassword", t[t.LogonFailure = 2] = "LogonFailure", t[t.AccessDenied = 3] = "AccessDenied", t[t.RDCleanPath = 4] = "RDCleanPath", t[t.ProxyConnect = 5] = "ProxyConnect", t[t.NegotiationFailure = 6] = "NegotiationFailure", t))(er || {});
const Fn = 100;
function ne(t) {
  throw {
    kind: () => er.General,
    backtrace: () => t
  };
}
class Mn {
  constructor(e, i) {
    __publicField(this, "remoteDesktopService");
    __publicField(this, "module");
    __publicField(this, "ClipboardApiSupported", W.None);
    __publicField(this, "lastClientClipboardItems", {});
    __publicField(this, "lastReceivedClipboardData", {});
    __publicField(this, "lastSentClipboardData", null);
    __publicField(this, "clipboardDataToSave", null);
    __publicField(this, "lastClipboardMonitorLoopError", null);
    // When true, the clipboard monitoring loop skips reading/sending clipboard updates.
    // Used to prevent the monitoring loop from clobbering an active file upload's
    // FormatList with a text/image clipboard update.
    __publicField(this, "monitoringSuppressed", false);
    // The monitoring loop and the clipboard write waiting for focus belong to this component: a page can hold several,
    // and one being destroyed must not stop the others.
    __publicField(this, "disposed", false);
    __publicField(this, "monitoringActive", false);
    __publicField(this, "monitorTimer");
    // Only the latest remote clipboard content is written once the window has the focus again.
    __publicField(this, "pendingFocus", null);
    // Firefox v126 and below does not support `navigator.clipboard.read` and `navigator.clipboard.write`.
    // So, we need to define specific methods to handle text-only clipboard.
    //
    // Also, Firefox v124 and below does not support `navigator.clipboard.readText`.
    // Because of this, we cannot read the data from the clipboard at all.
    __publicField(this, "ffClipboardDataToSave", null);
    this.remoteDesktopService = e, this.module = i;
  }
  /**
   * Suppress clipboard monitoring. While suppressed, the 100ms monitoring
   * loop will skip reading the local clipboard and sending updates to the
   * remote. This prevents the monitor from clobbering a file upload's
   * FormatList announcement with a text/image clipboard update.
   */
  suppressMonitoring() {
    this.monitoringSuppressed = true;
  }
  /**
   * Resume clipboard monitoring after a previous {@link suppressMonitoring} call.
   */
  resumeMonitoring() {
    this.monitoringSuppressed = false;
  }
  /**
   * Stops the monitoring loop and drops the clipboard write waiting for focus, until the next session starts.
   */
  stopMonitoring() {
    this.monitoringActive = false, clearTimeout(this.monitorTimer), this.monitorTimer = void 0, this.pendingFocus = null;
  }
  /**
   * For when the component is destroyed: nothing is read from or written to the clipboard anymore.
   */
  dispose() {
    this.disposed = true, this.stopMonitoring();
  }
  async initClipboard() {
    if (!window.isSecureContext) {
      this.remoteDesktopService.emitWarningEvent("Clipboard is available only in secure contexts (HTTPS).");
      return;
    }
    if (navigator.clipboard != null && (navigator.clipboard.read != null && navigator.clipboard.write != null ? this.ClipboardApiSupported = W.Full : navigator.clipboard.readText != null ? (this.ClipboardApiSupported = W.TextOnly, this.remoteDesktopService.emitWarningEvent(
      "Clipboard is limited to text-only data types due to an outdated browser version!"
    )) : navigator.clipboard.writeText != null && (this.ClipboardApiSupported = W.TextOnlyServerOnly, this.remoteDesktopService.emitWarningEvent(
      "Clipboard reading is not supported and writing is limited to text-only data types due to an outdated browser version!"
    ))), this.ClipboardApiSupported === W.Full)
      try {
        (await navigator.permissions.query({
          name: "clipboard-read"
        })).state === "denied" && (this.ClipboardApiSupported = W.TextOnly);
      } catch {
        try {
          await navigator.clipboard.read();
        } catch {
          this.ClipboardApiSupported = W.TextOnly;
        }
      }
    if (this.ClipboardApiSupported === W.None) {
      this.remoteDesktopService.emitWarningEvent(
        "Clipboard is not supported due to an outdated browser version!"
      );
      return;
    }
    this.disposed || (this.remoteDesktopService.sessionEndedObservable.subscribe(() => this.stopMonitoring()), this.remoteDesktopService.setOnForceClipboardUpdate(this.onForceClipboardUpdate.bind(this)), this.ClipboardApiSupported === W.Full ? this.remoteDesktopService.autoClipboard ? (this.remoteDesktopService.setOnRemoteClipboardChanged(this.onRemoteClipboardChangedAutoMode.bind(this)), this.remoteDesktopService.sessionStartedObservable.subscribe((e) => {
      this.monitoringActive = !this.disposed, this.scheduleOnMonitorClipboardUpdate();
    })) : this.remoteDesktopService.setOnRemoteClipboardChanged(
      this.onRemoteClipboardChangedManualMode.bind(this)
    ) : this.remoteDesktopService.setOnRemoteClipboardChanged(this.ffOnRemoteClipboardChanged.bind(this)));
  }
  // Copies clipboard content received from the server to the local clipboard.
  // Returns the result of the operation. On failure, it additionally raises an error session event.
  async saveRemoteClipboardData() {
    if (this.ClipboardApiSupported !== W.Full)
      return await this.ffSaveRemoteClipboardData();
    this.clipboardDataToSave == null && ne("The server did not send the clipboard data.");
    try {
      const e = this.clipboardDataToRecord(this.clipboardDataToSave), i = new ClipboardItem(e);
      await navigator.clipboard.write([i]), this.clipboardDataToSave = null;
    } catch (e) {
      ne("Failed to write to the clipboard: " + e);
    }
  }
  // Sends local clipboard's content to the server.
  // Returns the result of the operation. On failure, it additionally raises an error session event.
  async sendClipboardData() {
    if (this.ClipboardApiSupported !== W.Full)
      return await this.ffSendClipboardData();
    const e = await navigator.clipboard.read().catch((n) => {
      ne("Failed to read from the clipboard: " + n);
    });
    e.length == 0 && ne("The clipboard has no data.");
    const i = e[0];
    i.types.some((n) => n.startsWith("text/") || n.startsWith("image/png")) || ne("The clipboard has no data of supported type (text or image).");
    const r = new this.module.ClipboardData();
    for (const n of i.types) {
      const o = n.startsWith("text/"), d = await i.getType(n);
      o ? r.addText(n, await d.text()) : r.addBinary(n, new Uint8Array(await d.arrayBuffer()));
    }
    r.isEmpty() || (this.lastSentClipboardData = r, await this.remoteDesktopService.onClipboardChanged(r));
  }
  scheduleOnMonitorClipboardUpdate() {
    clearTimeout(this.monitorTimer), this.monitorTimer = this.monitoringActive && !this.disposed ? setTimeout(() => {
      this.monitorTimer = void 0, this.onMonitorClipboard();
    }, Fn) : void 0;
  }
  // With several sessions on a page, the automatic clipboard sync belongs to the one with the keyboard focus: the
  // others neither send the local clipboard nor overwrite it.
  isFocused() {
    return document.hasFocus() && this.remoteDesktopService.hasFocus();
  }
  runWhenWindowFocused(e) {
    this.disposed || (this.isFocused() ? Promise.resolve().then(() => {
      if (!this.disposed) {
        if (!this.isFocused()) {
          this.pendingFocus = e;
          return;
        }
        return e();
      }
    }).catch((i) => console.error("Failed to set client clipboard: " + i)) : this.pendingFocus = e);
  }
  /**
   * Runs the clipboard write that waited for this session to have the focus (the component calls it on focus).
   */
  flushFocused() {
    if (!this.isFocused())
      return;
    const e = this.pendingFocus;
    this.pendingFocus = null, e && this.runWhenWindowFocused(e);
  }
  // This function is required to convert `ClipboardData` to an object that can be used
  // with `ClipboardItem` API.
  clipboardDataToRecord(e) {
    const i = {};
    for (const r of e.items()) {
      const n = r.mimeType();
      i[n] = new Blob([r.value()], { type: n });
    }
    return i;
  }
  clipboardDataToClipboardItemsRecord(e) {
    const i = {};
    for (const r of e.items()) {
      const n = r.mimeType();
      i[n] = r.value();
    }
    return i;
  }
  // This callback is required to send initial clipboard state if available.
  async onForceClipboardUpdate() {
    try {
      if (this.disposed)
        return;
      this.lastSentClipboardData ? await this.remoteDesktopService.onClipboardChanged(this.lastSentClipboardData) : await this.remoteDesktopService.onClipboardChangedEmpty();
    } catch (e) {
      console.error("Failed to send initial clipboard state: " + e);
    }
  }
  // This callback is required to update client clipboard state when remote side has changed.
  onRemoteClipboardChangedManualMode(e) {
    this.clipboardDataToSave = e, this.remoteDesktopService.emitClipboardRemoteUpdateEvent();
  }
  // This callback is required to update client clipboard state when remote side has changed.
  onRemoteClipboardChangedAutoMode(e) {
    if (!this.disposed)
      try {
        const i = this.clipboardDataToRecord(e), r = new ClipboardItem(i);
        this.runWhenWindowFocused(() => (this.lastReceivedClipboardData = this.clipboardDataToClipboardItemsRecord(e), navigator.clipboard.write([r])));
      } catch (i) {
        console.error("Failed to set client clipboard: " + i);
      }
  }
  // Called periodically to monitor clipboard changes
  async onMonitorClipboard() {
    let e = false;
    try {
      if (this.disposed || !this.monitoringActive || this.monitoringSuppressed || !this.isFocused())
        return;
      const i = await navigator.clipboard.read();
      if (i.length == 0)
        return;
      const r = i[0];
      if (!r.types.some((d) => d.startsWith("text/") || d.startsWith("image/png")))
        return;
      const n = {};
      let o = true;
      for (const d of r.types) {
        const b = d.startsWith("text/"), c = await r.getType(d), p = b ? await c.text() : new Uint8Array(await c.arrayBuffer()), h = b ? function(s, l) {
          return s === l;
        } : function(s, l) {
          return !(s instanceof Uint8Array) || !(l instanceof Uint8Array) ? false : s.length === l.length && s.every((a, u) => a === l[u]);
        }, m = this.lastClientClipboardItems[d];
        h(m, p) || (h(this.lastReceivedClipboardData[d], p) ? this.lastClientClipboardItems[d] = this.lastReceivedClipboardData[d] : o = false), n[d] = p;
      }
      if (!o && !this.disposed && this.monitoringActive && !this.monitoringSuppressed && this.isFocused()) {
        this.lastClientClipboardItems = n;
        const d = new this.module.ClipboardData();
        Object.entries(n).forEach(([b, c]) => {
          c != null && (b.startsWith("text/") && typeof c == "string" ? d.addText(b, c) : b.startsWith("image/") && c instanceof Uint8Array && d.addBinary(b, c));
        }), d.isEmpty() || (this.lastSentClipboardData = d, await this.remoteDesktopService.onClipboardChanged(d));
      }
    } catch (i) {
      if (i instanceof DOMException && i.name === "NotAllowedError") {
        console.warn("Clipboard monitoring disabled: browser requires user activation for clipboard read."), this.remoteDesktopService.setOnRemoteClipboardChanged(
          this.onRemoteClipboardChangedManualMode.bind(this)
        ), e = true;
        return;
      }
      i instanceof Error && ((this.lastClipboardMonitorLoopError === null || this.lastClipboardMonitorLoopError.toString() !== i.toString()) && console.error("Clipboard monitoring error: " + i), this.lastClipboardMonitorLoopError = i);
    } finally {
      e || this.scheduleOnMonitorClipboardUpdate();
    }
  }
  // This function is required to retrieve the text data from the `ClipboardData`.
  ffRetrieveTextData(e) {
    for (const i of e.items())
      if (i.mimeType().startsWith("text/")) {
        const r = i.value();
        if (typeof r == "string") return r;
      }
    return "";
  }
  // Firefox specific function.
  // This callback is required to update client clipboard state when remote side has changed.
  ffOnRemoteClipboardChanged(e) {
    const i = this.ffRetrieveTextData(e);
    i !== "" && (this.ffClipboardDataToSave = i, this.remoteDesktopService.emitClipboardRemoteUpdateEvent());
  }
  // Firefox specific function. We are using text-only clipboard API here.
  //
  // Copies clipboard content received from the server to the local clipboard.
  // Returns the result of the operation. On failure, it additionally raises an error session event.
  async ffSaveRemoteClipboardData() {
    this.ffClipboardDataToSave == null && ne("The server did not send the clipboard data.");
    try {
      await navigator.clipboard.writeText(this.ffClipboardDataToSave), this.ffClipboardDataToSave = null;
    } catch (e) {
      ne("Failed to write to the clipboard: " + e);
    }
  }
  // Firefox specific function. We are using text-only clipboard API here.
  //
  // Sends local clipboard's content to the server.
  // Returns the result of the operation. On failure, it additionally raises an error session event.
  async ffSendClipboardData() {
    this.ClipboardApiSupported !== W.TextOnly && ne("The browser does not support clipboard read.");
    const e = await navigator.clipboard.readText().catch((r) => {
      ne("Failed to read from the clipboard: " + r);
    });
    e.length == 0 && ne("The clipboard has no data.");
    const i = new this.module.ClipboardData();
    i.addText("text/plain", e), i.isEmpty() || (this.lastSentClipboardData = i, await this.remoteDesktopService.onClipboardChanged(i));
  }
}
function tr(t = window) {
  const e = t.document.documentElement, i = t.document.getElementsByTagName("body")[0];
  return {
    x: t.innerWidth ?? e.clientWidth ?? i.clientWidth,
    y: t.innerHeight ?? e.clientHeight ?? i.clientHeight
  };
}
function Nn(t, e = window) {
  if (t) {
    const i = t.getBoundingClientRect();
    if (i.width > 0 && i.height > 0)
      return { x: i.right, y: i.bottom };
  }
  return tr(e);
}
var Pn = (t, e) => e(t, true), Un = (t, e) => e(t, false), Bn = (t) => t.preventDefault(), zn = /* @__PURE__ */ ln('<div class="svelte-1103xra"><div><div class="screen-viewer svelte-1103xra"><canvas id="renderer" tabindex="0" class="svelte-1103xra"></canvas></div></div></div>');
const In = {
  hash: "svelte-1103xra",
  code: ".screen-wrapper.svelte-1103xra {position:relative;}.capturing-inputs.svelte-1103xra {outline:1px solid rgba(0, 97, 166, 0.7);outline-offset:-1px;}canvas.svelte-1103xra {width:100%;height:100%;}.svelte-1103xra::selection {background-color:transparent;}.screen-wrapper.hidden.svelte-1103xra {pointer-events:none !important;position:absolute !important;visibility:hidden;height:100%;width:100%;transform:translate(-100%, -100%);}"
};
function ir(t, e) {
  Vi(e, true), cn(t, In);
  let i = ut(e, "scale"), r = ut(e, "verbose"), n = ut(e, "flexcenter"), o = ut(e, "module"), d = Ft(false), b = () => {
    var _a2, _b2;
    return L.info(`
            capturingInputs: ${document.activeElement === h}
            current active element: ${document.activeElement}
        `), ((_b2 = (_a2 = document.activeElement) == null ? void 0 : _a2.shadowRoot) == null ? void 0 : _b2.firstElementChild) === c;
  }, c, p, h, m = Ft(""), s = Ft(""), l = new On(o()), a = new Mn(l, o()), u = new Ln(l, a), f = me.Fit, $ = false, A;
  function w(v) {
    b() && Ve(v);
  }
  function _() {
    he(), it(), window.addEventListener("keydown", w, false), window.addEventListener("keyup", w, false), window.addEventListener("focus", be), window.addEventListener("focusin", be), window.addEventListener("blur", pe), document.addEventListener("visibilitychange", He);
  }
  function O() {
    n() === "true" && (c.style.flexGrow = "", c.style.display = "", c.style.justifyContent = "", c.style.alignItems = "");
  }
  function F(v) {
    n() === "true" && (c.style.flexGrow = "1", c.style.display = "flex", c.style.justifyContent = "center", c.style.alignItems = "center");
  }
  function Q(v, T, M) {
    let R = `height: ${v}; width: ${T}`;
    R = `${R}; max-height: ${v}; max-width: ${T}; min-height: ${v}; min-width: ${T}`, q(m, De(R));
  }
  function ae(v, T, M) {
    q(s, `height: ${v}; width: ${T}; overflow: ${M}`);
  }
  const Ee = (v) => {
    ee(i());
  };
  function he() {
    l.resizeObservable.subscribe((v) => {
      L.info(`Resize canvas to: ${v.desktopSize.width}x${v.desktopSize.height}`), h.width = v.desktopSize.width, h.height = v.desktopSize.height, ee(i());
    });
  }
  function it() {
    window.addEventListener("resize", Ee), l.scaleObservable.subscribe((v) => {
      L.info("Change scale!"), ee(v);
    }), l.dynamicResizeObservable.subscribe((v) => {
      L.info(`Dynamic resize!, width: ${v.width}, height: ${v.height}`), Q(v.height.toString() + "px", v.width.toString() + "px");
    }), l.changeVisibilityObservable.subscribe((v) => {
      q(d, De(v)), v && (ae("100%", "100%", "hidden"), clearTimeout(A), A = setTimeout(() => ee(i()), 150));
    });
  }
  function rt() {
    ee(f);
  }
  function ee(v) {
    if (!$ && (O(), U(d)))
      switch (v) {
        case "fit":
        case me.Fit:
          L.info("Size to fit"), f = me.Fit, i("fit"), At();
          break;
        case "full":
        case me.Full:
          L.info("Size to full"), f = me.Full, Re(), i("full");
          break;
        case "real":
        case me.Real:
          L.info("Size to real"), f = me.Real, $e(), i("real");
          break;
      }
  }
  function Re() {
    const v = qe(), T = v.x, M = v.y;
    let R = h.width, z = h.height;
    const N = Math.min(T / h.width, M / h.height);
    R = R * N, z = z * N, ae(`${M}px`, `${T}px`, "hidden"), R = R > 0 ? R : 0, z = z > 0 ? z : 0, Q(`${z}px`, `${R}px`);
  }
  function At(v = false) {
    const T = Le(), M = p.getBoundingClientRect(), R = T.x - M.x, z = T.y - M.y;
    let N = h.width, ve = h.height;
    if (!v || R < h.width || z < h.height) {
      const Ne = Math.min(R / h.width, z / h.height);
      N = N * Ne, ve = ve * Ne;
    }
    N = N > 0 ? N : 0, ve = ve > 0 ? ve : 0, ae("initial", "initial", "hidden"), Q(`${ve}px`, `${N}px`), F();
  }
  function $e() {
    const v = Le(), T = p.getBoundingClientRect(), M = v.x - T.x, R = v.y - T.y;
    M < h.width || R < h.height ? ae(`${Math.min(R, h.height)}px`, `${Math.min(M, h.width)}px`, "auto") : ae("initial", "initial", "initial"), Q(`${h.height}px`, `${h.width}px`), F();
  }
  function Ae(v) {
    const T = h == null ? void 0 : h.getBoundingClientRect(), M = (h == null ? void 0 : h.width) / T.width, R = (h == null ? void 0 : h.height) / T.height, z = {
      x: Math.round((v.clientX - T.left) * M),
      y: Math.round((v.clientY - T.top) * R)
    };
    l.updateMousePosition(z);
  }
  function We(v, T) {
    l.mouseButtonState(v, T, true);
  }
  function nt(v) {
    l.mouseWheel(v);
  }
  function Ot(v) {
    h.focus({ preventScroll: true }), l.mouseIn(v);
  }
  function Oe(v) {
    l.mouseOut(v);
  }
  function Ve(v) {
    return l.sendKeyboardEvent(v), true;
  }
  function qe() {
    return tr();
  }
  function Le() {
    return Nn(e.$$host);
  }
  async function st() {
    L.info("Start canvas initialization..."), h.width = 800, h.height = 600, l.setCanvas(h), l.setOnCanvasResized(rt), _();
  }
  function ke() {
    let v = {
      irgUserInteraction: u.getExposedFunctions()
    };
    L.info("Component ready"), L.info("Dispatching ready event"), c.dispatchEvent(new CustomEvent("ready", {
      detail: v,
      bubbles: true,
      composed: true
    }));
  }
  function be() {
    a.flushFocused();
  }
  function pe() {
    l.focusLost();
  }
  function He() {
    document.visibilityState === "hidden" && l.focusLost();
  }
  Zi(async () => {
    if (L.verbose = r() === "true", L.info("Dom ready"), await st(), !$) {
      try {
        await a.initClipboard();
      } catch (v) {
        L.error("Clipboard initialization failed: " + v);
      }
      $ || ke();
    }
  }), pn(() => {
    $ = true, clearTimeout(A), a.dispose(), window.removeEventListener("resize", Ee), window.removeEventListener("keydown", w, false), window.removeEventListener("keyup", w, false), window.removeEventListener("focus", be), window.removeEventListener("focusin", be), window.removeEventListener("blur", pe), document.removeEventListener("visibilitychange", He);
  });
  var te = zn(), le = Nt(te);
  let Fe;
  var Me = Nt(le), j = Nt(Me);
  return j.__mousemove = Ae, j.__mousedown = [Pn, We], j.__mouseup = [Un, We], j.__contextmenu = [Bn], Pt(j, (v) => h = v, () => h), Mt(Me), Mt(le), Pt(le, (v) => p = v, () => p), Mt(te), Pt(te, (v) => c = v, () => c), Yr(() => {
    Fe = hn(le, 1, `screen-wrapper scale-${i() ?? ""}`, "svelte-1103xra", Fe, {
      hidden: !U(d),
      "capturing-inputs": b
    }), ui(le, "style", U(s)), ui(Me, "style", U(m));
  }), lt("mouseleave", j, (v) => {
    Oe(v);
  }), lt("mouseenter", j, (v) => {
    Ot(v);
  }), lt("wheel", j, nt), lt("selectstart", j, (v) => {
    v.preventDefault();
  }), Gi(t, te), qi({
    get scale() {
      return i();
    },
    set scale(v) {
      i(v), Ye();
    },
    get verbose() {
      return r();
    },
    set verbose(v) {
      r(v), Ye();
    },
    get flexcenter() {
      return n();
    },
    set flexcenter(v) {
      n(v), Ye();
    },
    get module() {
      return o();
    },
    set module(v) {
      o(v), Ye();
    }
  });
}
on([
  "mousemove",
  "mousedown",
  "mouseup",
  "contextmenu"
]);
customElements.define("iron-remote-desktop", gn(
  ir,
  {
    scale: {},
    verbose: {},
    flexcenter: {},
    module: {}
  },
  [],
  [],
  false,
  (t) => class extends t {
    constructor() {
      super(), this.attachShadow({ mode: "open", delegatesFocus: true });
    }
  }
));
const Kn = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ir
}, Symbol.toStringTag, { value: "Module" }));
export {
  $n as Config,
  An as ConfigBuilder,
  Kn as default
};
