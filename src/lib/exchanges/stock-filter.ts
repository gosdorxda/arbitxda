/**
 * Filter token saham / tokenized stocks agar tidak di-fetch dan tidak tampil.
 *
 * Adapter masa depan: jika exchange punya flag resmi, set `isStock` dan/atau
 * `isLeveraged` pada MarketInfo. Filter ini dipasang di jalur fetch bersama
 * (fetch-service), jadi semua adapter sekarang dan nanti otomatis tersaring.
 * Pola nama (rTOKEN, suffix X/ON, 3L/3S, UP/DOWN) hanya cadangan — jangan
 * andalkan prefix/suffix mentah supaya coin kripto seperti RENDER, RSR, RUNE,
 * RAY, XRP, AVAX, ONDO, JUP tidak ikut terbuang.
 */
import type { DerivedTicker, MarketInfo } from "../types";

export type StockFilterInput = {
  base: string;
  exchange?: string;
  rawSymbol?: string;
  isStock?: boolean | null;
  isLeveraged?: boolean | null;
  /** Nama tampilan / fullName / deskripsi koin dari exchange, jika ada. */
  names?: Array<string | null | undefined>;
  /** Base lain di exchange yang sama; dipakai untuk suffix UP/DOWN/BULL/BEAR. */
  knownBases?: Set<string>;
};

