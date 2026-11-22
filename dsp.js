// Processamento de sinal rPPG (POS) partilhado entre a app e as ferramentas de treino (Node).
const DSP = (() => {
  function resample(ts, ch, fs) {
    const t0 = ts[0], t1 = ts[ts.length - 1];
    const n = Math.max(0, Math.floor((t1 - t0) * fs));
    const out = ch.map(() => new Float64Array(n));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / fs;
      while (j < ts.length - 2 && ts[j + 1] < t) j++;
      const dt = ts[j + 1] - ts[j];
      const a = dt > 0 ? Math.min(1, Math.max(0, (t - ts[j]) / dt)) : 0;
      for (let c = 0; c < ch.length; c++) { const v = ch[c]; out[c][i] = v[j] + (v[j + 1] - v[j]) * a; }
    }
    return out;
  }
  // Plane-Orthogonal-to-Skin (Wang et al. 2017)
  function pos(R, G, B, fs) {
    const N = R.length, L = Math.round(1.6 * fs), H = new Float64Array(N);
    const s1 = new Float64Array(L), s2 = new Float64Array(L);
    for (let n = 0; n + L <= N; n++) {
      let mr = 0, mg = 0, mb = 0;
      for (let k = 0; k < L; k++) { mr += R[n + k]; mg += G[n + k]; mb += B[n + k]; }
      mr /= L; mg /= L; mb /= L;
      if (!(mr > 0 && mg > 0 && mb > 0)) continue;
      let a1 = 0, a2 = 0;
      for (let k = 0; k < L; k++) {
        const r = R[n + k] / mr, g = G[n + k] / mg, b = B[n + k] / mb;
        s1[k] = g - b; s2[k] = g + b - 2 * r; a1 += s1[k]; a2 += s2[k];
      }
      a1 /= L; a2 /= L;
      let v1 = 0, v2 = 0;
      for (let k = 0; k < L; k++) { v1 += (s1[k] - a1) ** 2; v2 += (s2[k] - a2) ** 2; }
      const alpha = v2 > 0 ? Math.sqrt(v1 / v2) : 0;
      let mh = 0;
      for (let k = 0; k < L; k++) mh += s1[k] + alpha * s2[k];
      mh /= L;
      for (let k = 0; k < L; k++) H[n + k] += s1[k] + alpha * s2[k] - mh;
    }
    return H;
  }
  function biquad(type, fc, fs) {
    const w = 2 * Math.PI * fc / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Math.SQRT1_2);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - al) / a0];
  }
  function filt(x, q) {
    const [b0, b1, b2, a1, a2] = q, y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
    }
    return y;
  }
  const rev = a => Float64Array.from(a).reverse();
  const filtfilt = (x, q) => rev(filt(rev(filt(x, q)), q));
  function bandpass(x, fs, lo, hi) {
    const n = x.length; let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;
    const p = Math.min(n - 2, Math.round(2 * fs)), ext = new Float64Array(n + 2 * p);
    for (let i = 0; i < p; i++) {
      ext[i] = 2 * (x[0] - m) - (x[p - i] - m);
      ext[n + p + i] = 2 * (x[n - 1] - m) - (x[n - 2 - i] - m);
    }
    for (let i = 0; i < n; i++) ext[p + i] = x[i] - m;
    let y = filtfilt(ext, biquad('hp', lo, fs));
    y = filtfilt(y, biquad('lp', hi, fs));
    return y.slice(p, p + n);
  }
  function spectrum(x, fs, f0, f1, df) {
    const n = x.length, w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    const fr = [], P = [];
    for (let f = f0; f <= f1 + 1e-9; f += df) {
      let re = 0, im = 0; const k = 2 * Math.PI * f / fs;
      for (let i = 0; i < n; i++) { re += w[i] * Math.cos(k * i); im -= w[i] * Math.sin(k * i); }
      fr.push(f); P.push(re * re + im * im);
    }
    return { fr, P };
  }
  function hrSnr(x, fs) {
    const df = 0.01, { fr, P } = spectrum(x, fs, 0.6, 4.0, df);
    let bi = -1, bp = -1;
    for (let i = 0; i < fr.length; i++) { if (fr[i] < 0.7 || fr[i] > 3.5) continue; if (P[i] > bp) { bp = P[i]; bi = i; } }
    const f0 = fr[bi];
    let s = 0, nz = 0;
    for (let i = 0; i < fr.length; i++) {
      const f = fr[i]; if (f < 0.7) continue;
      if (Math.abs(f - f0) <= 0.1 || Math.abs(f - 2 * f0) <= 0.2) s += P[i]; else nz += P[i];
    }
    let fRef = f0;
    if (bi > 0 && bi < P.length - 1) {
      const a = P[bi - 1], b = P[bi], c = P[bi + 1], d = a - 2 * b + c;
      if (d < 0) fRef = f0 + 0.5 * (a - c) / d * df;
    }
    return { bpm: fRef * 60, snr: 10 * Math.log10((s + 1e-12) / (nz + 1e-12)) };
  }
  function peaksOf(x, minDist) {
    const pk = [];
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0) {
        if (pk.length && i - pk[pk.length - 1] < minDist) { if (x[i] > x[pk[pk.length - 1]]) pk[pk.length - 1] = i; }
        else pk.push(i);
      }
    }
    return pk;
  }
  // média coerente de ciclos alinhados pelos picos do sinal em banda estreita (robusto ao ruído)
  function template(x, nb, fs, bpm) {
    const per = 60 / bpm * fs, half = per / 2, pk = peaksOf(nb, Math.round(0.6 * per)), M = 100;
    const acc = new Float64Array(M); let cnt = 0;
    for (const p of pk) {
      const a = p - half, b = p + half;
      if (a < 0 || b > x.length - 2) continue;
      const seg = new Float64Array(M); let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < M; k++) {
        const t = a + k * (b - a) / M, j = Math.floor(t), f = t - j, v = x[j] + (x[j + 1] - x[j]) * f;
        seg[k] = v; if (v < mn) mn = v; if (v > mx) mx = v;
      }
      if (!(mx > mn)) continue;
      for (let k = 0; k < M; k++) acc[k] += (seg[k] - mn) / (mx - mn);
      cnt++;
    }
    let im = 0;
    for (let k = 1; k < M; k++) if (acc[k] < acc[im]) im = k;
    const tpl = new Float64Array(M); let tmx = 0;
    for (let k = 0; k < M; k++) { tpl[k] = acc[(im + k) % M] - acc[im]; if (tpl[k] > tmx) tmx = tpl[k]; }
    if (tmx > 0) for (let k = 0; k < M; k++) tpl[k] /= tmx;
    const w = Math.round(0.2 * per);
    const pkB = pk.map(p => { let bi = p; for (let j = Math.max(0, p - w); j <= Math.min(x.length - 1, p + w); j++) if (x[j] > x[bi]) bi = j; return bi; });
    return { tpl, beats: cnt, pk: pkB };
  }
  function shape(tpl) {
    const M = tpl.length; let im = 0;
    for (let k = 1; k < M; k++) if (tpl[k] > tpl[im]) im = k;
    let above = 0, aS = 0, aD = 0;
    for (let k = 0; k < M; k++) {
      if (tpl[k] >= 0.5 * tpl[im]) above++;
      const v = Math.max(0, tpl[k]);
      if (k <= im) aS += v; else aD += v;
    }
    return { riseFrac: im / (M - 1), width50: above / M, areaRatio: aS > 0 ? aD / aS : 0 };
  }
  // S = {t:[s], r:[], g:[], b:[]}
  function analyze(S, opt = {}) {
    const fs = 30, skip = opt.skip || 0;
    let i0 = 0;
    while (i0 < S.t.length && S.t[i0] - S.t[0] < skip) i0++;
    const t = S.t.slice(i0);
    if (t.length < 60 || t[t.length - 1] - t[0] < 8) return null;
    const [R, G, B] = resample(t, [S.r.slice(i0), S.g.slice(i0), S.b.slice(i0)], fs);
    const h = pos(R, G, B, fs), x = bandpass(h, fs, 0.7, 3.5);
    const e = Math.round(fs), y = x.slice(e, x.length - e);
    let sd = 0;
    for (let i = 0; i < y.length; i++) sd += y[i] * y[i];
    sd = Math.sqrt(sd / y.length) || 1;
    for (let i = 0; i < y.length; i++) y[i] /= sd;
    const hs = hrSnr(y, fs), f0 = hs.bpm / 60;
    const nb = bandpass(h, fs, Math.max(0.5, f0 - 0.4), f0 + 0.4).slice(e, x.length - e);
    const ny = y.map(v => -v), nnb = nb.map(v => -v);
    const A = template(y, nb, fs, hs.bpm), Bn = template(ny, nnb, fs, hs.bpm);
    const fa = shape(A.tpl), fb = shape(Bn.tpl);
    // PPG: subida sistólica mais curta que a descida -> escolhe a polaridade com subida mais rápida
    const useB = fb.riseFrac < fa.riseFrac;
    const T = useB ? Bn : A, F = useB ? fb : fa, sig = useB ? ny : y;
    return {
      bpm: hs.bpm, snr: hs.snr, beats: T.beats, dur: t[t.length - 1] - t[0], fs,
      sig, pk: T.pk, tpl: Array.from(T.tpl),
      feats: { ...F }
    };
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; if (Math.abs(d) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function ridgeFit(X, y, lam) {
    const n = X.length, p = X[0].length, mu = Array(p).fill(0), sd = Array(p).fill(0);
    X.forEach(r => r.forEach((v, j) => mu[j] += v / n));
    X.forEach(r => r.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / n));
    for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
    const Z = X.map(r => r.map((v, j) => (v - mu[j]) / sd[j])), ym = y.reduce((a, b) => a + b, 0) / n;
    const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lam : 0)));
    const bb = Array.from({ length: p }, (_, i) => Z.reduce((s, r, k) => s + r[i] * (y[k] - ym), 0));
    const w = solve(A, bb) || Array(p).fill(0);
    return { mu, sd, w, ym, predict: x => ym + x.reduce((s, v, j) => s + w[j] * (v - mu[j]) / sd[j], 0) };
  }
  // leave-one-out: erro do modelo vs. erro de "adivinhar sempre a média"
  function loo(X, y, lam) {
    let em = 0, eb = 0;
    for (let i = 0; i < X.length; i++) {
      const Xt = X.filter((_, k) => k !== i), yt = y.filter((_, k) => k !== i);
      em += Math.abs(ridgeFit(Xt, yt, lam).predict(X[i]) - y[i]);
      eb += Math.abs(yt.reduce((a, b) => a + b, 0) / yt.length - y[i]);
    }
    return { mae: em / X.length, base: eb / X.length };
  }
  return { analyze, ridgeFit, loo };
})();
if (typeof module !== 'undefined') module.exports = DSP;
