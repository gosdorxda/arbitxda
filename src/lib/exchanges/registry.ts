import type { ExchangeAdapter } from "../types";
import { bingxAdapter } from "./bingx";
import { bitgetAdapter } from "./bitget";
import { bybitAdapter } from "./bybit";
import { cryptocomAdapter } from "./cryptocom";
import { asterdexAdapter } from "./asterdex";
import { gateAdapter } from "./gate";
import { hotcoinAdapter } from "./hotcoin";
import { htxAdapter } from "./htx";
import { bitrueAdapter } from "./bitrue";
import { krakenAdapter } from "./kraken";
import { poloniexAdapter } from "./poloniex";
import { lbankAdapter } from "./lbank";
import { bifinanceAdapter } from "./bifinance";
import { bigoneAdapter } from "./bigone";
import { fameexAdapter } from "./fameex";
import { xtAdapter } from "./xt";
import { mexcAdapter } from "./mexc";
import { toobitAdapter } from "./toobit";
import { ourbitAdapter } from "./ourbit";
import { mgbxAdapter } from "./mgbx";
import { btseAdapter } from "./btse";
import { pionexAdapter } from "./pionex";
import { coinwAdapter } from "./coinw";
import { weexAdapter } from "./weex";
import { phemexAdapter } from "./phemex";
import { dextradeAdapter } from "./dextrade";
import { p2pb2bAdapter } from "./p2pb2b";
import { safetradeAdapter } from "./safetrade";
import { binanceAlphaAdapter } from "./binance-alpha";
import { cexioAdapter } from "./cexio";
import { biconomyAdapter } from "./biconomy";

const adapters: Record<string, ExchangeAdapter> = {
  kraken: krakenAdapter,
  bingx: bingxAdapter,
  lbank: lbankAdapter,
  bybit: bybitAdapter,
  bitget: bitgetAdapter,
  gate: gateAdapter,
  poloniex: poloniexAdapter,
  bitrue: bitrueAdapter,
  mexc: mexcAdapter,
  htx: htxAdapter,
  fameex: fameexAdapter,
  xt: xtAdapter,
  bifinance: bifinanceAdapter,
  hotcoin: hotcoinAdapter,
  bigone: bigoneAdapter,
  cryptocom: cryptocomAdapter,
  asterdex: asterdexAdapter,
  toobit: toobitAdapter,
  ourbit: ourbitAdapter,
  mgbx: mgbxAdapter,
  btse: btseAdapter,
  pionex: pionexAdapter,
  coinw: coinwAdapter,
  weex: weexAdapter,
  phemex: phemexAdapter,
  dextrade: dextradeAdapter,
  p2pb2b: p2pb2bAdapter,
  safetrade: safetradeAdapter,
  "binance-alpha": binanceAlphaAdapter,
  cexio: cexioAdapter,
  biconomy: biconomyAdapter,
};

export function getAdapter(id: string): ExchangeAdapter {
  const adapter = adapters[id.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `Adapter untuk exchange "${id}" belum ada. Tambahkan file di src/lib/exchanges/ lalu daftarkan di registry.ts.`,
    );
  }
  return adapter;
}

export function listRegisteredAdapters(): ExchangeAdapter[] {
  return Object.values(adapters);
}

export function hasAdapter(id: string): boolean {
  return Boolean(adapters[id.toLowerCase()]);
}