/** Ticker ekuitas/ETF yang dipakai hanya sebagai prefiks (AAPL + X/ON/B). */
const EQUITY_TICKERS = new Set(
  "A,AAPL,ABBV,ABNB,ABT,ACGL,ACN,ADBE,ADI,ADM,ADP,ADSK,AEE,AEP,AES,AFL,AIG,AIZ,AJG,AKAM,ALB,ALGN,ALL,ALLE,AMAT,AMCR,AMD,AME,AMGN,AMP,AMT,AMZN,ANET,AON,AOS,APA,APD,APH,APO,APP,APTV,ARE,ARES,ARKG,ARKK,ARKW,ARM,ASML,ATO,AVGO,AVY,AWK,AXON,AXP,AZO,BA,BABA,BAC,BALL,BAX,BBY,BDX,BE,BEN,BFB,BG,BIDU,BIIB,BITO,BKNG,BKR,BLK,BMNR,BMY,BNY,BR,BRKB,BRO,BSX,BX,BXP,C,CAH,CARR,CASY,CAT,CB,CBOE,CBRE,CCI,CCL,CDNS,CDW,CEG,CF,CFG,CHD,CHRW,CHTR,CI,CIEN,CINF,CL,CLX,CMCSA,CME,CMG,CMI,CMS,CNC,CNP,COF,COHR,COIN,COO,COP,COPX,COR,COST,CPAY,CPRT,CPT,CRCL,CRH,CRL,CRM,CRWD,CRWV,CSCO,CSGP,CSX,CTAS,CTSH,CVNA,CVS,CVX,D,DAL,DASH,DD,DDOG,DE,DECK,DELL,DG,DGX,DHI,DHR,DIA,DIS,DLR,DLTR,DOC,DOV,DOW,DPZ,DRI,DTE,DUK,DVA,DVN,DXCM,EBAY,ECHO,ECL,ED,EEM,EFA,EFX,EG,EIX,EL,ELV,EME,EMR,EOG,EQIX,EQT,ERIE,ES,ESS,ETN,ETR,EVRG,EW,EXC,EXE,EXPD,EXPE,EXR,F,FANG,FAST,FBTC,FCX,FDS,FDX,FDXF,FE,FERG,FFIV,FICO,FIS,FISV,FITB,FIX,FLEX,FOX,FOXA,FRT,FSLR,FTNT,FTV,GD,GDDY,GDX,GDXJ,GE,GEHC,GEN,GEV,GILD,GIS,GL,GLD,GLW,GM,GME,GNRC,GOOG,GOOGL,GPC,GPN,GRMN,GS,GWW,HAL,HAS,HBAN,HCA,HD,HIG,HII,HIMS,HLT,HON,HONA,HOOD,HPE,HPQ,HRL,HSIC,HST,HSY,HUBB,HUM,HWM,HYG,IAU,IBIT,IBKR,IBM,ICE,IDXX,IEFA,IEMG,IEX,IFF,ILMN,INCY,INTC,INTU,INVH,IP,IQV,IR,IREN,IRM,ISRG,IT,ITW,IVV,IVZ,IWM,J,JBHT,JBL,JCI,JKHY,JNJ,JPM,KDP,KEY,KEYS,KHC,KIM,KKR,KLAC,KMB,KMI,KO,KR,L,LDOS,LEN,LH,LHX,LI,LII,LIN,LITE,LLY,LMT,LNT,LOW,LQD,LRCX,LULU,LUV,LVS,LYB,LYV,MA,MAA,MAR,MARA,MAS,MCD,MCHP,MCK,MCO,MDLZ,MDT,MET,META,MGM,MKC,MLM,MMM,MNST,MO,MOS,MP,MPC,MPWR,MRK,MRNA,MRSH,MRVL,MS,MSCI,MSFT,MSI,MSTR,MTB,MTD,MU,NBIS,NCLH,NDAQ,NDSN,NEE,NEM,NFLX,NI,NIO,NKE,NOC,NOW,NRG,NSC,NTAP,NTRS,NUE,NVDA,NVO,NVR,NWS,NWSA,NXPI,O,ODFL,OKE,OKLO,OKTA,OMC,ON,ONDS,ORCL,ORLY,OTIS,OXY,P,PANW,PAYX,PBR,PCAR,PCG,PDD,PEG,PEP,PFE,PFG,PG,PGR,PH,PHM,PKG,PLD,PLTR,PM,PNC,PNR,PNW,PODD,PPG,PPL,PRU,PSA,PSX,PTC,PWR,PYPL,Q,QBTS,QCOM,QLD,QQQ,RCL,RDDT,REG,REGN,RF,RIVN,RJF,RL,RMD,ROK,ROL,ROP,ROST,RSG,RTX,RVTY,SBAC,SBUX,SCHW,SHOP,SHW,SJM,SKYD,SLB,SLV,SMCI,SMH,SNA,SNDK,SNOW,SNPS,SO,SOFI,SOLV,SOXL,SOXS,SOXX,SPCX,SPG,SPGI,SPXS,SPXU,SPY,SQQQ,SRE,STE,STLD,STT,STX,STZ,SW,SWK,SWKS,SYF,SYK,SYY,T,TDG,TDY,TECH,TEL,TER,TFC,TGT,TJX,TKO,TLT,TMF,TMO,TMUS,TNA,TPL,TPR,TQQQ,TRGP,TRMB,TROW,TRV,TSCO,TSLA,TSM,TSN,TT,TTWO,TWLO,TXN,TXT,TYL,TZA,UAL,UBER,UDR,UHS,ULTA,UNG,UNH,UNP,UPRO,UPS,URI,USB,USO,UVXY,V,VEEV,VICI,VLO,VLTO,VMC,VMRK,VOO,VRSK,VRSN,VRT,VRTX,VST,VTI,VTR,VTRS,VYLR,VZ,WAB,WAT,WDAY,WDC,WEC,WELL,WFC,WM,WMB,WMT,WRB,WSM,WST,WTW,WY,WYNN,XEL,XLB,XLE,XLF,XLI,XLK,XLP,XLRE,XLU,XLV,XLY,XOM,XPEV,XYL,XYZ,YUM,ZBH,ZBRA,ZTS".split(","),
);

/** Sufiks Ondo "ON" untuk ticker 2 huruf yang sudah terlihat sebagai token saham (bukan SO/EL yang bentrok dengan SOON/ELON). */
const TWO_LETTER_ON = new Set(["KO", "MU", "BA"]);

