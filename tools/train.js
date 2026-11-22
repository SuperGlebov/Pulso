#!/usr/bin/env node
// Treina o modelo geral a partir de um ou mais ficheiros exportados pela app.
// Recalcula as características a partir do sinal guardado (raw), por isso
// melhorias em dsp.js aplicam-se a todas as leituras antigas.
// Uso: node tools/train.js pulso-dados-*.json  -> escreve model.json
// Os ficheiros de dados NÃO devem ser publicados no repositório.
const fs = require('fs'), path = require('path');
const DSP = require(path.join(__dirname, '..', 'dsp.js'));
const KEYS = ['fh', 'cl', 'cr'], LAM = 2, MIN = 8;

const files = process.argv.slice(2);
if (!files.length) { console.error('Uso: node tools/train.js ficheiro1.json [ficheiro2.json ...]'); process.exit(1); }
const byId = new Map();
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of (Array.isArray(d) ? d : d.readings)) if (r && r.id) byId.set(r.id, r);
}

function combined(raw) {
  const o = { t: raw.t, r: [], g: [], b: [] };
  for (let i = 0; i < raw.t.length; i++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (const k of KEYS) { const z = raw[k]; r += z.r[i] * z.n[i]; g += z.g[i] * z.n[i]; b += z.b[i] * z.n[i]; n += z.n[i]; }
    o.r.push(r / n); o.g.push(g / n); o.b.push(b / n);
  }
  return o;
}

const rows = [];
for (const r of byId.values()) {
  if (!r.cuff || !Number.isFinite(r.cuff.sys) || !Number.isFinite(r.cuff.dia)) continue;
  let a = null;
  if (r.raw) a = DSP.analyze(combined(r.raw), { skip: r.mode === 'live' ? 2 : 1 });
  const bpm = a ? a.bpm : r.bpm, feats = a ? a.feats : r.feats, snr = a ? a.snr : r.snr;
  if (!feats || !Number.isFinite(bpm)) continue;
  rows.push({ id: r.id, snr, x: [bpm, feats.riseFrac, feats.width50, feats.areaRatio], sys: r.cuff.sys, dia: r.cuff.dia, pulse: r.cuff.pulse });
}
console.log(`Leituras com braçadeira: ${rows.length} (de ${byId.size})`);
const withPulse = rows.filter(r => Number.isFinite(r.pulse));
if (withPulse.length) console.log('Erro do pulso (câmara vs braçadeira):', (withPulse.reduce((s, r) => s + Math.abs(r.x[0] - r.pulse), 0) / withPulse.length).toFixed(1), 'bpm');
if (rows.length < MIN) { console.log(`São precisas pelo menos ${MIN}. model.json não foi alterado.`); process.exit(0); }

const X = rows.map(r => r.x), out = { ready: true, n: rows.length, trained: new Date().toISOString().slice(0, 10), features: ['bpm', 'riseFrac', 'width50', 'areaRatio'], loo: {}, base: {} };
for (const k of ['sys', 'dia']) {
  const y = rows.map(r => r[k]), m = DSP.ridgeFit(X, y, LAM), L = DSP.loo(X, y, LAM);
  out[k] = { mu: m.mu, sd: m.sd, w: m.w, ym: m.ym };
  out.loo[k] = +L.mae.toFixed(2); out.base[k] = +L.base.toFixed(2);
  console.log(`${k}: erro LOO ${L.mae.toFixed(1)} mmHg vs ${L.base.toFixed(1)} a adivinhar a média`);
}
if (out.loo.sys >= out.base.sys * 0.9 && out.loo.dia >= out.base.dia * 0.9) { out.ready = false; console.log('O modelo não bate a média: publicado com ready=false.'); }
fs.writeFileSync(path.join(__dirname, '..', 'model.json'), JSON.stringify(out, null, 1));
console.log('model.json escrito.');
