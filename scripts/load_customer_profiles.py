# -*- coding: utf-8 -*-
"""Load OIG + UNICO customer master from the user's two xlsx files into
store.json as `customerDeliveryProfiles`.

Each profile = { CardCode, Company, Name, City, Street, Zone,
                 DeliveryDays[], Issue }

Issue values: "" | "missing_city" | "missing_zone" | "missing_city+missing_zone"
"""
import json
import os
import sys
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')

OIG = r'C:\Users\izik\AppData\Local\Temp\של רשימה של כרטיסיםOIG (3).xlsx'
UNI = r'C:\Users\izik\AppData\Local\Temp\רשימה של כרטיסים UNICO (3).xlsx'
STORE = r'C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\data\store.json'
# Manually-curated doc-policy spreadsheet. When the user fills it in, this
# loader reads the 4 policy columns and writes them onto each profile.
DOC_POLICY_XLSX = r'C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\docs\customer-doc-policy\customer-doc-policy.xlsx'


def _yn(val):
    """Coerce a Hebrew 'כן'/'לא'/'—' / empty into a normalized value."""
    s = str(val or '').strip()
    if s in ('כן',):  return 'yes'
    if s in ('לא',):  return 'no'
    if s in ('—', '-', 'n/a', 'N/A'): return 'na'
    return ''  # blank → not yet decided


def load_doc_policy_xlsx(path):
    """Return { (Company, CardCode): { perOrderDeliveryNote, perOrderInvoice,
                                       aggregateDeliveryNote, aggregateInvoice, notes } }.
    Empty dict if the file is missing or unfilled."""
    if not os.path.exists(path):
        print(f'[policy] file not found: {path}')
        return {}
    try:
        df = pd.read_excel(path, sheet_name='לקוחות תקינים')
    except Exception as e:
        print(f'[policy] read failed: {e}')
        return {}
    out = {}
    filled_rows = 0
    for _, r in df.iterrows():
        cc = clean(r.get('קוד כרטיס'))
        co = clean(r.get('חברה'))
        if not cc or not co:
            continue
        policy = {
            'perOrderDeliveryNote':   _yn(r.get('תעודת משלוח לכל הזמנה')),
            'perOrderInvoice':        _yn(r.get('חשבונית לכל הזמנה')),
            'aggregateDeliveryNote':  _yn(r.get('תעודת משלוח מרכזת לקו')),
            'aggregateInvoice':       _yn(r.get('חשבונית מרכזת לקו')),
            'notes':                  clean(r.get('הערות')),
        }
        if any(policy.values()):
            filled_rows += 1
        out[(co, str(cc))] = policy
    print(f'[policy] loaded {len(out)} keys from xlsx, {filled_rows} with at least one filled column')
    return out


def clean(v):
    if v is None:
        return ''
    s = str(v).strip()
    return '' if s.lower() in ('nan', 'none') else s


def map_zone_to_code(name, store_zones):
    """Match Hebrew zone name from xlsx → (ZoneCode, SubZone).
    SubZone captures finer subdivisions (e.g. 'קרוב'/'רחוק') the user maintains
    in the master file but we don't have as canonical zones in store.json yet.
    """
    if not name:
        return ('', '')
    s = name.strip()
    direct = {
        'צפון': ('NORTH', ''),
        'צפון קרוב': ('NORTH', 'קרוב'),
        'צפון רחוק': ('NORTH', 'רחוק'),
        'צפון מערבי': ('NORTHWEST', ''),
        'שרון': ('SHARON', ''),
        'מרכז': ('CENTER', ''),
        'מרכז קרוב': ('CENTER', 'קרוב'),
        'מרכז רחוק': ('CENTER', 'רחוק'),
        'תל אביב': ('CENTER', 'תל אביב'),
        'ירושלים': ('JERUSALEM', ''),
        'שפלה': ('SHFELA', ''),
        'דרום': ('SOUTH-1', ''),
        'דרום-אשדוד': ('SOUTH-1', ''),
        'דרום - אשדוד': ('SOUTH-1', ''),
        'דרום ב"ש': ('SOUTH-2', ''),
        'דרום-ב"ש': ('SOUTH-2', ''),
        'דרום - ב"ש': ('SOUTH-2', ''),
        'אילת': ('EILAT', ''),
    }
    if s in direct:
        return direct[s]
    for z in store_zones:
        if z.get('Name', '').strip() == s:
            return (z['Code'], '')
    return ('', '')