const CRYPTO_KEEP = new Set([
  "RENDER", "RSR", "RUNE", "RAY", "XRP", "AVAX", "IMX", "GMX", "SNX", "DYDX", "STX", "TRX", "ZRX",
  "ONDO", "AUCTION", "SOON", "ELON", "MON", "ION", "RON", "BOSON", "NEUTRON", "COMMON", "AEON",
  "SOLOMON", "DIGIMON", "MISSION", "ELECTRON", "XION", "KAON", "NEON", "ALON", "ANON", "COON",
  "VON", "LON", "ON", "RION", "FRAX", "WEMIX", "IOTX", "FLUX", "APEX", "IDEX", "POLYX", "STRAX",
  "MX", "CFX", "MYX", "TMX", "ARX", "SLX", "SPX", "INDEX", "BEAMX", "UPCX", "NOX", "TDX", "CRX",
  "VEX", "PFEX", "VRAX", "MBOX", "NFTX", "QANX", "NAVX", "LEOX", "MDEX", "STMX", "REDX", "VRTX",
  "VMPX", "POOLX", "MPLX", "OPENX", "LYNX", "SOLX", "MNTX", "BONDX", "EDGEX", "GAIX", "FROX",
  "CSIX", "GENX", "SOONX", "QTLX", "ALCX", "PUNDIX", "AGIX", "CHEX", "STRX", "ARTX", "SPHYNX",
  "RTX", "BTC", "ETH", "SOL", "DOGE", "ADA", "DOT", "LINK", "UNI", "ATOM", "LTC", "BCH", "NEAR",
  "APT", "SUI", "PEPE", "SHIB", "WIF", "BONK", "ARB", "OP", "INJ", "TIA", "SEI", "FET", "PI",
  "SOPH", "USDGO", "USDC", "USDT", "DAI", "RPL", "RVN", "RARE", "RLC", "RED", "RIF", "RAVE",
  "ROOT", "RACA", "ROSE", "REN", "RAIN", "REKT", "RAMP", "RWA", "RESOLV", "RATS", "RIVER",
  "RECALL", "ROAM", "RLUSD",
]);

const NAME_RE =
  /\b(tokenized stock|tokenised stock|tokenized equity|tokenised equity|tokenized etf|tokenised etf|tokenized asset|ondo tokenized|x[\s-]?stocks?|rtoken|reality stock|stock token)\b/i;

function namesHintStock(names: Array<string | null | undefined> | undefined): boolean {
  if (!names) return false;
  const blob = names.filter(Boolean).join(" ");
  return blob.length > 0 && NAME_RE.test(blob);
}

function suffixStock(base: string): boolean {
  const b = base.trim().toUpperCase();
  if (!b || CRYPTO_KEEP.has(b)) return false;
  // BingX TradFi equity tokens (NCSK...).
  if (b.startsWith("NCSK")) return true;
  for (const suffix of ["ON", "X", "B"] as const) {
    if (b.length <= suffix.length || !b.endsWith(suffix)) continue;
    const ticker = b.slice(0, -suffix.length);
    if (!ticker || CRYPTO_KEEP.has(ticker)) continue;
    if (ticker.length >= 3 && EQUITY_TICKERS.has(ticker)) return true;
    if (suffix === "ON" && ticker.length === 2 && TWO_LETTER_ON.has(ticker)) return true;
  }
  return false;
}

/**
 * Bitget rTokens menjaga huruf r kecil + ticker kapital di baseCoin (rCRH, rA, rNVDA).
 * Coin kripto biasa biasanya ALL CAPS (RENDER, RSR, RUNE, RAY, RAMP) jadi tidak lolos pola ini.
 */
function isBitgetStyleRToken(base: string): boolean {
  return /^r[A-Z0-9]+$/.test(base.trim());
}

/**
 * True jika pair ini token saham / xStock / rToken / Ondo tokenized stock.
 * `isStock` dari adapter (flag resmi) selalu dihormati.
 */
