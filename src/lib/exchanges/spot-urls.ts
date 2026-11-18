/** Template URL halaman spot per exchange. Tambah entri baru di sini saat menambah adapter. */
const SPOT_URLS: Record<string, (base: string, quote: string, rawSymbol?: string | null) => string> = {
  kraken: (base, quote) =>
    `https://pro.kraken.com/app/trade/${base.toLowerCase()}-${quote.toLowerCase()}`,
  bingx: (base, quote) =>
    `https://bingx.com/en/spot/${base.toUpperCase()}${quote.toUpperCase()}/`,
  lbank: (base, quote) =>
    `https://www.lbank.com/trade/${base.toLowerCase()}_${quote.toLowerCase()}`,
  bybit: (base, quote) =>
    `https://www.bybit.com/en/trade/spot/${base}/${quote}`,
  bitget: (base, quote) =>
    `https://www.bitget.com/spot/${base}${quote}`,
  gate: (base, quote) =>
    `https://www.gate.com/trade/${base.toUpperCase()}_${quote.toUpperCase()}`,
  poloniex: (base, quote) =>
    `https://poloniex.com/trade/${base.toUpperCase()}_${quote.toUpperCase()}?type=spot`,
  bitrue: (base, quote) =>
    `https://www.bitrue.com/trade/${base.toLowerCase()}_${quote.toLowerCase()}`,
  mexc: (base, quote) =>
    `https://www.mexc.com/exchange/${base.toUpperCase()}_${quote.toUpperCase()}`,
  htx: (base, quote) =>
    `https://www.htx.com/trade/${base.toLowerCase()}_${quote.toLowerCase()}`,
  fameex: (base, quote) =>
    `https://www.fameex.com/en-US/trade/${base.toUpperCase()}-${quote.toUpperCase()}`,
  xt: (base, quote) =>
    `https://www.xt.com/en/trade/${base.toLowerCase()}_${quote.toLowerCase()}`,
  bifinance: (base, quote) =>
    `https://www.bifinance.com/trade?symbol=${base.toUpperCase()}/${quote.toUpperCase()}`,
  hotcoin: (base, quote) =>
    `https://www.hotcoin.com/en_US/spot/${base.toLowerCase()}-${quote.toLowerCase()}/`,
  bigone: (base, quote) =>
    `https://big.one/en/trade/${base.toUpperCase()}-${quote.toUpperCase()}`,
  cryptocom: (base, quote) =>
    `https://crypto.com/exchange/trade/${base.toUpperCase()}_${quote.toUpperCase()}`,
  asterdex: (base, quote) =>
    `https://www.asterdex.com/en/trade/pro/spot/${base.toUpperCase()}${quote.toUpperCase()}`,
  toobit: (base, quote) =>
    `https://www.toobit.com/en-US/spot/${base.toUpperCase()}_${quote.toUpperCase()}`,
  ourbit: (base, quote) =>
    `https://www.ourbit.com/exchange/${base.toUpperCase()}${quote.toUpperCase()}`,
  mgbx: (base, quote) =>
    `https://www.mgbx.com/en/spot/trade/${base.toLowerCase()}_${quote.toLowerCase()}`,
  // BTSE memakai raw symbol asli agar prefiks K_/M_/B_ (mis. K_SATS-USDT) tetap terjaga.
  btse: (base, quote, rawSymbol) => {
    const raw = rawSymbol?.trim() || `${base.toUpperCase()}-${quote.toUpperCase()}`;
    return `https://www.btse.com/en/trading/${raw}`;
  },
  pionex: (base, quote) =>
    `https://www.pionex.com/en/trade/${base.toUpperCase()}_${quote.toUpperCase()}/Manual`,
  coinw: (base, quote) =>
    `https://www.coinw.com/spot/${base.toLowerCase()}${quote.toLowerCase()}`,
  weex: (base, quote) =>
    `https://www.weex.com/spot/${base.toUpperCase()}-${quote.toUpperCase()}`,
  phemex: (base, quote) =>
    `https://phemex.com/spot/trade/${base.toUpperCase()}${quote.toUpperCase()}`,
  // Dex-Trade: nama pair case-sensitive (mis. RtimeUSDT), jadi pakai raw symbol asli.
  dextrade: (base, quote, rawSymbol) => {
    const pair = rawSymbol?.trim() || `${base.toUpperCase()}${quote.toUpperCase()}`;
    return `https://dex-trade.com/spot/trading/${encodeURIComponent(pair)}`;
  },
  p2pb2b: (base, quote) =>
    `https://p2pb2b.com/trade/${base.toUpperCase()}_${quote.toUpperCase()}/`,
};

export function getSpotUrl(
  exchange: string,
  base: string,
  quote: string,
  rawSymbol?: string | null,
): string | null {
  const build = SPOT_URLS[exchange.toLowerCase()];
  if (!build || !base || !quote) return null;
  return build(base, quote, rawSymbol);
}