def load_oig(path, store_zones):
    df = pd.read_excel(path, sheet_name='Sheet1')
    out = []
    for _, r in df.iterrows():
        zone_name = clean(r.get('אזור'))
        city = clean(r.get('כתובת לחיוב - עיר'))
        zone_code, sub = map_zone_to_code(zone_name, store_zones)
        days = [d for d in (clean(r.get('ימי הפצה')), clean(r.get('ימי הפצה.1'))) if d]
        issues = []
        if not city:
            issues.append('missing_city')
        if not zone_code:
            issues.append('missing_zone')
        out.append({
            'CardCode': str(clean(r.get('קוד כרטיס'))),
            'Company': 'OIG',
            'Name': clean(r.get('שם כרטיס')),
            'City': city,
            'Street': clean(r.get('כתובת לחיוב - רחוב')),
            'Zone': zone_code,
            'SubZone': sub,
            'ZoneNameRaw': zone_name,
            'DeliveryDays': days,
            'Issue': '+'.join(issues),
        })
    return out


def load_unico(path, store_zones):
    df = pd.read_excel(path, sheet_name='גיליון1')
    out = []
    for _, r in df.iterrows():
        zone_name = clean(r.get('אזור'))
        city = clean(r.get('כתובת למשלוח - עיר')) or clean(r.get('כתובת לחיוב - עיר'))
        street = clean(r.get('כתובת למשלוח - רחוב')) or clean(r.get('רחוב'))
        zone_code, sub = map_zone_to_code(zone_name, store_zones)
        days = [d for d in (clean(r.get('יום אספקה')), clean(r.get('יום אספקה '))) if d]
        issues = []
        if not city:
            issues.append('missing_city')
        if not zone_code:
            issues.append('missing_zone')
        out.append({
            'CardCode': str(clean(r.get('קוד כרטיס'))),
            'Company': 'UNICO',
            'Name': clean(r.get('שם כרטיס')),
            'City': city,
            'Street': street,
            'Zone': zone_code,
            'SubZone': sub,
            'ZoneNameRaw': zone_name,
            'DeliveryDays': days,
            'Issue': '+'.join(issues),
        })
    return out


EMPTY_POLICY = {
    'perOrderDeliveryNote': '',
    'perOrderInvoice': '',
    'aggregateDeliveryNote': '',
    'aggregateInvoice': '',
    'notes': '',
}


def main():
    with open(STORE, 'r', encoding='utf-8') as f:
        store = json.load(f)
    zones = store.get('zones', [])
    policy_index = load_doc_policy_xlsx(DOC_POLICY_XLSX)

    # Preserve any policy that may already exist in store (so re-running the
    # loader after the user edited values through the API doesn't wipe them).
    existing_policy = {}
    for p in store.get('customerDeliveryProfiles', []):
        if isinstance(p.get('DocPolicy'), dict):
            existing_policy[(p.get('Company'), str(p.get('CardCode')))] = p['DocPolicy']

    profiles = load_oig(OIG, zones) + load_unico(UNI, zones)

    for p in profiles:
        key = (p['Company'], p['CardCode'])
        # Precedence: xlsx (user-curated) > existing store > empty
        if key in policy_index:
            p['DocPolicy'] = {**EMPTY_POLICY, **policy_index[key]}
        elif key in existing_policy:
            p['DocPolicy'] = {**EMPTY_POLICY, **existing_policy[key]}
        else:
            p['DocPolicy'] = dict(EMPTY_POLICY)

    # Stats
    total = len(profiles)
    by_company = {}
    by_zone = {}
    issues = 0
    with_policy = 0
    for p in profiles:
        by_company[p['Company']] = by_company.get(p['Company'], 0) + 1
        if p['Issue']:
            issues += 1
        else:
            by_zone[p['Zone']] = by_zone.get(p['Zone'], 0) + 1
        dp = p.get('DocPolicy', {})
        if any(v for k, v in dp.items() if k != 'notes' and v):
            with_policy += 1

    print(f'Total profiles: {total}')
    print(f'  by company: {by_company}')
    print(f'  with issues: {issues}')
    print(f'  with policy decided: {with_policy}/{total}')
    print(f'  by zone (clean only):')
    for z, n in sorted(by_zone.items(), key=lambda x: -x[1]):
        print(f'    {z:12s} {n}')

    # Sample
    print('\nSample profile:', json.dumps(profiles[0], ensure_ascii=False, indent=2))

    # Write
    store['customerDeliveryProfiles'] = profiles
    with open(STORE, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    print(f'\nWrote {total} profiles to store.json')


if __name__ == '__main__':
    main()