export function isTokenizedStock(input: StockFilterInput): boolean {
  if (input.isStock) return true;
  if (namesHintStock(input.names)) return true;
  if (isBitgetStyleRToken(input.base)) return true;
  return suffixStock(input.base);
}

const LEV_NAME_RE =
  /(\d+\s*x\s*(long|short)|leveraged token|token leverage|leverage token|leveraged etn)/i;

/** 3L/3S/5L/5S/2L dll. — harus ada digit tepat sebelum L/S, jadi SKL/BEL/MTL aman. */
const LEV_LS_RE = /^[A-Z0-9]*\d[LS]$/;

const LEV_SUFFIXES = ["DOWN", "BULL", "BEAR", "UP"] as const;

function namesHintLeveraged(names: Array<string | null | undefined> | undefined): boolean {
  if (!names) return false;
  const blob = names.filter(Boolean).join(" ");
  return blob.length > 0 && LEV_NAME_RE.test(blob);
}

function digitLsLeveraged(base: string): boolean {
  const b = base.trim().toUpperCase();
  return b.length >= 2 && LEV_LS_RE.test(b);
}

/**
 * Sufiks Binance-style BTCUP/ETHDOWN/BTCBULL/ETHBEAR hanya jika sisa base
 * ada di daftar pair exchange yang sama (jadi JUP, SYRUP, CUP, SUP aman).
 */
function directionalLeveraged(base: string, knownBases?: Set<string>): boolean {
  if (!knownBases || knownBases.size === 0) return false;
  const b = base.trim().toUpperCase();
  for (const suffix of LEV_SUFFIXES) {
    if (b.length <= suffix.length || !b.endsWith(suffix)) continue;
    const rest = b.slice(0, -suffix.length);
    if (rest.length >= 2 && knownBases.has(rest)) return true;
  }
  return false;
}

/**
 * True jika pair ini token leverage (3L/3S, 5L, BTCUP, ETHBEAR, dll.).
 * `isLeveraged` dari adapter (flag/nama resmi) selalu dihormati.
 */
export function isLeveragedToken(input: StockFilterInput): boolean {
  if (input.isLeveraged) return true;
  if (namesHintLeveraged(input.names)) return true;
  if (digitLsLeveraged(input.base)) return true;
  return directionalLeveraged(input.base, input.knownBases);
}

export type ExcludedTokenFilterResult<T> = {
  markets: MarketInfo[];
  tickers: T[];
  excluded: MarketInfo[];
  excludedStocks: MarketInfo[];
  excludedLeveraged: MarketInfo[];
};

export function filterStockTokens<T extends { rawSymbol: string }>(
  markets: MarketInfo[],
  tickers: T[],
): ExcludedTokenFilterResult<T> {
  const knownBases = new Set(markets.map((market) => market.base.trim().toUpperCase()));
  const excludedStocks: MarketInfo[] = [];
  const excludedLeveraged: MarketInfo[] = [];
  const kept: MarketInfo[] = [];
  for (const market of markets) {
    const names = market.displayName ? [market.displayName] : undefined;
    if (
      isTokenizedStock({
        base: market.base,
        rawSymbol: market.rawSymbol,
        isStock: market.isStock,
        names,
      })
    ) {
      excludedStocks.push(market);
    } else if (
      isLeveragedToken({
        base: market.base,
        rawSymbol: market.rawSymbol,
        isLeveraged: market.isLeveraged,
        names,
        knownBases,
      })
    ) {
      excludedLeveraged.push(market);
    } else {
      kept.push(market);
    }
  }
  const excluded = [...excludedStocks, ...excludedLeveraged];
  if (excluded.length === 0) {
    return { markets, tickers, excluded, excludedStocks, excludedLeveraged };
  }
  const drop = new Set(excluded.map((market) => market.rawSymbol));
  return {
    markets: kept,
    tickers: tickers.filter((ticker) => !drop.has(ticker.rawSymbol)),
    excluded,
    excludedStocks,
    excludedLeveraged,
  };
}
