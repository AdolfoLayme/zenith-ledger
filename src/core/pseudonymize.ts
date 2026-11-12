import type { Span } from './types';

export type EntityKind = 'vendor' | 'person' | 'card' | 'iban' | 'account' | 'email' | 'phone' | 'ssn' | 'ein' | 'url';

const PREFIX: Record<EntityKind, string> = {
  vendor: 'Vendor', person: 'Person', card: 'Card', iban: 'IBAN', account: 'Account',
  email: 'Email', phone: 'Phone', ssn: 'SSN', ein: 'EIN', url: 'Link',
};

const letters = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : letters(Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26)));

export interface Aliaser {
  alias(kind: EntityKind, value: string): string;
  /** alias -> original. Stays on the device. */
  map: Map<string, string>;
}

export function createAliaser(): Aliaser {
  const byValue = new Map<string, string>();
  const counts = new Map<EntityKind, number>();
  const map = new Map<string, string>();
  return {
    map,
    alias(kind, value) {
      const key = `${kind}:${value}`;
      let a = byValue.get(key);
      if (!a) {
        const n = counts.get(kind) ?? 0;
        counts.set(kind, n + 1);
        a = `${PREFIX[kind]}_${kind === 'vendor' ? letters(n) : n + 1}`;
        byValue.set(key, a);
        map.set(a, value);
      }
      return a;
    },
  };
}

export function redact(text: string, spans: Span[], aliaser: Aliaser): string {
  let out = '';
  let pos = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, s.start) + aliaser.alias(s.type, s.value);
    pos = s.end;
  }
  return out + text.slice(pos);
}

export function reidentify(text: string, map: Map<string, string>): string {
  // models sometimes pluralize an alias ("Vendors_C"): read it as the alias it stands for
  return text.replace(/\b(Vendor|Person|Card|IBAN|Account|Email|Phone|SSN|EIN|Link)s?_([A-Z]+|\d+)\b/g, (a, kind: string, id: string) => map.get(`${kind}_${id}`) ?? a);
}
