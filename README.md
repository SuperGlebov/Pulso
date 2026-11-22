# Pulso pela câmara

PWA experimental que mede o pulso pela câmara frontal (rPPG, algoritmo POS) e regista leituras de braçadeira para treinar um modelo de pressão arterial. **Não é um dispositivo médico.**

- Deteção de cara com MediaPipe (BlazeFace), servida localmente em `mp/`.
- Dados guardados só no dispositivo (IndexedDB), com exportar/importar JSON.
- Cada leitura guarda o sinal RGB bruto de cada zona (testa, bochechas), para reprocessar com versões futuras do algoritmo.

## Treinar o modelo geral

```
node tools/train.js pulso-dados-2026-11-30.json [outros.json]
```

Escreve `model.json` (só coeficientes). Os ficheiros de dados estão no `.gitignore` — não os publiques.

Ao alterar a app, atualiza `VERSION` em `sw.js`.
