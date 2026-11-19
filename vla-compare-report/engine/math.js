// 统计数学核心：t 分布、配对 t 检验、Welch 两样本 t 检验、SHA-256。
// 浏览器与 Node 共用；结果由 verify.py（scipy）与 Excel 复核表独立校验。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});

  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // 正则化不完全 Beta 函数的连分式（Numerical Recipes betacf）
  function betacf(a, b, x) {
    const MAXIT = 500, EPS = 1e-15, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
  }

  // 双侧 p 值：P(|T| >= |t|)
  function tTwoSidedP(t, df) {
    if (!isFinite(t)) return 0;
    return betai(df / 2, 0.5, df / (df + t * t));
  }

  // t 分布上分位点：返回 x 使 P(T <= x) = q（q > 0.5），二分法求解
  function tQuantile(q, df) {
    const target = 2 * (1 - q);
    let lo = 0, hi = 1;
    while (tTwoSidedP(hi, df) > target) hi *= 2;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (tTwoSidedP(mid, df) > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  function sdSample(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(sum(a.map((x) => (x - m) * (x - m))) / (a.length - 1));
  }

  const TOL = 1e-12;
  // 配对 t 检验（双侧）+ 置信区间 + 可分辨范围 + 方向计数
  // a、b 为同一批用例的用例级指标值，返回 b - a 的统计量
  function pairedT(a, b, conf) {
    conf = conf || 0.9;
    const n = a.length;
    const d = a.map((x, i) => b[i] - x);
    const up = d.filter((x) => x > TOL).length;
    const down = d.filter((x) => x < -TOL).length;
    const res = { n, meanDiff: mean(d), up, down, flat: n - up - down, df: n - 1 };
    if (n < 2) return Object.assign(res, { sd: NaN, se: NaN, t: NaN, p: NaN, lo: NaN, hi: NaN, tcrit: NaN, mde: NaN });
    const sd = sdSample(d), se = sd / Math.sqrt(n);
    const tcrit = tQuantile(1 - (1 - conf) / 2, n - 1);
    let t, p;
    if (se < TOL) {
      // 差值完全相同：均值为 0 时 p=1；否则差异确定，p=0
      t = Math.abs(res.meanDiff) < TOL ? 0 : Infinity * Math.sign(res.meanDiff);
      p = Math.abs(res.meanDiff) < TOL ? 1 : 0;
    } else {
      t = res.meanDiff / se;
      p = tTwoSidedP(t, n - 1);
    }
    return Object.assign(res, {
      sd, se, t, p, tcrit,
      lo: res.meanDiff - tcrit * (se || 0),
      hi: res.meanDiff + tcrit * (se || 0),
      mde: tcrit * (se || 0), // 可分辨范围 = 90% 区间半宽
    });
  }

  // Welch 两样本 t 检验（双侧），用于 ID 与 OOD 配对差值的交互效应
  function welchT(x, y, conf) {
    conf = conf || 0.9;
    const n1 = x.length, n2 = y.length;
    if (n1 < 2 || n2 < 2) return { n1, n2, diff: mean(x) - mean(y), p: NaN, lo: NaN, hi: NaN, df: NaN, t: NaN };
    const v1 = sdSample(x) ** 2 / n1, v2 = sdSample(y) ** 2 / n2;
    const se = Math.sqrt(v1 + v2);
    const diff = mean(x) - mean(y);
    const df = (v1 + v2) ** 2 / ((v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1));
    if (se < TOL) return { n1, n2, diff, df, t: 0, p: Math.abs(diff) < TOL ? 1 : 0, lo: diff, hi: diff };
    const t = diff / se;
    const tcrit = tQuantile(1 - (1 - conf) / 2, df);
    return { n1, n2, diff, df, t, se, p: tTwoSidedP(t, df), lo: diff - tcrit * se, hi: diff + tcrit * se };
  }

  // 纯 JS SHA-256（同步），用于数据指纹
  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const K = [];
    for (let i = 0, n = 2; i < 64; n++) {
      let prime = true;
      for (let j = 2; j * j <= n; j++) if (n % j === 0) { prime = false; break; }
      if (prime) { K.push((Math.cbrt(n) % 1) * 2 ** 32 | 0); i++; }
    }
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length, withPad = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    withPad.set(bytes); withPad[l] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, (l * 8) >>> 0); dv.setUint32(withPad.length - 8, Math.floor(l / 2 ** 29));
    const W = new Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H = H.map((x, i) => (x + [a, b, c, d, e, f, g, h][i]) | 0);
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  V.math = { lgamma, betai, tTwoSidedP, tQuantile, mean, sum, sdSample, pairedT, welchT, sha256, TOL };
})();
