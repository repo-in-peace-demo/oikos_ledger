// Shared currency formatting — looks the symbol up from SUPPORTED_CURRENCIES instead of
// hardcoding a glyph, so amounts render correctly if a currency other than INR is ever added.
import { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from "@/lib/constants/currencies"

export function getCurrencySymbol(currencyCode: string): string {
  return SUPPORTED_CURRENCIES.find((c) => c.code === currencyCode)?.symbol
    ?? SUPPORTED_CURRENCIES.find((c) => c.code === DEFAULT_CURRENCY)!.symbol
}

export function formatCurrency(amount: number, currencyCode: string = DEFAULT_CURRENCY): string {
  const symbol = getCurrencySymbol(currencyCode)
  return `${symbol}${Math.round(Math.abs(amount)).toLocaleString("en-IN")}`
}
