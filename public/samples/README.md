# Sample statements

Synthetic, three months each, USD, for a fictional small business ("Acme").
Everything personal in these files is invented test data: names, emails, phone
numbers, card numbers (Luhn-valid test numbers), IBANs, SSNs and EINs.

- acme-q2.csv: 119 rows, ISO dates (Apr-Jun 2025, coherent prior period for Q3 comparison)
- acme-q3.csv: 117 rows, ISO dates (Jul-Sep 2025)
- acme-q4.csv: 112 rows, MM/DD/YYYY dates (Oct-Dec 2025)
- *.truth.json: the seeded PII and anomalies, used by the privacy rule tests

Regenerate with `pnpm samples`.

## Seeded anomalies

### Duplicate charges (same merchant and amount, at most 3 days apart)

- acme-q2: DELTA OFFICE DEPOT $184.20 on 2025-05-10 and 2025-05-11
- acme-q2: CORNER BISTRO $96.35 on 2025-06-04 and 2025-06-06
- acme-q3: DELTA OFFICE DEPOT $184.20 on 2025-08-10 and 2025-08-11
- acme-q3: CORNER BISTRO $96.35 on 2025-09-04 and 2025-09-06
- acme-q4: DELTA OFFICE DEPOT $184.20 on 2025-11-10 and 2025-11-11
- acme-q4: CORNER BISTRO $96.35 on 2025-12-04 and 2025-12-06

### Subscription price increases

- acme-q2: NORTHWIND SOFTWARE $89.00 to $99.00 on 2025-06-12
- acme-q3: CLOUDNEST HOSTING $49.00 to $59.00 on 2025-09-05
- acme-q4: STREAMDESK PRO $15.99 to $19.99 on 2025-12-09

### Outliers within a category

- acme-q2: Supplies: BRIGHTLINE PLUMBING LLC $890.00 on 2025-05-22
- acme-q2: Meals: CORNER BISTRO $417.80 on 2025-04-24
- acme-q3: Supplies: BRIGHTLINE PLUMBING LLC $2380.00 on 2025-08-22
- acme-q3: Meals: CORNER BISTRO $417.80 on 2025-07-24
- acme-q4: Supplies: BRIGHTLINE PLUMBING LLC $2380.00 on 2025-11-21
- acme-q4: Meals: CORNER BISTRO $417.80 on 2025-10-24

### Round transfers (multiples of $500)

- acme-q2: $5000.00 on 2025-04-29
- acme-q2: $1500.00 on 2025-06-16
- acme-q3: $5000.00 on 2025-07-30
- acme-q3: $1500.00 on 2025-09-16
- acme-q4: $5000.00 on 2025-10-29
- acme-q4: $1500.00 on 2025-12-16

### Weekend spend (large charge on a Saturday)

- acme-q2: DELTA OFFICE DEPOT $640.15 on 2025-05-17
- acme-q3: DELTA OFFICE DEPOT $640.15 on 2025-08-16
- acme-q4: DELTA OFFICE DEPOT $640.15 on 2025-11-15

