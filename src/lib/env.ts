import path from "node:path";

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function getEnabledExchanges(): string[] {
  const listed = splitList(process.env.ENABLED_EXCHANGES);
  return listed.length > 0 ? listed : ["kraken"];
}

export function getDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim() || "./data/arbit.db";
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}
