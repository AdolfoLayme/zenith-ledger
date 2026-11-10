export type PiiType = 'person' | 'card' | 'iban' | 'account' | 'email' | 'phone' | 'ssn' | 'ein' | 'url';
export interface Span { start: number; end: number; type: PiiType; value: string }
export interface StatementRow { date: string; description: string; amountCents: number; currency: string; balanceCents: number | null }
/** What an on-device model can tell us about one description. All fields optional. */
export interface RowEntities { category?: string; merchant?: string; persons?: string[] }
